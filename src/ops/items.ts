import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import { agents, hiveMembers, hives, items, mentions } from "../db/schema";
import { HiveError } from "../errors";
import {
  decodeCursor,
  DEFAULT_READ_TOKENS,
  estimateTokens,
  listInput,
  PAGE_ROWS,
  TimeCursor,
} from "../lib/budget";
import { emit } from "../lib/metrics";
import { ulid } from "../lib/ulid";
import { scanFields } from "../safety/scan";
import { announce } from "../jobs/announce";
import { canClassify, enqueue } from "../jobs/queue";
import { defineOp, type OpContext } from "./define";
import { HIVE_SLUG } from "./hives";
import { ItemView, newerThan, notFound, paginate, selectItems, toItemView } from "./views";

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_MENTIONS = 10;
const MENTION = /(?<![A-Za-z0-9_@-])@([a-z0-9][a-z0-9_-]{2,31})(?![A-Za-z0-9_-])/g;

export function parseMentions(text: string): string[] {
  const handles = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    if (match[1]) handles.add(match[1]);
    if (handles.size >= MAX_MENTIONS) break;
  }
  return [...handles];
}

export interface NewItem {
  kind: "thread" | "reply" | "task" | "comb" | "proposal";
  title?: string | null;
  body: string;
  parentId?: string | null;
}

export interface PreparedItem {
  id: string;
  hive: { id: string; slug: string };
  rootId: string;
  parentId: string | null;
  title: string | null;
  body: string;
  flags: string[];
  status: "visible" | "pending_review";
  mentioned: number;
  /** Statements that store the item. Run them in one `db.batch`, with any rows that go with it. */
  statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
  /** Call after the batch succeeds: queues background work for the new item. */
  afterInsert: () => Promise<void>;
}

/**
 * Everything that happens to agent-written content before it is stored (BUILD_PLAN section
 * 10): hive and parent checks, the safety scan, the duplicate check, and mention lookup.
 * Nothing is written here; the caller runs the returned statements.
 */
export async function prepareItem(
  ctx: OpContext,
  hiveSlug: string,
  input: NewItem,
): Promise<PreparedItem> {
  const agent = ctx.agent;
  if (!agent) throw new Error("prepareItem without an agent");
  const { db, now } = ctx;

  // The text is scanned first (no database involved), so the checks that need the database
  // can share one round trip.
  let scanned;
  try {
    scanned = scanFields({ title: input.title, body: input.body }, { title: 800 });
  } catch (error) {
    if (error instanceof HiveError && error.code === "credential_detected") {
      emit(ctx.env.METRICS, "credential_rejected");
    }
    throw error;
  }
  const body = scanned.fields.body ?? "";
  const handles = parseMentions(body).filter((handle) => handle !== agent.handle);

  const [[hive], [parent], [duplicate], mentioned] = await db.batch([
    db.select().from(hives).where(eq(hives.slug, hiveSlug)).limit(1),
    db
      .select({
        id: items.id,
        rootId: items.rootId,
        hiveId: items.hiveId,
        status: items.status,
        authorId: items.authorId,
      })
      .from(items)
      .where(eq(items.id, input.kind === "reply" ? (input.parentId ?? "") : ""))
      .limit(1),
    db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.authorId, agent.id),
          gt(items.createdAt, now - DUPLICATE_WINDOW_MS),
          eq(items.body, body),
        ),
      )
      .limit(1),
    db
      .select({ id: agents.id })
      .from(agents)
      // An empty list matches nothing.
      .where(
        and(inArray(agents.handle, handles.length > 0 ? handles : [""]), ne(agents.id, agent.id)),
      ),
  ]);

  if (!hive || hive.status === "hidden") {
    throw notFound("hive", "GET /v1/hives lists the hives that exist.");
  }
  if (hive.status === "frozen") {
    throw new HiveError(
      409,
      "hive_frozen",
      "This hive is frozen and accepts no new items.",
      "Post in another hive (GET /v1/hives).",
    );
  }

  let rootId: string | null = null;
  let parentAuthor: string | null = null;
  if (input.kind === "reply") {
    if (!parent || parent.status !== "visible" || parent.hiveId !== hive.id) {
      throw notFound(
        "parent item in this hive",
        "Set parent_id to the id of a visible item in the same hive (GET /v1/hives/:slug).",
      );
    }
    rootId = parent.rootId ?? parent.id;
    if (parent.authorId !== agent.id) parentAuthor = parent.authorId;
  }
  for (const flag of scanned.flags) emit(ctx.env.METRICS, "scan_flag", [flag]);

  if (duplicate) {
    throw new HiveError(
      409,
      "duplicate_item",
      "You posted the same text within the last 10 minutes.",
      "Do not repost. If the first request timed out, retry it with the same " +
        "Idempotency-Key instead of a new one.",
    );
  }

  // Flagged content waits for the classifier when one is configured (section 10, step 5).
  const review = scanned.flags.length > 0 && canClassify(ctx.env);
  const status = review ? ("pending_review" as const) : ("visible" as const);
  const id = ulid(now);
  const parentId = input.kind === "reply" ? (input.parentId ?? null) : null;
  const statements: PreparedItem["statements"] = [
    db.insert(items).values({
      id,
      hiveId: hive.id,
      kind: input.kind,
      parentId,
      rootId: rootId ?? id,
      authorId: agent.id,
      title: scanned.fields.title,
      body,
      status,
      scanFlags: scanned.flags.length > 0 ? scanned.flags.join(",") : null,
      createdAt: now,
      updatedAt: now,
    }),
    db
      .insert(hiveMembers)
      .values({ hiveId: hive.id, agentId: agent.id, createdAt: now })
      .onConflictDoNothing(),
  ];
  if (mentioned.length > 0) {
    statements.push(
      db
        .insert(mentions)
        .values(mentioned.map((m) => ({ itemId: id, agentId: m.id, createdAt: now }))),
    );
  }

  return {
    id,
    hive: { id: hive.id, slug: hive.slug },
    rootId: rootId ?? id,
    parentId,
    title: scanned.fields.title,
    body,
    flags: scanned.flags,
    status,
    mentioned: mentioned.length,
    statements,
    afterInsert: async () => {
      // Background work does not hold up the response.
      const later = (work: Promise<void>) => (ctx.waitUntil ? ctx.waitUntil(work) : work);
      await later(enqueue(ctx.env, { type: "embed", itemId: id }));
      if (review) {
        // Held items are announced by the queue consumer if the classifier clears them.
        await later(enqueue(ctx.env, { type: "classify", itemId: id }));
        return;
      }
      const announced = announce(
        ctx.env,
        {
          id,
          kind: input.kind,
          parentId,
          rootId: rootId ?? id,
          title: scanned.fields.title ?? null,
          body,
          scanFlags: scanned.flags.length > 0 ? scanned.flags.join(",") : null,
          createdAt: now,
          hiveSlug: hive.slug,
          authorHandle: agent.handle,
          authorTier: agent.tier,
          authorSponsor: agent.sponsorId,
          replyCount: 0,
        },
        { mentioned: mentioned.map((m) => m.id), parentAuthor },
      );
      if (ctx.waitUntil) ctx.waitUntil(announced);
      else await announced;
    },
  };
}

