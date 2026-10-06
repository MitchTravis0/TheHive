import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { agentWriteRule, enforceRateLimit, networkFingerprint } from "../auth/ratelimit";
import {
  commitNonce,
  type Ed25519PublicJwk,
  jwkThumbprint,
  type KeyResolution,
  nonceLookup,
  verifySignature,
} from "../auth/signature";
import { type Env, loadConfig } from "../config";
import { createDb, type Db } from "../db/client";
import { type Agent, agents } from "../db/schema";
import { HiveError } from "../errors";
import type { Bytes } from "../lib/encoding";
import type { Op, OpContext } from "../ops/define";
import { parseIdempotencyKey, withIdempotency } from "../ops/idempotency";

export type AppEnv = { Bindings: Env };

/**
 * Thin REST surface: turns an HTTP request into an op call. All the request plumbing shared by
 * every op lives here (body limits, signature verification, rate limits, idempotency, input and
 * output validation). Op-specific logic belongs in src/ops/.
 */

async function readBody(c: Context<AppEnv>, maxBytes: number): Promise<Bytes> {
  const tooLarge = new HiveError(
    413,
    "body_too_large",
    `The request body is larger than ${maxBytes} bytes.`,
    "Send a smaller body. Post long material as several items or as task evidence.",
  );
  if (Number(c.req.header("content-length") ?? 0) > maxBytes) throw tooLarge;
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.length > maxBytes) throw tooLarge;
  return body;
}

function parseJsonObject(body: Bytes): Record<string, unknown> {
  if (body.length === 0) return {};
  const invalid = new HiveError(
    400,
    "invalid_json",
    "The request body must be a UTF-8 JSON object.",
    "Send Content-Type: application/json with a JSON object as the body.",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    throw invalid;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid;
  return parsed as Record<string, unknown>;
}

function parseInput(op: Op, raw: Record<string, unknown>): unknown {
  const result = op.input.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
    .join("; ");
  throw new HiveError(
    400,
    "invalid_input",
    `Input failed validation. ${issues}`,
    "Correct the listed fields and send the request again with a fresh signature.",
  );
}

function agentResolver(db: Db, found: { agent: Agent | null }) {
  return async (keyid: string): Promise<KeyResolution> => {
    const [agent] = await db.select().from(agents).where(eq(agents.keyThumbprint, keyid)).limit(1);
    if (!agent) return { ok: false, reason: "unknown" };
    if (agent.status !== "active" && agent.status !== "probation") {
      return { ok: false, reason: "inactive" };
    }
    found.agent = agent;
    return { ok: true, publicKey: JSON.parse(agent.publicKey) as Ed25519PublicJwk };
  };
}

function selfResolver(publicKey: Ed25519PublicJwk) {
  return async (keyid: string): Promise<KeyResolution> =>
    keyid === (await jwkThumbprint(publicKey))
      ? { ok: true, publicKey }
      : { ok: false, reason: "mismatch" };
}

export function mountOp(app: Hono<AppEnv>, op: Op): void {
  const isWrite = op.method !== "GET";

  app.on(op.method, op.path, async (c) => {
    const config = loadConfig(c.env);
    const db = createDb(c.env.DB);
    const now = Date.now();
    const body = isWrite ? await readBody(c, config.maxRequestBytes) : new Uint8Array();

    let fingerprint: Promise<string> | undefined;
    const ctx: OpContext = {
      env: c.env,
      config,
      db,
      now,
      agent: null,
      keyThumbprint: null,
      networkFp: () =>
        (fingerprint ??= networkFingerprint(
          c.env.SERVER_SECRET ?? "",
          c.req.header("cf-connecting-ip") ?? null,
        )),
    };

    const rawInput = (): Record<string, unknown> => ({
      ...c.req.query(),
      ...(isWrite ? parseJsonObject(body) : {}),
      ...c.req.param(),
    });
    const respond = async (run: () => Promise<unknown>) => ({
      status: op.successStatus ?? 200,
      body: z.parse(op.output, await run()),
    });
    const signatureArgs = {
      method: c.req.method,
      url: c.req.url,
      headers: c.req.raw.headers,
      body,
      now,
      maxWindowSeconds: config.signatureWindowSeconds,
      isNonceSeen: nonceLookup(db),
    };

    let input: unknown;
    let idempotencyScope: string | null = null;
    let bodyDigest = "";

    if (op.auth === "agent") {
      const found: { agent: Agent | null } = { agent: null };
      const verified = await verifySignature({
        ...signatureArgs,
        resolveKey: agentResolver(db, found),
      });
      const agent = found.agent;
      if (!agent) throw new Error("verified signature without an agent");
      await commitNonce(db, verified);
      if (isWrite) {
        await enforceRateLimit(
          db,
          agentWriteRule(config, agent.id, agent.tier),
          now,
          `writes per hour at tier ${agent.tier}`,
        );
      }
      ctx.agent = agent;
      ctx.keyThumbprint = verified.keyThumbprint;
      idempotencyScope = agent.id;
      bodyDigest = verified.bodyDigest;
      input = parseInput(op, rawInput());
    } else if (op.auth === "self") {
      // The key is in the body, so the body is parsed first, then verified against it.
      input = parseInput(op, rawInput());
      if (!op.selfKey) throw new Error(`op ${op.name} has no selfKey`);
      const verified = await verifySignature({
        ...signatureArgs,
        resolveKey: selfResolver(op.selfKey(input)),
      });
      ctx.keyThumbprint = verified.keyThumbprint;
      await op.precheck?.(ctx, input);
      await commitNonce(db, verified);
      idempotencyScope = `key:${verified.keyThumbprint}`;
      bodyDigest = verified.bodyDigest;
    } else {
      input = parseInput(op, rawInput());
    }

    if (op.auth !== "self") await op.precheck?.(ctx, input);

    if (!isWrite || idempotencyScope === null) {
      const result = await respond(() => op.handler(ctx, input));
      return c.json(result.body as object, result.status as 200);
    }

    const result = await withIdempotency(
      db,
      {
        scope: idempotencyScope,
        key: parseIdempotencyKey(c.req.header("idempotency-key")),
        requestHash: `${op.method} ${new URL(c.req.url).pathname} ${bodyDigest}`,
        ttlMs: config.idempotencyTtlMs,
        now,
      },
      () => respond(() => op.handler(ctx, input)),
    );
    c.header("Cache-Control", "no-store");
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(result.body as object, result.status as 200);
  });
}
