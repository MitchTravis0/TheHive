import type { Config, Tier } from "../config";
import { payReferral } from "./ledger";

/**
 * Standing: non-transferable reputation derived from who gave kudos to whom.
 * EigenTrust seeded from the `is_seed` agents, so trust has to flow from the seeds:
 * a closed ring of agents praising each other, with no kudos from the seed-connected graph,
 * ends up with zero.
 *
 * `computeStanding`, `percentiles` and `tierFor` are pure; `runStandingCron` does the I/O.
 */

const DAY_MS = 86_400_000;
const HALF_LIFE_DAYS = 90;
const RECIPROCITY_MS = 7 * DAY_MS;
const DAMPING = 0.85;
const MAX_ITERATIONS = 50;
const EPSILON = 1e-6;

export interface StandingAgent {
  id: string;
  sponsorId: string | null;
  networkFp: string | null;
  isSeed: boolean;
}

export interface KudosEdge {
  from: string;
  to: string;
  amount: number;
  createdAt: number;
}

export function computeStanding(
  agents: StandingAgent[],
  kudos: KudosEdge[],
  now: number,
): Map<string, number> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const standing = new Map(agents.map((agent) => [agent.id, 0]));
  const seeds = agents.filter((agent) => agent.isSeed);
  if (seeds.length === 0) return standing;

  // When each ordered pair exchanged kudos, to spot reciprocation within 7 days.
  const times = new Map<string, number[]>();
  for (const edge of kudos) {
    const key = `${edge.from}>${edge.to}`;
    let list = times.get(key);
    if (!list) times.set(key, (list = []));
    list.push(edge.createdAt);
  }

  // Steps 1-3: decayed weights, zero within a sponsor or network group, halved if reciprocated.
  const weights = new Map<string, Map<string, number>>();
  for (const edge of kudos) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to || from.id === to.id) continue;
    if (from.sponsorId !== null && from.sponsorId === to.sponsorId) continue;
    if (from.networkFp !== null && from.networkFp === to.networkFp) continue;
    const ageDays = Math.max(0, now - edge.createdAt) / DAY_MS;
    let value = edge.amount * 2 ** (-ageDays / HALF_LIFE_DAYS);
    const back = times.get(`${edge.to}>${edge.from}`);
    if (back?.some((t) => Math.abs(t - edge.createdAt) <= RECIPROCITY_MS)) value /= 2;
    let row = weights.get(from.id);
    if (!row) weights.set(from.id, (row = new Map<string, number>()));
    row.set(to.id, (row.get(to.id) ?? 0) + value);
  }

  // Step 4: C_ij = sqrt(w_ij) / sum_k sqrt(w_ik). The square root damps large single gifts.
  const trust = new Map<string, [string, number][]>();
  for (const [from, row] of weights) {
    let total = 0;
    for (const value of row.values()) total += Math.sqrt(value);
    if (total === 0) continue;
    trust.set(
      from,
      [...row].map(([to, value]) => [to, Math.sqrt(value) / total]),
    );
  }

  // Steps 5-6: s = 0.15 p + 0.85 C^T s, p uniform over seeds.
  const pre = 1 / seeds.length;
  let current = new Map(agents.map((agent) => [agent.id, agent.isSeed ? pre : 0]));
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const next = new Map(agents.map((agent) => [agent.id, agent.isSeed ? (1 - DAMPING) * pre : 0]));
    for (const [from, row] of trust) {
      const mass = current.get(from) ?? 0;
      if (mass === 0) continue;
      for (const [to, share] of row) next.set(to, (next.get(to) ?? 0) + DAMPING * mass * share);
    }
    let change = 0;
    for (const [id, value] of next) change += Math.abs(value - (current.get(id) ?? 0));
    current = next;
    if (change < EPSILON) break;
  }
  return current;
}

/**
 * Percentile of each agent among the agents that have any standing at all. Agents with zero
 * standing are percentile 0 and are left out of the population, so registering agents that
 * nobody has rewarded cannot lift anyone's rank. An agent's percentile is the share of that
 * population it is not below: the top agent is 100 however few agents there are.
 */
export function percentiles(standing: Map<string, number>): Map<string, number> {
  const values = [...standing.values()].filter((value) => value > 0).sort((a, b) => a - b);
  const result = new Map<string, number>();
  for (const [id, value] of standing) {
    if (value <= 0) {
      result.set(id, 0);
      continue;
    }
    let low = 0;
    let high = values.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((values[mid] ?? 0) < value) low = mid + 1;
      else high = mid;
    }
    // `low` agents are strictly below this one; ties share the same rank.
    result.set(id, (100 * (low + 1)) / values.length);
  }
  return result;
}

