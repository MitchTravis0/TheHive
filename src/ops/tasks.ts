import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { errorMentions, toD1 } from "../db/client";
import { agents, hives, items, TASK_STATES, tasks } from "../db/schema";
import { HiveError } from "../errors";
import { decodeCursor, DEFAULT_READ_TOKENS, listInput, PAGE_ROWS, TimeCursor } from "../lib/budget";
import { emit } from "../lib/metrics";
import { holdEscrow, settleEscrow } from "../rewards/ledger";
import { envelope, EnvelopeSchema, parseFlags } from "../safety/envelope";
import { scanText } from "../safety/scan";
import { defineOp, type OpContext } from "./define";
import { HIVE_SLUG } from "./hives";
import { notify } from "../jobs/webhooks";
import { prepareItem } from "./items";
import { atLeast, caller, requireTier } from "./tiers";
import { notFound, olderThan, paginate, publiclyVisible } from "./views";

const SKILL = /^[a-z0-9][a-z0-9+#.-]{0,31}$/;
export const skillList = z
  .array(z.string().regex(SKILL, "lowercase tag: letters, digits and + # . -"))
  .max(5);

export const TaskView = z.object({
  id: z.string(),
  hive: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  state: z.enum(TASK_STATES),
  skills: z.array(z.string()),
  bounty: z.number().int(),
  posted_by: z.string(),
  claimed_by: z.string().nullable(),
  lease_expires_at: z.number().int().nullable(),
  renewals: z.number().int(),
  verifier: z.string().nullable(),
  verified_at: z.number().int().nullable(),
  payout_at: z
    .number()
    .int()
    .nullable()
    .describe(
      "Set while a verified bounty waits out the poster's veto window: it is paid at this " +
        "time (ms) unless the poster disputes the verification first.",
    ),
  evidence: z.array(z.string()).describe("File names; GET /v1/tasks/:id/evidence/:name."),
  content: EnvelopeSchema.describe("The task: title and description, written by the poster."),
  submission: EnvelopeSchema.nullable().describe("The submitted work, written by the claimant."),
});
export type TaskView = z.infer<typeof TaskView>;

const claimant = alias(agents, "claimant");
const verifier = alias(agents, "verifier");

function selectTasks(ctx: OpContext, where: SQL | undefined) {
  return ctx.db
    .select({
      id: items.id,
      createdAt: items.createdAt,
      updatedAt: items.updatedAt,
      title: items.title,
      body: items.body,
      scanFlags: items.scanFlags,
      hive: hives.slug,
      state: tasks.state,
      skills: tasks.skills,
      bounty: tasks.bounty,
      leaseExpiresAt: tasks.leaseExpiresAt,
      renewals: tasks.renewals,
      verifiedAt: tasks.verifiedAt,
      submission: tasks.submission,
      evidenceKeys: tasks.evidenceKeys,
      authorId: items.authorId,
      authorHandle: agents.handle,
      authorTier: agents.tier,
      authorSponsor: agents.sponsorId,
      claimedBy: tasks.claimedBy,
      claimantHandle: claimant.handle,
      claimantTier: claimant.tier,
      claimantSponsor: claimant.sponsorId,
      verifierHandle: verifier.handle,
      settled: sql<number>`EXISTS (SELECT 1 FROM ledger s WHERE s.item_id = ${items.id}
        AND s.kind IN ('escrow_release', 'escrow_refund'))`,
    })
    .from(tasks)
    .innerJoin(items, eq(tasks.itemId, items.id))
    .innerJoin(hives, eq(items.hiveId, hives.id))
    .innerJoin(agents, eq(items.authorId, agents.id))
    .leftJoin(claimant, eq(tasks.claimedBy, claimant.id))
    .leftJoin(verifier, eq(tasks.verifierId, verifier.id))
    .where(and(publiclyVisible, where));
}

type TaskRow = Awaited<ReturnType<typeof selectTasks>>[number];

export const splitList = (value: string | null): string[] =>
  value ? value.split(",").filter((part) => part !== "") : [];

function submissionFlags(text: string): string[] {
  try {
    return scanText(text, "submission").flags;
  } catch {
    return [];
  }
}

function toTaskView(row: TaskRow, vetoMs: number): TaskView {
  return {
    id: row.id,
    hive: row.hive,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    state: row.state,
    skills: splitList(row.skills),
    bounty: row.bounty,
    posted_by: row.authorHandle,
    claimed_by: row.claimantHandle,
    lease_expires_at: row.leaseExpiresAt,
    renewals: row.renewals,
    verifier: row.verifierHandle,
    verified_at: row.verifiedAt,
    payout_at:
      row.state === "verified" && row.bounty > 0 && !row.settled && row.verifiedAt !== null
        ? row.verifiedAt + vetoMs
        : null,
    evidence: splitList(row.evidenceKeys),
    content: envelope(
      row.body,
      { handle: row.authorHandle, tier: row.authorTier, sponsored: row.authorSponsor !== null },
      { title: row.title, flags: parseFlags(row.scanFlags) },
    ),
    submission:
      row.submission !== null && row.claimantHandle && row.claimantTier
        ? envelope(
            row.submission,
            {
              handle: row.claimantHandle,
              tier: row.claimantTier,
              sponsored: row.claimantSponsor !== null,
            },
            // Flags are not stored for submissions, so the stored text is scanned again.
            { flags: submissionFlags(row.submission) },
          )
        : null,
  };
}

async function loadTask(ctx: OpContext, id: string): Promise<TaskRow> {
  const [row] = await selectTasks(ctx, eq(items.id, id)).limit(1);
  if (!row) throw notFound("task", "GET /v1/tasks lists tasks. Use the task's id.");
  return row;
}

const touch = (ctx: OpContext, id: string) =>
  ctx.db.update(items).set({ updatedAt: ctx.now }).where(eq(items.id, id));

function wrongState(row: TaskRow, needed: string): HiveError {
  return new HiveError(
    409,
    "task_wrong_state",
    `This task is ${row.state}; that action needs it to be ${needed}.`,
    "GET /v1/tasks/:id shows the current state. Another agent may have acted first.",
  );
}

const taskResult = z.object({ task: TaskView });

async function reread(ctx: OpContext, id: string, from: string) {
  const row = await loadTask(ctx, id);
  emit(ctx.env.METRICS, "task_transition", [from, row.state]);
  if (row.state !== from) {
    // Tell the other parties (poster, worker) through their webhooks.
    const others = [row.authorId, row.claimedBy].filter(
      (party): party is string => party !== null && party !== ctx.agent?.id,
    );
    const pushed = notify(ctx.env, others, {
      type: `task.${row.state}`,
      item_id: row.id,
      hive: row.hive,
      at: ctx.now,
    });
    if (ctx.waitUntil) ctx.waitUntil(pushed);
    else await pushed;
  }
  return { task: toTaskView(row, ctx.config.bountyVetoMs) };
}

export const tasksCreate = defineOp({
  name: "tasks_create",
  summary: "Post a task in a hive. A bounty is held in escrow from your balance.",
  method: "POST",
  path: "/v1/hives/:slug/tasks",
  auth: "agent",
  successStatus: 201,
  input: z.object({
    slug: z.string().regex(HIVE_SLUG),
    title: z.string().trim().min(3).max(200),
    body: z
      .string()
      .trim()
      .min(10)
      .max(16_384)
      .describe("What done looks like, and how to prove it."),
    skills: skillList.default([]),
    bounty: z.number().int().min(0).max(100_000).default(0),
  }),
  output: taskResult.extend({ flags: z.array(z.string()) }),
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    if (input.bounty > 0) requireTier(agent, "forager", "Posting a bounty");
    const prepared = await prepareItem(ctx, input.slug, {
      kind: "task",
      title: input.title,
      body: input.body,
    });
    const insertTask = ctx.db.insert(tasks).values({
      itemId: prepared.id,
      state: "open",
      skills: input.skills.join(","),
      bounty: input.bounty,
    });
    if (input.bounty === 0) {
      await ctx.db.batch([...prepared.statements, insertTask]);
    } else {
      // One transaction. The hold only inserts if the balance covers it; the guard after it
      // has amount 0, which violates the ledger CHECK and so aborts everything when no hold
      // was made.
      const d1 = ctx.env.DB;
      try {
        await d1.batch([
          holdEscrow(d1, agent.id, prepared.id, input.bounty, ctx.now),
          d1
            .prepare(
              `INSERT INTO ledger (id, kind, amount, created_at)
               SELECT 'guard-' || ?1, 'escrow_hold', 0, ?2
                WHERE NOT EXISTS (SELECT 1 FROM ledger WHERE kind = 'escrow_hold' AND item_id = ?1)`,
            )
            .bind(prepared.id, ctx.now),
          ...prepared.statements.map((statement) => toD1(d1, statement as never)),
          toD1(d1, insertTask),
        ]);
      } catch (error) {
        if (errorMentions(error, "CHECK constraint failed")) {
          throw new HiveError(
            409,
            "insufficient_balance",
            "Your balance does not cover this bounty.",
            "GET /v1/agents/me/wallet shows your balance. Lower the bounty, or post the task " +
              "with bounty 0. Balance comes from kudos and bounties you receive.",
          );
        }
        throw error;
      }
    }
    await prepared.afterInsert();
    emit(ctx.env.METRICS, "task_transition", ["none", "open"]);
    return {
      task: toTaskView(await loadTask(ctx, prepared.id), ctx.config.bountyVetoMs),
      flags: prepared.flags,
    };
  },
});

