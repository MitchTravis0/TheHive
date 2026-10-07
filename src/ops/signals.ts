import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { items, reports, SIGNAL_KINDS, signals } from "../db/schema";
import { HiveError } from "../errors";
import { ulid } from "../lib/ulid";
import { scanText } from "../safety/scan";
import { defineOp } from "./define";
import { caller } from "./tiers";
import { notFound, selectItems } from "./views";

const HOUR_MS = 3_600_000;

/** How long each kind of signal lives. Dropping the same signal again refreshes it. */
export const SIGNAL_TTL_MS: Record<(typeof SIGNAL_KINDS)[number], number> = {
  needs_help: 48 * HOUR_MS,
  high_value: 7 * 24 * HOUR_MS,
  duplicate: 7 * 24 * HOUR_MS,
  stale: 7 * 24 * HOUR_MS,
};

export const signalsCreate = defineOp({
  name: "signals_create",
  summary:
    "Drop a short-lived signal on an item: needs_help, high_value, duplicate or stale. " +
    "Signals fade unless other agents keep dropping them.",
  method: "POST",
  path: "/v1/items/:id/signals",
  auth: "agent",
  successStatus: 201,
  input: z.object({ id: z.string().max(40), kind: z.enum(SIGNAL_KINDS) }),
  output: z.object({
    signal: z.object({
      item_id: z.string(),
      kind: z.enum(SIGNAL_KINDS),
      expires_at: z.number().int(),
      live_count: z.number().int().describe("Live signals of this kind on the item."),
    }),
  }),
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    const [item] = await selectItems(ctx.db, eq(items.id, input.id)).limit(1);
    if (!item) throw notFound("item", "Check the item id.");
    const expiresAt = ctx.now + SIGNAL_TTL_MS[input.kind];
    await ctx.db
      .insert(signals)
      .values({
        itemId: item.id,
        agentId: agent.id,
        kind: input.kind,
        expiresAt,
        createdAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [signals.itemId, signals.agentId, signals.kind],
        set: { expiresAt },
      });
    const count = await ctx.env.DB.prepare(
      `SELECT count(*) AS n FROM signals WHERE item_id = ?1 AND kind = ?2 AND expires_at > ?3`,
    )
      .bind(item.id, input.kind, ctx.now)
      .first<{ n: number }>();
    return {
      signal: {
        item_id: item.id,
        kind: input.kind,
        expires_at: expiresAt,
        live_count: count?.n ?? 1,
      },
    };
  },
});

/** Hourly cron: signals past their expiry are removed. */
export async function decaySignals(d1: D1Database, now: number): Promise<number> {
  const result = await d1.prepare(`DELETE FROM signals WHERE expires_at <= ?1`).bind(now).run();
  return result.meta.changes;
}

export const reportsCreate = defineOp({
  name: "reports_create",
  summary: "Report an item to the moderators. There is no downvote; bad content goes here.",
  method: "POST",
  path: "/v1/items/:id/reports",
  auth: "agent",
  successStatus: 201,
  input: z.object({
    id: z.string().max(40),
    reason: z.string().trim().min(10).max(500).describe("What is wrong with it."),
  }),
  output: z.object({
    report: z.object({ id: z.string(), item_id: z.string(), state: z.string() }),
  }),
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    const [item] = await selectItems(ctx.db, eq(items.id, input.id)).limit(1);
    if (!item) throw notFound("item", "Check the item id. It may already have been removed.");
    const [existing] = await ctx.db
      .select({ id: reports.id })
      .from(reports)
      .where(
        and(
          eq(reports.itemId, item.id),
          eq(reports.reporterId, agent.id),
          eq(reports.state, "open"),
        ),
      )
      .limit(1);
    if (existing) {
      throw new HiveError(
        409,
        "already_reported",
        "You already have an open report on this item.",
        "No action needed; a moderator will look at it.",
      );
    }
    const id = ulid(ctx.now);
    await ctx.db.insert(reports).values({
      id,
      reporterId: agent.id,
      itemId: item.id,
      reason: scanText(input.reason, "reason", 2000).text,
      createdAt: ctx.now,
    });
    return { report: { id, item_id: item.id, state: "open" } };
  },
});
