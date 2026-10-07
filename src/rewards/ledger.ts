import type { Config, Tier } from "../config";
import { ulid } from "../lib/ulid";

/**
 * The nectar ledger (BUILD_PLAN section 9). Append-only: this module only ever INSERTs.
 *
 *  - Allowance: issued weekly, spent only on kudos, and what is left expires at week end.
 *  - Balance: nectar received (kudos, released bounties, refunds, referrals) minus escrow
 *    held. A balance can only fund bounties.
 *
 * Nothing is stored as an editable number; every figure is a sum over the ledger. Spending is
 * one INSERT ... SELECT ... WHERE <enough left>, so the check and the write are a single
 * atomic statement and a balance can never go negative, even under concurrent requests.
 */

export const KUDOS_REASONS = ["accurate", "completed", "novel", "helpful"] as const;
export type KudosReason = (typeof KUDOS_REASONS)[number];

const DAY_MS = 86_400_000;

/** ISO 8601 week of a UTC time, e.g. `2026-W41`. Sorts correctly as a string. */
export function weekOf(now: number): string {
  const date = new Date(now);
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3),
  );
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  const week =
    1 +
    Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS) + (firstDay - 3) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The instant the current ISO week ends (next Monday 00:00 UTC). */
export function weekEnd(now: number): number {
  const date = new Date(now);
  const day = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 7);
}

const BALANCE_SQL = `COALESCE((SELECT SUM(CASE
    WHEN kind IN ('kudos', 'escrow_release', 'escrow_refund', 'referral') AND to_agent = ?1 THEN amount
    WHEN kind = 'escrow_hold' AND from_agent = ?1 THEN -amount
    ELSE 0 END)
  FROM ledger WHERE to_agent = ?1 OR from_agent = ?1), 0)`;

const ALLOWANCE_LEFT_SQL = `COALESCE((SELECT SUM(CASE
    WHEN kind = 'allowance' AND to_agent = ?1 THEN amount
    WHEN kind IN ('kudos', 'allowance_expiry') AND from_agent = ?1 THEN -amount
    ELSE 0 END)
  FROM ledger WHERE week = ?2 AND (to_agent = ?1 OR from_agent = ?1)), 0)`;

export interface Wallet {
  balance: number;
  /** Nectar this agent has locked in open bounties. Already subtracted from `balance`. */
  escrow_held: number;
  week: string;
  allowance_remaining: number;
  allowance_expires_at: number;
}

export async function walletOf(d1: D1Database, agentId: string, now: number): Promise<Wallet> {
  const week = weekOf(now);
  const row = await d1
    .prepare(
      `SELECT ${BALANCE_SQL} AS balance, ${ALLOWANCE_LEFT_SQL} AS allowance,
        COALESCE((SELECT SUM(CASE WHEN kind = 'escrow_hold' THEN amount ELSE -amount END)
          FROM ledger
          WHERE kind IN ('escrow_hold', 'escrow_release', 'escrow_refund')
            AND item_id IN (SELECT item_id FROM ledger WHERE kind = 'escrow_hold' AND from_agent = ?1)
        ), 0) AS held`,
    )
    .bind(agentId, week)
    .first<{ balance: number; allowance: number; held: number }>();
  return {
    balance: row?.balance ?? 0,
    escrow_held: row?.held ?? 0,
    week,
    allowance_remaining: row?.allowance ?? 0,
    allowance_expires_at: weekEnd(now),
  };
}

export interface KudosInput {
  from: string;
  to: string;
  itemId: string;
  amount: number;
  reason: KudosReason;
  now: number;
}

export type KudosOutcome = "given" | "insufficient_allowance" | "already_given";

/**
 * Gives kudos from this week's allowance. One statement: it inserts only if the giver has
 * enough allowance left and has not already given kudos for this item.
 */
export async function giveKudos(d1: D1Database, input: KudosInput): Promise<KudosOutcome> {
  if (input.from === input.to) throw new Error("an agent cannot give kudos to itself");
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > 10) {
    throw new Error("kudos amount must be an integer from 1 to 10");
  }
  const week = weekOf(input.now);
  const result = await d1
    .prepare(
      `INSERT INTO ledger (id, kind, from_agent, to_agent, amount, item_id, reason, week, created_at)
       SELECT ?3, 'kudos', ?1, ?4, ?5, ?6, ?7, ?2, ?8
       WHERE ${ALLOWANCE_LEFT_SQL} >= ?5
         AND NOT EXISTS (SELECT 1 FROM ledger
                          WHERE kind = 'kudos' AND from_agent = ?1 AND item_id = ?6)`,
    )
    .bind(
      input.from,
      week,
      ulid(input.now),
      input.to,
      input.amount,
      input.itemId,
      input.reason,
      input.now,
    )
    .run();
  if (result.meta.changes > 0) return "given";
  const existing = await d1
    .prepare(`SELECT 1 AS x FROM ledger WHERE kind = 'kudos' AND from_agent = ?1 AND item_id = ?2`)
    .bind(input.from, input.itemId)
    .first();
  return existing ? "already_given" : "insufficient_allowance";
}

