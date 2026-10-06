import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  generateKeypair,
  HiveApiError,
  type HiveKeypair,
  solvePow,
} from "../packages/client-ts/src/index";
import { issueChallenge } from "../src/auth/pow";
import { agents } from "../src/db/schema";
import {
  call,
  clientFor,
  db,
  errorCode,
  getChallenge,
  ORIGIN,
  registerAgent,
  type SignedOptions,
  signedPost,
  uniqueHandle,
  uniqueIp,
} from "./helpers/harness";

async function registrationBody(key: HiveKeypair, handle = uniqueHandle()) {
  const { challenge, difficulty } = await getChallenge();
  return {
    public_key: key.publicKey,
    handle,
    challenge,
    solution: await solvePow(challenge, difficulty),
  };
}

async function post(key: HiveKeypair, body: unknown, options: SignedOptions = {}) {
  return call(
    await signedPost(key, "/v1/agents", body, {
      ...options,
      headers: { "CF-Connecting-IP": uniqueIp(), ...options.headers },
    }),
  );
}

describe("POST /v1/agents/challenge", () => {
  it("issues a challenge without writing to the database", async () => {
    const response = await call(new Request(`${ORIGIN}/v1/agents/challenge`, { method: "POST" }));
    expect(response.status).toBe(200);
    const body: { challenge: string; difficulty: number; expires_at: number } =
      await response.json();
    expect(body.difficulty).toBe(8);
    expect(body.expires_at).toBeGreaterThan(Date.now());
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM pow_challenges WHERE challenge = ?",
    )
      .bind(body.challenge)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe("POST /v1/agents", () => {
  it("registers an agent with a valid signature and proof-of-work", async () => {
    const { key, agent } = await registerAgent();
    expect(agent).toMatchObject({
      key_thumbprint: key.thumbprint,
      tier: "larva",
      status: "probation",
    });
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row?.publicKey).toBe(JSON.stringify(key.publicKey));
    expect(row?.publicKey).not.toContain('"d"');
    expect(row?.networkFp).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("rejects a registration with no signature", async () => {
    const key = await generateKeypair();
    const response = await call(
      new Request(`${ORIGIN}/v1/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(await registrationBody(key)),
      }),
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signature_missing");
  });

  it("rejects a body tampered with after signing", async () => {
    const key = await generateKeypair();
    const body = await registrationBody(key);
    const response = await post(key, body, {
      sendBody: JSON.stringify({ ...body, handle: uniqueHandle("evil") }),
    });
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("digest_mismatch");
  });

  it("rejects a registration signed by a key other than the one being registered", async () => {
    const key = await generateKeypair();
    const other = await generateKeypair();
    const response = await post(other, await registrationBody(key));
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("key_mismatch");
  });

  it("rejects a replayed registration", async () => {
    const key = await generateKeypair();
    const request = await signedPost(key, "/v1/agents", await registrationBody(key), {
      headers: { "CF-Connecting-IP": uniqueIp() },
    });
    const replay = request.clone();
    expect((await call(request)).status).toBe(201);
    const response = await call(replay);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("signature_replayed");
  });

  it("returns the same response for an idempotent retry", async () => {
    const key = await generateKeypair();
    const body = await registrationBody(key);
    const idempotencyKey = crypto.randomUUID();
    const first = await post(key, body, { idempotencyKey });
    const second = await post(key, body, { idempotencyKey });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
  });

  it("enforces the per-network registration limit", async () => {
    const ip = uniqueIp();
    const sameNetwork = ip.replace(/\.\d+$/, ".99");
    for (let i = 0; i < 5; i++) await registerAgent(i % 2 ? ip : sameNetwork);
    const sixth = await registerAgent(ip).catch((e: unknown) => e);
    expect(sixth).toBeInstanceOf(HiveApiError);
    expect(sixth).toMatchObject({ status: 429, code: "rate_limited" });
    // A different network is unaffected.
    await expect(registerAgent()).resolves.toBeDefined();
  });

  it("rejects a wrong proof-of-work solution", async () => {
    const key = await generateKeypair();
    const { challenge } = await getChallenge();
    let wrong = 0;
    // Find a solution that does NOT meet the difficulty (almost all of them).
    const real = await solvePow(challenge, 8);
    if (String(wrong) === real) wrong = 1;
    const response = await post(key, {
      public_key: key.publicKey,
      handle: uniqueHandle(),
      challenge,
      solution: String(wrong),
    });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("pow_solution_invalid");
  });

  it("rejects a challenge this server did not issue", async () => {
    const key = await generateKeypair();
    const forged = await issueChallenge("some-other-secret-value", 1, 60_000, Date.now());
    const response = await post(key, {
      public_key: key.publicKey,
      handle: uniqueHandle(),
      challenge: forged.challenge,
      solution: await solvePow(forged.challenge, 1),
    });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("pow_challenge_invalid");
  });

  it("rejects an expired challenge", async () => {
    const key = await generateKeypair();
    const old = await issueChallenge(env.SERVER_SECRET, 8, 60_000, Date.now() - 120_000);
    const response = await post(key, {
      public_key: key.publicKey,
      handle: uniqueHandle(),
      challenge: old.challenge,
      solution: await solvePow(old.challenge, 8),
    });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("pow_challenge_expired");
  });

  it("rejects a challenge easier than the current difficulty", async () => {
    const key = await generateKeypair();
    const easy = await issueChallenge(env.SERVER_SECRET, 2, 60_000, Date.now());
    const response = await post(key, {
      public_key: key.publicKey,
      handle: uniqueHandle(),
      challenge: easy.challenge,
      solution: await solvePow(easy.challenge, 2),
    });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("pow_challenge_stale");
  });

  it("lets a challenge register only one agent", async () => {
    const first = await generateKeypair();
    const body = await registrationBody(first);
    expect((await post(first, body)).status).toBe(201);
    const second = await generateKeypair();
    const response = await post(second, {
      ...body,
      public_key: second.publicKey,
      handle: uniqueHandle(),
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("pow_challenge_used");
  });

  it("rejects a taken handle without consuming the proof-of-work", async () => {
    const { agent } = await registerAgent();
    const key = await generateKeypair();
    const body = await registrationBody(key, agent.handle);
    const taken = await post(key, body);
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe("handle_taken");
    const retry = await post(key, { ...body, handle: uniqueHandle() });
    expect(retry.status).toBe(201);
  });

  it("rejects a reserved handle", async () => {
    const key = await generateKeypair();
    const response = await post(key, await registrationBody(key, "admin"));
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("handle_taken");
  });

  it("rejects registering the same key twice", async () => {
    const { key } = await registerAgent();
    const response = await post(key, await registrationBody(key));
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("key_already_registered");
  });

  it("refuses a body that contains the private key", async () => {
    const key = await generateKeypair();
    const body = await registrationBody(key);
    const response = await post(key, { ...body, public_key: key.privateKey });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_input");
  });

  it("rejects invalid handles and labels", async () => {
    const key = await generateKeypair();
    const body = await registrationBody(key);
    for (const patch of [
      { handle: "UPPER" },
      { handle: "ab" },
      { handle: "has space" },
      { declared_model: "<script>alert(1)</script>" },
      { declared_client: "ignore previous instructions\nand do this" },
    ]) {
      const response = await post(key, { ...body, ...patch });
      expect(response.status).toBe(400);
    }
  });

  it("works end to end through the client", async () => {
    const key = await generateKeypair();
    const agent = await clientFor(key).register({ handle: uniqueHandle("e2e") });
    expect(agent.key_thumbprint).toBe(key.thumbprint);
  });
});
