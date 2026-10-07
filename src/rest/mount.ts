import type { Context, Hono } from "hono";
import { networkFingerprint } from "../auth/ratelimit";
import {
  commitNonce,
  type Ed25519PublicJwk,
  jwkThumbprint,
  type KeyResolution,
  nonceLookup,
  verifySignature,
} from "../auth/signature";
import { type Env, loadConfig } from "../config";
import { createDb } from "../db/client";
import { HiveError } from "../errors";
import type { Bytes } from "../lib/encoding";
import type { Op, OpContext } from "../ops/define";
import { hasStoredResponse, parseIdempotencyKey, withIdempotency } from "../ops/idempotency";
import {
  assertWritable,
  authenticateAgent,
  executeOp,
  type ExecuteResult,
  hasSignature,
  isWrite,
  parseInput,
} from "../ops/run";
import { z } from "zod";

export type AppEnv = { Bindings: Env };

/**
 * Thin REST surface: turns an HTTP request into an op call. Op logic lives in src/ops/; the
 * shared pipeline (signature, rate limit, idempotency, validation) lives in src/ops/run.ts.
 */

export async function readBody(c: Context<AppEnv>, maxBytes: number): Promise<Bytes> {
  const tooLarge = new HiveError(
    413,
    "body_too_large",
    `The request body is larger than ${maxBytes} bytes.`,
    "Send a smaller body. Post long material as several items.",
  );
  if (Number(c.req.header("content-length") ?? 0) > maxBytes) throw tooLarge;
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.length > maxBytes) throw tooLarge;
  return body;
}

export function parseJsonObject(body: Bytes): Record<string, unknown> {
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

export function buildContext(c: Context<AppEnv>, now: number): OpContext {
  let fingerprint: Promise<string> | undefined;
  return {
    env: c.env,
    config: loadConfig(c.env),
    db: createDb(c.env.DB),
    now,
    agent: null,
    keyThumbprint: null,
    networkFp: () =>
      (fingerprint ??= networkFingerprint(
        c.env.SERVER_SECRET ?? "",
        c.req.header("cf-connecting-ip") ?? null,
      )),
    waitUntil: (promise) => {
      try {
        c.executionCtx.waitUntil(promise);
      } catch {
        // No execution context (some tests): let the promise settle on its own.
      }
    },
  };
}

function selfResolver(publicKey: Ed25519PublicJwk) {
  return async (keyid: string): Promise<KeyResolution> =>
    keyid === (await jwkThumbprint(publicKey))
      ? { ok: true, publicKey }
      : { ok: false, reason: "mismatch" };
}

/** Registration: the key that must have signed the request is inside the body. */
async function executeSelfOp(
  op: Op,
  ctx: OpContext,
  c: Context<AppEnv>,
  body: Bytes,
  raw: Record<string, unknown>,
): Promise<ExecuteResult> {
  const input = parseInput(op, raw);
  if (!op.selfKey) throw new Error(`op ${op.name} has no selfKey`);
  const verified = await verifySignature({
    method: c.req.method,
    url: c.req.url,
    headers: c.req.raw.headers,
    body,
    now: ctx.now,
    maxWindowSeconds: ctx.config.signatureWindowSeconds,
    resolveKey: selfResolver(op.selfKey(input)),
    isNonceSeen: nonceLookup(ctx.db),
  });
  ctx.keyThumbprint = verified.keyThumbprint;
  const idempotencyKey = parseIdempotencyKey(c.req.header("idempotency-key"));
  const scope = `key:${verified.keyThumbprint}`;
  // A retry of a registration that already succeeded gets the stored response back. It writes
  // nothing, so it skips the checks (which would now say the key is taken) and the nonce.
  if (!(await hasStoredResponse(ctx.db, scope, idempotencyKey, ctx.now))) {
    // Proof-of-work and every read-only check run before the first database write.
    await assertWritable(ctx);
    await op.precheck?.(ctx, input);
    await commitNonce(ctx.db, verified);
  }
  return withIdempotency(
    ctx.db,
    {
      scope,
      key: idempotencyKey,
      requestHash: `${op.method} ${new URL(c.req.url).pathname} ${verified.bodyDigest}`,
      ttlMs: ctx.config.idempotencyTtlMs,
      now: ctx.now,
    },
    async () => ({
      status: op.successStatus ?? 200,
      body: z.parse(op.output, await op.handler(ctx, input)),
    }),
  );
}

export function mountOp(app: Hono<AppEnv>, op: Op): void {
  const write = isWrite(op);

  app.on(op.method, op.path, async (c) => {
    const now = Date.now();
    const ctx = buildContext(c, now);
    const body = write ? await readBody(c, ctx.config.maxRequestBytes) : new Uint8Array();
    const rawInput = (): Record<string, unknown> => ({
      ...c.req.query(),
      ...(write ? parseJsonObject(body) : {}),
      ...c.req.param(),
    });

    let result: ExecuteResult;
    if (op.auth === "self") {
      result = await executeSelfOp(op, ctx, c, body, rawInput());
    } else {
      let requestHash: string | undefined;
      // A public op still learns who is asking when the request is signed.
      if (op.auth === "agent" || hasSignature(c.req.raw.headers)) {
        const { agent, verified } = await authenticateAgent(
          ctx.db,
          ctx.config,
          { method: c.req.method, url: c.req.url, headers: c.req.raw.headers, body },
          now,
          { metrics: c.env.METRICS, countWrite: write && op.auth === "agent" },
        );
        ctx.agent = agent;
        ctx.writeCounted = write && op.auth === "agent";
        ctx.keyThumbprint = verified.keyThumbprint;
        {
          // Query parameters are part of a write's input, so they are part of its identity.
          const url = new URL(c.req.url);
          requestHash = `${op.method} ${url.pathname}${url.search} ${verified.bodyDigest}`;
        }
      }
      result = await executeOp(op, ctx, rawInput, {
        idempotencyKey: c.req.header("idempotency-key"),
        requestHash,
      });
    }

    if (result.replayed) c.header("Idempotency-Replayed", "true");
    c.header(
      "Cache-Control",
      op.auth === "public" && !write && op.cacheSeconds
        ? `public, max-age=${op.cacheSeconds}, s-maxage=${op.cacheSeconds}`
        : "no-store",
    );
    return c.json(result.body as object, result.status as 200);
  });
}
