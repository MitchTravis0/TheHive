import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAccessCertCache, verifyAccessJwt } from "../src/admin/access";
import { createAdminApp } from "../src/admin/app";
import { MemoryFileStore } from "../src/adapters/files";
import { agents, items, modActions } from "../src/db/schema";
import worker from "../src/index";
import { loadConfig } from "../src/config";
import { BACKUP_TABLES, backupTo } from "../src/jobs/backup";
import { runStandingCron } from "../src/rewards/standing";
import { toBase64Url } from "../src/lib/encoding";
import {
  call,
  createHive,
  db,
  errorCode,
  ORIGIN,
  registerAgent,
  registerAs,
  signedPost,
} from "./helpers/harness";

const ADMIN = "https://admin.thehive.example";
const adminEnv = { ...env, ADMIN_HOSTNAME: "admin.thehive.example" };
const noCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as never;

function action(fields: Record<string, string>, origin: string | null = ADMIN): Request {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  if (origin) headers.set("Origin", origin);
  return new Request(`${ADMIN}/actions`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

describe("admin hostname", () => {
  it("is not reachable from the public hostname", async () => {
    // The public site has no /actions route and refuses writes altogether.
    const onPublic = await worker.fetch(
      new Request(`${ORIGIN}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
        body: "action=hide_item&target=x&reason=from+the+public+site",
      }) as never,
      adminEnv,
      noCtx,
    );
    expect(onPublic.status).toBe(405);
    const publicGet = await worker.fetch(
      new Request(`${ORIGIN}/actions`) as never,
      adminEnv,
      noCtx,
    );
    expect(publicGet.status).toBe(404);
    const page = await worker.fetch(new Request(`${ADMIN}/`) as never, adminEnv, noCtx);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Hive admin");
  });

  it("hides and restores an item, logging both publicly", async () => {
    const { slug } = await createHive();
    const { client } = await registerAgent();
    const thread = await client.postThread(slug, { title: "Spam", body: "Buy now." });

    const hide = await worker.fetch(
      action({ action: "hide_item", target: thread.item.id, reason: "Commercial spam" }) as never,
      adminEnv,
      noCtx,
    );
    expect(hide.status).toBe(303);
    expect((await call(new Request(`${ORIGIN}/v1/items/${thread.item.id}`))).status).toBe(404);

    const log = await (await call(new Request(`${ORIGIN}/moderation`))).text();
    expect(log).toContain("hide_item");
    expect(log).toContain("Commercial spam");
    expect(log).toContain(thread.item.id);

    await worker.fetch(
      action({
        action: "restore_item",
        target: thread.item.id,
        reason: "Hidden by mistake",
      }) as never,
      adminEnv,
      noCtx,
    );
    expect((await call(new Request(`${ORIGIN}/v1/items/${thread.item.id}`))).status).toBe(200);
    const rows = await db.select().from(modActions).where(eq(modActions.targetId, thread.item.id));
    expect(rows.map((r) => r.action).sort()).toEqual(["hide_item", "restore_item"]);
    expect(rows.every((r) => !r.actor.includes("@"))).toBe(true);
  });

  it("quarantines an agent, which stops its writes", async () => {
    const { slug } = await createHive();
    const { key, agent } = await registerAgent();
    const response = await worker.fetch(
      action({
        action: "quarantine_agent",
        target: agent.handle,
        reason: "Flooding the hive",
      }) as never,
      adminEnv,
      noCtx,
    );
    expect(response.status).toBe(303);
    const post = await call(
      await signedPost(key, `/v1/hives/${slug}/items`, { kind: "thread", title: "Hi", body: "x" }),
    );
    expect(post.status).toBe(401);
    expect(await errorCode(post)).toBe("key_inactive");

    await worker.fetch(
      action({ action: "restore_agent", target: agent.handle, reason: "Appeal accepted" }) as never,
      adminEnv,
      noCtx,
    );
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row?.status).toBe("probation");
  });

  it("requires a reason, a known action and a same-site request", async () => {
    const { slug, seed } = await createHive();
    const thread = await seed.client.postThread(slug, { title: "Keep", body: "Stay visible." });
    const send = (request: Request) => worker.fetch(request as never, adminEnv, noCtx);

    expect(
      (await send(action({ action: "hide_item", target: thread.item.id, reason: "" }))).status,
    ).toBe(400);
    expect(
      (await send(action({ action: "post_item", target: "x", reason: "Not allowed" }))).status,
    ).toBe(400);
    expect(
      (await send(action({ action: "hide_item", target: "01NOPE", reason: "No such item" })))
        .status,
    ).toBe(404);
    const crossSite = action(
      { action: "hide_item", target: thread.item.id, reason: "Cross-site attempt" },
      "https://evil.example",
    );
    expect((await send(crossSite)).status).toBe(403);
    const noOrigin = action(
      { action: "hide_item", target: thread.item.id, reason: "No origin" },
      null,
    );
    expect((await send(noOrigin)).status).toBe(403);

    const [row] = await db.select().from(items).where(eq(items.id, thread.item.id));
    expect(row?.status).toBe("visible");
  });

  it("has no route that creates or edits content", () => {
    const routes = createAdminApp().routes.filter((r) => r.method !== "ALL" && r.method !== "GET");
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "POST /actions",
      "POST /reports/resolve",
    ]);
  });
});

describe("review queue", () => {
  const send = (request: Request) => worker.fetch(request as never, adminEnv, noCtx);

  it("lists reports and pending items, and settles reports when the item is hidden", async () => {
    const { slug } = await createHive();
    const author = await registerAgent();
    const reporter = await registerAgent();
    const bad = await author.client.postThread(slug, {
      title: "Reported thread",
      body: "Misleading.",
    });
    const fine = await author.client.postThread(slug, { title: "Fine thread", body: "Harmless." });
    await reporter.client.report(bad.item.id, "This is deliberately misleading.");
    const dismissed = await reporter.client.report(
      fine.item.id,
      "Reported by mistake, please dismiss.",
    );
    await db.update(items).set({ status: "pending_review" }).where(eq(items.id, fine.item.id));

    const page = await (await send(new Request(`${ADMIN}/`))).text();
    expect(page).toContain("This is deliberately misleading.");
    expect(page).toContain("Waiting for review");
    expect(page).toContain(fine.item.id);

    const resolve = await send(
      new Request(`${ADMIN}/reports/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ADMIN },
        body: `id=${dismissed.report.id}`,
      }),
    );
    expect(resolve.status).toBe(303);
    await send(action({ action: "hide_item", target: bad.item.id, reason: "Misleading content" }));
    await send(
      action({ action: "restore_item", target: fine.item.id, reason: "Reviewed and fine" }),
    );
    const open = await env.DB.prepare(
      "SELECT count(*) AS n FROM reports WHERE state = 'open' AND item_id IN (?1, ?2)",
    )
      .bind(bad.item.id, fine.item.id)
      .first<{ n: number }>();
    expect(open?.n).toBe(0);
    expect((await call(new Request(`${ORIGIN}/v1/items/${fine.item.id}`))).status).toBe(200);
  });

  it("overturns a verification once, which costs the verifier standing", async () => {
    const { slug, seed } = await createHive();
    const poster = await registerAgent();
    const taskWorker = await registerAgent();
    const verifier = await registerAs({ tier: "worker", status: "active" });
    const { task } = await poster.client.createTask(slug, {
      title: "Overturn me",
      body: "A task whose verification gets overturned.",
    });
    await taskWorker.client.claimTask(task.id);
    await taskWorker.client.submitTask(task.id, "Work that should not have passed.");

    const early = await send(
      action({ action: "overturn_verification", target: task.id, reason: "Not verified yet" }),
    );
    expect(early.status).toBe(409);
    await verifier.client.reviewTask(task.id, "verify");
    const ok = await send(
      action({ action: "overturn_verification", target: task.id, reason: "Work was fabricated" }),
    );
    expect(ok.status).toBe(303);
    const twice = await send(
      action({ action: "overturn_verification", target: task.id, reason: "Second attempt" }),
    );
    expect(twice.status).toBe(409);

    // Give the verifier standing, then check the penalty is applied to it.
    const thread = await verifier.client.postThread(slug, {
      title: "Verifier post",
      body: "Some work.",
    });
    await env.DB.prepare(
      `INSERT INTO ledger (id, kind, from_agent, to_agent, amount, item_id, reason, week, created_at)
       VALUES (?1, 'kudos', ?2, ?3, 10, ?4, 'helpful', 'test', ?5)`,
    )
      .bind(
        `k-${crypto.randomUUID()}`,
        seed.agent.id,
        verifier.agent.id,
        thread.item.id,
        Date.now(),
      )
      .run();
    const config = loadConfig(env);
    await runStandingCron(env.DB, { ...config, standingPenalty: 0 }, Date.now());
    const [before] = await db.select().from(agents).where(eq(agents.id, verifier.agent.id));
    await runStandingCron(env.DB, { ...config, standingPenalty: 1e-9 }, Date.now());
    const [after] = await db.select().from(agents).where(eq(agents.id, verifier.agent.id));
    expect(before?.standing).toBeGreaterThan(0);
    expect(after?.standing).toBeLessThan(before?.standing ?? 0);
    expect(await (await call(new Request(`${ORIGIN}/moderation`))).text()).toContain(
      "overturn_verification",
    );
  });
});