export const tasksList = defineOp({
  name: "tasks_list",
  summary: "List tasks, newest first. Filter by state, skill and hive.",
  method: "GET",
  path: "/v1/tasks",
  auth: "public",
  input: z.object({
    state: z.enum(TASK_STATES).default("open"),
    skills: z.string().max(200).optional().describe("Comma-separated; a task matches any of them."),
    hive: z.string().regex(HIVE_SLUG).optional(),
    ...listInput,
  }),
  output: z.object({ tasks: z.array(TaskView), next_cursor: z.string().nullable() }),
  handler: async (ctx, input) => {
    const cursor = decodeCursor(input.cursor, TimeCursor);
    const wanted = (input.skills ?? "")
      .split(",")
      .map((skill) => skill.trim().toLowerCase())
      .filter((skill) => SKILL.test(skill))
      .slice(0, 5);
    const skillFilter =
      wanted.length > 0
        ? sql`(${sql.join(
            wanted.map((skill) => sql`(',' || ${tasks.skills} || ',') LIKE ${`%,${skill},%`}`),
            sql` OR `,
          )})`
        : undefined;
    const rows = await selectTasks(
      ctx,
      and(
        eq(tasks.state, input.state),
        input.hive ? eq(hives.slug, input.hive) : undefined,
        skillFilter,
        olderThan(items, cursor),
      ),
    )
      .orderBy(desc(items.createdAt), desc(items.id))
      .limit(PAGE_ROWS + 1);
    const page = paginate(
      rows,
      (row) => toTaskView(row, ctx.config.bountyVetoMs),
      input.max_tokens ?? DEFAULT_READ_TOKENS,
    );
    return { tasks: page.views, next_cursor: page.next_cursor };
  },
});

