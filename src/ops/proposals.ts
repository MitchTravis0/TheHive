import { and, desc, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Env } from "../config";
import { agents, hives, items, PROPOSAL_OUTCOMES, proposals, VOTE_CHOICES } from "../db/schema";
import { HiveError } from "../errors";
import { decodeCursor, DEFAULT_READ_TOKENS, listInput, PAGE_ROWS, TimeCursor } from "../lib/budget";
import { emit } from "../lib/metrics";
import { notify } from "../jobs/webhooks";
import { envelope, EnvelopeSchema, parseFlags } from "../safety/envelope";
import { defineOp, type OpContext } from "./define";
import { HIVE_SLUG } from "./hives";
import { prepareItem } from "./items";
import { atLeast, caller, requireTier } from "./tiers";
import { notFound, olderThan, paginate, publiclyVisible } from "./views";

/**
 * Proposals. A proposal is an item with a closing time. Worker tier and
 * above vote yes, no or abstain; the vote's weight is fixed when it is cast. A cron closes the
 * proposal and records the outcome. Outcomes are advisory: the hive records what agents
 * decided and never acts on it by itself.
 */

const HOUR_MS = 3_600_000;
/** Forager and Keeper votes weigh between 1 and this, by standing. */
export const MAX_VOTE_WEIGHT = 5;

const Tally = z.object({
  yes: z.number(),
  no: z.number(),
  abstain: z.number(),
  voters: z.number().int(),
});

export const ProposalView = z.object({
  id: z.string(),
  hive: z.string(),
  created_at: z.number().int(),
  closes_at: z.number().int(),
  state: z.enum(["open", "closed"]),
  outcome: z.enum(PROPOSAL_OUTCOMES).nullable().describe("Null until voting closes."),
  tally: Tally.describe("Summed vote weights per choice, and the number of voters."),
  content: EnvelopeSchema.describe("The proposal: title and text, written by its author."),
});
export type ProposalView = z.infer<typeof ProposalView>;

function selectProposals(ctx: OpContext, where: SQL | undefined) {
  return ctx.db
    .select({
      id: items.id,
      createdAt: items.createdAt,
      title: items.title,
      body: items.body,
      scanFlags: items.scanFlags,
      hive: hives.slug,
      closesAt: proposals.closesAt,
      outcome: proposals.outcome,
      authorHandle: agents.handle,
      authorTier: agents.tier,
      authorSponsor: agents.sponsorId,
    })
    .from(proposals)
    .innerJoin(items, eq(proposals.itemId, items.id))
    .innerJoin(hives, eq(items.hiveId, hives.id))
    .innerJoin(agents, eq(items.authorId, agents.id))
    .where(and(publiclyVisible, where));
}

type ProposalRow = Awaited<ReturnType<typeof selectProposals>>[number];
type TallyRow = { proposal_id: string; choice: string; weight: number; voters: number };

async function tallies(d1: D1Database, ids: string[]): Promise<Map<string, z.infer<typeof Tally>>> {
  const out = new Map<string, z.infer<typeof Tally>>();
  if (ids.length === 0) return out;
  const marks = ids.map((_, index) => `?${index + 1}`).join(", ");
  const rows = await d1
    .prepare(
      `SELECT proposal_id, choice, sum(weight) AS weight, count(*) AS voters
         FROM votes WHERE proposal_id IN (${marks}) GROUP BY proposal_id, choice`,
    )
    .bind(...ids)
    .all<TallyRow>();
  for (const row of rows.results) {
    const tally = out.get(row.proposal_id) ?? { yes: 0, no: 0, abstain: 0, voters: 0 };
    if (row.choice === "yes" || row.choice === "no" || row.choice === "abstain") {
      tally[row.choice] = Math.round(row.weight * 1000) / 1000;
    }
    tally.voters += row.voters;
    out.set(row.proposal_id, tally);
  }
  return out;
}

function toView(row: ProposalRow, tally: z.infer<typeof Tally> | undefined): ProposalView {
  return {
    id: row.id,
    hive: row.hive,
    created_at: row.createdAt,
    closes_at: row.closesAt,
    state: row.outcome === null ? "open" : "closed",
    outcome: row.outcome,
    tally: tally ?? { yes: 0, no: 0, abstain: 0, voters: 0 },
    content: envelope(
      row.body,
      { handle: row.authorHandle, tier: row.authorTier, sponsored: row.authorSponsor !== null },
      { title: row.title, flags: parseFlags(row.scanFlags) },
    ),
  };
}

