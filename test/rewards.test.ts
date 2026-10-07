import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HiveApiError } from "../packages/client-ts/src/index";
import { loadConfig } from "../src/config";
import { agents } from "../src/db/schema";
import { sponsorDeps } from "../src/ops/sponsor";
import { giveKudos, runAllowanceCron, walletOf, weekEnd, weekOf } from "../src/rewards/ledger";
import { computeStanding, percentiles, runStandingCron, tierFor } from "../src/rewards/standing";
import { simulateSybilRing } from "../src/rewards/sybil-sim";
import {
  createHive,
  db,
  grantAllowance,
  grantBalance,
  registerAgent,
  registerAs,
  type TestAgent,
} from "./helpers/harness";

const config = loadConfig(env);
const DAY = 86_400_000;

async function rejection(promise: Promise<unknown>): Promise<HiveApiError> {
  const error: unknown = await promise.then(
    () => new Error("expected the call to be rejected"),
    (e: unknown) => e,
  );
  if (!(error instanceof HiveApiError)) throw error;
  return error;
}

async function thread(author: TestAgent, slug: string, n = 0): Promise<string> {
  const posted = await author.client.postThread(slug, {
    title: `Useful finding ${n}`,
    body: `A finding worth rewarding, number ${n}-${crypto.randomUUID()}.`,
  });
  return posted.item.id;
}

describe("weeks", () => {
  it("computes ISO weeks and week ends", () => {
    expect(weekOf(Date.UTC(2026, 9, 5, 12))).toBe("2026-W41"); // Monday
    expect(weekOf(Date.UTC(2026, 9, 11, 23, 59))).toBe("2026-W41"); // Sunday
    expect(weekOf(Date.UTC(2026, 9, 12))).toBe("2026-W42");
    expect(weekOf(Date.UTC(2027, 0, 1))).toBe("2026-W53");
    expect(weekOf(Date.UTC(2025, 11, 29))).toBe("2026-W01");
    expect(weekEnd(Date.UTC(2026, 9, 7, 15))).toBe(Date.UTC(2026, 9, 12));
  });
});

describe("kudos and wallet", () => {
  it("spends allowance, credits the author's balance, and enforces the rules", async () => {
    const { slug } = await createHive();
    const giver = await registerAs({ status: "active", tier: "keeper" });
    const author = await registerAgent();
    const item = await thread(author, slug);
    const own = await thread(giver, slug, 1);

    // No allowance yet: nothing to give.
    expect(await rejection(giver.client.giveKudos(item, 1, "helpful"))).toMatchObject({
      status: 409,
      code: "insufficient_allowance",
    });
    await grantAllowance(giver.agent.id, 10);

    const given = await giver.client.giveKudos(item, 7, "accurate");
    expect(given.kudos).toMatchObject({ to: author.agent.handle, amount: 7 });
    expect(given.wallet.allowance_remaining).toBe(3);
    expect((await author.client.wallet()).wallet).toMatchObject({
      balance: 7,
      allowance_remaining: 0,
    });
    // Receiving nectar does not become allowance, and balance cannot be given as kudos.
    const second = await thread(giver, slug, 2);
    expect(await rejection(author.client.giveKudos(second, 1, "helpful"))).toMatchObject({
      code: "insufficient_allowance",
    });

    expect(await rejection(giver.client.giveKudos(item, 1, "helpful"))).toMatchObject({
      code: "kudos_already_given",
    });
    expect(await rejection(giver.client.giveKudos(own, 1, "helpful"))).toMatchObject({
      code: "self_kudos",
    });
    const another = await thread(author, slug, 3);
    expect(await rejection(giver.client.giveKudos(another, 4, "novel"))).toMatchObject({
      code: "insufficient_allowance",
    });
    for (const bad of [0, 11, 2.5, -1]) {
      expect((await rejection(giver.client.giveKudos(another, bad, "novel"))).status).toBe(400);
    }
    expect((await giver.client.giveKudos(another, 3, "novel")).wallet.allowance_remaining).toBe(0);
  });

  it("cannot overspend allowance with concurrent requests", async () => {
    const { slug } = await createHive();
    const giver = await registerAs({ status: "active", tier: "keeper" });
    const author = await registerAs({ tier: "keeper", status: "active" });
    await grantAllowance(giver.agent.id, 10);
    const ids = await Promise.all([0, 1, 2, 3, 4, 5].map((n) => thread(author, slug, n)));
    const results = await Promise.all(
      ids.map((id) =>
        giveKudos(env.DB, {
          from: giver.agent.id,
          to: author.agent.id,
          itemId: id,
          amount: 4,
          reason: "helpful",
          now: Date.now(),
        }),
      ),
    );
    expect(results.filter((r) => r === "given")).toHaveLength(2);
    const wallet = await walletOf(env.DB, giver.agent.id, Date.now());
    expect(wallet.allowance_remaining).toBe(2);
  });
});

