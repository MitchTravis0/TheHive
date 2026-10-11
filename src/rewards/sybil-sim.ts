import { loadConfig } from "../config";
import {
  computeStanding,
  type KudosEdge,
  percentiles,
  type StandingAgent,
  tierFor,
} from "./standing";

/**
 * Sybil simulation. A ring of fake agents, all unsponsored and on distinct
 * networks, give each other the maximum kudos every week. Alongside them a small honest
 * community works normally around the seed agents. The ring must end at Larva.
 */

export interface SybilOptions {
  ringSize?: number;
  honest?: number;
  seeds?: number;
  weeks?: number;
  /** Kudos the ring manages to obtain from honest agents (0 = fully closed ring). */
  leakedKudos?: number;
  random?: () => number;
}

export interface SybilResult {
  tiers: Map<string, string>;
  standing: Map<string, number>;
  ringTotal: number;
  minSeed: number;
  ringTiers: Record<string, number>;
  honestTiers: Record<string, number>;
}

const DAY_MS = 86_400_000;

export function simulateSybilRing(options: SybilOptions = {}): SybilResult {
  const ringSize = options.ringSize ?? 50;
  const honestCount = options.honest ?? 30;
  const seedCount = options.seeds ?? 3;
  const weeks = options.weeks ?? 4;
  const random = options.random ?? Math.random;
  const now = weeks * 7 * DAY_MS;
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)] as T;

  const agent = (id: string, isSeed = false): StandingAgent => ({
    id,
    sponsorId: null,
    networkFp: `net-${id}`,
    isSeed,
  });
  const seeds = Array.from({ length: seedCount }, (_, i) => agent(`seed-${i}`, true));
  const honest = Array.from({ length: honestCount }, (_, i) => agent(`honest-${i}`));
  const ring = Array.from({ length: ringSize }, (_, i) => agent(`ring-${i}`));
  const community = [...seeds, ...honest];

  const kudos: KudosEdge[] = [];
  for (let week = 0; week < weeks; week++) {
    const at = week * 7 * DAY_MS + DAY_MS;
    // Honest community: each agent rewards a few others for real work.
    for (const giver of community) {
      for (let n = 0; n < 4; n++) {
        const to = pick(community);
        if (to.id !== giver.id) {
          kudos.push({
            from: giver.id,
            to: to.id,
            amount: 1 + Math.floor(random() * 5),
            createdAt: at,
          });
        }
      }
    }
    // The ring: every member gives the maximum to its neighbours, every week.
    for (let i = 0; i < ringSize; i++) {
      for (const step of [1, 2, 3]) {
        const to = ring[(i + step) % ringSize];
        const from = ring[i];
        if (from && to) kudos.push({ from: from.id, to: to.id, amount: 10, createdAt: at });
      }
    }
  }
  for (let n = 0; n < (options.leakedKudos ?? 0); n++) {
    kudos.push({ from: pick(honest).id, to: pick(ring).id, amount: 1, createdAt: now - DAY_MS });
  }

  const all = [...community, ...ring];
  const standing = computeStanding(all, kudos, now);
  const ranks = percentiles(standing);
  const thresholds = loadConfig({ DB: undefined as never }).tierPercentile;
  const tiers = new Map(
    all.map((a) => [
      a.id,
      tierFor(ranks.get(a.id) ?? 0, { sponsored: false, vouched: false }, thresholds),
    ]),
  );
  const count = (list: StandingAgent[]) => {
    const totals: Record<string, number> = {};
    for (const a of list)
      totals[tiers.get(a.id) ?? "larva"] = (totals[tiers.get(a.id) ?? "larva"] ?? 0) + 1;
    return totals;
  };
  return {
    tiers,
    standing,
    ringTotal: ring.reduce((sum, a) => sum + (standing.get(a.id) ?? 0), 0),
    minSeed: Math.min(...seeds.map((a) => standing.get(a.id) ?? 0)),
    ringTiers: count(ring),
    honestTiers: count(honest),
  };
}
