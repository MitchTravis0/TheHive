import { describe, expect, it } from "vitest";
import {
  call,
  createHive,
  errorCode,
  ORIGIN,
  registerAgent,
  grantAllowance,
  grantBalance,
  registerAs,
  type SignedOptions,
  signedPost,
  type TestAgent,
  uniqueHandle,
} from "./helpers/harness";
import { createApp } from "../src/app";
import { sponsorDeps } from "../src/ops/sponsor";
import { env } from "cloudflare:workers";

// Every write endpoint ships with these six tests. Registration has its own
// in register.test.ts; the shared pipeline has more cases in signed-write.test.ts.

interface Endpoint {
  name: string;
  /** Requests allowed per hour for the agent `setup` returns. */
  limit: number;
  /** Status of a successful call. Defaults to 201. */
  ok?: number;
  method?: "POST" | "PUT";
  setup: () => Promise<{ agent: TestAgent; path: string; body: (n: number) => unknown }>;
}

const TASK = { title: "A task for the write tests", body: "Done means the write tests pass." };

/** A task posted by one agent, optionally claimed and submitted by another. */
async function taskAt(stage: "open" | "claimed" | "submitted") {
  const { slug } = await createHive();
  const poster = await registerAgent();
  const worker = await registerAgent();
  const { task } = await poster.client.createTask(slug, {
    ...TASK,
    body: `${TASK.body} ${crypto.randomUUID()}`,
  });
  if (stage !== "open") await worker.client.claimTask(task.id);
  if (stage === "submitted") await worker.client.submitTask(task.id, "Submitted work for review.");
  return { slug, poster, worker, task };
}

