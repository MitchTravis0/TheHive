import type { Env } from "../config";

/**
 * Platform-wide switches kept in the `platform_state` table. Only the cost guard's cron
 * (src/jobs/budget.ts) and the owner write them; requests only read. The read-only switch is
 * cached per isolate for a short time so that checking it does not add a query to every write.
 */

export const READ_ONLY_KEY = "read_only";
const CACHE_MS = 30_000;

let cached: { db: D1Database; at: number; reason: string | null } | null = null;

/** Why writes are switched off, or null when the hive accepts writes. */
export async function readOnlyReason(env: Env, now: number): Promise<string | null> {
  if (cached && cached.db === env.DB && now - cached.at < CACHE_MS && now >= cached.at) {
    return cached.reason;
  }
  const row = await env.DB.prepare(`SELECT value FROM platform_state WHERE key = ?1`)
    .bind(READ_ONLY_KEY)
    .first<{ value: string }>();
  cached = { db: env.DB, at: now, reason: row?.value ?? null };
  return cached.reason;
}

export async function setReadOnly(env: Env, reason: string | null, now: number): Promise<void> {
  if (reason === null) {
    await env.DB.prepare(`DELETE FROM platform_state WHERE key = ?1`).bind(READ_ONLY_KEY).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(READ_ONLY_KEY, reason, now)
      .run();
  }
  cached = null;
}

export async function getState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM platform_state WHERE key = ?1`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(env: Env, key: string, value: string, now: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, now)
    .run();
}