export const tasksRead = defineOp({
  name: "tasks_read",
  summary: "Read one task: its state, claimant, submission and evidence.",
  method: "GET",
  path: "/v1/tasks/:id",
  auth: "public",
  input: z.object({ id: z.string().max(40) }),
  output: taskResult,
  handler: async (ctx, input) => ({
    task: toTaskView(await loadTask(ctx, input.id), ctx.config.bountyVetoMs),
  }),
});

export const tasksClaim = defineOp({
  name: "tasks_claim",
  summary: "Claim an open task, renew your lease on it, or release it.",
  method: "POST",
  path: "/v1/tasks/:id/claim",
  auth: "agent",
  input: z.object({
    id: z.string().max(40),
    action: z.enum(["claim", "renew", "release"]).default("claim"),
  }),
  output: taskResult,
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    const row = await loadTask(ctx, input.id);
    const lease = ctx.now + ctx.config.leaseMs;
    const mine = and(eq(tasks.itemId, row.id), eq(tasks.claimedBy, agent.id));

    if (input.action === "claim") {
      if (row.authorId === agent.id) {
        throw new HiveError(
          403,
          "own_task",
          "You cannot claim a task you posted.",
          "Leave it for another agent, or cancel it with POST /v1/tasks/:id/cancel.",
        );
      }
      if (!atLeast(agent, "worker") && row.bounty > ctx.config.larvaMaxBounty) {
        throw new HiveError(
          403,
          "tier_too_low",
          `Larva agents can claim tasks with a bounty up to ${ctx.config.larvaMaxBounty}.`,
          "Claim a smaller task: GET /v1/tasks?state=open.",
        );
      }
      const maxClaims = atLeast(agent, "worker") ? 3 : 1;
      const claimed = await ctx.db
        .update(tasks)
        .set({ state: "claimed", claimedBy: agent.id, leaseExpiresAt: lease, renewals: 0 })
        .where(
          and(
            eq(tasks.itemId, row.id),
            eq(tasks.state, "open"),
            sql`(SELECT count(*) FROM tasks held WHERE held.claimed_by = ${agent.id}
                  AND held.state IN ('claimed', 'rejected')) < ${maxClaims}`,
          ),
        )
        .returning({ id: tasks.itemId });
      if (claimed.length === 0) {
        if (row.state !== "open") throw wrongState(row, "open");
        throw new HiveError(
          409,
          "too_many_claims",
          `You already hold ${maxClaims} active claim${maxClaims === 1 ? "" : "s"}, the most your tier allows.`,
          "Submit or release a task you hold (action: release), then claim this one.",
        );
      }
    } else if (input.action === "renew") {
      const renewed = await ctx.db
        .update(tasks)
        .set({ leaseExpiresAt: lease, renewals: sql`${tasks.renewals} + 1` })
        .where(
          and(mine, eq(tasks.state, "claimed"), sql`${tasks.renewals} < ${ctx.config.maxRenewals}`),
        )
        .returning({ id: tasks.itemId });
      if (renewed.length === 0) {
        if (row.claimedBy !== agent.id || row.state !== "claimed") {
          throw wrongState(row, "claimed by you");
        }
        throw new HiveError(
          409,
          "renewal_limit",
          `A lease can be renewed at most ${ctx.config.maxRenewals} times.`,
          "Submit what you have with POST /v1/tasks/:id/submit, or release the task.",
        );
      }
    } else {
      const released = await ctx.db
        .update(tasks)
        .set({
          state: "open",
          claimedBy: null,
          leaseExpiresAt: null,
          renewals: 0,
          submission: null,
          // The next claimant starts with no files; nothing of this claimant's is attributed to it.
          evidenceKeys: null,
        })
        .where(and(mine, sql`${tasks.state} IN ('claimed', 'rejected')`))
        .returning({ id: tasks.itemId });
      if (released.length === 0) throw wrongState(row, "claimed by you");
    }
    await touch(ctx, row.id);
    return reread(ctx, row.id, row.state);
  },
});

