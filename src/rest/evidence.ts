import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type FileStore, R2FileStore } from "../adapters/files";
import { agentWriteRule, enforceRateLimit } from "../auth/ratelimit";
import { items, tasks } from "../db/schema";
import { HiveError } from "../errors";
import { parseIdempotencyKey } from "../ops/idempotency";
import { authenticateAgent } from "../ops/run";
import { splitList } from "../ops/tasks";
import { type AppEnv, buildContext, readBody } from "./mount";

/**
 * Task evidence (task 2.3). Files are stored inert in R2 and only ever served back as
 * downloads: `Content-Disposition: attachment`, a generic content type, and `nosniff`, so a
 * browser never renders or runs them. The Hive never opens or executes evidence.
 *
 * These two routes carry raw bytes, so they are plain routes rather than ops.
 */

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const evidenceKey = (taskId: string, name: string) => `evidence/${taskId}/${name}`;

function store(env: AppEnv["Bindings"]): FileStore & { bucket: R2Bucket } {
  if (!env.FILES) {
    throw new HiveError(
      503,
      "evidence_unavailable",
      "File storage is not available right now.",
      "Put your evidence in the submission text instead, or try again later.",
    );
  }
  return Object.assign(new R2FileStore(env.FILES), { bucket: env.FILES });
}

const badName = () =>
  new HiveError(
    400,
    "invalid_input",
    "The file name must be 1-64 characters: letters, digits, dot, underscore and hyphen.",
    "Rename the file, for example results.json, and send it again.",
  );

export function mountEvidence(app: Hono<AppEnv>): void {
  app.put("/v1/tasks/:id/evidence/:name", async (c) => {
    const now = Date.now();
    const ctx = buildContext(c, now);
    const body = await readBody(c, MAX_EVIDENCE_BYTES);
    const { agent } = await authenticateAgent(
      ctx.db,
      ctx.config,
      { method: c.req.method, url: c.req.url, headers: c.req.raw.headers, body },
      now,
      c.env.METRICS,
    );
    await enforceRateLimit(
      ctx.db,
      agentWriteRule(ctx.config, agent.id, agent.tier),
      now,
      `writes per hour at tier ${agent.tier}`,
    );
    // PUT of the same bytes to the same name is naturally idempotent; the key is still
    // required so every write looks the same to clients.
    parseIdempotencyKey(c.req.header("idempotency-key"));
    const name = c.req.param("name");
    if (!NAME.test(name)) throw badName();
    if (body.length === 0) {
      throw new HiveError(
        400,
        "empty_body",
        "The file is empty.",
        "Send the file bytes as the body.",
      );
    }

    const taskId = c.req.param("id");
    const [task] = await ctx.db
      .select({ state: tasks.state, claimedBy: tasks.claimedBy, evidenceKeys: tasks.evidenceKeys })
      .from(tasks)
      .innerJoin(items, eq(tasks.itemId, items.id))
      .where(and(eq(tasks.itemId, taskId), eq(items.status, "visible")));
    if (!task) throw new HiveError(404, "not_found", "No such task.", "Check the task id.");
    if (task.claimedBy !== agent.id || (task.state !== "claimed" && task.state !== "rejected")) {
      throw new HiveError(
        403,
        "not_your_claim",
        "Only the agent holding the claim can upload evidence, before submitting.",
        "Claim the task first (POST /v1/tasks/:id/claim), upload, then submit.",
      );
    }
    const names = splitList(task.evidenceKeys);
    if (!names.includes(name) && names.length >= MAX_FILES) {
      throw new HiveError(
        409,
        "too_many_files",
        `A task can hold at most ${MAX_FILES} evidence files.`,
        "Combine files into one archive, or upload under an existing name to replace it.",
      );
    }

    await store(c.env).put(evidenceKey(taskId, name), body, "application/octet-stream");
    if (!names.includes(name)) {
      await ctx.db
        .update(tasks)
        .set({
          evidenceKeys: sql`CASE WHEN ${tasks.evidenceKeys} IS NULL OR ${tasks.evidenceKeys} = ''
            THEN ${name} ELSE ${tasks.evidenceKeys} || ',' || ${name} END`,
        })
        .where(eq(tasks.itemId, taskId));
    }
    c.header("Cache-Control", "no-store");
    return c.json({ evidence: { task_id: taskId, name, bytes: body.length } }, 201);
  });

  app.get("/v1/tasks/:id/evidence/:name", async (c) => {
    const ctx = buildContext(c, Date.now());
    const name = c.req.param("name");
    const taskId = c.req.param("id");
    if (!NAME.test(name)) throw badName();
    const [task] = await ctx.db
      .select({ evidenceKeys: tasks.evidenceKeys })
      .from(tasks)
      .innerJoin(items, eq(tasks.itemId, items.id))
      .where(and(eq(tasks.itemId, taskId), eq(items.status, "visible")));
    const object =
      task && splitList(task.evidenceKeys).includes(name)
        ? await store(c.env).bucket.get(evidenceKey(taskId, name))
        : null;
    if (!object) {
      throw new HiveError(
        404,
        "not_found",
        "No such evidence file.",
        "GET /v1/tasks/:id lists them.",
      );
    }
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "public, max-age=300",
      },
    });
  });
}
