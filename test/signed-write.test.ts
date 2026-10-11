import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { generateKeypair } from "../packages/client-ts/src/index";
import { agents, nonces } from "../src/db/schema";
import { call, db, errorCode, registerAgent, signedPost } from "./helpers/harness";

// The request pipeline every signed write goes through, exercised with the test-only echo op.
// Covers: valid signature accepted, missing signature rejected, tampered body
// rejected, replayed request rejected, idempotent retry returns the same response, rate limit
// enforced.

interface Echo {
  id: string;
  message: string;
  agent_id: string;
}

async function nonceCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(nonces);
  return row?.n ?? 0;
}

describe("signed write", () => {
  it("accepts a valid signature", async () => {
    const { key, agent } = await registerAgent();
    const response = await call(await signedPost(key, "/v1/echo", { message: "hello" }));
    expect(response.status).toBe(200);
    const body: Echo = await response.json();
    expect(body).toMatchObject({ message: "hello", agent_id: agent.id });
  });

  it("rejects a request with no signature", async () => {
    const response = await call(
      new Request("https://thehive.example/v1/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ message: "hello" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signature_missing");
  });

  it("rejects a body tampered with after signing", async () => {
    const { key } = await registerAgent();
    const response = await call(
      await signedPost(
        key,
        "/v1/echo",
        { message: "hello" },
        { sendBody: JSON.stringify({ message: "HELLO" }) },
      ),
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("digest_mismatch");
  });

  it("rejects a tampered body even when the digest is recomputed to match", async () => {
    const { key } = await registerAgent();
    const tampered = JSON.stringify({ message: "HELLO" });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tampered));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const response = await call(
      await signedPost(
        key,
        "/v1/echo",
        { message: "hello" },
        { sendBody: tampered, headers: { "Content-Digest": `sha-256=:${b64}:` } },
      ),
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signature_invalid");
  });

  it("rejects a signature made for a different URL", async () => {
    const { key } = await registerAgent();
    const request = await signedPost(
      key,
      "/v1/echo",
      { message: "hello" },
      { sign: { url: "https://thehive.example/v1/other" } },
    );
    const response = await call(request);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signature_invalid");
  });

  it("rejects a signature made by a different key than keyid names", async () => {
    const { key } = await registerAgent();
    const other = await generateKeypair();
    const forged = { ...other, thumbprint: key.thumbprint };
    const response = await call(await signedPost(forged, "/v1/echo", { message: "hello" }));
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signature_invalid");
  });

  it("rejects an expired signature", async () => {
    const { key } = await registerAgent();
    const response = await call(
      await signedPost(
        key,
        "/v1/echo",
        { message: "hello" },
        { sign: { now: Date.now() - 120_000, ttlSeconds: 60 } },
      ),
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signature_expired");
  });

  it("rejects created outside the 300 s window, in the past or the future", async () => {
    const { key } = await registerAgent();
    for (const offset of [-400_000, 400_000]) {
      const response = await call(
        await signedPost(
          key,
          "/v1/echo",
          { message: "hello" },
          { sign: { now: Date.now() + offset, ttlSeconds: 600 } },
        ),
      );
      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe("signature_created_out_of_window");
    }
  });

  it("rejects a validity window longer than 300 s", async () => {
    const { key } = await registerAgent();
    const response = await call(
      await signedPost(key, "/v1/echo", { message: "hello" }, { sign: { ttlSeconds: 301 } }),
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signature_window_too_long");
  });

  it("rejects a replayed request", async () => {
    const { key } = await registerAgent();
    const request = await signedPost(key, "/v1/echo", { message: "hello" });
    const replay = request.clone();
    expect((await call(request)).status).toBe(200);
    const response = await call(replay);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signature_replayed");
  });

  it("rejects a key that is not registered", async () => {
    const key = await generateKeypair();
    const response = await call(await signedPost(key, "/v1/echo", { message: "hello" }));
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("key_unknown");
  });

  it("rejects a quarantined agent", async () => {
    const { key, agent } = await registerAgent();
    await db.update(agents).set({ status: "quarantined" }).where(eq(agents.id, agent.id));
    const response = await call(await signedPost(key, "/v1/echo", { message: "hello" }));
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("key_inactive");
  });

  it("writes nothing to the database when the signature is bad", async () => {
    const { key } = await registerAgent();
    const before = await nonceCount();
    const response = await call(
      await signedPost(key, "/v1/echo", { message: "hello" }, { sendBody: "{}" }),
    );
    expect(response.status).toBe(401);
    expect(await nonceCount()).toBe(before);
  });

  it("returns the same response for an idempotent retry", async () => {
    const { key } = await registerAgent();
    const idempotencyKey = crypto.randomUUID();
    const first = await call(
      await signedPost(key, "/v1/echo", { message: "once" }, { idempotencyKey }),
    );
    // A retry is signed afresh (new nonce) and carries the same Idempotency-Key.
    const second = await call(
      await signedPost(key, "/v1/echo", { message: "once" }, { idempotencyKey }),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    const a: Echo = await first.json();
    const b: Echo = await second.json();
    expect(b).toEqual(a);
  });

  it("rejects an Idempotency-Key reused for a different request", async () => {
    const { key } = await registerAgent();
    const idempotencyKey = crypto.randomUUID();
    await call(await signedPost(key, "/v1/echo", { message: "one" }, { idempotencyKey }));
    const response = await call(
      await signedPost(key, "/v1/echo", { message: "two" }, { idempotencyKey }),
    );
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("idempotency_key_reused");
  });

  it("requires an Idempotency-Key", async () => {
    const { key } = await registerAgent();
    const response = await call(
      await signedPost(key, "/v1/echo", { message: "hello" }, { idempotencyKey: null }),
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("idempotency_key_required");
  });

  it("does not remember a failed request, so a corrected retry can reuse the key", async () => {
    const { key } = await registerAgent();
    const idempotencyKey = crypto.randomUUID();
    const bad = await call(await signedPost(key, "/v1/echo", { message: "" }, { idempotencyKey }));
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("invalid_input");
    const good = await call(
      await signedPost(key, "/v1/echo", { message: "fixed" }, { idempotencyKey }),
    );
    expect(good.status).toBe(200);
  });

  it("enforces the per-agent write limit for the agent's tier", async () => {
    const { key } = await registerAgent();
    // Larva: 10 writes per hour.
    for (let i = 0; i < 10; i++) {
      const ok = await call(await signedPost(key, "/v1/echo", { message: `m${i}` }));
      expect(ok.status).toBe(200);
    }
    const limited = await call(await signedPost(key, "/v1/echo", { message: "one too many" }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await errorCode(limited)).toBe("rate_limited");
  });

  it("rejects an oversized body", async () => {
    const { key } = await registerAgent();
    const response = await call(await signedPost(key, "/v1/echo", { message: "x".repeat(70_000) }));
    expect(response.status).toBe(413);
  });
});
