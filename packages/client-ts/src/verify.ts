import { type Bytes, sha256, toBase64, utf8 } from "./encoding.js";
import type { HiveSigningKey, WebhookEvent } from "./client.js";

export interface IncomingRequest {
  method: string;
  /** The full URL the hive called: your webhook URL exactly as you registered it. */
  url: string;
  headers: { get(name: string): string | null } | Record<string, string | undefined>;
  /** The raw body bytes, before any JSON parsing. */
  body: Uint8Array | string;
}

export interface VerifyOptions {
  /** Unix ms. Defaults to the current time. */
  now?: number;
  /** Allowed clock difference in seconds. Default 300. */
  toleranceSeconds?: number;
}

const INPUT =
  /^sig1=(\("@method" "@target-uri" "content-digest"\);created=(\d+);expires=(\d+);keyid="([A-Za-z0-9_-]+)";alg="ed25519";nonce="([A-Za-z0-9_-]+)")$/;

function header(headers: IncomingRequest["headers"], name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const record = headers as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name) return value ?? null;
  }
  return null;
}

function fromBase64(text: string): Bytes | null {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Checks that a webhook delivery really came from the hive: the signature (RFC 9421, Ed25519)
 * covers the method, your URL and the digest of the body, was made with one of `keys` (from
 * `HiveClient.hiveKeys()`), and is fresh. Returns the event, or null if anything is off.
 * To stop replays, also remember recent `event.id` values and ignore repeats.
 */
export async function verifyHiveRequest(
  request: IncomingRequest,
  keys: HiveSigningKey[],
  options: VerifyOptions = {},
): Promise<WebhookEvent | null> {
  const body = typeof request.body === "string" ? utf8(request.body) : new Uint8Array(request.body);
  const digest = `sha-256=:${toBase64(await sha256(body))}:`;
  if (header(request.headers, "content-digest") !== digest) return null;

  const match = INPUT.exec(header(request.headers, "signature-input") ?? "");
  const signature = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(header(request.headers, "signature") ?? "");
  if (!match || !signature) return null;
  const [, params, created, expires, keyid] = match;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Number(created) > now + tolerance || Number(expires) < now - tolerance) return null;

  const key = keys.find((candidate) => candidate.kid === keyid);
  const signatureBytes = fromBase64(signature[1] ?? "");
  if (!key || !signatureBytes) return null;
  const base = [
    `"@method": ${request.method.toUpperCase()}`,
    `"@target-uri": ${new URL(request.url).href}`,
    `"content-digest": ${digest}`,
    `"@signature-params": ${params}`,
  ].join("\n");
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: key.kty, crv: key.crv, x: key.x },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      signatureBytes,
      utf8(base),
    );
    if (!valid) return null;
  } catch {
    // A malformed key in the directory verifies nothing.
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as WebhookEvent;
  } catch {
    return null;
  }
}
