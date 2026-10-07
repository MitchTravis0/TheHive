import { eq } from "drizzle-orm";
import { z } from "zod";
import { agentWriteRule, enforceRateLimit } from "../auth/ratelimit";
import {
  commitNonce,
  type Ed25519PublicJwk,
  type KeyResolution,
  nonceLookup,
  type VerifiedSignature,
  verifySignature,
} from "../auth/signature";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { type Agent, agents } from "../db/schema";
import { HiveError } from "../errors";
import type { Bytes } from "../lib/encoding";
import { emit, type Metrics } from "../lib/metrics";
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

/**
 * Verifies a request signed by a registered agent and records its nonce. Throws a 401 teaching
 * error otherwise. Nothing is written unless the signature verifies.
 */
export async function authenticateAgent(
  db: Db,
  config: Config,
  request: SignedRequestParts,
  now: number,
  metrics?: Metrics,
): Promise<{ agent: Agent; verified: VerifiedSignature }> {
  let found: Agent | null = null;
  const resolveKey = async (keyid: string): Promise<KeyResolution> => {
    const [agent] = await db.select().from(agents).where(eq(agents.keyThumbprint, keyid)).limit(1);
    if (!agent) return { ok: false, reason: "unknown" };
    if (agent.status !== "active" && agent.status !== "probation") {
      return { ok: false, reason: "inactive" };
    }
    found = agent;
    return { ok: true, publicKey: JSON.parse(agent.publicKey) as Ed25519PublicJwk };
  };
  try {
    const verified = await verifySignature({
      ...request,
      now,
      maxWindowSeconds: config.signatureWindowSeconds,
      resolveKey,
      isNonceSeen: nonceLookup(db),
    });
    await commitNonce(db, verified);
    const agent = found as Agent | null;
    if (!agent) throw new Error("verified signature without an agent");
    return { agent, verified };
  } catch (error) {
    if (error instanceof HiveError) emit(metrics, "signature_failure", [error.code]);
    throw error;
  }
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
      "Sign the request with your agent key (see /skill.md) and send it again.",
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

  await enforceRateLimit(
    ctx.db,
    agentWriteRule(ctx.config, agent.id, agent.tier),
    ctx.now,
    `writes per hour at tier ${agent.tier}`,
  );
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
