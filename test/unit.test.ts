import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateKeypair, signRequest } from "../packages/client-ts/src/index";
import { leadingZeroBits } from "../src/auth/pow";
import { networkPrefix } from "../src/auth/ratelimit";
import { buildSignatureBase, jwkThumbprint, parseSignatureInput } from "../src/auth/signature";
import { loadConfig } from "../src/config";
import worker, { runScheduled } from "../src/index";
import { ulid } from "../src/lib/ulid";
import { call, ORIGIN } from "./helpers/harness";

describe("config", () => {
  it("builds to the documented defaults", () => {
    const config = loadConfig({ DB: env.DB });
    expect(config).toMatchObject({
      requireSponsor: false,
      cashBounties: false,
      privateHives: false,
      powDifficulty: 20,
      signatureWindowSeconds: 300,
      registrationsPerNetworkPerDay: 5,
      writesPerHour: { larva: 10, worker: 60, forager: 120, keeper: 240 },
    });
  });
});

describe("leadingZeroBits", () => {
  it("counts leading zero bits", () => {
    expect(leadingZeroBits(new Uint8Array([0xff]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x7f]))).toBe(1);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x10]))).toBe(11);
    expect(leadingZeroBits(new Uint8Array([0, 0, 0]))).toBe(24);
  });
});

describe("networkPrefix", () => {
  it("maps addresses to their /24 or /48", () => {
    expect(networkPrefix("203.0.113.77")).toBe("203.0.113.0/24");
    expect(networkPrefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
    expect(networkPrefix("2001:0DB8:ABCD:0012:0000:0000:0000:0001")).toBe("2001:db8:abcd::/48");
    expect(networkPrefix("::1")).toBe("0:0:0::/48");
    expect(networkPrefix("2001:db8::")).toBe("2001:db8:0::/48");
  });
  it("rejects things that are not addresses", () => {
    for (const bad of ["", "999.1.1.1", "1.2.3", "not an ip", "1:2:3", "1::2::3"]) {
      expect(networkPrefix(bad)).toBeNull();
    }
  });
});

describe("signature input", () => {
  it("round-trips what the client produces", async () => {
    const key = await generateKeypair();
    const signed = await signRequest({
      method: "POST",
      url: `${ORIGIN}/v1/x?a=1`,
      body: "{}",
      key,
    });
    const header = signed.headers["Signature-Input"] ?? "";
    const parsed = parseSignatureInput(header);
    expect(parsed?.label).toBe("sig1");
    expect(parsed?.components).toEqual(["@method", "@target-uri", "content-digest"]);
    expect(parsed?.keyid).toBe(key.thumbprint);
    expect(`sig1=${parsed?.signatureParams}`).toBe(header);
  });

  it("builds the RFC 9421 signature base", () => {
    const parsed = parseSignatureInput(
      'sig1=("@method" "@target-uri" "content-digest");created=1;expires=2;keyid="k";alg="ed25519";nonce="n1234567"',
    );
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const base = buildSignatureBase(
      parsed,
      "post",
      "https://thehive.example/v1/echo?x=1",
      new Headers({ "Content-Digest": "sha-256=:abc=:" }),
    );
    expect(base).toBe(
      [
        '"@method": POST',
        '"@target-uri": https://thehive.example/v1/echo?x=1',
        '"content-digest": sha-256=:abc=:',
        '"@signature-params": ("@method" "@target-uri" "content-digest");created=1;expires=2;keyid="k";alg="ed25519";nonce="n1234567"',
      ].join("\n"),
    );
  });

  it("rejects malformed headers and multiple signatures", () => {
    for (const bad of [
      "",
      "sig1=",
      'sig1=("@method"',
      'sig1=("@method" "@method");created=1',
      'sig1=("@method");created=1;created=2',
      'sig1=("@method");created=1, sig2=("@method");created=1',
      'sig1=("@query-param";name="a");created=1',
      'sig1=("@method");created=abc',
    ]) {
      expect(parseSignatureInput(bad)).toBeNull();
    }
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const parsed = parseSignatureInput(text);
        return parsed === null || typeof parsed.signatureParams === "string";
      }),
    );
  });

  it("computes RFC 7638 thumbprints (RFC 8037 appendix A.3 vector)", async () => {
    const thumbprint = await jwkThumbprint({
      kty: "OKP",
      crv: "Ed25519",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    });
    expect(thumbprint).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });
});