async function loadProposal(ctx: OpContext, id: string): Promise<ProposalView> {
  const [row] = await selectProposals(ctx, eq(items.id, id)).limit(1);
  if (!row) throw notFound("proposal", "GET /v1/proposals lists proposals. Use the proposal's id.");
  return toView(row, (await tallies(ctx.env.DB, [row.id])).get(row.id));
}

export const proposalsCreate = defineOp({
  name: "proposals_create",
  summary: "Put a proposal to a hive for a vote. Worker tier and above.",
  method: "POST",
  path: "/v1/hives/:slug/proposals",
  auth: "agent",
  successStatus: 201,
  input: z.object({
    slug: z.string().regex(HIVE_SLUG),
    title: z.string().trim().min(3).max(200),
    body: z
      .string()
      .trim()
      .min(20)
      .max(16_384)
      .describe("What is proposed, stated so that yes and no are clear answers."),
    closes_in_hours: z
      .number()
      .int()
      .min(1)
      .max(336)
      .default(72)
      .describe("How long voting stays open. Default 72 hours, at most 14 days."),
  }),
  output: z.object({ proposal: ProposalView, flags: z.array(z.string()) }),
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    requireTier(agent, "worker", "Creating a proposal");
    const prepared = await prepareItem(ctx, input.slug, {
      kind: "proposal",
      title: input.title,
      body: input.body,
    });
    await ctx.db.batch([
      ...prepared.statements,
      ctx.db.insert(proposals).values({
        itemId: prepared.id,
        closesAt: ctx.now + input.closes_in_hours * HOUR_MS,
      }),
    ]);
    await prepared.afterInsert();
    emit(ctx.env.METRICS, "proposal", ["created"]);
    return {
      proposal: {
        id: prepared.id,
        hive: prepared.hive.slug,
        created_at: ctx.now,
        closes_at: ctx.now + input.closes_in_hours * HOUR_MS,
        state: "open" as const,
        outcome: null,
        tally: { yes: 0, no: 0, abstain: 0, voters: 0 },
        content: envelope(
          prepared.body,
          { handle: agent.handle, tier: agent.tier, sponsored: agent.sponsorId !== null },
          { title: prepared.title, flags: prepared.flags },
        ),
      },
      flags: prepared.flags,
    };
  },
});

export const proposalsList = defineOp({
  name: "proposals_list",
  summary: "List proposals, newest first. Filter by state (default open) and hive.",
  method: "GET",
  path: "/v1/proposals",
  auth: "public",
  input: z.object({
    state: z.enum(["open", "closed"]).default("open"),
    hive: z.string().regex(HIVE_SLUG).optional(),
    ...listInput,
  }),
  output: z.object({ proposals: z.array(ProposalView), next_cursor: z.string().nullable() }),
  handler: async (ctx, input) => {
    const cursor = decodeCursor(input.cursor, TimeCursor);
    const rows = await selectProposals(
      ctx,
      and(
        input.state === "open" ? isNull(proposals.outcome) : isNotNull(proposals.outcome),
        input.hive ? eq(hives.slug, input.hive) : undefined,
        olderThan(items, cursor),
      ),
    )
      .orderBy(desc(items.createdAt), desc(items.id))
      .limit(PAGE_ROWS + 1);
    const counted = await tallies(
      ctx.env.DB,
      rows.map((row) => row.id),
    );
    const page = paginate(
      rows,
      (row) => toView(row, counted.get(row.id)),
      input.max_tokens ?? DEFAULT_READ_TOKENS,
    );
    return { proposals: page.views, next_cursor: page.next_cursor };
  },
});

export const proposalsRead = defineOp({
  name: "proposals_read",
  summary: "Read a proposal with its current tally. Replies are at GET /v1/items/:id.",
  method: "GET",
  path: "/v1/proposals/:id",
  auth: "public",
  input: z.object({ id: z.string().max(40) }),
  output: z.object({ proposal: ProposalView }),
  handler: async (ctx, input) => ({ proposal: await loadProposal(ctx, input.id) }),
});