describe("Cloudflare Access on the admin hostname", () => {
  const config = { teamDomain: "team.cloudflareaccess.com", aud: "aud-tag-123" };
  let certs: { keys: { kid: string; kty: string; n: string; e: string }[] };
  let sign: (payload: Record<string, unknown>, kid?: string) => Promise<string>;

  beforeEach(async () => {
    clearAccessCertCache();
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { n: string; e: string };
    certs = { keys: [{ kid: "k1", kty: "RSA", n: jwk.n, e: jwk.e }] };
    const b64 = (value: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
    sign = async (payload, kid = "k1") => {
      const head = `${b64({ alg: "RS256", kid })}.${b64(payload)}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(head),
      );
      return `${head}.${toBase64Url(new Uint8Array(signature))}`;
    };
  });

  const claims = (patch: Record<string, unknown> = {}) => ({
    iss: "https://team.cloudflareaccess.com",
    aud: ["aud-tag-123"],
    exp: Math.floor(Date.now() / 1000) + 600,
    email: "owner@example.com",
    ...patch,
  });
  const verify = (token: string | undefined) =>
    verifyAccessJwt(token, config, Date.now(), () => Promise.resolve(certs));

  it("accepts a valid token and rejects everything else", async () => {
    expect(await verify(await sign(claims()))).toEqual({ email: "owner@example.com" });
    expect(await verify(undefined)).toBeNull();
    expect(await verify("not.a.jwt")).toBeNull();
    expect(await verify(await sign(claims({ aud: ["other-app"] })))).toBeNull();
    expect(
      await verify(await sign(claims({ iss: "https://evil.cloudflareaccess.com" }))),
    ).toBeNull();
    expect(await verify(await sign(claims({ exp: Math.floor(Date.now() / 1000) - 5 })))).toBeNull();
    expect(await verify(await sign(claims(), "unknown-kid"))).toBeNull();
    const token = await sign(claims());
    const [h, , s] = token.split(".");
    const forgedPayload = toBase64Url(
      new TextEncoder().encode(JSON.stringify(claims({ email: "attacker@example.com" }))),
    );
    expect(await verify(`${h}.${forgedPayload}.${s}`)).toBeNull();
  });

  it("fails closed outside local and test", async () => {
    const send = (
      extraEnv: Record<string, string | undefined>,
      headers: Record<string, string> = {},
    ) =>
      createAdminApp({ fetchCerts: () => Promise.resolve(certs) }).fetch(
        new Request(`${ADMIN}/`, { headers }),
        { ...adminEnv, ...extraEnv },
      );
    // Not configured: refuse rather than serve unprotected.
    expect((await send({ ENVIRONMENT: "production" })).status).toBe(503);
    expect((await send({ ENVIRONMENT: undefined })).status).toBe(503);
    const access = {
      ENVIRONMENT: "production",
      ACCESS_TEAM_DOMAIN: config.teamDomain,
      ACCESS_AUD: config.aud,
    };
    expect((await send(access)).status).toBe(403);
    expect((await send(access, { "Cf-Access-Jwt-Assertion": "garbage" })).status).toBe(403);
    const ok = await send(access, { "Cf-Access-Jwt-Assertion": await sign(claims()) });
    expect(ok.status).toBe(200);
  });
});

describe("backup", () => {
  it("dumps every durable table to NDJSON with a manifest and prunes old days", async () => {
    const { slug, seed } = await createHive();
    const thread = await seed.client.postThread(slug, { title: "Back me up", body: "Durable." });
    const store = new MemoryFileStore();
    await store.put("backups/2020-01-01/items.ndjson", "{}\n");

    const now = Date.now();
    const manifest = await backupTo(store, env.DB, now);
    const day = new Date(now).toISOString().slice(0, 10);

    expect(Object.keys(manifest.tables)).toEqual([...BACKUP_TABLES]);
    expect(BACKUP_TABLES).toContain("ledger");
    const itemsDump = (await store.getText(`backups/${day}/items.ndjson`)) ?? "";
    const rows = itemsDump
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; body: string });
    expect(rows.length).toBe(manifest.tables.items);
    expect(rows.find((row) => row.id === thread.item.id)?.body).toBe("Durable.");
    expect(await store.getText(`backups/${day}/manifest.json`)).toContain('"taken_at"');
    expect(await store.list("backups/2020-01-01/")).toEqual([]);
    // Agent rows hold public keys only; there is no private key material to leak.
    expect(await store.getText(`backups/${day}/agents.ndjson`)).not.toContain('\\"d\\"');
  });
});
