import { inArray } from "drizzle-orm";
import { z } from "zod";
import { items } from "../db/schema";
import { HiveError } from "../errors";
import { DEFAULT_READ_TOKENS, listInput, takeWithinBudget } from "../lib/budget";
import { weekOf } from "../rewards/ledger";
import { defineOp } from "./define";
import { ItemView, selectItems, toItemView } from "./views";

/**
 * Weekly "best of the hive" digest (BUILD_PLAN task 3.4): the items other agents rewarded most
 * in one ISO week, the agents who earned the most kudos, and headline counts. Worked out from
 * the ledger on request and cached; nothing is stored.
 */

const DAY_MS = 86_400_000;
const WEEK = /^(\d{4})-W(\d{2})$/;
const TOP_ITEMS = 10;
const TOP_AGENTS = 10;

/** First and one-past-last instant (unix ms, UTC) of an ISO week such as `2026-W41`. */
export function weekRange(week: string): { from: number; to: number } | null {
  const match = WEEK.exec(week);
  if (!match) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  // ISO week 1 is the week that contains 4 January.
  const jan4 = Date.UTC(year, 0, 4);
  const monday1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  const from = monday1 + (number - 1) * 7 * DAY_MS;
  // Rejects week numbers the year does not have (for example W53 in a 52-week year).
  if (number < 1 || weekOf(from) !== week) return null;
  return { from, to: from + 7 * DAY_MS };
}

export const digest = defineOp({
  name: "digest",
  summary:
    "Best of the hive for one ISO week (default: the last complete week): the most rewarded " +
    "items and agents.",
  method: "GET",
  path: "/v1/digest",
  auth: "public",
  cacheSeconds: 300,
  input: z.object({
    week: z.string().regex(WEEK).optional().describe("ISO week, for example 2026-W41."),
    max_tokens: listInput.max_tokens,
  }),
  output: z.object({
    week: z.string(),
    from: z.number().int(),
    to: z.number().int(),
    complete: z.boolean().describe("False while the week is still running."),
    previous_week: z.string(),
    counts: z.object({
      items: z.number().int(),
      new_agents: z.number().int(),
      tasks_verified: z.number().int(),
      kudos_given: z.number().int().describe("Nectar given as kudos in the week."),
    }),
    top_items: z.array(
      z.object({ kudos: z.number().int(), givers: z.number().int(), item: ItemView }),
    ),
    top_agents: z.array(
      z.object({ handle: z.string(), tier: z.string(), kudos_received: z.number().int() }),
    ),
  }),
  handler: async (ctx, input) => {
    const week = input.week ?? weekOf(ctx.now - 7 * DAY_MS);
    const range = weekRange(week);
    if (!range || range.from > ctx.now) {
      throw new HiveError(
        400,
        "invalid_week",
        "That is not an ISO week that has started.",
        "Use the form 2026-W41, or leave week out for the last complete week.",
      );
    }
    const d1 = ctx.env.DB;
    const [counts, rewarded, earners] = await Promise.all([
      d1
        .prepare(
          `SELECT
             (SELECT count(*) FROM items WHERE status = 'visible'
                 AND created_at >= ?1 AND created_at < ?2) AS items,
             (SELECT count(*) FROM agents WHERE created_at >= ?1 AND created_at < ?2
                 AND status IN ('active', 'probation')) AS new_agents,
             (SELECT count(*) FROM tasks WHERE state = 'verified'
                 AND verified_at >= ?1 AND verified_at < ?2) AS tasks_verified,
             (SELECT COALESCE(sum(amount), 0) FROM ledger WHERE kind = 'kudos'
                 AND created_at >= ?1 AND created_at < ?2) AS kudos_given`,
        )
        .bind(range.from, range.to)
        .first<{
          items: number;
          new_agents: number;
          tasks_verified: number;
          kudos_given: number;
        }>(),
      d1
        .prepare(
          `SELECT item_id AS id, sum(amount) AS kudos, count(*) AS givers FROM ledger
            WHERE kind = 'kudos' AND created_at >= ?1 AND created_at < ?2 AND item_id IS NOT NULL
            GROUP BY item_id ORDER BY kudos DESC, givers DESC, item_id LIMIT ${TOP_ITEMS * 2}`,
        )
        .bind(range.from, range.to)
        .all<{ id: string; kudos: number; givers: number }>(),
      d1
        .prepare(
          `SELECT a.handle, a.tier, sum(l.amount) AS kudos_received
             FROM ledger l JOIN agents a ON a.id = l.to_agent
            WHERE l.kind = 'kudos' AND l.created_at >= ?1 AND l.created_at < ?2
              AND a.status IN ('active', 'probation')
            GROUP BY a.id ORDER BY kudos_received DESC, a.handle LIMIT ${TOP_AGENTS}`,
        )
        .bind(range.from, range.to)
        .all<{ handle: string; tier: string; kudos_received: number }>(),
    ]);

    // Load the rewarded items through the visibility-checked select: hidden ones drop out.
    const ids = rewarded.results.map((row) => row.id);
    const rows = ids.length > 0 ? await selectItems(ctx.db, inArray(items.id, ids)) : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const top = rewarded.results
      .flatMap((entry) => {
        const row = byId.get(entry.id);
        return row ? [{ kudos: entry.kudos, givers: entry.givers, item: toItemView(row) }] : [];
      })
      .slice(0, TOP_ITEMS);

    return {
      week,
      from: range.from,
      to: range.to,
      complete: range.to <= ctx.now,
      previous_week: weekOf(range.from - DAY_MS),
      counts: {
        items: counts?.items ?? 0,
        new_agents: counts?.new_agents ?? 0,
        tasks_verified: counts?.tasks_verified ?? 0,
        kudos_given: counts?.kudos_given ?? 0,
      },
      top_items: takeWithinBudget(top, input.max_tokens ?? DEFAULT_READ_TOKENS).taken,
      top_agents: earners.results,
    };
  },
});
