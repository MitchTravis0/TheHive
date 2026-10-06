import { mkdtemp, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateKeypair, leadingZeroBits, signRequest, solvePow } from "../src/index.js";
import { loadKeyFile, nodeSha256, saveKeyFile } from "../src/node.js";

const posix = process.platform !== "win32";

async function tempKeyPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "hive-key-")), "nested", "key.json");
}

describe("key file", () => {
  it("is written with 0600 permissions and round-trips", async () => {
    const path = await tempKeyPath();
    const key = await generateKeypair();
    await saveKeyFile(path, { version: 1, key });
    if (posix) expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await loadKeyFile(path)).key).toEqual(key);
  });

  it("refuses to overwrite an existing key unless asked", async () => {
    const path = await tempKeyPath();
    const key = await generateKeypair();
    await saveKeyFile(path, { version: 1, key });
    await expect(saveKeyFile(path, { version: 1, key: await generateKeypair() })).rejects.toThrow();
    expect((await loadKeyFile(path)).key).toEqual(key);
    await saveKeyFile(path, { version: 1, key, handle: "h" }, { overwrite: true });
    expect((await loadKeyFile(path)).handle).toBe("h");
    if (posix) expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)("refuses to load a key file other users can read", async () => {
    const path = await tempKeyPath();
    await saveKeyFile(path, { version: 1, key: await generateKeypair() });
    await chmod(path, 0o644);
    await expect(loadKeyFile(path)).rejects.toThrow(/chmod 600/);
  });

  it("rejects a corrupt key file", async () => {
    const path = await tempKeyPath();
    const key = await generateKeypair();
    await saveKeyFile(path, { version: 1, key });
    await writeFile(path, JSON.stringify({ version: 1, key: { ...key, thumbprint: "wrong" } }));
    await expect(loadKeyFile(path)).rejects.toThrow(/corrupt/);
  });
});

describe("proof-of-work solver", () => {
  it("finds a solution with the node hash and the default hash", async () => {
    for (const hash of [nodeSha256, undefined]) {
      const solution = await solvePow("challenge-text", 10, { hash });
      const digest = nodeSha256(new TextEncoder().encode("challenge-text" + solution));
      expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("signRequest", () => {
  it("produces a signature that verifies over the RFC 9421 base", async () => {
    const key = await generateKeypair();
    const signed = await signRequest({
      method: "post",
      url: "https://thehive.example/v1/echo",
      body: '{"a":1}',
      key,
      now: 1_700_000_000_000,
      nonce: "fixed-nonce-0001",
    });
    const params = signed.headers["Signature-Input"]?.replace(/^sig1=/, "");
    expect(params).toBe(
      '("@method" "@target-uri" "content-digest");created=1700000000;expires=1700000060;' +
        `keyid="${key.thumbprint}";alg="ed25519";nonce="fixed-nonce-0001"`,
    );
    const base = [
      '"@method": POST',
      '"@target-uri": https://thehive.example/v1/echo',
      `"content-digest": ${signed.headers["Content-Digest"]}`,
      `"@signature-params": ${params}`,
    ].join("\n");
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      key.publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const signature = Buffer.from(
      signed.headers.Signature?.replace(/^sig1=:|:$/g, "") ?? "",
      "base64",
    );
    expect(
      await crypto.subtle.verify("Ed25519", publicKey, signature, new TextEncoder().encode(base)),
    ).toBe(true);
  });
});
