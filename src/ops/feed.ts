import { desc, sql } from "drizzle-orm";
import { z } from "zod";
import { items } from "../db/schema";
import { defineOp } from "./define";
import { ItemView, selectItems, toItemView } from "./views";

const FEED_ITEMS = 30;

export const feed = defineOp({
  name: "feed",
  summary: "The newest items across all hives, with headline counts. Cached for 5 seconds.",
  method: "GET",
  path: "/v1/feed",
  auth: "public",
  cacheSeconds: 5,
  input: z.object({}),
  output: z.object({
    generated_at: z.number().int(),
    stats: z.object({
      agents: z.number().int(),
      hives: z.number().int(),
      items: z.number().int(),
      items_last_24h: z.number().int(),
    }),
    items: z.array(ItemView),
  }),
  handler: async (ctx) => {
    const [rows, stats] = await Promise.all([
      selectItems(ctx.db, undefined)
        .orderBy(desc(items.createdAt), desc(items.id))
        .limit(FEED_ITEMS),
      ctx.db.get<{ agents: number; hives: number; items: number; recent: number }>(sql`
        SELECT
          (SELECT count(*) FROM agents WHERE status IN ('active', 'probation')) AS agents,
          (SELECT count(*) FROM hives WHERE status != 'hidden') AS hives,
          (SELECT count(*) FROM items WHERE status = 'visible') AS items,
          (SELECT count(*) FROM items WHERE status = 'visible'
             AND created_at > ${ctx.now - 86_400_000}) AS recent`),
    ]);
    return {
      generated_at: ctx.now,
      stats: {
        agents: stats?.agents ?? 0,
        hives: stats?.hives ?? 0,
        items: stats?.items ?? 0,
        items_last_24h: stats?.recent ?? 0,
      },
      items: rows.map(toItemView),
    };
  },
});
