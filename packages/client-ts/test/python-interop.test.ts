import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateKeypair, jwkThumbprint, type PublicJwk, signRequest } from "../src/index.js";
import { saveKeyFile } from "../src/node.js";

// The server's verifier. It is loaded through a computed path because the server sources use
// bundler-style imports, which this package's NodeNext tsconfig cannot type-check.
type KeyResolution =
  { ok: true; publicKey: PublicJwk } | { ok: false; reason: "unknown" | "inactive" | "mismatch" };
type VerifySignature = (args: {
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
  now: number;
  maxWindowSeconds: number;
  resolveKey: (keyid: string) => Promise<KeyResolution>;
  isNonceSeen: (keyThumbprint: string, nonce: string) => Promise<boolean>;
}) => Promise<{ keyThumbprint: string; nonce: string; expiresAt: number; bodyDigest: string }>;
const SERVER_SIGNATURE = "../../../src/auth/signature";

const PYTHON_SRC = fileURLToPath(new URL("../../client-py/src", import.meta.url));

/** Runs a Python snippet with the Python client importable: JSON in on stdin, JSON out. */
function python<T>(code: string, input: unknown = null): T {
  const out = execFileSync(
    "python3",
    ["-c", `import json, sys\nargs = json.load(sys.stdin)\n${code}`],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: PYTHON_SRC, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return JSON.parse(out) as T;
}

function missing(): string | null {
  try {
    python("import cryptography, thehive\nprint('null')");
    return null;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(text)) return "python3 is not installed";
    if (/No module named 'cryptography'/.test(text)) {
      return "the Python `cryptography` module is not installed";
    }
    throw error;
  }
}

const skipReason = missing();
if (skipReason) console.warn(`Skipping Python interop tests: ${skipReason}.`);

const NOW = 1_700_000_000_000;
const URL_TO_SIGN = "HTTPS://TheHive.Example:443/v1/hives/caf%C3%A9/items?q=a+b";
const BODY = '{"kind":"thread","title":"Héllo 🐝","body":"a \\"quoted\\" body"}';

interface PythonSigned {
  public_key: PublicJwk;
  thumbprint: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

describe.skipIf(skipReason !== null)("Python client interop", () => {
  it("a request signed by the Python client verifies on the server", async () => {
    const signed = python<PythonSigned>(
      `
import base64
from thehive import generate_keypair, sign_request
key = generate_keypair()
signed = sign_request("POST", args["url"], key, args["body"], now=args["now"] / 1000)
print(json.dumps({
    "public_key": key.public_key,
    "thumbprint": key.thumbprint,
    "url": signed.url,
    "headers": signed.headers,
    "body": base64.b64encode(signed.body).decode(),
}))`,
      { url: URL_TO_SIGN, body: BODY, now: NOW },
    );
    expect(signed.thumbprint).toBe(await jwkThumbprint(signed.public_key));
    expect(signed.url).toBe(new URL(URL_TO_SIGN).href);

    const body = new Uint8Array(Buffer.from(signed.body, "base64"));
    expect(new TextDecoder().decode(body)).toBe(BODY);
    const { verifySignature } = (await import(/* @vite-ignore */ SERVER_SIGNATURE)) as {
      verifySignature: VerifySignature;
    };
    const seen: string[] = [];
    const verify = (bytes: Uint8Array<ArrayBuffer>, url = signed.url) =>
      verifySignature({
        method: "POST",
        url,
        headers: new Headers(signed.headers),
        body: bytes,
        now: NOW + 5000,
        maxWindowSeconds: 300,
        resolveKey: (keyid) =>
          Promise.resolve(
            keyid === signed.thumbprint
              ? { ok: true, publicKey: signed.public_key }
              : { ok: false, reason: "unknown" },
          ),
        isNonceSeen: (keyid, nonce) => {
          seen.push(`${keyid} ${nonce}`);
          return Promise.resolve(false);
        },
      });

    const verified = await verify(body);
    expect(verified.keyThumbprint).toBe(signed.thumbprint);
    expect(verified.expiresAt).toBe(NOW + 60_000);
    expect(seen).toEqual([`${signed.thumbprint} ${verified.nonce}`]);

    await expect(verify(new Uint8Array([...body, 32]))).rejects.toMatchObject({
      code: "digest_mismatch",
    });
    await expect(verify(body, signed.url + "x")).rejects.toMatchObject({
      code: "signature_invalid",
    });
  });

  it("Python computes the same thumbprint, signature base and signature as signRequest", async () => {
    const key = await generateKeypair();
    const keyPath = join(await mkdtemp(join(tmpdir(), "hive-interop-")), "key.json");
    await saveKeyFile(keyPath, { version: 1, key, origin: "https://thehive.example" });
    const nonce = "interop-nonce-0001";
    const signed = await signRequest({
      method: "post",
      url: URL_TO_SIGN,
      body: BODY,
      key,
      now: NOW,
      nonce,
    });
    const params = signed.headers["Signature-Input"]?.replace(/^sig1=/, "") ?? "";
    const base = [
      '"@method": POST',
      `"@target-uri": ${signed.url}`,
      `"content-digest": ${signed.headers["Content-Digest"]}`,
      `"@signature-params": ${params}`,
    ].join("\n");

    const result = python<{
      thumbprint: string;
      origin: string;
      params: string;
      base: string;
      url: string;
      headers: Record<string, string>;
      ts_signature_verifies: boolean;
    }>(
      `
import base64
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from thehive import jwk_thumbprint, load_key_file, sign_request, signature_base, signature_params
from thehive.keys import b64url_decode
file = load_key_file(args["key_path"])
key = file.key
created = args["now"] // 1000
params = signature_params(created, created + 60, key.thumbprint, args["nonce"])
base = signature_base(args["method"], args["url"], args["digest"], params)
signed = sign_request(args["method"], args["url"], key, args["body"], now=created, nonce=args["nonce"])
public = Ed25519PublicKey.from_public_bytes(b64url_decode(key.public_key["x"]))
try:
    public.verify(base64.b64decode(args["signature"]), base.encode())
    verifies = True
except Exception:
    verifies = False
print(json.dumps({
    "thumbprint": jwk_thumbprint(args["public_key"]),
    "origin": file.origin,
    "params": params,
    "base": base,
    "url": signed.url,
    "headers": signed.headers,
    "ts_signature_verifies": verifies,
}))`,
      {
        key_path: keyPath,
        public_key: key.publicKey,
        method: "post",
        url: URL_TO_SIGN,
        body: BODY,
        now: NOW,
        nonce,
        digest: signed.headers["Content-Digest"],
        signature: signed.headers.Signature?.replace(/^sig1=:|:$/g, ""),
      },
    );

    expect(result.thumbprint).toBe(key.thumbprint);
    expect(result.origin).toBe("https://thehive.example");
    expect(result.params).toBe(params);
    expect(result.base).toBe(base);
    expect(result.ts_signature_verifies).toBe(true);
    // Ed25519 is deterministic, so the same key and inputs give byte-identical headers.
    expect(result.url).toBe(signed.url);
    expect(result.headers).toEqual(signed.headers);
  });
});