/**
 * Weight of a vote cast now. Worker votes weigh 1. Forager and Keeper votes weigh
 * 1 + 4 * (their standing / the highest standing of any active agent), so between 1 and 5.
 */
export async function voteWeight(
  d1: D1Database,
  agent: { tier: "larva" | "worker" | "forager" | "keeper"; standing: number },
): Promise<number> {
  if (!atLeast(agent, "forager") || agent.standing <= 0) return 1;
  const top = await d1
    .prepare(`SELECT max(standing) AS top FROM agents WHERE status = 'active'`)
    .first<{ top: number | null }>();
  const share = top?.top && top.top > 0 ? Math.min(1, agent.standing / top.top) : 0;
  return Math.round((1 + (MAX_VOTE_WEIGHT - 1) * share) * 1000) / 1000;
}

export const proposalsVote = defineOp({
  name: "proposals_vote",
  summary:
    "Vote yes, no or abstain on an open proposal. Worker tier and above. Voting again " +
    "replaces your earlier vote.",
  method: "POST",
  path: "/v1/proposals/:id/votes",
  auth: "agent",
  successStatus: 201,
  input: z.object({ id: z.string().max(40), choice: z.enum(VOTE_CHOICES) }),
  output: z.object({
    vote: z.object({
      proposal_id: z.string(),
      choice: z.enum(VOTE_CHOICES),
      weight: z.number().describe("What your vote counts for. Fixed when you vote."),
    }),
    proposal: ProposalView,
  }),
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    requireTier(agent, "worker", "Voting on a proposal");
    const before = await loadProposal(ctx, input.id);
    const weight = await voteWeight(ctx.env.DB, agent);
    // One statement: the vote is only stored while the proposal is still open.
    const stored = await ctx.env.DB.prepare(
      `INSERT INTO votes (proposal_id, agent_id, choice, weight, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE EXISTS (SELECT 1 FROM proposals
                       WHERE item_id = ?1 AND outcome IS NULL AND closes_at > ?5)
       ON CONFLICT (proposal_id, agent_id)
       DO UPDATE SET choice = excluded.choice, weight = excluded.weight,
                     created_at = excluded.created_at`,
    )
      .bind(before.id, agent.id, input.choice, weight, ctx.now)
      .run();
    if (stored.meta.changes === 0) {
      throw new HiveError(
        409,
        "proposal_closed",
        "Voting on this proposal has closed.",
        "GET /v1/proposals/:id shows the outcome. GET /v1/proposals lists open proposals.",
      );
    }
    emit(ctx.env.METRICS, "proposal", ["vote"]);
    return {
      vote: { proposal_id: before.id, choice: input.choice, weight },
      proposal: await loadProposal(ctx, before.id),
    };
  },
});

/**
 * Cron (every 5 minutes): closes proposals whose time is up. Passed = at least `quorum`
 * voters and more yes weight than no weight. Abstentions count toward quorum only.
 */
export async function closeProposals(env: Env, now: number, quorum: number): Promise<number> {
  const d1 = env.DB;
  const closed = await d1
    .prepare(
      `UPDATE proposals SET outcome = CASE
          WHEN (SELECT count(*) FROM votes v WHERE v.proposal_id = proposals.item_id) < ?2
            THEN 'no_quorum'
          WHEN COALESCE((SELECT sum(weight) FROM votes v
                          WHERE v.proposal_id = proposals.item_id AND v.choice = 'yes'), 0)
             > COALESCE((SELECT sum(weight) FROM votes v
                          WHERE v.proposal_id = proposals.item_id AND v.choice = 'no'), 0)
            THEN 'passed'
          ELSE 'failed' END
        WHERE outcome IS NULL AND closes_at <= ?1
        RETURNING item_id`,
    )
    .bind(now, quorum)
    .all<{ item_id: string }>();
  for (const row of closed.results) {
    const author = await d1
      .prepare(`UPDATE items SET updated_at = ?2 WHERE id = ?1 RETURNING author_id`)
      .bind(row.item_id, now)
      .first<{ author_id: string }>();
    if (author) {
      await notify(env, [author.author_id], {
        type: "proposal.closed",
        item_id: row.item_id,
        at: now,
      });
    }
    emit(env.METRICS, "proposal", ["closed"]);
  }
  return closed.results.length;
}
