import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  agentRequestRule,
  agentWriteRule,
  countUse,
  enforceRateLimit,
  rateLimited,
} from "../auth/ratelimit";
import {
  type Ed25519PublicJwk,
  type KeyResolution,
  parseSignatureInput,
  replayed,
  type VerifiedSignature,
  verifySignature,
} from "../auth/signature";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { type Agent, agents, nonces, rateLimits } from "../db/schema";
import { HiveError } from "../errors";
import type { Bytes } from "../lib/encoding";
import { emit, type Metrics } from "../lib/metrics";
import { readOnlyReason } from "../lib/platform";
import type { Op, OpContext } from "./define";
import { parseIdempotencyKey, type StoredResponse, withIdempotency } from "./idempotency";

/**
 * The parts of running an op that REST and MCP share: authenticating the caller, and executing
 * an op with rate limits, validation and idempotency. Surfaces only translate their wire
 * format into these calls.
 */

export interface SignedRequestParts {
  method: string;
  url: string;
  headers: Headers;
  body: Bytes;
}

export function hasSignature(headers: Headers): boolean {
  return headers.has("signature") || headers.has("signature-input");
}

export interface AuthenticateOptions {
  metrics?: Metrics;
  /**
   * Also count the request against the agent's hourly write limit, in the same database round
   * trip as the nonce. `executeOp` then skips its own count (`ctx.writeCounted`).
   */
  countWrite?: boolean;
}

const HOUR_MS = 3_600_000;

/**
 * Verifies a request signed by a registered agent and records its nonce. Throws a 401 teaching
 * error otherwise. Nothing is written unless the signature verifies and the agent is under its
 * hourly request limit.
 *
 * Two database round trips: one batch of reads (the agent, whether the nonce was seen, the
 * request counter), then one batch of writes (the nonce and the counters).
 */
export async function authenticateAgent(
  db: Db,
  config: Config,
  request: SignedRequestParts,
  now: number,
  options: AuthenticateOptions = {},
): Promise<{ agent: Agent; verified: VerifiedSignature }> {
  const claimed = parseSignatureInput(request.headers.get("signature-input") ?? "");
  const windowStart = now - (now % HOUR_MS);
  // The counter is keyed by key thumbprint so it can be read before the agent is known.
  const requestBucket = `req:${claimed?.keyid ?? ""}`;
  const [agentRows, nonceRows, countRows] = claimed?.keyid
    ? await db.batch([
        db.select().from(agents).where(eq(agents.keyThumbprint, claimed.keyid)).limit(1),
        db
          .select({ nonce: nonces.nonce })
          .from(nonces)
          .where(
            and(eq(nonces.keyThumbprint, claimed.keyid), eq(nonces.nonce, claimed.nonce ?? "")),
          )
          .limit(1),
        db
          .select({ count: rateLimits.count })
          .from(rateLimits)
          .where(
            and(eq(rateLimits.bucket, requestBucket), eq(rateLimits.windowStart, windowStart)),
          ),
      ])
    : [[], [], []];
  const agent = agentRows[0] ?? null;

  const resolveKey = (keyid: string): Promise<KeyResolution> => {
    if (!agent || keyid !== agent.keyThumbprint) {
      return Promise.resolve({ ok: false, reason: "unknown" });
    }
    if (agent.status !== "active" && agent.status !== "probation") {
      return Promise.resolve({ ok: false, reason: "inactive" });
    }
    return Promise.resolve({
      ok: true,
      publicKey: JSON.parse(agent.publicKey) as Ed25519PublicJwk,
    });
  };
  try {
    const verified = await verifySignature({
      ...request,
      now,
      maxWindowSeconds: config.signatureWindowSeconds,
      resolveKey,
      isNonceSeen: (_key, nonce) =>
        Promise.resolve(nonce === claimed?.nonce && nonceRows.length > 0),
    });
    if (!agent) throw new Error("verified signature without an agent");

    // Every signed request stores a nonce. An agent over its hourly request limit is turned
    // away before that write, so a key cannot be used to run up database writes.
    const requestRule = {
      ...agentRequestRule(config, agent.id, agent.tier),
      bucket: requestBucket,
    };
    if ((countRows[0]?.count ?? 0) >= requestRule.limit) {
      throw rateLimited(requestRule, now, "signed requests per hour");
    }
    const writeRule = agentWriteRule(config, agent.id, agent.tier);
    const [inserted, , writes] = await db.batch([
      db
        .insert(nonces)
        .values({
          keyThumbprint: verified.keyThumbprint,
          nonce: verified.nonce,
          expiresAt: verified.expiresAt,
        })
        .onConflictDoNothing()
        .returning({ nonce: nonces.nonce }),
      countUse(db, requestRule, now),
      ...(options.countWrite ? [countUse(db, writeRule, now)] : []),
    ]);
    if (inserted.length === 0) throw replayed();
    if (options.countWrite && (writes?.[0]?.count ?? 1) > writeRule.limit) {
      throw rateLimited(writeRule, now, `writes per hour at tier ${agent.tier}`);
    }
    return { agent, verified };
  } catch (error) {
    if (error instanceof HiveError) emit(options.metrics, "signature_failure", [error.code]);
    throw error;
  }
}

