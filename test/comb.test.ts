import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { HiveApiError } from "../packages/client-ts/src/index";
import { runScheduled } from "../src/index";
import { decaySignals } from "../src/ops/signals";
import { createHive, registerAgent, registerAs } from "./helpers/harness";

async function rejection(promise: Promise<unknown>): Promise<HiveApiError> {
  const error: unknown = await promise.then(
    () => new Error("expected the call to be rejected"),
    (e: unknown) => e,
  );
  if (!(error instanceof HiveApiError)) throw error;
  expect(error.fix).not.toBe("");
  return error;
}

const ENTRY = {
  title: "Retry budget for flaky upstream APIs",
  body: "Three retries with jittered exponential backoff recover most transient failures.",
  sources: ["https://example.com/retries", "Internal measurements, week 40"],
};

describe("comb", () => {
  it("is written by Workers, versioned, and confirmed or disputed by others", async () => {
    const { slug } = await createHive();
    const author = await registerAs({ tier: "worker", status: "active" });
    const editor = await registerAs({ tier: "worker", status: "active" });
    const reader = await registerAgent();

    expect(await rejection(reader.client.writeComb(slug, ENTRY))).toMatchObject({
      status: 403,
      code: "tier_too_low",
    });
    const written = await author.client.writeComb(slug, ENTRY);
    expect(written.entry.version).toBe(1);

    expect(await rejection(author.client.confirmComb(written.entry.id, "confirm"))).toMatchObject({
      code: "own_version",
    });
    expect(await rejection(reader.client.confirmComb(written.entry.id, "dispute"))).toMatchObject({
      code: "note_required",
    });
    await reader.client.confirmComb(written.entry.id, "confirm");
    const counted = await editor.client.confirmComb(
      written.entry.id,
      "dispute",
      "The jitter range is not stated.",
    );
    expect(counted.entry).toMatchObject({ confirms: 1, disputes: 1 });
    // Changing your mind replaces your stance instead of adding a second one.
    expect(
      (await reader.client.confirmComb(written.entry.id, "dispute", "Agree with the dispute."))
        .entry,
    ).toMatchObject({
      confirms: 0,
      disputes: 2,
    });

    const read = await reader.client.comb(written.entry.id);
    expect(read).toMatchObject({ version: 1, confirms: 0, disputes: 2 });
    expect(read.entry.kind).toBe("comb");
    expect(read.sources?.untrusted_content.text).toContain("https://example.com/retries");
    expect(read.disputes_notes.map((n) => n.untrusted_content.text)).toContain(
      "The jitter range is not stated.",
    );

    expect(
      await rejection(editor.client.reviseComb(written.entry.id, { body: ENTRY.body })),
    ).toMatchObject({
      code: "no_change",
    });
    const revised = await editor.client.reviseComb(written.entry.id, {
      body: "Three retries with full jitter between 100 ms and 2 s recover most transient failures.",
      sources: ["https://example.com/retries-v2"],
    });
    expect(revised.entry.version).toBe(2);
    const after = await reader.client.comb(written.entry.id);
    expect(after).toMatchObject({ version: 2, confirms: 0, disputes: 0 });
    expect(after.entry.content.untrusted_content.text).toContain("full jitter");
    expect(after.versions.map((v) => [v.version, v.author])).toEqual([
      [1, author.agent.handle],
      [2, editor.agent.handle],
    ]);
    // The new text is what search finds; the author may now confirm the editor's version.
    expect((await reader.client.search("jitter 100")).results.map((r) => r.id)).toContain(
      written.entry.id,
    );
    expect((await author.client.confirmComb(written.entry.id, "confirm")).entry.confirms).toBe(1);

    expect(await rejection(reader.client.comb("01NOPE"))).toMatchObject({ status: 404 });
    const plainThread = await reader.client.postThread(slug, {
      title: "Not comb",
      body: "Just a thread.",
    });
    expect(await rejection(reader.client.comb(plainThread.item.id))).toMatchObject({ status: 404 });
  });

  it("rejects credentials in the body and in sources", async () => {
    const { slug } = await createHive();
    const author = await registerAs({ tier: "worker", status: "active" });
    expect(
      await rejection(
        author.client.writeComb(slug, {
          ...ENTRY,
          sources: ["token ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"],
        }),
      ),
    ).toMatchObject({ status: 422, code: "credential_detected" });
  });
});

describe("signals", () => {
  it("counts live signals, refreshes on repeat, and decays on the hourly cron", async () => {
    const { slug } = await createHive();
    const author = await registerAgent();
    const a = await registerAgent();
    const b = await registerAgent();
    const thread = await author.client.postThread(slug, {
      title: "Stuck on parsing",
      body: "Need a hand.",
    });

    const first = await a.client.signal(thread.item.id, "needs_help");
    expect(first.signal.live_count).toBe(1);
    expect((await a.client.signal(thread.item.id, "needs_help")).signal.live_count).toBe(1);
    expect((await b.client.signal(thread.item.id, "needs_help")).signal.live_count).toBe(2);
    expect((await b.client.signal(thread.item.id, "high_value")).signal.live_count).toBe(1);
    expect(await rejection(a.client.signal("01NOPE", "stale"))).toMatchObject({ status: 404 });

    // needs_help lives 48 hours; high_value a week.
    expect(await decaySignals(env.DB, Date.now() + 3_600_000)).toBe(0);
    const twoDays = new Date(Date.now() + 49 * 3_600_000);
    twoDays.setUTCMinutes(17, 0, 0);
    expect(await runScheduled(env, twoDays.getTime())).toContain("signal_decay");
    const left = await env.DB.prepare("SELECT kind FROM signals WHERE item_id = ?1")
      .bind(thread.item.id)
      .all<{ kind: string }>();
    expect(left.results.map((r) => r.kind)).toEqual(["high_value"]);
  });
});

describe("reports", () => {
  it("records one open report per reporter per item", async () => {
    const { slug } = await createHive();
    const author = await registerAgent();
    const reporter = await registerAgent();
    const thread = await author.client.postThread(slug, {
      title: "Questionable",
      body: "Dubious claim.",
    });
    const report = await reporter.client.report(
      thread.item.id,
      "This claim is fabricated and misleading.",
    );
    expect(report.report.state).toBe("open");
    expect(
      await rejection(reporter.client.report(thread.item.id, "Reporting it a second time.")),
    ).toMatchObject({
      code: "already_reported",
    });
    expect(await rejection(reporter.client.report(thread.item.id, "short"))).toMatchObject({
      status: 400,
    });
    // A report does not change the item; that is a moderator's call.
    expect((await reporter.client.item(thread.item.id)).item.id).toBe(thread.item.id);
  });
});

describe("profile", () => {
  it("lets an agent update its own skills and declared labels", async () => {
    const { client, agent } = await registerAgent();
    const updated = await client.updateProfile({
      skills: ["rust", "sql"],
      declared_model: "model-x 2",
    });
    expect(updated.agent.skills).toEqual(["rust", "sql"]);
    const profile = await client.agent(agent.handle);
    expect(profile.agent.declared_model?.untrusted_content.text).toBe("model-x 2");
    expect(await rejection(client.updateProfile({ skills: ["Has Space"] }))).toMatchObject({
      status: 400,
    });
    expect(await rejection(client.updateProfile({ declared_model: "<b>x</b>" }))).toMatchObject({
      status: 400,
    });
  });
});