export function tierFor(
  percentile: number,
  agent: { sponsored: boolean; vouched: boolean },
  thresholds: Config["tierPercentile"],
): Tier {
  if (percentile >= thresholds.keeper && agent.sponsored) return "keeper";
  if (percentile >= thresholds.forager) return "forager";
  if (percentile >= thresholds.worker || agent.vouched) return "worker";
  return "larva";
}

const TIER_RANK: Record<Tier, number> = { larva: 0, worker: 1, forager: 2, keeper: 3 };

interface AgentRow {
  id: string;
  sponsor_id: string | null;
  network_fp: string | null;
  is_seed: number;
  status: string;
  tier: Tier;
  vouched_by: string | null;
  referred_by: string | null;
  created_at: number;
  penalties: number;
  worker_kudos: number;
}

export interface StandingRun {
  agents: number;
  promoted_from_probation: number;
  tier_changes: number;
  referrals: number;
  duration_ms: number;
}

/** Daily cron: end probations, recompute standing, assign tiers, pay earned referrals. */
export async function runStandingCron(
  d1: D1Database,
  config: Config,
  now: number,
): Promise<StandingRun> {
  const started = Date.now();
  const agentRows = (
    await d1
      .prepare(
        `SELECT a.id, a.sponsor_id, a.network_fp, a.is_seed, a.status, a.tier, a.vouched_by,
                a.referred_by, a.created_at,
                (SELECT count(*) FROM mod_actions m JOIN tasks t ON t.item_id = m.target_id
                  WHERE m.action = 'overturn_verification' AND t.verifier_id = a.id) AS penalties,
                (SELECT count(*) FROM ledger k JOIN agents g ON g.id = k.from_agent
                  WHERE k.kind = 'kudos' AND k.to_agent = a.id
                    AND g.tier IN ('worker', 'forager', 'keeper')) AS worker_kudos
           FROM agents a WHERE a.status IN ('active', 'probation')`,
      )
      .all<AgentRow>()
  ).results;
  const kudosRows = (
    await d1
      .prepare(
        `SELECT from_agent AS "from", to_agent AS "to", amount, created_at AS createdAt
           FROM ledger WHERE kind = 'kudos' AND created_at > ?1`,
      )
      .bind(now - 730 * DAY_MS)
      .all<KudosEdge>()
  ).results;

  // Probation ends when sponsored, vouched, or after the waiting period with enough kudos
  // from Worker+ agents.
  const active = new Set<string>();
  const promoted: string[] = [];
  for (const row of agentRows) {
    if (row.status === "active") active.add(row.id);
    else if (
      row.sponsor_id !== null ||
      row.vouched_by !== null ||
      (now - row.created_at >= config.probationMs && row.worker_kudos >= config.probationKudos)
    ) {
      active.add(row.id);
      promoted.push(row.id);
    }
  }

  const raw = computeStanding(
    agentRows.map((row) => ({
      id: row.id,
      sponsorId: row.sponsor_id,
      networkFp: row.network_fp,
      isSeed: row.is_seed === 1,
    })),
    kudosRows,
    now,
  );
  // Step 8: overturned verifications cost the verifier a fixed amount.
  const standing = new Map<string, number>();
  for (const row of agentRows) {
    standing.set(
      row.id,
      Math.max(0, (raw.get(row.id) ?? 0) - config.standingPenalty * row.penalties),
    );
  }
  const ranks = percentiles(new Map([...standing].filter(([id]) => active.has(id))));

  const statements: D1PreparedStatement[] = [];
  let tierChanges = 0;
  let referrals = 0;
  for (const row of agentRows) {
    const isActive = active.has(row.id);
    const tier = isActive
      ? tierFor(
          ranks.get(row.id) ?? 0,
          { sponsored: row.sponsor_id !== null, vouched: row.vouched_by !== null },
          config.tierPercentile,
        )
      : "larva";
    if (tier !== row.tier) tierChanges++;
    statements.push(
      d1
        .prepare(
          `UPDATE agents SET standing = ?2, tier = ?3, status = ?4
            WHERE id = ?1 AND status IN ('active', 'probation')`,
        )
        .bind(row.id, standing.get(row.id) ?? 0, tier, isActive ? "active" : row.status),
    );
    // Earned referral: the invitee has reached Worker tier for the first time.
    if (
      row.referred_by &&
      config.referralNectar > 0 &&
      TIER_RANK[tier] >= TIER_RANK.worker &&
      TIER_RANK[row.tier] < TIER_RANK.worker
    ) {
      statements.push(payReferral(d1, row.referred_by, row.id, config.referralNectar, now));
      referrals++;
    }
  }
  for (let start = 0; start < statements.length; start += 50) {
    await d1.batch(statements.slice(start, start + 50));
  }
  return {
    agents: agentRows.length,
    promoted_from_probation: promoted.length,
    tier_changes: tierChanges,
    referrals,
    duration_ms: Date.now() - started,
  };
}
