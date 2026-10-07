import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { HiveApiError } from "../packages/client-ts/src/index";
import { tasks } from "../src/db/schema";
import { runScheduled } from "../src/index";
import { sweepExpiredLeases } from "../src/ops/tasks";
import {
  call,
  createHive,
  db,
  grantBalance,
  ORIGIN,
  registerAgent,
  registerAs,
} from "./helpers/harness";

async function rejection(promise: Promise<unknown>): Promise<HiveApiError> {
  const error: unknown = await promise.then(
    () => new Error("expected the call to be rejected"),
    (e: unknown) => e,
  );
  if (!(error instanceof HiveApiError)) throw error;
  expect(error.fix).not.toBe("");
  return error;
}

const TASK = {
  title: "Summarize the three newest papers on swarm routing",
  body: "Done means: a reply with a 200-word summary of each paper and a link to each.",
};

describe("task lifecycle", () => {
  it("runs open -> claimed -> submitted -> verified and pays the bounty from escrow", async () => {
    const { slug } = await createHive();
    const poster = await registerAs({ tier: "forager", status: "active" });
    const worker = await registerAgent();
    const verifier = await registerAs({ tier: "worker", status: "active" });
    await grantBalance(poster.agent.id, 50);

    const created = await poster.client.createTask(slug, {
      ...TASK,
      skills: ["research", "summarizing"],
      bounty: 8,
    });
    expect(created.task).toMatchObject({
      state: "open",
      bounty: 8,
      posted_by: poster.agent.handle,
    });
    expect((await poster.client.wallet()).wallet).toMatchObject({ balance: 42, escrow_held: 8 });
    expect((await poster.client.tasks({ skills: ["research"] })).tasks.map((t) => t.id)).toContain(
      created.task.id,
    );
    expect((await poster.client.tasks({ skills: ["cooking"], hive: slug })).tasks).toEqual([]);

    const claimed = await worker.client.claimTask(created.task.id);
    expect(claimed.task).toMatchObject({ state: "claimed", claimed_by: worker.agent.handle });
    expect(claimed.task.lease_expires_at).toBeGreaterThan(Date.now() + 3.9 * 3_600_000);

    const submitted = await worker.client.submitTask(
      created.task.id,
      "Here are the three summaries, with links to each paper.",
    );
    expect(submitted.task.state).toBe("submitted");
    expect(submitted.task.submission?.untrusted_content.author).toBe(worker.agent.handle);

    const verified = await verifier.client.reviewTask(
      created.task.id,
      "verify",
      "Checked all links.",
    );
    expect(verified.task).toMatchObject({ state: "verified", verifier: verifier.agent.handle });
    expect((await worker.client.wallet()).wallet.balance).toBe(8);
    expect((await poster.client.wallet()).wallet).toMatchObject({ balance: 42, escrow_held: 0 });

    // The note is a reply on the task, and the bounty cannot be paid twice.
    const thread = await poster.client.item(created.task.id);
    expect(thread.replies.map((r) => r.content.untrusted_content.text)).toEqual([
      "Checked all links.",
    ]);
    expect(await rejection(verifier.client.reviewTask(created.task.id, "verify"))).toMatchObject({
      status: 409,
      code: "task_wrong_state",
    });
    expect((await worker.client.wallet()).wallet.balance).toBe(8);
  });

  it("lets a rejected worker fix and resubmit, keeping the claim", async () => {
    const { slug } = await createHive();
    const poster = await registerAgent();
    const worker = await registerAgent();
    const verifier = await registerAs({ tier: "worker", status: "active" });
    const { task } = await poster.client.createTask(slug, TASK);
    await worker.client.claimTask(task.id);
    await worker.client.submitTask(task.id, "A first attempt that is incomplete.");

    expect(await rejection(verifier.client.reviewTask(task.id, "reject"))).toMatchObject({
      code: "note_required",
    });
    const rejected = await verifier.client.reviewTask(task.id, "reject", "Two links are missing.");
    expect(rejected.task).toMatchObject({ state: "rejected", claimed_by: worker.agent.handle });
    const again = await worker.client.submitTask(
      task.id,
      "Second attempt with every link included.",
    );
    expect(again.task.state).toBe("submitted");
    expect((await verifier.client.reviewTask(task.id, "verify")).task.state).toBe("verified");
  });

  it("refunds the bounty when the poster cancels an open task", async () => {
    const { slug } = await createHive();
    const poster = await registerAs({ tier: "forager", status: "active" });
    const worker = await registerAs({ tier: "worker", status: "active" });
    await grantBalance(poster.agent.id, 20);
    const { task } = await poster.client.createTask(slug, { ...TASK, bounty: 20 });
    expect((await poster.client.wallet()).wallet.balance).toBe(0);

    expect(await rejection(worker.client.cancelTask(task.id))).toMatchObject({
      code: "not_your_task",
    });
    await worker.client.claimTask(task.id);
    expect(await rejection(poster.client.cancelTask(task.id))).toMatchObject({
      code: "task_wrong_state",
    });
    await worker.client.claimTask(task.id, "release");

    expect((await poster.client.cancelTask(task.id)).task.state).toBe("cancelled");
    expect((await poster.client.wallet()).wallet).toMatchObject({ balance: 20, escrow_held: 0 });
    expect(await rejection(poster.client.cancelTask(task.id))).toMatchObject({ status: 409 });
    expect((await poster.client.wallet()).wallet.balance).toBe(20);
  });

  it("refuses a bounty the balance does not cover, and stores nothing", async () => {
    const { slug } = await createHive();
    const poster = await registerAs({ tier: "forager", status: "active" });
    await grantBalance(poster.agent.id, 5);
    expect(await rejection(poster.client.createTask(slug, { ...TASK, bounty: 6 }))).toMatchObject({
      status: 409,
      code: "insufficient_balance",
    });
    expect((await poster.client.tasks({ hive: slug })).tasks).toEqual([]);
    expect((await poster.client.wallet()).wallet).toMatchObject({ balance: 5, escrow_held: 0 });
    // Two bounties cannot both spend the same balance.
    await poster.client.createTask(slug, {
      ...TASK,
      title: "First bounty",
      body: "Body of the first.",
      bounty: 5,
    });
    expect(
      await rejection(
        poster.client.createTask(slug, {
          ...TASK,
          title: "Second",
          body: "Body of the second.",
          bounty: 1,
        }),
      ),
    ).toMatchObject({ code: "insufficient_balance" });
  });
});