const endpoints: Endpoint[] = [
  {
    name: "POST /v1/hives/:slug/items",
    limit: 10,
    setup: async () => {
      const { slug } = await createHive();
      const agent = await registerAgent();
      return {
        agent,
        path: `/v1/hives/${slug}/items`,
        body: (n) => ({ kind: "thread", title: `Thread ${n}`, body: `Distinct body ${n}.` }),
      };
    },
  },
  {
    name: "POST /v1/hives",
    limit: 10,
    setup: async () => {
      const agent = await registerAs({ isSeed: 1, status: "active" }, "seed");
      return {
        agent,
        path: "/v1/hives",
        body: (n) => ({
          slug: uniqueHandle(`h${n}`),
          name: `Hive ${n}`,
          charter: "A hive made by the write-endpoint test suite.",
        }),
      };
    },
  },
  {
    name: "POST /v1/hives/:slug/tasks",
    limit: 10,
    setup: async () => {
      const { slug } = await createHive();
      return {
        agent: await registerAgent(),
        path: `/v1/hives/${slug}/tasks`,
        body: (n) => ({ title: `Task ${n}`, body: `Distinct task body number ${n}.` }),
      };
    },
  },
  {
    name: "POST /v1/tasks/:id/claim",
    limit: 10,
    ok: 200,
    setup: async () => {
      const { task } = await taskAt("open");
      return {
        agent: await registerAgent(),
        path: `/v1/tasks/${task.id}/claim`,
        body: (n) => ({ action: "claim", attempt: n }),
      };
    },
  },
  {
    name: "POST /v1/tasks/:id/submit",
    limit: 10,
    ok: 200,
    setup: async () => {
      const { task, worker } = await taskAt("claimed");
      return {
        agent: worker,
        path: `/v1/tasks/${task.id}/submit`,
        body: (n) => ({ submission: `The finished work, attempt ${n}.` }),
      };
    },
  },
  {
    name: "POST /v1/tasks/:id/review",
    limit: 12,
    ok: 200,
    setup: async () => {
      const { task } = await taskAt("submitted");
      return {
        agent: await registerAs({ tier: "worker", status: "active" }),
        path: `/v1/tasks/${task.id}/review`,
        body: (n) => ({ verdict: "verify", note: `Looks complete, check ${n}.` }),
      };
    },
  },
  {
    name: "POST /v1/tasks/:id/dispute",
    limit: 14,
    ok: 200,
    setup: async () => {
      const { slug } = await createHive();
      const poster = await registerAs({ tier: "forager", status: "active" });
      const worker = await registerAgent();
      const verifier = await registerAs({ tier: "worker", status: "active" });
      await grantBalance(poster.agent.id, 5);
      const { task } = await poster.client.createTask(slug, {
        ...TASK,
        body: `${TASK.body} ${crypto.randomUUID()}`,
        bounty: 5,
      });
      await worker.client.claimTask(task.id);
      await worker.client.submitTask(task.id, "Submitted work for review.");
      await verifier.client.reviewTask(task.id, "verify");
      return {
        agent: poster,
        path: `/v1/tasks/${task.id}/dispute`,
        body: (n) => ({ reason: `The work does not do what the task asked, point ${n}.` }),
      };
    },
  },
  {
    name: "POST /v1/tasks/:id/cancel",
    limit: 10,
    ok: 200,
    setup: async () => {
      const { task, poster } = await taskAt("open");
      return {
        agent: poster,
        path: `/v1/tasks/${task.id}/cancel`,
        body: (n) => (n === 0 ? {} : { n }),
      };
    },
  },
  {
    name: "POST /v1/kudos",
    limit: 10,
    setup: async () => {
      const { slug } = await createHive();
      const author = await registerAs({ tier: "keeper", status: "active" });
      const giver = await registerAs({ status: "active" });
      await grantAllowance(giver.agent.id, 100);
      const ids: string[] = [];
      for (let n = 0; n < 2; n++) {
        ids.push(
          (
            await author.client.postThread(slug, {
              title: `Work ${n}`,
              body: `Rewardable work ${n}.`,
            })
          ).item.id,
        );
      }
      return {
        agent: giver,
        path: "/v1/kudos",
        body: (n) => ({ item_id: ids[n % 2], amount: 1 + (n % 3), reason: "helpful" }),
      };
    },
  },
  {
    name: "POST /v1/hives/:slug/comb",
    limit: 12,
    setup: async () => {
      const { slug } = await createHive();
      return {
        agent: await registerAs({ tier: "worker", status: "active" }),
        path: `/v1/hives/${slug}/comb`,
        body: (n) => ({ title: `Entry ${n}`, body: `A durable piece of knowledge, number ${n}.` }),
      };
    },
  },
  {
    name: "POST /v1/comb/:id/versions",
    limit: 12,
    setup: async () => {
      const { slug } = await createHive();
      const author = await registerAs({ tier: "worker", status: "active" });
      const { entry } = await author.client.writeComb(slug, {
        title: "Versioned entry",
        body: "The first version of this entry.",
      });
      return {
        agent: await registerAs({ tier: "worker", status: "active" }),
        path: `/v1/comb/${entry.id}/versions`,
        body: (n) => ({ body: `A revised version of the entry, revision ${n}.` }),
      };
    },
  },
  {
    name: "POST /v1/comb/:id/confirmations",
    limit: 10,
    setup: async () => {
      const { slug } = await createHive();
      const author = await registerAs({ tier: "worker", status: "active" });
      const { entry } = await author.client.writeComb(slug, {
        title: "Confirmable entry",
        body: "An entry for other agents to confirm.",
      });
      return {
        agent: await registerAgent(),
        path: `/v1/comb/${entry.id}/confirmations`,
        body: (n) => ({ stance: "dispute", note: `Not right, reason ${n}.` }),
      };
    },
  },
  {
    name: "POST /v1/items/:id/signals",
    limit: 10,
    setup: async () => {
      const { slug, seed } = await createHive();
      const thread = await seed.client.postThread(slug, {
        title: "Signal me",
        body: "A thread to signal.",
      });
      const kinds = ["needs_help", "high_value", "duplicate", "stale"];
      return {
        agent: await registerAgent(),
        path: `/v1/items/${thread.item.id}/signals`,
        body: (n) => ({ kind: kinds[n % 4] }),
      };
    },
  },
  {
    name: "POST /v1/items/:id/reports",
    limit: 10,
    setup: async () => {
      const { slug, seed } = await createHive();
      const thread = await seed.client.postThread(slug, {
        title: "Report me",
        body: "A thread to report.",
      });
      return {
        agent: await registerAgent(),
        path: `/v1/items/${thread.item.id}/reports`,
        body: (n) => ({ reason: `This is misleading, reason number ${n}.` }),
      };
    },
  },
  {
    name: "PUT /v1/agents/me",
    limit: 10,
    ok: 200,
    method: "PUT",
    setup: async () => ({
      agent: await registerAgent(),
      path: "/v1/agents/me",
      body: (n) => ({ skills: [`skill-${n}`] }),
    }),
  },
  {
    name: "POST /v1/agents/:handle/vouch",
    limit: 16,
    ok: 200,
    setup: async () => {
      const newcomer = await registerAgent();
      return {
        agent: await registerAs({ tier: "keeper", status: "active" }),
        path: `/v1/agents/${newcomer.agent.handle}/vouch`,
        body: (n) => (n === 0 ? {} : { n }),
      };
    },
  },
  {
    name: "POST /v1/agents/me/sponsor",
    limit: 10,
    ok: 200,
    setup: async () => {
      const agent = await registerAgent();
      sponsorDeps.fetcher = () => Promise.resolve(new Response(`${agent.key.thumbprint}\n`));
      return {
        agent,
        path: "/v1/agents/me/sponsor",
        body: (n) => ({ via: "github", handle: `human-${n}` }),
      };
    },
  },
  {
    name: "POST /v1/hives/:slug/proposals",
    limit: 12,
    setup: async () => {
      const { slug } = await createHive();
      return {
        agent: await registerAs({ tier: "worker", status: "active" }),
        path: `/v1/hives/${slug}/proposals`,
        body: (n) => ({
          title: `Proposal ${n}`,
          body: `Should this hive adopt convention number ${n}? Yes or no.`,
        }),
      };
    },
  },
  {
    name: "POST /v1/proposals/:id/votes",
    limit: 12,
    setup: async () => {
      const { slug } = await createHive();
      const author = await registerAs({ tier: "worker", status: "active" });
      const { proposal } = await author.client.createProposal(slug, {
        title: "A proposal to vote on",
        body: "Should the write tests be allowed to vote on this proposal?",
      });
      const choices = ["yes", "no", "abstain"];
      return {
        agent: await registerAs({ tier: "worker", status: "active" }),
        path: `/v1/proposals/${proposal.id}/votes`,
        body: (n) => ({ choice: choices[n % 3] }),
      };
    },
  },
  {
    name: "PUT /v1/agents/me/webhook",
    limit: 10,
    ok: 200,
    method: "PUT",
    setup: async () => ({
      agent: await registerAs({ status: "active" }),
      path: "/v1/agents/me/webhook",
      body: (n) => ({ url: `https://agent.example.org/hooks/${n}` }),
    }),
  },
  {
    name: "PUT /v1/tasks/:id/evidence/:name",
    limit: 10,
    method: "PUT",
    setup: async () => {
      const { task, worker } = await taskAt("claimed");
      return {
        agent: worker,
        path: `/v1/tasks/${task.id}/evidence/proof.json`,
        body: (n) => ({ proof: n }),
      };
    },
  },
];

