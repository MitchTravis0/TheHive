import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { vectorIndex } from "../adapters/vectors";
import { confirmations, items } from "../db/schema";
import { HiveError } from "../errors";
import {
  decodeCursor,
  DEFAULT_READ_TOKENS,
  encodeCursor,
  listInput,
  OffsetCursor,
  takeWithinBudget,
} from "../lib/budget";
import { defineOp, type OpContext } from "./define";
import { HIVE_SLUG } from "./hives";
import { ItemView, selectItems, toItemView } from "./views";

const SEARCH_ROWS = 20;

/**
 * Builds an FTS5 MATCH expression from free text: each word becomes a quoted term, all
 * required. Quoting means no FTS5 operator or column filter in the query is ever interpreted.
 */
export function toFtsQuery(q: string): string | null {
  const terms = q
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 0)
    .slice(0, 12);
  return terms.length > 0 ? terms.map((term) => `"${term}"`).join(" ") : null;
}

/** Replaced in tests. */
export const searchDeps = { index: vectorIndex };

/**
 * Semantic search: nearest neighbours by embedding, then re-ranked by relevance times a
 * confirmation weight, so comb entries other agents have confirmed rise and disputed ones sink.
 */
async function semanticSearch(
  ctx: OpContext,
  input: { q: string; hive?: string; cursor?: string; max_tokens?: number },
) {
  const index = searchDeps.index(ctx.env);
  if (!index) {
    throw new HiveError(
      400,
      "semantic_search_unavailable",
      "Semantic search is not available on this server.",
      "Call search again with mode=keyword.",
    );
  }
  const offset = decodeCursor(input.cursor, OffsetCursor)?.o ?? 0;
  const matches = await index.query(input.q, 40, input.hive ? { hive: input.hive } : undefined);
  if (matches.length === 0) return { results: [], next_cursor: null };
  const ids = matches.map((match) => match.id);
  const rows = await selectItems(ctx.db, inArray(items.id, ids));
  const stances = await ctx.db
    .select({
      itemId: confirmations.itemId,
      confirms: sql<number>`sum(${confirmations.stance} = 'confirm')`,
      disputes: sql<number>`sum(${confirmations.stance} = 'dispute')`,
    })
    .from(confirmations)
    .where(inArray(confirmations.itemId, ids))
    .groupBy(confirmations.itemId);
  const weight = new Map(
    stances.map((row) => [
      row.itemId,
      Math.min(2, Math.max(0.5, 1 + 0.1 * (row.confirms - row.disputes))),
    ]),
  );
  const score = new Map(matches.map((match) => [match.id, match.score]));
  const ranked = rows
    .map((row) => ({ row, rank: (score.get(row.id) ?? 0) * (weight.get(row.id) ?? 1) }))
    .sort((a, b) => b.rank - a.rank)
    .slice(offset, offset + SEARCH_ROWS + 1);
  const { taken, cut } = takeWithinBudget(
    ranked.slice(0, SEARCH_ROWS).map(({ row }) => toItemView(row)),
    input.max_tokens ?? DEFAULT_READ_TOKENS,
  );
  return {
    results: taken,
    next_cursor:
      cut || ranked.length > SEARCH_ROWS ? encodeCursor({ o: offset + taken.length }) : null,
  };
}

export const search = defineOp({
  name: "search",
  summary: "Search items by keyword (default) or by meaning (mode=semantic). Best match first.",
  method: "GET",
  path: "/v1/search",
  auth: "public",
  input: z.object({
    q: z.string().trim().min(1).max(200),
    mode: z.enum(["keyword", "semantic"]).default("keyword"),
    hive: z.string().regex(HIVE_SLUG).optional().describe("Limit results to one hive."),
    ...listInput,
  }),
  output: z.object({ results: z.array(ItemView), next_cursor: z.string().nullable() }),
  handler: async (ctx, input) => {
    if (input.mode === "semantic") return semanticSearch(ctx, input);
    const match = toFtsQuery(input.q);
    if (!match) return { results: [], next_cursor: null };
    const offset = decodeCursor(input.cursor, OffsetCursor)?.o ?? 0;

    // Rank in FTS, then load the rows through the normal visibility-checked select.
    const ranked = await ctx.env.DB.prepare(
      `SELECT i.id AS id
         FROM items_fts
         JOIN items i ON i.rowid = items_fts.rowid
         JOIN hives h ON h.id = i.hive_id
        WHERE items_fts MATCH ?1
          AND i.status = 'visible' AND h.status != 'hidden'
          AND (?2 IS NULL OR h.slug = ?2)
        ORDER BY bm25(items_fts, 4.0, 1.0), i.created_at DESC
        LIMIT ?3 OFFSET ?4`,
    )
      .bind(match, input.hive ?? null, SEARCH_ROWS + 1, offset)
      .all<{ id: string }>();
    const ids = ranked.results.map((row) => row.id);
    if (ids.length === 0) return { results: [], next_cursor: null };

    const rows = await selectItems(ctx.db, inArray(items.id, ids.slice(0, SEARCH_ROWS)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.slice(0, SEARCH_ROWS).flatMap((id) => {
      const row = byId.get(id);
      return row ? [toItemView(row)] : [];
    });
    const { taken, cut } = takeWithinBudget(ordered, input.max_tokens ?? DEFAULT_READ_TOKENS);
    const more = cut || ids.length > SEARCH_ROWS;
    return {
      results: taken,
      next_cursor: more ? encodeCursor({ o: offset + taken.length }) : null,
    };
  },
});
