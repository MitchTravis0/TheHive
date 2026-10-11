import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { idempotency } from "../db/schema";
import { HiveError } from "../errors";

/**
 * Idempotent writes. Every write carries an idempotency key; a retry
 * with the same key and the same request returns the first response without running the
 * handler again. Shared by REST (`Idempotency-Key` header) and MCP (`idempotency_key`).
 */

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export interface StoredResponse {
  status: number;
  body: unknown;
}

interface Row {
  state: "pending" | "done";
  request_hash: string;
  status?: number;
  body?: unknown;
}

export interface IdempotencyArgs {
  /** Agent id, or `key:<thumbprint>` for registration. */
  scope: string;
  key: string;
  /** Identifies the request (method, path, body digest) to catch key reuse across requests. */
  requestHash: string;
  ttlMs: number;
  now: number;
}

export function parseIdempotencyKey(value: string | null | undefined): string {
  if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new HiveError(
      400,
      "idempotency_key_required",
      "Every write needs an Idempotency-Key: 8-128 characters from A-Z, a-z, 0-9 and _.:-",
      "Generate a random UUID for this action and send it as the Idempotency-Key header " +
        "(MCP: the idempotency_key argument). Reuse the same key only when retrying the " +
        "same action.",
    );
  }
  return value;
}

/** True when a finished response is stored for this key. Reads only. */
export async function hasStoredResponse(db: Db, scope: string, key: string, now: number) {
  const [row] = await db
    .select({ response: idempotency.response, expiresAt: idempotency.expiresAt })
    .from(idempotency)
    .where(and(eq(idempotency.agentId, scope), eq(idempotency.key, key)));
  return (
    row !== undefined && row.expiresAt > now && (JSON.parse(row.response) as Row).state === "done"
  );
}

export async function withIdempotency(
  db: Db,
  args: IdempotencyArgs,
  run: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const where = and(eq(idempotency.agentId, args.scope), eq(idempotency.key, args.key));
  const pending: Row = { state: "pending", request_hash: args.requestHash };
  const expiresAt = args.now + args.ttlMs;

  // Reserve the key. An expired row for the same key is taken over.
  const reserved = await db
    .insert(idempotency)
    .values({
      agentId: args.scope,
      key: args.key,
      response: JSON.stringify(pending),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [idempotency.agentId, idempotency.key],
      set: { response: sql`excluded.response`, expiresAt: sql`excluded.expires_at` },
      setWhere: lte(idempotency.expiresAt, args.now),
    })
    .returning({ key: idempotency.key });

  if (reserved.length === 0) {
    const [existing] = await db
      .select({ response: idempotency.response })
      .from(idempotency)
      .where(where);
    const row = existing ? (JSON.parse(existing.response) as Row) : null;
    if (!row || row.state === "pending") {
      throw new HiveError(
        409,
        "idempotency_in_progress",
        "A request with this Idempotency-Key is still being processed.",
        "Wait a second, then retry with the same Idempotency-Key and a fresh signature.",
        { "Retry-After": "1" },
      );
    }
    if (row.request_hash !== args.requestHash) {
      throw new HiveError(
        422,
        "idempotency_key_reused",
        "This Idempotency-Key was already used for a different request.",
        "Use a new Idempotency-Key for a new action. Reuse a key only to retry the identical " +
          "method, path and body.",
      );
    }
    return { status: row.status ?? 200, body: row.body, replayed: true };
  }

  try {
    const result = await run();
    const done: Row = { state: "done", request_hash: args.requestHash, ...result };
    await db
      .update(idempotency)
      .set({ response: JSON.stringify(done) })
      .where(where);
    return { ...result, replayed: false };
  } catch (error) {
    // Failures are not remembered: release the key so a corrected retry can run.
    await db.delete(idempotency).where(where);
    throw error;
  }
}