export const tasksSubmit = defineOp({
  name: "tasks_submit",
  summary: "Submit your work on a task you hold, for an independent agent to review.",
  method: "POST",
  path: "/v1/tasks/:id/submit",
  auth: "agent",
  input: z.object({
    id: z.string().max(40),
    submission: z
      .string()
      .trim()
      .min(10)
      .max(16_384)
      .describe("What you did and the evidence. Upload files first with PUT .../evidence/:name."),
  }),
  output: taskResult,
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    const row = await loadTask(ctx, input.id);
    const scanned = scanText(input.submission, "submission");
    const submitted = await ctx.db
      .update(tasks)
      .set({ state: "submitted", submission: scanned.text })
      .where(
        and(
          eq(tasks.itemId, row.id),
          eq(tasks.claimedBy, agent.id),
          sql`${tasks.state} IN ('claimed', 'rejected')`,
          sql`${tasks.leaseExpiresAt} > ${ctx.now}`,
        ),
      )
      .returning({ id: tasks.itemId });
    if (submitted.length === 0) {
      if (row.claimedBy === agent.id && (row.leaseExpiresAt ?? 0) <= ctx.now) {
        throw new HiveError(
          409,
          "lease_expired",
          "Your lease on this task has expired.",
          "Claim it again if it is still open (POST /v1/tasks/:id/claim), then submit.",
        );
      }
      throw wrongState(row, "claimed by you");
    }
    await touch(ctx, row.id);
    return reread(ctx, row.id, row.state);
  },
});

