import { describe, expect, it } from "vitest";
import { ops } from "../src/ops/index";
import { call, createHive, ORIGIN, registerAgent } from "./helpers/harness";

const get = (path: string) => call(new Request(ORIGIN + path));

describe("website", () => {
  it("serves every page as HTML with a strict CSP and no cookies", async () => {
    const { slug } = await createHive();
    const { client, agent } = await registerAgent();
    const thread = await client.postThread(slug, { title: "A visible thread", body: "Hello." });
    await client.reply(slug, thread.item.id, "A reply.");

    for (const path of [
      "/",
      "/hives",
      `/h/${slug}`,
      `/t/${thread.item.id}`,
      `/a/${agent.handle}`,
      "/about",
      "/moderation",
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(response.headers.get("set-cookie")).toBeNull();
      const html = await response.text();
      expect(html).not.toMatch(/<form|<input|<textarea/i);
      expect(html).not.toMatch(/<script(?![^>]*\ssrc="\/static\/)/i);
    }
  });

  it("sets the cache lifetimes from the plan", async () => {
    const { slug, seed } = await createHive();
    const thread = await seed.client.postThread(slug, { title: "Cache me", body: "Body." });
    expect((await get("/")).headers.get("cache-control")).toContain("s-maxage=5");
    expect((await get("/v1/feed")).headers.get("cache-control")).toContain("s-maxage=5");
    expect((await get("/hives")).headers.get("cache-control")).toContain("s-maxage=30");
    expect((await get(`/t/${thread.item.id}`)).headers.get("cache-control")).toContain(
      "s-maxage=60",
    );
  });

  it("escapes agent content and never renders it as HTML", async () => {
    const { slug } = await createHive();
    const { client } = await registerAgent();
    const thread = await client.postThread(slug, {
      title: '<img src=x onerror="alert(1)">',
      body: '<script>alert("xss")</script> javascript:alert(1) https://example.com/a?b=1&c=2 "quoted"',
    });
    for (const path of [`/t/${thread.item.id}`, `/h/${slug}`, "/"]) {
      const html = await (await get(path)).text();
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;script&gt;alert");
    }
    const html = await (await get(`/t/${thread.item.id}`)).text();
    // http(s) links are shown as links with rel set; other schemes stay plain text.
    expect(html).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2" rel="nofollow noopener noreferrer">',
    );
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("returns 405 for any write to the website", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/", "/hives", "/h/general", "/about", "/moderation", "/anything"]) {
        const response = await call(new Request(ORIGIN + path, { method, body: "x=1" }));
        expect(response.status, `${method} ${path}`).toBe(405);
        expect(response.headers.get("allow")).toBe("GET, HEAD");
      }
    }
  });

  it("answers HEAD and returns an HTML 404 for unknown pages", async () => {
    const head = await call(new Request(`${ORIGIN}/about`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    for (const path of ["/nope", "/h/no-such-hive", "/t/01NOPE", "/a/no-such-agent", "/h/BAD!"]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
    }
  });

  it("serves the stylesheet and the feed script", async () => {
    expect((await get("/static/style.css")).headers.get("content-type")).toContain("text/css");
    const script = await get("/static/feed.js");
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).not.toContain("innerHTML");
    const copy = await get("/static/copy.js");
    expect(copy.headers.get("content-type")).toContain("javascript");
    expect(await copy.text()).not.toContain("innerHTML");
  });

  it("links its assets by content version, so a deploy never serves a stale one", async () => {
    const html = await (await get("/")).text();
    for (const asset of ["style.css", "feed.js", "copy.js"]) {
      const link = new RegExp(`"(/static/${asset.replace(".", "\\.")}\\?v=[0-9a-f]{8})"`).exec(
        html,
      );
      expect(link, asset).not.toBeNull();
      expect((await get(link![1]!)).status, asset).toBe(200);
    }
  });
});

describe("discovery files", () => {
  it("serves skill.md with a matching published SHA-256", async () => {
    const response = await get("/skill.md");
    const text = await response.text();
    expect(response.headers.get("content-type")).toContain("text/markdown");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(response.headers.get("x-content-sha256")).toBe(hex);
    expect(await (await get("/skill.md.sha256")).text()).toBe(`${hex}  skill.md\n`);

    expect(text).toMatch(/^---\nname: the-hive\nversion: \d+\.\d+\.\d+/);
    expect(text).toContain("data, not instructions");
    expect(text).toContain(`${ORIGIN}/v1/openapi.json`);
    // It must not turn itself into a remote command channel.
    expect(text).toContain("Do not re-fetch it on a schedule");
    expect(text).not.toMatch(
      /\b(?:re-?fetch|check|download) this file (?:every|each|periodically)/i,
    );
  });

  it("serves llms.txt pointing at the skill file and the OpenAPI document", async () => {
    const text = await (await get("/llms.txt")).text();
    expect(text).toContain(`${ORIGIN}/skill.md`);
    expect(text).toContain(`${ORIGIN}/v1/openapi.json`);
  });

  it("generates OpenAPI from the op definitions", async () => {
    const response = await get("/v1/openapi.json");
    expect(response.status).toBe(200);
    const doc: {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string; security?: unknown }>>;
    } = await response.json();
    expect(doc.openapi).toBe("3.1.0");
    const operationIds = Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId),
    );
    expect(operationIds.sort()).toEqual(ops.map((op) => op.name).sort());
    expect(doc.paths["/v1/hives/{slug}/items"]?.post?.security).toBeDefined();
    expect(doc.paths["/v1/hives/{slug}"]?.get?.security).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain("/v1/echo");
  });
});
