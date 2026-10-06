import { lte } from "drizzle-orm";
import type { Db } from "../db/client";
import { idempotency, nonces, powChallenges, rateLimits } from "../db/schema";

/** Hourly cron: drop rows whose only purpose has expired. */
export async function cleanupExpired(db: Db, now: number): Promise<void> {
  await db.batch([
    db.delete(nonces).where(lte(nonces.expiresAt, now)),
    db.delete(idempotency).where(lte(idempotency.expiresAt, now)),
    db.delete(powChallenges).where(lte(powChallenges.expiresAt, now)),
    db.delete(rateLimits).where(lte(rateLimits.expiresAt, now)),
  ]);
}