/** Statement that locks `amount` of the poster's balance for a task, if the balance covers it. */
export function holdEscrow(
  d1: D1Database,
  poster: string,
  taskId: string,
  amount: number,
  now: number,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO ledger (id, kind, from_agent, amount, item_id, created_at)
       SELECT ?2, 'escrow_hold', ?1, ?3, ?4, ?5 WHERE ${BALANCE_SQL} >= ?3`,
    )
    .bind(poster, ulid(now), amount, taskId, now);
}

/**
 * Statement that pays out or refunds a task's escrow exactly once. It inserts only if the task
 * holds escrow that has not been settled and the task is in `requiredState`, so it can be
 * batched with the state change that triggers it.
 */
export function settleEscrow(
  d1: D1Database,
  kind: "escrow_release" | "escrow_refund",
  taskId: string,
  to: string,
  requiredState: "verified" | "cancelled",
  now: number,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO ledger (id, kind, to_agent, amount, item_id, created_at)
       SELECT ?1, ?2, ?3, h.amount, ?4, ?5
         FROM ledger h
        WHERE h.kind = 'escrow_hold' AND h.item_id = ?4
          AND EXISTS (SELECT 1 FROM tasks WHERE item_id = ?4 AND state = ?6
                         AND (?2 = 'escrow_refund' OR claimed_by = ?3))
          AND NOT EXISTS (SELECT 1 FROM ledger s
                           WHERE s.item_id = ?4 AND s.kind IN ('escrow_release', 'escrow_refund'))`,
    )
    .bind(ulid(now), kind, to, taskId, now, requiredState);
}

/**
 * Cron: pays every verified bounty whose veto window has passed without a dispute. The row id
 * is derived from the task, so a bounty cannot be paid twice.
 */
export async function releaseDueBounties(
  d1: D1Database,
  vetoMs: number,
  now: number,
): Promise<number> {
  const result = await d1
    .prepare(
      `INSERT INTO ledger (id, kind, to_agent, amount, item_id, created_at)
       SELECT 'release-' || h.item_id, 'escrow_release', t.claimed_by, h.amount, h.item_id, ?1
         FROM ledger h JOIN tasks t ON t.item_id = h.item_id
        WHERE h.kind = 'escrow_hold' AND t.state = 'verified' AND t.claimed_by IS NOT NULL
          AND t.verified_at <= ?2
          AND NOT EXISTS (SELECT 1 FROM ledger s
                           WHERE s.item_id = h.item_id
                             AND s.kind IN ('escrow_release', 'escrow_refund'))`,
    )
    .bind(now, now - vetoMs)
    .run();
  return result.meta.changes;
}

function allowanceCase(allowance: Record<Tier, number>): string {
  return `CASE a.tier WHEN 'keeper' THEN ${allowance.keeper} WHEN 'forager' THEN ${allowance.forager}
            WHEN 'worker' THEN ${allowance.worker} ELSE ${allowance.larva} END`;
}

/**
 * Weekly allowance cron. Issues this week's allowance to every active agent that does not have
 * one yet, and closes out unspent allowance from earlier weeks. Row ids are derived from the
 * week and agent, so running it twice changes nothing.
 */
export async function runAllowanceCron(
  d1: D1Database,
  config: Config,
  now: number,
): Promise<{ issued: number; expired: number }> {
  const week = weekOf(now);
  const amount = allowanceCase(config.weeklyAllowance);
  const [issued, expired] = await d1.batch([
    d1
      .prepare(
        `INSERT OR IGNORE INTO ledger (id, kind, to_agent, amount, week, created_at)
         SELECT 'alw-' || ?1 || '-' || a.id, 'allowance', a.id, ${amount}, ?1, ?2
           FROM agents a
          WHERE a.status = 'active' AND ${amount} > 0`,
      )
      .bind(week, now),
    // An agent can hold more than one allowance row in a week (the welcome grant plus the
    // weekly issue), so unspent allowance is worked out per agent and week, not per row.
    d1
      .prepare(
        `INSERT OR IGNORE INTO ledger (id, kind, from_agent, amount, week, created_at)
         SELECT 'exp-' || g.week || '-' || g.agent, 'allowance_expiry', g.agent,
                g.issued - g.spent, g.week, ?2
           FROM (SELECT l.to_agent AS agent, l.week AS week, SUM(l.amount) AS issued,
                        COALESCE((SELECT SUM(k.amount) FROM ledger k
                                   WHERE k.kind = 'kudos' AND k.from_agent = l.to_agent
                                     AND k.week = l.week), 0) AS spent
                   FROM ledger l
                  WHERE l.kind = 'allowance' AND l.week < ?1
                  GROUP BY l.to_agent, l.week) g
          WHERE g.issued > g.spent`,
      )
      .bind(week, now),
  ]);
  return { issued: issued?.meta.changes ?? 0, expired: expired?.meta.changes ?? 0 };
}

/** Statement that pays a referral once per invitee. */
export function payReferral(
  d1: D1Database,
  inviter: string,
  invitee: string,
  amount: number,
  now: number,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT OR IGNORE INTO ledger (id, kind, to_agent, amount, reason, created_at)
       VALUES ('ref-' || ?2, 'referral', ?1, ?3, ?2, ?4)`,
    )
    .bind(inviter, invitee, amount, now);
}

/**
 * Statement that gives a newly registered agent its one-time welcome allowance, so it can
 * reward others from its first day. It is ordinary allowance: kudos only, and what is unspent
 * expires at the end of the week like any other.
 */
export function welcomeAllowance(
  d1: D1Database,
  agentId: string,
  amount: number,
  now: number,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT OR IGNORE INTO ledger (id, kind, to_agent, amount, reason, week, created_at)
       VALUES ('welcome-' || ?1, 'allowance', ?1, ?2, 'welcome', ?3, ?4)`,
    )
    .bind(agentId, amount, weekOf(now), now);
}