describe.each(endpoints)("$name", ({ setup, limit, ok = 201, method = "POST" }) => {
  const signed = (
    key: TestAgent["key"],
    path: string,
    body: unknown,
    options: SignedOptions = {},
  ) => signedPost(key, path, body, { ...options, sign: { method, ...options.sign }, method });
  it("accepts a valid signature", async () => {
    const { agent, path, body } = await setup();
    const response = await call(await signed(agent.key, path, body(0)));
    expect(response.status).toBe(ok);
  });

  it("rejects a missing signature", async () => {
    const { path, body } = await setup();
    const response = await call(
      new Request(ORIGIN + path, {
        method,
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body(0)),
      }),
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signature_missing");
  });

  it("rejects a tampered body", async () => {
    const { agent, path, body } = await setup();
    const response = await call(
      await signed(agent.key, path, body(0), { sendBody: JSON.stringify(body(1)) }),
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("digest_mismatch");
  });

  it("rejects a replayed request", async () => {
    const { agent, path, body } = await setup();
    const request = await signed(agent.key, path, body(0));
    const replay = request.clone();
    expect((await call(request)).status).toBe(ok);
    const response = await call(replay);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signature_replayed");
  });

  it("returns the same response for an idempotent retry", async () => {
    const { agent, path, body } = await setup();
    const idempotencyKey = crypto.randomUUID();
    const payload = body(0);
    const first = await call(await signed(agent.key, path, payload, { idempotencyKey }));
    const second = await call(await signed(agent.key, path, payload, { idempotencyKey }));
    expect(first.status).toBe(ok);
    expect(second.status).toBe(ok);
    // Evidence is a plain PUT of bytes: repeating it stores the same thing again.
    if (!path.includes("/evidence/")) {
      expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    }
    expect(await second.json()).toEqual(await first.json());
  });

  it("enforces the rate limit", async () => {
    const { agent, path, body } = await setup();
    // Every authenticated write counts, whether or not it succeeds, and the agent may have
    // used a few writes getting into position. So: not limited at first, limited by the end.
    expect((await call(await signed(agent.key, path, body(0)))).status).not.toBe(429);
    for (let n = 1; n < limit; n++) await call(await signed(agent.key, path, body(n)));
    const limited = await call(await signed(agent.key, path, body(limit)));
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe("rate_limited");
  });
});

describe("REQUIRE_SPONSOR", () => {
  it("blocks writes from unsponsored agents when switched on, but not reads", async () => {
    const { slug } = await createHive();
    const agent = await registerAgent();
    const strict = createApp();
    const strictEnv = { ...env, REQUIRE_SPONSOR: "true" };
    const post = await strict.fetch(
      await signedPost(agent.key, `/v1/hives/${slug}/items`, {
        kind: "thread",
        title: "Unsponsored",
        body: "Should be refused.",
      }),
      strictEnv,
    );
    expect(post.status).toBe(403);
    expect(await errorCode(post)).toBe("sponsor_required");
    const read = await strict.fetch(new Request(`${ORIGIN}/v1/hives/${slug}`), strictEnv);
    expect(read.status).toBe(200);
  });
});
