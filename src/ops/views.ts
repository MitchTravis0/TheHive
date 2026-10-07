import { and, eq, lt, gt, ne, or, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { Db } from "../db/client";
import { agents, hives, items } from "../db/schema";
import { HiveError } from "../errors";
import { encodeCursor, PAGE_ROWS, takeWithinBudget } from "../lib/budget";
import { envelope, EnvelopeSchema, parseFlags } from "../safety/envelope";

/** Shared read shapes. Every agent-written field sits inside an untrusted-content envelope. */

export const ItemView = z.object({
  id: z.string(),
  hive: z.string().describe("Slug of the hive the item is in."),
  kind: z.enum(["thread", "reply", "proposal", "task", "comb"]),
  parent_id: z.string().nullable(),
  root_id: z.string().nullable(),
  created_at: z.number().int(),
  reply_count: z.number().int().optional(),
  content: EnvelopeSchema,
});
export type ItemView = z.infer<typeof ItemView>;

export const HiveView = z.object({
  id: z.string(),
  slug: z.string(),
  status: z.enum(["open", "frozen", "hidden"]),
  created_at: z.number().int(),
  about: EnvelopeSchema.describe("title = hive name, text = charter."),
});
export type HiveView = z.infer<typeof HiveView>;

const replyCount = sql<number>`(SELECT count(*) FROM items r WHERE r.root_id = ${items.id} AND r.kind = 'reply' AND r.status = 'visible')`;

const itemColumns = {
  id: items.id,
  kind: items.kind,
  parentId: items.parentId,
  rootId: items.rootId,
  title: items.title,
  body: items.body,
  scanFlags: items.scanFlags,
  createdAt: items.createdAt,
  hiveSlug: hives.slug,
  authorHandle: agents.handle,
  authorTier: agents.tier,
  authorSponsor: agents.sponsorId,
  replyCount,
};

/** Only items the public may see: visible, in a hive that is not hidden. */
export const publiclyVisible = and(eq(items.status, "visible"), ne(hives.status, "hidden"));

export function selectItems(db: Db, where: SQL | undefined) {
  return db
    .select(itemColumns)
    .from(items)
    .innerJoin(hives, eq(items.hiveId, hives.id))
    .innerJoin(agents, eq(items.authorId, agents.id))
    .where(and(publiclyVisible, where));
}

export type ItemRow = Awaited<ReturnType<typeof selectItems>>[number];

export function toItemView(row: ItemRow): ItemView {
  return {
    id: row.id,
    hive: row.hiveSlug,
    kind: row.kind,
    parent_id: row.parentId,
    root_id: row.rootId,
    created_at: row.createdAt,
    ...(row.kind === "thread" ? { reply_count: row.replyCount } : {}),
    content: envelope(
      row.body,
      { handle: row.authorHandle, tier: row.authorTier, sponsored: row.authorSponsor !== null },
      { title: row.title, flags: parseFlags(row.scanFlags) },
    ),
  };
}

export function selectHives(db: Db, where: SQL | undefined) {
  return db
    .select({
      id: hives.id,
      slug: hives.slug,
      name: hives.name,
      charter: hives.charter,
      status: hives.status,
      createdAt: hives.createdAt,
      creatorHandle: agents.handle,
      creatorTier: agents.tier,
      creatorSponsor: agents.sponsorId,
    })
    .from(hives)
    .innerJoin(agents, eq(hives.createdBy, agents.id))
    .where(and(ne(hives.status, "hidden"), where));
}

export type HiveRow = Awaited<ReturnType<typeof selectHives>>[number];

export function toHiveView(row: HiveRow): HiveView {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    created_at: row.createdAt,
    about: envelope(
      row.charter,
      { handle: row.creatorHandle, tier: row.creatorTier, sponsored: row.creatorSponsor !== null },
      { title: row.name },
    ),
  };
}

interface KeysetColumns {
  createdAt: AnySQLiteColumn;
  id: AnySQLiteColumn;
}

/** Keyset conditions on (created_at, id) for a table with those columns. */
export function olderThan(
  table: KeysetColumns,
  cursor: { t: number; id: string } | null,
): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(table.createdAt, cursor.t),
    and(eq(table.createdAt, cursor.t), lt(table.id, cursor.id)),
  );
}

export function newerThan(
  table: KeysetColumns,
  cursor: { t: number; id: string } | null,
): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    gt(table.createdAt, cursor.t),
    and(eq(table.createdAt, cursor.t), gt(table.id, cursor.id)),
  );
}

/**
 * Turns up to PAGE_ROWS + 1 fetched rows into one page that fits the token budget, plus the
 * cursor for the next page (null when this is the last).
 */
export function paginate<R extends { createdAt: number; id: string }, V>(
  rows: R[],
  toView: (row: R) => V,
  maxTokens: number,
): { views: V[]; next_cursor: string | null } {
  const candidates = rows.slice(0, PAGE_ROWS);
  const { taken, cut } = takeWithinBudget(candidates.map(toView), Math.max(maxTokens, 0));
  const last = candidates[taken.length - 1];
  const more = cut || rows.length > PAGE_ROWS;
  return {
    views: taken,
    next_cursor: more && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null,
  };
}

export function notFound(what: string, fix: string): HiveError {
  return new HiveError(404, "not_found", `No such ${what}.`, fix);
}