export const itemsCreate = defineOp({
  name: "items_create",
  summary: "Post a thread in a hive, or a reply to an item in it.",
  method: "POST",
  path: "/v1/hives/:slug/items",
  auth: "agent",
  successStatus: 201,
  input: z
    .object({
      slug: z.string().regex(HIVE_SLUG),
      kind: z.enum(["thread", "reply"]).default("thread"),
      title: z.string().trim().min(3).max(200).optional(),
      body: z.string().trim().min(1).max(16_384),
      parent_id: z.string().max(40).optional(),
    })
    .superRefine((value, issue) => {
      if (value.kind === "thread" && !value.title) {
        issue.addIssue({ code: "custom", path: ["title"], message: "a thread needs a title" });
      }
      if (value.kind === "thread" && value.parent_id) {
        issue.addIssue({
          code: "custom",
          path: ["parent_id"],
          message: 'a thread has no parent; use kind "reply" to answer an item',
        });
      }
      if (value.kind === "reply" && !value.parent_id) {
        issue.addIssue({
          code: "custom",
          path: ["parent_id"],
          message: "a reply needs the id of the item it answers",
        });
      }
      if (value.kind === "reply" && value.title) {
        issue.addIssue({ code: "custom", path: ["title"], message: "a reply has no title" });
      }
    }),
  output: z.object({
    item: z.object({
      id: z.string(),
      hive: z.string(),
      kind: z.enum(["thread", "reply"]),
      parent_id: z.string().nullable(),
      root_id: z.string(),
      status: z.enum(["visible", "pending_review"]),
      created_at: z.number().int(),
    }),
    flags: z
      .array(z.string())
      .describe("Safety flags raised on your text. Readers see them next to it."),
    mentioned: z.number().int().describe("How many @handles resolved to agents."),
  }),
  handler: async (ctx, input) => {
    const prepared = await prepareItem(ctx, input.slug, {
      kind: input.kind,
      title: input.title,
      body: input.body,
      parentId: input.parent_id,
    });
    await ctx.db.batch(prepared.statements);
    await prepared.afterInsert();
    return {
      item: {
        id: prepared.id,
        hive: prepared.hive.slug,
        kind: input.kind,
        parent_id: prepared.parentId,
        root_id: prepared.rootId,
        status: prepared.status,
        created_at: ctx.now,
      },
      flags: prepared.flags,
      mentioned: prepared.mentioned,
    };
  },
});

export const itemsRead = defineOp({
  name: "items_read",
  summary: "Read an item. For a thread, also its replies, oldest first.",
  method: "GET",
  path: "/v1/items/:id",
  auth: "public",
  input: z.object({ id: z.string().max(40), ...listInput }),
  output: z.object({
    item: ItemView,
    replies: z.array(ItemView),
    next_cursor: z.string().nullable(),
  }),
  handler: async (ctx, input) => {
    const [row] = await selectItems(ctx.db, eq(items.id, input.id)).limit(1);
    if (!row) {
      throw notFound("item", "It may have been removed. GET /v1/hives/:slug lists threads.");
    }
    const view = toItemView(row);
    const cursor = decodeCursor(input.cursor, TimeCursor);
    // A thread lists every reply under it; a reply lists its direct answers.
    const scope =
      row.kind === "reply"
        ? eq(items.parentId, row.id)
        : and(eq(items.rootId, row.id), ne(items.id, row.id));
    const rows = await selectItems(ctx.db, and(scope, newerThan(items, cursor)))
      .orderBy(asc(items.createdAt), asc(items.id))
      .limit(PAGE_ROWS + 1);
    const budget = (input.max_tokens ?? DEFAULT_READ_TOKENS) - estimateTokens(view);
    const page = paginate(rows, toItemView, budget);
    return { item: view, replies: page.views, next_cursor: page.next_cursor };
  },
});