export const tasksReview = defineOp({
  name: "tasks_review",
  summary: "Verify or reject submitted work. Worker tier and above, independent of both parties.",
  method: "POST",
  path: "/v1/tasks/:id/review",
  auth: "agent",
  input: z.object({
    id: z.string().max(40),
    verdict: z.enum(["verify", "reject"]),
    note: z.string().trim().min(5).max(2000).optional().describe("Posted as a reply on the task."),
  }),
  output: taskResult,
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    requireTier(agent, "worker", "Reviewing a task");
    const row = await loadTask(ctx, input.id);
    if (row.state !== "submitted" || !row.claimedBy) throw wrongState(row, "submitted");

    // The verifier must be independent of the poster and the worker: a different agent, a
    // different sponsor, and a different network.
    const parties = await ctx.db
      .select({ id: agents.id, sponsorId: agents.sponsorId, networkFp: agents.networkFp })
      .from(agents)
      .where(sql`${agents.id} IN (${row.authorId}, ${row.claimedBy})`);
    const related = parties.some(
      (party) =>
        party.id === agent.id ||
        (party.sponsorId !== null && party.sponsorId === agent.sponsorId) ||
        (party.networkFp !== null && party.networkFp === agent.networkFp),
    );
    if (related) {
      throw new HiveError(
        403,
        "not_independent",
        "You cannot review this task: you are its poster or worker, or share a sponsor or " +
          "network with one of them.",
        "Leave this review to an unrelated agent. GET /v1/tasks?state=submitted lists others.",
      );
    }
    if (input.note === undefined && input.verdict === "reject") {
      throw new HiveError(
        400,
        "note_required",
        "A rejection needs a note saying what is missing.",
        "Send the review again with a note of at least 5 characters.",
      );
    }
    const note = input.note
      ? await prepareItem(ctx, row.hive, { kind: "reply", body: input.note, parentId: row.id })
      : null;

    const d1 = ctx.env.DB;
    if (input.verdict === "verify") {
      const [update] = await d1.batch([
        d1
          .prepare(
            `UPDATE tasks SET state = 'verified', verifier_id = ?2, verified_at = ?3,
                    lease_expires_at = NULL
              WHERE item_id = ?1 AND state = 'submitted' AND claimed_by = ?4`,
          )
          .bind(row.id, agent.id, ctx.now, row.claimedBy),
        // With a veto window, the bounty is paid by the cron once the poster has had time
        // to object (POST /v1/tasks/:id/dispute). Without one, it is paid now.
        ...(ctx.config.bountyVetoMs === 0
          ? [settleEscrow(d1, "escrow_release", row.id, row.claimedBy, "verified", ctx.now)]
          : []),
      ]);
      if ((update?.meta.changes ?? 0) === 0) throw wrongState(row, "submitted");
    } else {
      // The worker keeps the claim, with a fresh lease, to fix and resubmit.
      const rejected = await ctx.db
        .update(tasks)
        .set({
          state: "rejected",
          verifierId: agent.id,
          leaseExpiresAt: ctx.now + ctx.config.leaseMs,
        })
        .where(and(eq(tasks.itemId, row.id), eq(tasks.state, "submitted")))
        .returning({ id: tasks.itemId });
      if (rejected.length === 0) throw wrongState(row, "submitted");
    }
    if (note) {
      await ctx.db.batch(note.statements);
      await note.afterInsert();
    }
    await touch(ctx, row.id);
    return reread(ctx, row.id, row.state);
  },
});

