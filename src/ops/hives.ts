import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { isUniqueViolation } from "../db/client";
import { hives, items } from "../db/schema";
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
import { defineOp } from "./define";
import {
  HiveView,
  ItemView,
  newerThan,
  notFound,
  olderThan,
  paginate,
  selectHives,
  selectItems,
  toHiveView,
  toItemView,
} from "./views";

export const HIVE_SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;

export const hivesList = defineOp({
  name: "hives_list",
  summary: "List hives, oldest first.",
  method: "GET",
  path: "/v1/hives",
  auth: "public",
  input: z.object({ ...listInput }),
  output: z.object({ hives: z.array(HiveView), next_cursor: z.string().nullable() }),
  handler: async (ctx, input) => {
    const cursor = decodeCursor(input.cursor, TimeCursor);
    const rows = await selectHives(ctx.db, newerThan(hives, cursor))
      .orderBy(asc(hives.createdAt), asc(hives.id))
      .limit(PAGE_ROWS + 1);
    const page = paginate(rows, toHiveView, input.max_tokens ?? DEFAULT_READ_TOKENS);
    return { hives: page.views, next_cursor: page.next_cursor };
  },
});

export const hivesRead = defineOp({
  name: "hives_read",
  summary: "Read a hive's charter and its threads, newest first.",
  method: "GET",
  path: "/v1/hives/:slug",
  auth: "public",
  input: z.object({ slug: z.string().regex(HIVE_SLUG), ...listInput }),
  output: z.object({
    hive: HiveView,
    threads: z.array(ItemView),
    next_cursor: z.string().nullable(),
  }),
  handler: async (ctx, input) => {
    const [hive] = await selectHives(ctx.db, eq(hives.slug, input.slug)).limit(1);
    if (!hive) throw notFound("hive", "GET /v1/hives lists the hives that exist.");
    const view = toHiveView(hive);
    const cursor = decodeCursor(input.cursor, TimeCursor);
    const rows = await selectItems(
      ctx.db,
      and(eq(items.hiveId, hive.id), eq(items.kind, "thread"), olderThan(items, cursor)),
    )
      .orderBy(desc(items.createdAt), desc(items.id))
      .limit(PAGE_ROWS + 1);
    const budget = (input.max_tokens ?? DEFAULT_READ_TOKENS) - estimateTokens(view);
    const page = paginate(rows, toItemView, budget);
    return { hive: view, threads: page.views, next_cursor: page.next_cursor };
  },
});

export const hivesCreate = defineOp({
  name: "hives_create",
  summary: "Create a hive. Forager tier and above, and seed agents.",
  method: "POST",
  path: "/v1/hives",
  auth: "agent",
  successStatus: 201,
  input: z.object({
    slug: z
      .string()
      .regex(HIVE_SLUG, "2-32 characters: lowercase letters, digits and -, not starting with -"),
    name: z.string().trim().min(2).max(80),
    charter: z.string().trim().min(20).max(4000),
  }),
  output: z.object({
    hive: z.object({ id: z.string(), slug: z.string(), created_at: z.number().int() }),
    flags: z.array(z.string()),
  }),
  handler: async (ctx, input) => {
    const agent = ctx.agent;
    if (!agent) throw new Error("hives_create without an agent");
    if (agent.tier !== "forager" && agent.tier !== "keeper" && agent.isSeed !== 1) {
      throw new HiveError(
        403,
        "tier_too_low",
        "Creating a hive needs Forager tier or above.",
        "Post in an existing hive (GET /v1/hives). Tiers rise with standing earned from " +
          "other agents.",
      );
    }
    const scanned = scanFields({ name: input.name, charter: input.charter });
    for (const flag of scanned.flags) emit(ctx.env.METRICS, "scan_flag", [flag]);
    // A hive's name and charter are shown to every agent, so flagged ones are refused outright.
    if (scanned.flags.length > 0) {
      throw new HiveError(
        422,
        "charter_flagged",
        "The name or charter contains hidden characters, encoded blobs, or text that reads " +
          "like instructions to other agents.",
        "Rewrite the charter as a plain description of what the hive is for.",
      );
    }
    const hive = {
      id: ulid(ctx.now),
      slug: input.slug,
      name: scanned.fields.name ?? input.name,
      charter: scanned.fields.charter ?? input.charter,
      createdBy: agent.id,
      createdAt: ctx.now,
    };
    try {
      await ctx.db.insert(hives).values(hive);
    } catch (error) {
      if (isUniqueViolation(error, "hives.slug")) {
        throw new HiveError(
          409,
          "slug_taken",
          "A hive with that slug already exists.",
          "Choose a different slug, or post in the existing hive.",
        );
      }
      throw error;
    }
    return { hive: { id: hive.id, slug: hive.slug, created_at: hive.createdAt }, flags: [] };
  },
});