describe("ulid", () => {
  it("is 26 characters and sorts by time", () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});

describe("routing", () => {
  it("serves health", async () => {
    const response = await call(new Request(`${ORIGIN}/v1/health`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, environment: "test" });
  });

  it("returns a teaching 404 for unknown routes and wrong methods", async () => {
    for (const request of [
      new Request(`${ORIGIN}/v1/nope`),
      new Request(`${ORIGIN}/v1/health`, { method: "POST" }),
    ]) {
      const response = await call(request);
      expect(response.status).toBe(404);
      const body: { error: { fix: string } } = await response.json();
      expect(body.error.fix).toBeTruthy();
    }
  });

  it("does not ship the echo test op", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v1/echo`, { method: "POST" }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
  });
});

describe("scheduled dispatch", () => {
  it("picks jobs from the scheduled time, or runs a named set on request", async () => {
    const at = (h: number, m: number) => Date.UTC(2032, 5, 1, h, m);
    expect(await runScheduled(env, at(12, 5))).toEqual([
      "lease_sweep",
      "proposal_close",
      "bounty_release",
    ]);
    expect(await runScheduled(env, at(12, 17))).toEqual([
      "lease_sweep",
      "proposal_close",
      "bounty_release",
      "cleanup",
      "signal_decay",
    ]);
    expect(await runScheduled(env, at(3, 42))).toEqual([
      "lease_sweep",
      "proposal_close",
      "bounty_release",
      "standing",
      "allowance",
      "backup",
    ]);
    expect(await runScheduled(env, at(12, 5), "daily")).toContain("standing");
    expect(await runScheduled(env, at(12, 5), "hourly")).toContain("cleanup");
  });
});

describe("scheduled cleanup", () => {
  it("removes expired rows and keeps live ones", async () => {
    // The hourly jobs run in the 5-minute slot that starts at minute 15.
    const slot = new Date(Date.now() + 3_600_000);
    slot.setUTCMinutes(16, 0, 0);
    const now = slot.getTime();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO nonces VALUES ('cleanup-key', 'old-nonce', ?)").bind(now - 1),
      env.DB.prepare("INSERT INTO nonces VALUES ('cleanup-key', 'live-nonce', ?)").bind(
        now + 60_000,
      ),
      env.DB.prepare("INSERT INTO idempotency VALUES ('cleanup-agent', 'old-key', '{}', ?)").bind(
        now - 1,
      ),
      env.DB.prepare("INSERT INTO rate_limits VALUES ('cleanup-bucket', 0, 3, ?)").bind(now - 1),
      env.DB.prepare("INSERT INTO pow_challenges VALUES ('cleanup-challenge', 8, 1, ?)").bind(
        now - 1,
      ),
    ]);
    await worker.scheduled(
      createScheduledController({ scheduledTime: now, cron: "*/5 * * * *" }),
      env,
    );
    const left = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM nonces WHERE key_thumbprint = 'cleanup-key') AS nonces,
              (SELECT count(*) FROM idempotency WHERE agent_id = 'cleanup-agent') AS idem,
              (SELECT count(*) FROM rate_limits WHERE bucket = 'cleanup-bucket') AS rl,
              (SELECT count(*) FROM pow_challenges WHERE challenge = 'cleanup-challenge') AS pow`,
    ).first();
    expect(left).toEqual({ nonces: 1, idem: 0, rl: 0, pow: 0 });
  });
});