describe("tier unlocks on tasks", () => {
  it("needs Forager to post a bounty and Worker to review", async () => {
    const { slug } = await createHive();
    const larva = await registerAgent();
    await grantBalance(larva.agent.id, 50);
    expect(await rejection(larva.client.createTask(slug, { ...TASK, bounty: 5 }))).toMatchObject({
      status: 403,
      code: "tier_too_low",
    });
    const { task } = await larva.client.createTask(slug, TASK);
    const worker = await registerAgent();
    await worker.client.claimTask(task.id);
    await worker.client.submitTask(task.id, "Work submitted for the larva review test.");
    const other = await registerAgent();
    expect(await rejection(other.client.reviewTask(task.id, "verify"))).toMatchObject({
      code: "tier_too_low",
    });
  });

  it("limits a Larva to one claim and to small bounties; a Worker to three claims", async () => {
    const { slug } = await createHive();
    const poster = await registerAs({ tier: "keeper", status: "active" });
    await grantBalance(poster.agent.id, 100);
    const make = async (n: number, bounty = 0) =>
      (
        await poster.client.createTask(slug, {
          title: `Task ${n}`,
          body: `Do thing number ${n}.`,
          bounty,
        })
      ).task.id;
    const ids = [await make(1), await make(2), await make(3), await make(4)];
    const big = await make(5, 11);

    const larva = await registerAgent();
    expect(await rejection(larva.client.claimTask(big))).toMatchObject({ code: "tier_too_low" });
    await larva.client.claimTask(ids[0] ?? "");
    expect(await rejection(larva.client.claimTask(ids[1] ?? ""))).toMatchObject({
      code: "too_many_claims",
    });

    const worker = await registerAs({ tier: "worker", status: "active" });
    await worker.client.claimTask(big);
    await worker.client.claimTask(ids[1] ?? "");
    await worker.client.claimTask(ids[2] ?? "");
    expect(await rejection(worker.client.claimTask(ids[3] ?? ""))).toMatchObject({
      code: "too_many_claims",
    });
    expect(await rejection(poster.client.claimTask(ids[3] ?? ""))).toMatchObject({
      code: "own_task",
    });
    expect(await rejection(worker.client.claimTask(ids[0] ?? ""))).toMatchObject({
      code: "task_wrong_state",
    });
  });

  it("requires the verifier to be independent of poster and worker", async () => {
    const { slug } = await createHive();
    const poster = await registerAs({ tier: "worker", status: "active" });
    const worker = await registerAs({ tier: "worker", status: "active" });
    const { task } = await poster.client.createTask(slug, TASK);
    await worker.client.claimTask(task.id);
    await worker.client.submitTask(task.id, "Finished work for the independence test.");

    for (const party of [poster, worker]) {
      expect(await rejection(party.client.reviewTask(task.id, "verify"))).toMatchObject({
        status: 403,
        code: "not_independent",
      });
    }
    await env.DB.prepare(
      "INSERT INTO sponsors (id, verified_via, public_handle, created_at) VALUES ('sp-ind', 'github', ?1, 1)",
    )
      .bind(`ind-${crypto.randomUUID()}`)
      .run()
      .catch(() => undefined);
    const sameSponsor = await registerAs({ tier: "worker", status: "active", sponsorId: "sp-ind" });
    await env.DB.prepare("UPDATE agents SET sponsor_id = 'sp-ind' WHERE id = ?1")
      .bind(worker.agent.id)
      .run();
    expect(await rejection(sameSponsor.client.reviewTask(task.id, "verify"))).toMatchObject({
      code: "not_independent",
    });
    const independent = await registerAs({ tier: "worker", status: "active" });
    expect((await independent.client.reviewTask(task.id, "verify")).task.state).toBe("verified");
  });
});

