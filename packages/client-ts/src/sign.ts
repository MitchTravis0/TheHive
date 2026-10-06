import { type Bytes, randomBase64Url, sha256, toBase64, utf8 } from "./encoding.js";
import type { HiveKeypair } from "./keys.js";

export interface SignRequestOptions {
  method: string;
  url: string;
  /** The exact bytes that will be sent. Strings are encoded as UTF-8. Omit for an empty body. */
  body?: Uint8Array | string;
  key: HiveKeypair;
  /** Unix ms. Defaults to the current time. */
  now?: number;
  /** How long the signature is valid. The server accepts at most 300 seconds. */
  ttlSeconds?: number;
  /** Defaults to 16 fresh random bytes. Never reuse a nonce. */
  nonce?: string;
}

export interface SignedRequest {
  /** The URL that was signed. Send the request to exactly this URL. */
  url: string;
  body: Bytes;
  /** Content-Digest, Signature-Input and Signature. */
  headers: Record<string, string>;
}

const COVERED = '("@method" "@target-uri" "content-digest")';

/**
 * Signs a request with HTTP Message Signatures (RFC 9421) and Ed25519, covering the method,
 * the full target URI and the Content-Digest of the body.
 */
export async function signRequest(options: SignRequestOptions): Promise<SignedRequest> {
  const body =
    typeof options.body === "string" ? utf8(options.body) : new Uint8Array(options.body ?? []);
  const url = new URL(options.url).href;
  const created = Math.floor((options.now ?? Date.now()) / 1000);
  const expires = created + (options.ttlSeconds ?? 60);
  const nonce = options.nonce ?? randomBase64Url(16);

  const contentDigest = `sha-256=:${toBase64(await sha256(body))}:`;
  const params =
    `${COVERED};created=${created};expires=${expires};` +
    `keyid="${options.key.thumbprint}";alg="ed25519";nonce="${nonce}"`;
  const base = [
    `"@method": ${options.method.toUpperCase()}`,
    `"@target-uri": ${url}`,
    `"content-digest": ${contentDigest}`,
    `"@signature-params": ${params}`,
  ].join("\n");

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { ...options.key.privateKey },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, utf8(base)),
  );

  return {
    url,
    body,
    headers: {
      "Content-Digest": contentDigest,
      "Signature-Input": `sig1=${params}`,
      Signature: `sig1=:${toBase64(signature)}:`,
    },
  };
}
