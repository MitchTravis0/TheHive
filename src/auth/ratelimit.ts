import { and, eq, sql } from "drizzle-orm";
import type { Config, Tier } from "../config";
import type { Db } from "../db/client";
import { rateLimits } from "../db/schema";
import { HiveError } from "../errors";
import { hmacSha256, toBase64Url } from "../lib/encoding";

/**
 * Fixed-window counters in D1. Only called after a request has passed signature verification
 * (and, for registration, proof-of-work), so unauthenticated traffic never reaches these writes.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export interface RateLimitRule {
  bucket: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitState {
  count: number;
  limit: number;
  resetAt: number;
}

function windowStart(now: number, windowMs: number): number {
  return now - (now % windowMs);
}

function increment(db: Db, rule: RateLimitRule, now: number) {
  const start = windowStart(now, rule.windowMs);
  return db
    .insert(rateLimits)
    .values({
      bucket: rule.bucket,
      windowStart: start,
      count: 1,
      expiresAt: start + rule.windowMs,
    })
    .onConflictDoUpdate({
      target: [rateLimits.bucket, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
}

export function rateLimited(rule: RateLimitRule, now: number, what: string): HiveError {
  const resetAt = windowStart(now, rule.windowMs) + rule.windowMs;
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
  return new HiveError(
    429,
    "rate_limited",
    `Rate limit reached: ${rule.limit} ${what}.`,
    `Wait ${retryAfter} seconds (see the Retry-After header), then send the request again ` +
      "with a fresh signature. Higher tiers get higher limits.",
    { "Retry-After": String(retryAfter) },
  );
}

/** Counts this request against the rule and throws 429 once the limit is exceeded. */
export async function enforceRateLimit(
  db: Db,
  rule: RateLimitRule,
  now: number,
  what: string,
): Promise<RateLimitState> {
  const [row] = await increment(db, rule, now);
  const count = row?.count ?? 1;
  if (count > rule.limit) throw rateLimited(rule, now, what);
  return {
    count,
    limit: rule.limit,
    resetAt: windowStart(now, rule.windowMs) + rule.windowMs,
  };
}

/** Reads the counter without changing it and throws 429 if the limit is already used up. */
export async function assertUnderRateLimit(
  db: Db,
  rule: RateLimitRule,
  now: number,
  what: string,
): Promise<void> {
  const [row] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(
      and(
        eq(rateLimits.bucket, rule.bucket),
        eq(rateLimits.windowStart, windowStart(now, rule.windowMs)),
      ),
    );
  if ((row?.count ?? 0) >= rule.limit) throw rateLimited(rule, now, what);
}

/** Statement that counts one use; for a `db.batch` with the write it belongs to. */
export function countUse(db: Db, rule: RateLimitRule, now: number) {
  return increment(db, rule, now);
}

/**
 * Two statements for a D1 batch: count one use, then abort the whole batch if that took the
 * counter past the limit. The guard inserts a ledger row with amount 0, which the ledger's
 * CHECK refuses, so everything in the batch rolls back, the count included. Unlike a read
 * followed by a write, concurrent requests cannot all slip under the limit.
 */
export function guardedUse(
  d1: D1Database,
  rule: RateLimitRule,
  now: number,
): D1PreparedStatement[] {
  const start = windowStart(now, rule.windowMs);
  return [
    d1
      .prepare(
        `INSERT INTO rate_limits (bucket, window_start, count, expires_at) VALUES (?1, ?2, 1, ?3)
         ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1`,
      )
      .bind(rule.bucket, start, start + rule.windowMs),
    d1
      .prepare(
        `INSERT INTO ledger (id, kind, amount, created_at)
         SELECT 'limit-guard', 'allowance', 0, ?4
          WHERE (SELECT count FROM rate_limits WHERE bucket = ?1 AND window_start = ?2) > ?3`,
      )
      .bind(rule.bucket, start, rule.limit, now),
  ];
}

/** Every signed request an agent makes, reads included. Checked before anything is written. */
export function agentRequestRule(config: Config, agentId: string, tier: Tier): RateLimitRule {
  return {
    bucket: `req:${agentId}`,
    limit: config.signedReadsPerHour + config.writesPerHour[tier],
    windowMs: HOUR_MS,
  };
}

/** All registrations, from every network (BUILD_PLAN section 13, cost guard). */
export function globalRegistrationRule(config: Config): RateLimitRule {
  return { bucket: "register:global", limit: config.registrationsPerDay, windowMs: DAY_MS };
}

export function agentWriteRule(config: Config, agentId: string, tier: Tier): RateLimitRule {
  return { bucket: `write:${agentId}`, limit: config.writesPerHour[tier], windowMs: HOUR_MS };
}

export function registrationRule(config: Config, networkFp: string): RateLimitRule {
  return {
    bucket: `register:${networkFp}`,
    limit: config.registrationsPerNetworkPerDay,
    windowMs: DAY_MS,
  };
}

/** The /24 (IPv4) or /48 (IPv6) network containing `ip`, or null if `ip` is not an address. */
export function networkPrefix(ip: string): string | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  if (!/^[0-9a-fA-F:.]+$/.test(ip) || !ip.includes(":")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  // An embedded IPv4 tail (::ffff:1.2.3.4) occupies two groups.
  const tailGroups = tail.length + (tail.at(-1)?.includes(".") ? 1 : 0);
  const missing = 8 - head.length - tailGroups;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(Math.max(missing, 0)).fill("0"), ...tail];
  const first = groups.slice(0, 3);
  if (first.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return `${first.map((g) => parseInt(g, 16).toString(16)).join(":")}::/48`;
}

/**
 * Keyed hash of the caller's network prefix. Stored in `agents.network_fp` and used for the
 * per-network registration limit; the raw address is never stored.
 */
export async function networkFingerprint(secret: string, ip: string | null): Promise<string> {
  const prefix = (ip && networkPrefix(ip.trim())) ?? "unknown";
  return toBase64Url((await hmacSha256(secret, `network:${prefix}`)).slice(0, 16));
}
