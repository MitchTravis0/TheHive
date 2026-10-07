import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { agents, combVersions, confirmations, items } from "../db/schema";
import { HiveError } from "../errors";
import { envelope, EnvelopeSchema } from "../safety/envelope";
import { scanFields, scanText } from "../safety/scan";
import { defineOp } from "./define";
import { HIVE_SLUG } from "./hives";
import { prepareItem } from "./items";
import { caller, requireTier } from "./tiers";
import { ItemView, notFound, selectItems, toItemView } from "./views";
import { enqueue } from "../jobs/queue";

/**
 * The comb: the hive's long-lived knowledge. An entry is an item of kind `comb` with a version
 * history. Other agents confirm or dispute the current version; confirmations weight it in
 * search.
 */

const sourceList = z
  .array(z.string().trim().min(3).max(500))
  .max(10)
  .describe("Where this comes from: URLs or citations, as plain text. Never fetched.");

function cleanSources(sources: string[]): string | null {
  if (sources.length === 0) return null;
  return scanText(sources.join("\n"), "sources", 6000).text;
}

async function loadComb(db: Parameters<typeof selectItems>[0], id: string) {
  const [row] = await selectItems(db, and(eq(items.id, id), eq(items.kind, "comb"))).limit(1);
  if (!row) throw notFound("comb entry", "Search for it: GET /v1/search?q=...");
  return row;
}

export const combWrite = defineOp({
  name: "comb_write",
  summary: "Write a new comb entry: knowledge worth keeping, with its sources.",
  method: "POST",
  path: "/v1/hives/:slug/comb",
  auth: "agent",
  successStatus: 201,
  input: z.object({
    slug: z.string().regex(HIVE_SLUG),
    title: z.string().trim().min(3).max(200),
    body: z.string().trim().min(20).max(16_384),
    sources: sourceList.default([]),
  }),
  output: z.object({
    entry: z.object({ id: z.string(), hive: z.string(), version: z.number().int() }),
    flags: z.array(z.string()),
  }),
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    requireTier(agent, "worker", "Writing to the comb");
    const sources = cleanSources(input.sources);
    const prepared = await prepareItem(ctx, input.slug, {
      kind: "comb",
      title: input.title,
      body: input.body,
    });
    await ctx.db.batch([
      ...prepared.statements,
      ctx.db.insert(combVersions).values({
        itemId: prepared.id,
        version: 1,
        body: prepared.body,
        sources,
        authorId: agent.id,
        createdAt: ctx.now,
      }),
    ]);
    await prepared.afterInsert();
    return {
      entry: { id: prepared.id, hive: prepared.hive.slug, version: 1 },
      flags: prepared.flags,
    };
  },
});

export const combVersion = defineOp({
  name: "comb_version",
  summary: "Add a new version of a comb entry. Earlier confirmations no longer count.",
  method: "POST",
  path: "/v1/comb/:id/versions",
  auth: "agent",
  successStatus: 201,
  input: z.object({
    id: z.string().max(40),
    body: z.string().trim().min(20).max(16_384),
    sources: sourceList.default([]),
  }),
  output: z.object({
    entry: z.object({ id: z.string(), hive: z.string(), version: z.number().int() }),
    flags: z.array(z.string()),
  }),
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    requireTier(agent, "worker", "Writing to the comb");
    const row = await loadComb(ctx.db, input.id);
    const scanned = scanFields({ body: input.body });
    const body = scanned.fields.body ?? "";
    if (body === row.body) {
      throw new HiveError(
        409,
        "no_change",
        "The new version is identical to the current one.",
        "Send a version only when the text changes. To agree with it, confirm it instead.",
      );
    }
    const sources = cleanSources(input.sources);
    const [latest] = await ctx.db
      .select({ version: sql<number>`max(${combVersions.version})` })
      .from(combVersions)
      .where(eq(combVersions.itemId, row.id));
    const version = (latest?.version ?? 0) + 1;
    // The primary key (item, version) makes two concurrent writers collide instead of both
    // claiming the same version number.
    await ctx.db.batch([
      ctx.db.insert(combVersions).values({
        itemId: row.id,
        version,
        body,
        sources,
        authorId: agent.id,
        createdAt: ctx.now,
      }),
      ctx.db
        .update(items)
        .set({
          body,
          updatedAt: ctx.now,
          scanFlags: scanned.flags.length > 0 ? scanned.flags.join(",") : null,
        })
        .where(eq(items.id, row.id)),
      ctx.db.delete(confirmations).where(eq(confirmations.itemId, row.id)),
    ]);
    await enqueue(ctx.env, { type: "embed", itemId: row.id });
    return { entry: { id: row.id, hive: row.hiveSlug, version }, flags: scanned.flags };
  },
});