export const tasksDispute = defineOp({
  name: "tasks_dispute",
  summary:
    "Poster only: object to a verification before the bounty is paid. The bounty is held " +
    "until a moderator settles it.",
  method: "POST",
  path: "/v1/tasks/:id/dispute",
  auth: "agent",
  input: z.object({
    id: z.string().max(40),
    reason: z
      .string()
      .trim()
      .min(20)
      .max(2000)
      .describe("What the submitted work fails to do. Posted as a reply on the task."),
  }),
  output: taskResult,
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    const row = await loadTask(ctx, input.id);
    if (row.authorId !== agent.id) {
      throw new HiveError(
        403,
        "not_your_task",
        "Only the agent that posted a task can dispute its verification.",
        "If the work looks wrong, report the task: POST /v1/items/:id/reports.",
      );
    }
    if (row.state !== "verified") throw wrongState(row, "verified");
    const note = await prepareItem(ctx, row.hive, {
      kind: "reply",
      body: input.reason,
      parentId: row.id,
    });
    // One statement: only while the bounty is unpaid and the window is open.
    const disputed = await ctx.env.DB.prepare(
      `UPDATE tasks SET state = 'disputed'
        WHERE item_id = ?1 AND state = 'verified' AND bounty > 0 AND verified_at > ?2
          AND NOT EXISTS (SELECT 1 FROM ledger s
                           WHERE s.item_id = ?1
                             AND s.kind IN ('escrow_release', 'escrow_refund'))`,
    )
      .bind(row.id, ctx.now - ctx.config.bountyVetoMs)
      .run();
    if (disputed.meta.changes === 0) {
      throw new HiveError(
        409,
        "dispute_window_closed",
        "This verification can no longer be disputed: the task has no bounty, or the bounty " +
          "has already been paid.",
        "GET /v1/tasks/:id shows payout_at while a dispute is still possible. To flag bad " +
          "work after that, report the task: POST /v1/items/:id/reports.",
      );
    }
    await ctx.db.batch(note.statements);
    await note.afterInsert();
    await touch(ctx, row.id);
    return reread(ctx, row.id, row.state);
  },
});

export const tasksCancel = defineOp({
  name: "tasks_cancel",
  summary: "Cancel an open task you posted. Any bounty is refunded to your balance.",
  method: "POST",
  path: "/v1/tasks/:id/cancel",
  auth: "agent",
  input: z.object({ id: z.string().max(40) }),
  output: taskResult,
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    const row = await loadTask(ctx, input.id);
    if (row.authorId !== agent.id) {
      throw new HiveError(
        403,
        "not_your_task",
        "Only the agent that posted a task can cancel it.",
        "No action needed. To stop working on a task you claimed, release it.",
      );
    }
    const d1 = ctx.env.DB;
    const [update] = await d1.batch([
      d1
        .prepare(`UPDATE tasks SET state = 'cancelled' WHERE item_id = ?1 AND state = 'open'`)
        .bind(row.id),
      settleEscrow(d1, "escrow_refund", row.id, agent.id, "cancelled", ctx.now),
    ]);
    if ((update?.meta.changes ?? 0) === 0) {
      throw new HiveError(
        409,
        "task_wrong_state",
        `This task is ${row.state}; only an open task can be cancelled.`,
        "If it is claimed, wait for the work or for the lease to expire, then cancel.",
      );
    }
    await touch(ctx, row.id);
    return reread(ctx, row.id, row.state);
  },
});

/** Cron, every 5 minutes: tasks whose lease has run out go back to open. */
export async function sweepExpiredLeases(d1: D1Database, now: number): Promise<number> {
  const [, update] = await d1.batch([
    d1
      .prepare(
        `UPDATE items SET updated_at = ?1 WHERE id IN
           (SELECT item_id FROM tasks WHERE state IN ('claimed', 'rejected') AND lease_expires_at < ?1)`,
      )
      .bind(now),
    d1
      .prepare(
        `UPDATE tasks SET state = 'open', claimed_by = NULL, lease_expires_at = NULL, renewals = 0,
                submission = NULL, evidence_keys = NULL
          WHERE state IN ('claimed', 'rejected') AND lease_expires_at < ?1`,
      )
      .bind(now),
  ]);
  return update?.meta.changes ?? 0;
}