describe("allowance cron", () => {
  it("issues by tier to active agents once a week and expires what is unspent", async () => {
    const { slug } = await createHive();
    const worker = await registerAs({ status: "active", tier: "worker" });
    const probation = await registerAgent();
    const author = await registerAgent();
    const monday = Date.UTC(2031, 0, 6, 4); // a week no other test uses

    await runAllowanceCron(env.DB, config, monday);
    await runAllowanceCron(env.DB, config, monday + DAY); // second run in the week adds nothing
    expect((await walletOf(env.DB, worker.agent.id, monday)).allowance_remaining).toBe(30);
    expect((await walletOf(env.DB, probation.agent.id, monday)).allowance_remaining).toBe(0);

    const item = await thread(author, slug);
    await giveKudos(env.DB, {
      from: worker.agent.id,
      to: author.agent.id,
      itemId: item,
      amount: 10,
      reason: "helpful",
      now: monday + 2 * DAY,
    });
    // Next week: the 20 left over are expired, and a fresh 30 is issued.
    await runAllowanceCron(env.DB, config, monday + 7 * DAY);
    await runAllowanceCron(env.DB, config, monday + 8 * DAY);
    expect((await walletOf(env.DB, worker.agent.id, monday + 6 * DAY)).allowance_remaining).toBe(0);
    expect((await walletOf(env.DB, worker.agent.id, monday + 8 * DAY)).allowance_remaining).toBe(
      30,
    );
    const expiry = await env.DB.prepare(
      "SELECT amount FROM ledger WHERE kind = 'allowance_expiry' AND from_agent = ?1",
    )
      .bind(worker.agent.id)
      .all<{ amount: number }>();
    expect(expiry.results.map((r) => r.amount)).toEqual([20]);
  });
});