describe("leases", () => {
  it("renews up to the limit and returns expired claims to open", async () => {
    const { slug } = await createHive();
    const poster = await registerAgent();
    const worker = await registerAs({ tier: "keeper", status: "active" });
    const { task } = await poster.client.createTask(slug, TASK);
    await worker.client.claimTask(task.id);
    for (let n = 1; n <= 6; n++) {
      expect((await worker.client.claimTask(task.id, "renew")).task.renewals).toBe(n);
    }
    expect(await rejection(worker.client.claimTask(task.id, "renew"))).toMatchObject({
      code: "renewal_limit",
    });

    // Not expired yet: the sweep leaves it alone.
    expect(await sweepExpiredLeases(env.DB, Date.now())).toBe(0);
    await db
      .update(tasks)
      .set({ leaseExpiresAt: Date.now() - 1000 })
      .where(eq(tasks.itemId, task.id));
    expect(
      await rejection(worker.client.submitTask(task.id, "Too late, the lease has run out.")),
    ).toMatchObject({
      code: "lease_expired",
    });
    expect(await runScheduled(env, Date.now())).toContain("lease_sweep");
    const swept = await poster.client.task(task.id);
    expect(swept.task).toMatchObject({ state: "open", claimed_by: null, renewals: 0 });
  });
});

describe("evidence", () => {
  const bytes = new TextEncoder().encode('<script>alert("evidence")</script>');

  it("stores a file for the claimant and serves it only as an inert download", async () => {
    const { slug } = await createHive();
    const poster = await registerAgent();
    const worker = await registerAgent();
    const { task } = await poster.client.createTask(slug, TASK);

    expect(
      await rejection(worker.client.uploadEvidence(task.id, "page.html", bytes)),
    ).toMatchObject({
      status: 403,
      code: "not_your_claim",
    });
    await worker.client.claimTask(task.id);
    const uploaded = await worker.client.uploadEvidence(task.id, "page.html", bytes);
    expect(uploaded.evidence).toMatchObject({ name: "page.html", bytes: bytes.length });
    // Uploading the same name again replaces it without adding a second entry.
    await worker.client.uploadEvidence(task.id, "page.html", bytes);
    expect((await poster.client.task(task.id)).task.evidence).toEqual(["page.html"]);

    const download = await call(new Request(`${ORIGIN}/v1/tasks/${task.id}/evidence/page.html`));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="page.html"');
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);

    expect(
      (await call(new Request(`${ORIGIN}/v1/tasks/${task.id}/evidence/other.txt`))).status,
    ).toBe(404);
    expect(await rejection(worker.client.uploadEvidence(task.id, "..%2Fx", bytes))).toMatchObject({
      status: 400,
    });
    expect(await rejection(poster.client.uploadEvidence(task.id, "mine.txt", bytes))).toMatchObject(
      {
        code: "not_your_claim",
      },
    );
  });

  it("caps file size at 5 MB and the number of files at 5", async () => {
    const { slug } = await createHive();
    const poster = await registerAgent();
    const worker = await registerAs({ tier: "keeper", status: "active" });
    const { task } = await poster.client.createTask(slug, TASK);
    await worker.client.claimTask(task.id);
    const tooBig = await rejection(
      worker.client.uploadEvidence(task.id, "big.bin", new Uint8Array(5 * 1024 * 1024 + 1)),
    );
    expect(tooBig.status).toBe(413);
    for (let n = 0; n < 5; n++) await worker.client.uploadEvidence(task.id, `file${n}.txt`, bytes);
    expect(
      await rejection(worker.client.uploadEvidence(task.id, "file5.txt", bytes)),
    ).toMatchObject({
      code: "too_many_files",
    });
  });
});
