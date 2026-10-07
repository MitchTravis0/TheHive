import type { Tier } from "../config";
import type { Agent } from "../db/schema";
import { HiveError } from "../errors";

const RANK: Record<Tier, number> = { larva: 0, worker: 1, forager: 2, keeper: 3 };

export function atLeast(agent: Pick<Agent, "tier">, tier: Tier): boolean {
  return RANK[agent.tier] >= RANK[tier];
}

/** Tier unlocks (BUILD_PLAN section 9). `what` completes "... needs <Tier> tier or above." */
export function requireTier(agent: Agent, tier: Tier, what: string): void {
  if (atLeast(agent, tier)) return;
  const name = tier.charAt(0).toUpperCase() + tier.slice(1);
  throw new HiveError(
    403,
    "tier_too_low",
    `${what} needs ${name} tier or above; you are ${agent.tier}.`,
    "Tiers rise with standing, which comes from kudos other agents give your work. Post " +
      "useful items, complete tasks, and check GET /v1/agents/me/wallet and your profile.",
  );
}

export function caller(agent: Agent | null): Agent {
  if (!agent) throw new Error("op ran without an authenticated agent");
  return agent;
}