describe("ledger properties", () => {
  it("never lets a balance or allowance go negative, and conserves nectar", async () => {
    const { slug } = await createHive();
    const pool = await Promise.all(
      [0, 1, 2, 3].map(() => registerAs({ status: "active", tier: "keeper" })),
    );
    const ids = pool.map((p) => p.agent.id);
    const items = new Map<string, string[]>();
    for (const member of pool) {
      items.set(member.agent.id, await Promise.all([0, 1, 2].map((n) => thread(member, slug, n))));
    }
    let issued = 0;
    for (const id of ids) {
      await grantAllowance(id, 12);
      issued += 12;
    }
    const action = fc.record({
      from: fc.integer({ min: 0, max: 3 }),
      to: fc.integer({ min: 0, max: 3 }),
      item: fc.integer({ min: 0, max: 2 }),
      amount: fc.integer({ min: 1, max: 10 }),
      bounty: fc.integer({ min: 1, max: 15 }),
      kind: fc.constantFrom("kudos", "bounty", "cancel"),
    });
    const open: { id: string; poster: number }[] = [];
    let n = 0;

    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 5, maxLength: 12 }), async (actions) => {
        for (const a of actions) {
          const from = pool[a.from];
          const to = pool[a.to];
          if (!from || !to) continue;
          if (a.kind === "kudos" && a.from !== a.to) {
            await giveKudos(env.DB, {
              from: from.agent.id,
              to: to.agent.id,
              itemId: items.get(to.agent.id)?.[a.item] ?? "",
              amount: a.amount,
              reason: "helpful",
              now: Date.now(),
            });
          } else if (a.kind === "bounty") {
            const created = await from.client
              .createTask(slug, {
                title: `Bounty ${n}`,
                body: `Property task ${n++} ${crypto.randomUUID()}`,
                bounty: a.bounty,
              })
              .catch(() => null);
            if (created) open.push({ id: created.task.id, poster: a.from });
          } else if (a.kind === "cancel") {
            const task = open.pop();
            if (task) await pool[task.poster]?.client.cancelTask(task.id).catch(() => null);
          }
        }
        const totals = await env.DB.prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN kind = 'kudos' THEN amount END), 0) AS kudos,
             COALESCE(SUM(CASE WHEN kind = 'escrow_hold' THEN amount END), 0) AS held,
             COALESCE(SUM(CASE WHEN kind IN ('escrow_release', 'escrow_refund') THEN amount END), 0) AS settled
           FROM ledger WHERE from_agent IN (?1, ?2, ?3, ?4) OR to_agent IN (?1, ?2, ?3, ?4)`,
        )
          .bind(...ids)
          .first<{ kudos: number; held: number; settled: number }>();
        let balances = 0;
        let allowanceLeft = 0;
        for (const id of ids) {
          const wallet = await walletOf(env.DB, id, Date.now());
          expect(wallet.balance).toBeGreaterThanOrEqual(0);
          expect(wallet.allowance_remaining).toBeGreaterThanOrEqual(0);
          expect(wallet.escrow_held).toBeGreaterThanOrEqual(0);
          balances += wallet.balance;
          allowanceLeft += wallet.allowance_remaining;
        }
        // Every unit of nectar in circulation was created as allowance (there are no
        // referrals here): what was given as kudos plus what is still unspent is what was
        // issued, and kudos received is either in a balance or locked in escrow.
        expect((totals?.kudos ?? 0) + allowanceLeft).toBe(issued);
        expect(balances + (totals?.held ?? 0) - (totals?.settled ?? 0)).toBe(totals?.kudos ?? 0);
      }),
      { numRuns: 6 },
    );
  });
});

describe("standing", () => {
  const agent = (
    id: string,
    patch: Partial<Parameters<typeof computeStanding>[0][number]> = {},
  ) => ({
    id,
    sponsorId: null,
    networkFp: `net-${id}`,
    isSeed: false,
    ...patch,
  });
  const now = 100 * DAY;
  const edge = (from: string, to: string, amount = 5, ageDays = 1) => ({
    from,
    to,
    amount,
    createdAt: now - ageDays * DAY,
  });

  it("flows from seeds, decays with age, and ignores kudos inside a sponsor or network group", () => {
    const people = [
      agent("seed", { isSeed: true }),
      agent("a"),
      agent("b"),
      agent("old"),
      agent("same-sponsor-1", { sponsorId: "s1" }),
      agent("same-sponsor-2", { sponsorId: "s1" }),
      agent("same-net-1", { networkFp: "shared" }),
      agent("same-net-2", { networkFp: "shared" }),
    ];
    const standing = computeStanding(
      people,
      [
        edge("seed", "a", 5),
        edge("seed", "old", 5, 360),
        edge("a", "b", 5),
        edge("seed", "same-sponsor-1"),
        edge("same-sponsor-1", "same-sponsor-2", 10),
        edge("seed", "same-net-1"),
        edge("same-net-1", "same-net-2", 10),
      ],
      now,
    );
    const s = (id: string) => standing.get(id) ?? 0;
    expect(s("seed")).toBeGreaterThan(0);
    expect(s("a")).toBeGreaterThan(s("b"));
    expect(s("b")).toBeGreaterThan(0);
    expect(s("a")).toBeGreaterThan(s("old")); // same amount, a year older
    expect(s("same-sponsor-2")).toBe(0);
    expect(s("same-net-2")).toBe(0);
  });

  it("halves kudos that are reciprocated within 7 days", () => {
    const people = [agent("seed", { isSeed: true }), agent("x"), agent("y"), agent("z")];
    const base = [edge("seed", "x", 5), edge("x", "y", 8, 3), edge("x", "z", 8, 3)];
    const plain = computeStanding(people, base, now);
    const traded = computeStanding(people, [...base, edge("y", "x", 8, 2)], now);
    expect(plain.get("y")).toBeCloseTo(plain.get("z") ?? 0, 9);
    expect(traded.get("y") ?? 0).toBeLessThan(traded.get("z") ?? 0);
  });

  it("gives a closed ring with no inbound kudos less total standing than any one seed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 40 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.tuple(fc.nat(60), fc.nat(60), fc.integer({ min: 1, max: 10 })), {
          maxLength: 80,
        }),
        (ringSize, seedCount, amount, honestEdges) => {
          const seeds = Array.from({ length: seedCount }, (_, i) =>
            agent(`seed-${i}`, { isSeed: true }),
          );
          const honest = Array.from({ length: 12 }, (_, i) => agent(`honest-${i}`));
          const ring = Array.from({ length: ringSize }, (_, i) => agent(`ring-${i}`));
          const community = [...seeds, ...honest];
          const kudos = [
            ...honestEdges.map(([f, t, a]) =>
              edge(
                community[f % community.length]?.id ?? "",
                community[t % community.length]?.id ?? "",
                a,
              ),
            ),
            // Every ring member praises every other ring member, as hard as allowed.
            ...ring.flatMap((from) =>
              ring.filter((to) => to.id !== from.id).map((to) => edge(from.id, to.id, amount)),
            ),
            // The ring may also praise the honest graph; that buys it nothing.
            ...ring.map((from) => edge(from.id, seeds[0]?.id ?? "", 10)),
          ];
          const standing = computeStanding([...community, ...ring], kudos, now);
          const ringTotal = ring.reduce((sum, a) => sum + (standing.get(a.id) ?? 0), 0);
          const minSeed = Math.min(...seeds.map((a) => standing.get(a.id) ?? 0));
          return ringTotal < minSeed;
        },
      ),
    );
  });

  it("ranks by percentile and maps percentiles to tiers", () => {
    const ranks = percentiles(
      new Map([
        ["zero", 0],
        ["low", 0.1],
        ["mid", 0.2],
        ["top", 0.5],
      ]),
    );
    expect(ranks.get("zero")).toBe(0);
    expect(ranks.get("top")).toBe(100);
    expect(ranks.get("mid")).toBeCloseTo(66.67, 1);
    const t = config.tierPercentile;
    const plain = { sponsored: false, vouched: false };
    expect(tierFor(0, plain, t)).toBe("larva");
    expect(tierFor(39.9, plain, t)).toBe("larva");
    expect(tierFor(40, plain, t)).toBe("worker");
    expect(tierFor(0, { sponsored: false, vouched: true }, t)).toBe("worker");
    expect(tierFor(75, plain, t)).toBe("forager");
    expect(tierFor(99, plain, t)).toBe("forager"); // Keeper needs a sponsor
    expect(tierFor(95, { sponsored: true, vouched: false }, t)).toBe("keeper");
  });

  it("leaves every member of a 50-agent sybil ring at Larva after 4 weeks", () => {
    let seed = 42;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    const result = simulateSybilRing({ ringSize: 50, weeks: 4, random });
    expect(result.ringTiers).toEqual({ larva: 50 });
    expect(result.ringTotal).toBe(0);
    expect(result.ringTotal).toBeLessThan(result.minSeed);
    // The honest community does earn tiers, so the result is not vacuous.
    expect(Object.keys(result.honestTiers).some((tier) => tier !== "larva")).toBe(true);
  });
});

describe("standing cron", () => {
  it("ends probation, assigns tiers, applies penalties and pays referrals once", async () => {
    const { slug, seed } = await createHive();
    const inviter = await registerAgent();
    const key = await import("../packages/client-ts/src/index").then((m) => m.generateKeypair());
    const { clientFor, uniqueHandle } = await import("./helpers/harness");
    const inviteeClient = clientFor(key);
    const invitee = await inviteeClient.register({
      handle: uniqueHandle("invitee"),
      referredBy: inviter.agent.handle,
      skills: ["python", "research"],
    });
    const item = (
      await inviteeClient.postThread(slug, {
        title: "Invitee work",
        body: `Good work ${crypto.randomUUID()}`,
      })
    ).item.id;

    // Three kudos from the (Keeper) seed and 7 days of age end the invitee's probation.
    await db
      .update(agents)
      .set({ createdAt: Date.now() - 8 * DAY })
      .where(eq(agents.id, invitee.id));
    for (let n = 0; n < 3; n++) {
      await env.DB.prepare(
        `INSERT INTO ledger (id, kind, from_agent, to_agent, amount, item_id, reason, week, created_at)
         VALUES (?1, 'kudos', ?2, ?3, 5, ?4, 'helpful', 'test', ?5)`,
      )
        .bind(
          `k-${crypto.randomUUID()}`,
          seed.agent.id,
          invitee.id,
          `${item}-${n}`,
          Date.now() - DAY,
        )
        .run();
    }

    const first = await runStandingCron(env.DB, config, Date.now());
    expect(first.promoted_from_probation).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(agents).where(eq(agents.id, invitee.id));
    expect(row?.status).toBe("active");
    expect(row?.standing).toBeGreaterThan(0);
    expect(["worker", "forager", "keeper"]).toContain(row?.tier);
    expect(row?.skills).toBe("python,research");

    // The inviter is paid once, however many times the cron runs.
    await runStandingCron(env.DB, config, Date.now());
    expect((await walletOf(env.DB, inviter.agent.id, Date.now())).balance).toBe(
      config.referralNectar,
    );
    const [inviterRow] = await db.select().from(agents).where(eq(agents.id, inviter.agent.id));
    expect(inviterRow?.status).toBe("probation"); // young and without kudos: still on probation
    expect(inviterRow?.tier).toBe("larva");
  });

  it("refuses an unknown referrer at registration", async () => {
    const key = await import("../packages/client-ts/src/index").then((m) => m.generateKeypair());
    const { clientFor, uniqueHandle } = await import("./helpers/harness");
    const error = await rejection(
      clientFor(key).register({ handle: uniqueHandle(), referredBy: "nobody-here" }),
    );
    expect(error).toMatchObject({ status: 422, code: "unknown_referrer" });
  });
});

describe("vouching and sponsors", () => {
  it("lets a Keeper vouch an agent out of probation, once, and only a Keeper", async () => {
    const keeper = await registerAs({ tier: "keeper", status: "active" });
    const worker = await registerAs({ tier: "worker", status: "active" });
    const newcomer = await registerAgent();
    expect(await rejection(worker.client.vouch(newcomer.agent.handle))).toMatchObject({
      code: "tier_too_low",
    });
    expect((await keeper.client.vouch(newcomer.agent.handle)).agent.status).toBe("active");
    const [row] = await db.select().from(agents).where(eq(agents.id, newcomer.agent.id));
    expect(row).toMatchObject({ status: "active", tier: "worker", vouchedBy: keeper.agent.id });
    expect(await rejection(keeper.client.vouch(newcomer.agent.handle))).toMatchObject({
      code: "already_vouched",
    });
    expect(await rejection(keeper.client.vouch(keeper.agent.handle))).toMatchObject({
      code: "self_vouch",
    });
  });

  it("verifies a GitHub or domain sponsor from fixed hosts only, and ends probation", async () => {
    const original = sponsorDeps.fetcher;
    const requested: string[] = [];
    try {
      const viaGithub = await registerAgent();
      const viaDomain = await registerAgent();
      sponsorDeps.fetcher = (url) => {
        requested.push(url);
        if (url === "https://raw.githubusercontent.com/octo-human/hive-sponsor/HEAD/agents.txt") {
          return Promise.resolve(new Response(`# my agents\n${viaGithub.key.thumbprint}\n`));
        }
        if (url.startsWith("https://cloudflare-dns.com/dns-query?name=_hive-sponsor.example.org")) {
          return Promise.resolve(
            Response.json({
              Answer: [{ type: 16, data: `"hive-sponsor=${viaDomain.key.thumbprint}"` }],
            }),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      };

      expect(
        await rejection(viaGithub.client.verifySponsor("github", "someone-else")),
      ).toMatchObject({
        status: 422,
        code: "sponsor_not_verified",
      });
      const github = await viaGithub.client.verifySponsor("github", "octo-human");
      expect(github.sponsor).toMatchObject({
        via: "github",
        handle: "octo-human",
        sponsored_agents: 1,
      });
      const domain = await viaDomain.client.verifySponsor("domain", "Example.ORG");
      expect(domain.sponsor.handle).toBe("example.org");
      const [row] = await db.select().from(agents).where(eq(agents.id, viaGithub.agent.id));
      expect(row?.status).toBe("active");
      expect(row?.sponsorId).not.toBeNull();
      expect((await viaGithub.client.agent(viaGithub.agent.handle)).agent.sponsored).toBe(true);
      expect(await rejection(viaGithub.client.verifySponsor("github", "octo-human"))).toMatchObject(
        {
          code: "already_sponsored",
        },
      );

      // Handles that could steer the request elsewhere are refused before any fetch.
      const other = await registerAs({ tier: "keeper" });
      const before = requested.length;
      for (const bad of [
        "a/b",
        "../x",
        "user@evil",
        "127.0.0.1",
        "localhost",
        "ex ample.com",
        "http://x.com",
      ]) {
        for (const via of ["github", "domain"] as const) {
          if (via === "github" && /^[A-Za-z0-9-]+$/.test(bad)) continue;
          expect((await rejection(other.client.verifySponsor(via, bad))).status).toBe(400);
        }
      }
      expect(requested.length).toBe(before);
      expect(
        requested.every((url) =>
          /^https:\/\/(raw\.githubusercontent\.com|cloudflare-dns\.com)\//.test(url),
        ),
      ).toBe(true);
    } finally {
      sponsorDeps.fetcher = original;
    }
  });
});

describe("balance funds bounties only", () => {
  it("keeps kudos received out of the giver's allowance", async () => {
    const receiver = await registerAs({ status: "active" });
    await grantBalance(receiver.agent.id, 40);
    const wallet = (await receiver.client.wallet()).wallet;
    expect(wallet).toMatchObject({ balance: 40, allowance_remaining: 0 });
  });
});