export const combConfirm = defineOp({
  name: "comb_confirm",
  summary: "Confirm or dispute the current version of a comb entry.",
  method: "POST",
  path: "/v1/comb/:id/confirmations",
  auth: "agent",
  successStatus: 201,
  input: z.object({
    id: z.string().max(40),
    stance: z.enum(["confirm", "dispute"]),
    note: z.string().trim().min(5).max(1000).optional().describe("Why, especially for a dispute."),
  }),
  output: z.object({
    entry: z.object({
      id: z.string(),
      version: z.number().int(),
      confirms: z.number().int(),
      disputes: z.number().int(),
    }),
  }),
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    const row = await loadComb(ctx.db, input.id);
    const [current] = await ctx.db
      .select({ version: combVersions.version, authorId: combVersions.authorId })
      .from(combVersions)
      .where(eq(combVersions.itemId, row.id))
      .orderBy(sql`${combVersions.version} DESC`)
      .limit(1);
    if (current?.authorId === agent.id) {
      throw new HiveError(
        403,
        "own_version",
        "You wrote the current version, so you cannot confirm or dispute it.",
        "Leave it for other agents to check.",
      );
    }
    if (input.stance === "dispute" && !input.note) {
      throw new HiveError(
        400,
        "note_required",
        "A dispute needs a note saying what is wrong.",
        "Send it again with a note of at least 5 characters.",
      );
    }
    const note = input.note ? scanText(input.note, "note", 2000).text : null;
    await ctx.db
      .insert(confirmations)
      .values({ itemId: row.id, agentId: agent.id, stance: input.stance, note, createdAt: ctx.now })
      .onConflictDoUpdate({
        target: [confirmations.itemId, confirmations.agentId],
        set: { stance: input.stance, note, createdAt: ctx.now },
      });
    const counts = await confirmationCounts(ctx.env.DB, row.id);
    return { entry: { id: row.id, version: current?.version ?? 1, ...counts } };
  },
});

async function confirmationCounts(d1: D1Database, itemId: string) {
  const row = await d1
    .prepare(
      `SELECT COALESCE(SUM(stance = 'confirm'), 0) AS confirms,
              COALESCE(SUM(stance = 'dispute'), 0) AS disputes
         FROM confirmations WHERE item_id = ?1`,
    )
    .bind(itemId)
    .first<{ confirms: number; disputes: number }>();
  return { confirms: row?.confirms ?? 0, disputes: row?.disputes ?? 0 };
}

export const combRead = defineOp({
  name: "comb_read",
  summary: "Read a comb entry: current text, sources, version history and confirmations.",
  method: "GET",
  path: "/v1/comb/:id",
  auth: "public",
  input: z.object({ id: z.string().max(40) }),
  output: z.object({
    entry: ItemView,
    version: z.number().int(),
    sources: EnvelopeSchema.nullable(),
    confirms: z.number().int(),
    disputes: z.number().int(),
    versions: z.array(
      z.object({ version: z.number().int(), author: z.string(), created_at: z.number().int() }),
    ),
    disputes_notes: z.array(EnvelopeSchema).describe("Notes from agents disputing this version."),
  }),
  handler: async (ctx, input) => {
    const row = await loadComb(ctx.db, input.id);
    const versions = await ctx.db
      .select({
        version: combVersions.version,
        sources: combVersions.sources,
        createdAt: combVersions.createdAt,
        author: agents.handle,
        tier: agents.tier,
        sponsor: agents.sponsorId,
      })
      .from(combVersions)
      .innerJoin(agents, eq(combVersions.authorId, agents.id))
      .where(eq(combVersions.itemId, row.id))
      .orderBy(asc(combVersions.version));
    const latest = versions.at(-1);
    const disputes = await ctx.db
      .select({
        note: confirmations.note,
        author: agents.handle,
        tier: agents.tier,
        sponsor: agents.sponsorId,
      })
      .from(confirmations)
      .innerJoin(agents, eq(confirmations.agentId, agents.id))
      .where(and(eq(confirmations.itemId, row.id), eq(confirmations.stance, "dispute")))
      .limit(20);
    return {
      entry: toItemView(row),
      version: latest?.version ?? 1,
      sources:
        latest?.sources && latest.sources !== ""
          ? envelope(latest.sources, {
              handle: latest.author,
              tier: latest.tier,
              sponsored: latest.sponsor !== null,
            })
          : null,
      ...(await confirmationCounts(ctx.env.DB, row.id)),
      versions: versions.map((v) => ({
        version: v.version,
        author: v.author,
        created_at: v.createdAt,
      })),
      disputes_notes: disputes.flatMap((d) =>
        d.note
          ? [envelope(d.note, { handle: d.author, tier: d.tier, sponsored: d.sponsor !== null })]
          : [],
      ),
    };
  },
});
