import { type Bytes, hmacSha256, randomBase64Url, toBase64, utf8 } from "../lib/encoding";
import { contentDigest, type Ed25519PublicJwk, jwkThumbprint } from "./signature";

/**
 * The Hive's own Ed25519 signing key, used to sign what the hive sends out (webhook
 * deliveries now, standing attestations later). It is derived from `SERVER_SECRET`, so
 * there is no second secret to set; rotating `SERVER_SECRET` rotates this key too. Agents get
 * the public half from /.well-known/http-message-signatures-directory.
 */

export interface ServerKey {
  privateKey: CryptoKey;
  publicJwk: Ed25519PublicJwk;
  /** RFC 7638 thumbprint of the public key: the `keyid` on everything the hive signs. */
  thumbprint: string;
}

// PKCS#8 wrapping of a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

const cache = new Map<string, Promise<ServerKey>>();

async function derive(secret: string): Promise<ServerKey> {
  const seed = await hmacSha256(secret, "the-hive/signing-key/v1");
  const pkcs8 = new Uint8Array([...PKCS8_PREFIX, ...seed]);
  const extractable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, [
    "sign",
  ]);
  const jwk = (await crypto.subtle.exportKey("jwk", extractable)) as { x?: string };
  if (!jwk.x) throw new Error("server key export failed");
  const publicJwk: Ed25519PublicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  return {
    privateKey: await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]),
    publicJwk,
    thumbprint: await jwkThumbprint(publicJwk),
  };
}

/** Null when no `SERVER_SECRET` is set: the hive then signs nothing and sends no webhooks. */
export function serverKey(secret: string | undefined): Promise<ServerKey> | null {
  if (!secret) return null;
  let key = cache.get(secret);
  if (!key) {
    key = derive(secret);
    cache.set(secret, key);
  }
  return key;
}

const COVERED = '("@method" "@target-uri" "content-digest")';

/**
 * Signs an outgoing request the same way agents sign theirs: RFC 9421
 * over the method, the full target URI and the Content-Digest of the body.
 */
export async function signOutgoing(
  key: ServerKey,
  request: { method: string; url: string; body: Bytes; now: number; ttlSeconds?: number },
): Promise<Record<string, string>> {
  const created = Math.floor(request.now / 1000);
  const digest = `sha-256=:${await contentDigest(request.body)}:`;
  const params =
    `${COVERED};created=${created};expires=${created + (request.ttlSeconds ?? 300)};` +
    `keyid="${key.thumbprint}";alg="ed25519";nonce="${randomBase64Url(16)}"`;
  const base = [
    `"@method": ${request.method.toUpperCase()}`,
    `"@target-uri": ${new URL(request.url).href}`,
    `"content-digest": ${digest}`,
    `"@signature-params": ${params}`,
  ].join("\n");
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, utf8(base)),
  );
  return {
    "Content-Digest": digest,
    "Signature-Input": `sig1=${params}`,
    Signature: `sig1=:${toBase64(signature)}:`,
  };
}
