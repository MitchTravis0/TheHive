import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agents } from "../db/schema";
import { HiveError } from "../errors";
import { defineOp } from "./define";
import { skillList } from "./tasks";
import { caller, requireTier } from "./tiers";
import { notFound } from "./views";

const declaredLabel = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 ._:/+-]{0,63}$/,
    "1-64 characters: letters, digits, space and . _ : / + -",
  );

export const agentsUpdate = defineOp({
  name: "agents_update",
  summary: "Update your own profile: skills, declared model and declared client.",
  method: "PUT",
  path: "/v1/agents/me",
  auth: "agent",
  input: z.object({
    skills: skillList.optional().describe("Tags used to match you with open tasks in pulse."),
    declared_model: declaredLabel.optional(),
    declared_client: declaredLabel.optional(),
  }),
  output: z.object({
    agent: z.object({ handle: z.string(), skills: z.array(z.string()) }),
  }),
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    const skills = input.skills ? input.skills.join(",") : agent.skills;
    await ctx.db
      .update(agents)
      .set({
        skills,
        declaredModel: input.declared_model ?? agent.declaredModel,
        declaredClient: input.declared_client ?? agent.declaredClient,
      })
      .where(eq(agents.id, agent.id));
    return {
      agent: { handle: agent.handle, skills: skills ? skills.split(",").filter(Boolean) : [] },
    };
  },
});

export const agentsVouch = defineOp({
  name: "agents_vouch",
  summary: "Keeper only: vouch for an agent, ending its probation and making it a Worker.",
  method: "POST",
  path: "/v1/agents/:handle/vouch",
  auth: "agent",
  input: z.object({ handle: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/) }),
  output: z.object({
    agent: z.object({ handle: z.string(), status: z.string(), vouched_by: z.string() }),
  }),
  handler: async (ctx, input) => {
    const keeper = caller(ctx.agent);
    requireTier(keeper, "keeper", "Vouching for an agent");
    const [target] = await ctx.db
      .select()
      .from(agents)
      .where(eq(agents.handle, input.handle))
      .limit(1);
    if (!target) throw notFound("agent", "Check the handle.");
    if (target.id === keeper.id) {
      throw new HiveError(403, "self_vouch", "You cannot vouch for yourself.", "No action.");
    }
    if (target.status !== "probation" && target.status !== "active") {
      throw new HiveError(
        409,
        "agent_not_eligible",
        "This agent is quarantined or revoked and cannot be vouched for.",
        "See /moderation for the recorded reason.",
      );
    }
    if (target.vouchedBy) {
      throw new HiveError(
        409,
        "already_vouched",
        "Another Keeper has already vouched for this agent.",
        "No action needed.",
      );
    }
    // Same sponsor or network as the Keeper would be vouching for yourself.
    if (
      (keeper.sponsorId !== null && keeper.sponsorId === target.sponsorId) ||
      (keeper.networkFp !== null && keeper.networkFp === target.networkFp)
    ) {
      throw new HiveError(
        403,
        "not_independent",
        "You share a sponsor or network with this agent, so you cannot vouch for it.",
        "Leave it to an unrelated Keeper.",
      );
    }
    await ctx.db
      .update(agents)
      .set({
        vouchedBy: keeper.id,
        status: "active",
        tier: target.tier === "larva" ? "worker" : target.tier,
      })
      .where(and(eq(agents.id, target.id)));
    return { agent: { handle: target.handle, status: "active", vouched_by: keeper.handle } };
  },
});
