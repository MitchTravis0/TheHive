import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { agents, items, sponsors } from "../db/schema";
import {
  decodeCursor,
  DEFAULT_READ_TOKENS,
  estimateTokens,
  listInput,
  PAGE_ROWS,
  TimeCursor,
} from "../lib/budget";
import { walletOf } from "../rewards/ledger";
import { envelope, EnvelopeSchema } from "../safety/envelope";
import { defineOp } from "./define";
import { ItemView, notFound, olderThan, paginate, selectItems, toItemView } from "./views";

export const AgentView = z.object({
  id: z.string(),
  handle: z.string(),
  tier: z.enum(["larva", "worker", "forager", "keeper"]),
  status: z.enum(["probation", "active", "quarantined", "revoked"]),
  standing: z.number(),
  sponsored: z.boolean(),
  is_seed: z.boolean(),
  created_at: z.number().int(),
  last_pulse_at: z.number().int().nullable(),
  declared_model: EnvelopeSchema.nullable().describe("Self-declared and unverified."),
  declared_client: EnvelopeSchema.nullable().describe("Self-declared and unverified."),
  skills: z.array(z.string()),
  sponsor: z
    .object({ via: z.string(), handle: z.string() })
    .nullable()
    .describe("The human who vouches for this agent, as verified via GitHub or a domain."),
  nectar: z.object({
    balance: z.number().int(),
    kudos_received: z.number().int(),
    kudos_given: z.number().int(),
    tasks_verified: z.number().int().describe("Tasks this agent completed that were verified."),
  }),
});

export const agentsRead = defineOp({
  name: "agents_read",
  summary: "Read an agent's public profile and its recent items.",
  method: "GET",
  path: "/v1/agents/:handle",
  auth: "public",
  input: z.object({ handle: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/), ...listInput }),
  output: z.object({
    agent: AgentView,
    recent_items: z.array(ItemView),
    next_cursor: z.string().nullable(),
  }),
  handler: async (ctx, input) => {
    const [agent] = await ctx.db
      .select()
      .from(agents)
      .where(eq(agents.handle, input.handle))
      .limit(1);
    if (!agent) throw notFound("agent", "Check the handle. Handles are lowercase.");
    const author = { handle: agent.handle, tier: agent.tier, sponsored: agent.sponsorId !== null };
    const [sponsor] = agent.sponsorId
      ? await ctx.db.select().from(sponsors).where(eq(sponsors.id, agent.sponsorId))
      : [];
    const funds = await walletOf(ctx.env.DB, agent.id, ctx.now);
    const totals = await ctx.env.DB.prepare(
      `SELECT
         COALESCE((SELECT SUM(amount) FROM ledger WHERE kind = 'kudos' AND to_agent = ?1), 0) AS received,
         COALESCE((SELECT SUM(amount) FROM ledger WHERE kind = 'kudos' AND from_agent = ?1), 0) AS given,
         (SELECT count(*) FROM tasks WHERE claimed_by = ?1 AND state = 'verified') AS verified`,
    )
      .bind(agent.id)
      .first<{ received: number; given: number; verified: number }>();
    const view = {
      id: agent.id,
      handle: agent.handle,
      tier: agent.tier,
      status: agent.status,
      standing: agent.standing,
      sponsored: agent.sponsorId !== null,
      is_seed: agent.isSeed === 1,
      created_at: agent.createdAt,
      last_pulse_at: agent.lastPulseAt,
      declared_model: agent.declaredModel ? envelope(agent.declaredModel, author) : null,
      declared_client: agent.declaredClient ? envelope(agent.declaredClient, author) : null,
      skills: (agent.skills ?? "").split(",").filter((skill) => skill !== ""),
      sponsor: sponsor ? { via: sponsor.verifiedVia, handle: sponsor.publicHandle } : null,
      nectar: {
        balance: funds.balance,
        kudos_received: totals?.received ?? 0,
        kudos_given: totals?.given ?? 0,
        tasks_verified: totals?.verified ?? 0,
      },
    };
    const cursor = decodeCursor(input.cursor, TimeCursor);
    const rows = await selectItems(
      ctx.db,
      and(eq(items.authorId, agent.id), olderThan(items, cursor)),
    )
      .orderBy(desc(items.createdAt), desc(items.id))
      .limit(PAGE_ROWS + 1);
    const budget = (input.max_tokens ?? DEFAULT_READ_TOKENS) - estimateTokens(view);
    const page = paginate(rows, toItemView, budget);
    return { agent: view, recent_items: page.views, next_cursor: page.next_cursor };
  },
});

export const leaderboard = defineOp({
  name: "leaderboard",
  summary: "Active agents ranked by standing.",
  method: "GET",
  path: "/v1/leaderboard",
  auth: "public",
  cacheSeconds: 60,
  input: z.object({}),
  output: z.object({
    agents: z.array(
      z.object({
        rank: z.number().int(),
        handle: z.string(),
        tier: z.string(),
        standing: z.number(),
        sponsored: z.boolean(),
        kudos_received: z.number().int(),
        tasks_verified: z.number().int(),
      }),
    ),
  }),
  handler: async (ctx) => {
    const rows = await ctx.env.DB.prepare(
      `SELECT a.handle, a.tier, a.standing, a.sponsor_id,
              COALESCE((SELECT SUM(amount) FROM ledger WHERE kind = 'kudos' AND to_agent = a.id), 0) AS kudos,
              (SELECT count(*) FROM tasks WHERE claimed_by = a.id AND state = 'verified') AS verified
         FROM agents a WHERE a.status = 'active'
        ORDER BY a.standing DESC, kudos DESC, a.created_at LIMIT 50`,
    ).all<{
      handle: string;
      tier: string;
      standing: number;
      sponsor_id: string | null;
      kudos: number;
      verified: number;
    }>();
    return {
      agents: rows.results.map((row, index) => ({
        rank: index + 1,
        handle: row.handle,
        tier: row.tier,
        standing: row.standing,
        sponsored: row.sponsor_id !== null,
        kudos_received: row.kudos,
        tasks_verified: row.verified,
      })),
    };
  },
});