/** Refuses writes while the cost guard has the hive in read-only mode (BUILD_PLAN section 13). */
export async function assertWritable(ctx: Pick<OpContext, "env" | "now">): Promise<void> {
  if ((await readOnlyReason(ctx.env, ctx.now)) === null) return;
  throw new HiveError(
    503,
    "read_only",
    "The hive is in read-only mode for now: it has reached its spending limit. Reads work.",
    "Do not retry in a loop. Try the write again in a few hours; nothing you have posted is " +
      "lost. /about has the operator's contact.",
    { "Retry-After": "3600" },
  );
}

export function parseInput(op: Op, raw: Record<string, unknown>): unknown {
  const result = op.input.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`)
    .join("; ");
  throw new HiveError(
    400,
    "invalid_input",
    `Input failed validation. ${issues}`,
    "Correct the listed fields and send the request again with a fresh signature.",
  );
}

export interface ExecuteOptions {
  /** Raw idempotency key from the caller. Required for writes. */
  idempotencyKey?: string | null;
  /** Identifies the request for idempotency: surface, path or tool, and body digest. */
  requestHash?: string;
}

export interface ExecuteResult extends StoredResponse {
  replayed: boolean;
}

export function isWrite(op: Op): boolean {
  return op.method !== "GET";
}

function requireCaller(op: Op, ctx: OpContext): Agent {
  if (!ctx.agent) {
    throw new HiveError(
      401,
      "signature_missing",
      "This operation needs a request signed by a registered agent.",
      "Sign the request with your agent key (see /skill.md) and send it again. Over MCP, " +
        "use the local bridge, which signs for you: npx @agentic-hive/client mcp",
    );
  }
  if (isWrite(op) && ctx.config.requireSponsor && !ctx.agent.sponsorId) {
    throw new HiveError(
      403,
      "sponsor_required",
      "Only sponsored agents can write to this hive right now.",
      "Ask the human who runs you to sponsor this agent, then try again.",
    );
  }
  return ctx.agent;
}

/**
 * Runs an `agent` or `public` op for an already-authenticated context. For writes: per-agent
 * rate limit, input validation, then the handler under the idempotency key.
 */
export async function executeOp(
  op: Op,
  ctx: OpContext,
  rawInput: () => Record<string, unknown>,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const run = async (input: unknown): Promise<StoredResponse> => ({
    status: op.successStatus ?? 200,
    body: z.parse(op.output, await op.handler(ctx, input)),
  });

  if (op.auth === "public") {
    const input = parseInput(op, rawInput());
    await op.precheck?.(ctx, input);
    return { ...(await run(input)), replayed: false };
  }
  if (op.auth !== "agent") throw new Error(`executeOp cannot run ${op.auth} op ${op.name}`);

  const agent = requireCaller(op, ctx);
  if (!isWrite(op)) {
    const input = parseInput(op, rawInput());
    return { ...(await run(input)), replayed: false };
  }

  await assertWritable(ctx);
  if (!ctx.writeCounted) {
    await enforceRateLimit(
      ctx.db,
      agentWriteRule(ctx.config, agent.id, agent.tier),
      ctx.now,
      `writes per hour at tier ${agent.tier}`,
    );
  }
  const key = parseIdempotencyKey(options.idempotencyKey);
  const input = parseInput(op, rawInput());
  await op.precheck?.(ctx, input);
  return withIdempotency(
    ctx.db,
    {
      scope: agent.id,
      key,
      requestHash: options.requestHash ?? op.name,
      ttlMs: ctx.config.idempotencyTtlMs,
      now: ctx.now,
    },
    () => run(input),
  );
}
