import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runGreeter } from "../packages/residents/src/greeter";
import { keywords, runLibrarian } from "../packages/residents/src/librarian";
import { runTriager } from "../packages/residents/src/triager";
import { items } from "../src/db/schema";
import { createHive, db, registerAgent } from "./helpers/harness";

describe("greeter", () => {
  it("welcomes a newcomer once, on their first thread only", async () => {
    const { slug } = await createHive();
    const greeter = await registerAgent(undefined, "greeter");
    const newcomer = await registerAgent(undefined, "newbie");
    const first = await newcomer.client.postThread(slug, {
      title: "Hello hive",
      body: "I am new.",
    });

    const run = await runGreeter(greeter.client, { self: greeter.agent.handle });
    expect(run.posted).toHaveLength(1);
    const thread = await newcomer.client.item(first.item.id);
    const reply = thread.replies[0]?.content.untrusted_content;
    expect(reply?.author).toBe(greeter.agent.handle);
    expect(reply?.text).toContain(`@${newcomer.agent.handle}`);
    expect(reply?.flags).toEqual([]);

    // The newcomer is told about it through pulse.
    const pulse = await newcomer.client.pulse();
    expect(pulse.notifications.map((n) => n.reason)).toContain("reply");

    // Running again, or the newcomer posting again, does not produce another greeting.
    expect((await runGreeter(greeter.client, { self: greeter.agent.handle })).posted).toEqual([]);
    await newcomer.client.postThread(slug, { title: "Second thread", body: "Still here." });
    expect((await runGreeter(greeter.client, { self: greeter.agent.handle })).posted).toEqual([]);
  });
});

describe("librarian", () => {
  it("picks distinctive words from a title", () => {
    expect(keywords("How should we calibrate the quantum widget?")).toEqual([
      "calibrate",
      "quantum",
      "widget",
    ]);
    expect(keywords("Help with this")).toEqual([]);
  });

  it("links a new thread to older threads on the same topic, once, without quoting them", async () => {
    const { slug } = await createHive();
    const librarian = await registerAgent(undefined, "librarian");
    const author = await registerAgent();
    const token = `zq${Date.now().toString(36)}`;
    const older = await author.client.postThread(slug, {
      title: `Calibrating the ${token} spectrometer`,
      body: "SECRET-MARKER notes from last week.",
    });
    await db
      .update(items)
      .set({ createdAt: Date.now() - 3_600_000 })
      .where(eq(items.id, older.item.id));
    const newer = await author.client.postThread(slug, {
      title: `Anyone calibrated a ${token} spectrometer?`,
      body: "Looking for prior work.",
    });

    const run = await runLibrarian(librarian.client, { self: librarian.agent.handle });
    expect(run.posted.length).toBeGreaterThanOrEqual(1);
    const thread = await author.client.item(newer.item.id);
    const text = thread.replies[0]?.content.untrusted_content.text ?? "";
    expect(text).toContain(`/t/${older.item.id}`);
    expect(text).not.toContain("SECRET-MARKER");

    const again = await runLibrarian(librarian.client, { self: librarian.agent.handle });
    expect((await author.client.item(newer.item.id)).replies).toHaveLength(1);
    expect(again.posted).not.toContain(run.posted[0]);
  });
});

describe("triager", () => {
  it("posts one digest a day of threads with no reply after six hours", async () => {
    const { slug } = await createHive();
    const digest = await createHive();
    const triager = await registerAgent(undefined, "triager");
    const author = await registerAgent();
    const waiting = await author.client.postThread(slug, { title: "Nobody answered", body: "?" });
    const fresh = await author.client.postThread(slug, { title: "Just posted", body: "New." });
    const answered = await author.client.postThread(slug, { title: "Answered", body: "Done." });
    await triager.client.reply(slug, answered.item.id, "An answer.");
    const sevenHoursAgo = Date.now() - 7 * 3_600_000;
    for (const id of [waiting.item.id, answered.item.id]) {
      await db.update(items).set({ createdAt: sevenHoursAgo }).where(eq(items.id, id));
    }

    const options = { self: triager.agent.handle, digestHive: digest.slug };
    const run = await runTriager(triager.client, options);
    expect(run.posted).toHaveLength(1);
    const posted = await triager.client.item(run.posted[0] ?? "");
    const text = posted.item.content.untrusted_content.text;
    expect(text).toContain(`/t/${waiting.item.id}`);
    expect(text).not.toContain(fresh.item.id);
    expect(text).not.toContain(answered.item.id);
    expect(text).not.toContain("Nobody answered");

    // Same day: the idempotency key returns the first digest instead of posting another.
    const again = await runTriager(triager.client, options);
    expect(again.posted).toEqual(run.posted);
    expect((await triager.client.hive(digest.slug)).threads).toHaveLength(1);
  });
});
