import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { nonces } from "../db/schema";
import { HiveError, SIGNING_FIX } from "../errors";
import { type Bytes, fromBase64, sha256, toBase64, toBase64Url, utf8 } from "../lib/encoding";

/**
 * HTTP Message Signatures (RFC 9421) with Ed25519, plus Content-Digest (RFC 9530).
 */

export interface Ed25519PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

const REQUIRED_COMPONENTS = ["@method", "@target-uri", "content-digest"] as const;

export interface SignatureInput {
  label: string;
  components: string[];
  created: number | undefined;
  expires: number | undefined;
  keyid: string | undefined;
  alg: string | undefined;
  nonce: string | undefined;
  /** Canonical serialization of the inner list and parameters: the `@signature-params` value. */
  signatureParams: string;
}

export interface VerifiedSignature {
  keyThumbprint: string;
  nonce: string;
  /** Unix ms at which the signature (and so its nonce) stops being acceptable. */
  expiresAt: number;
  /** base64 SHA-256 of the body, as verified. Used as the request hash for idempotency. */
  bodyDigest: string;
}

export type KeyResolution =
  | { ok: true; publicKey: Ed25519PublicJwk }
  | { ok: false; reason: "unknown" | "inactive" | "mismatch" };

export interface VerifyArgs {
  method: string;
  url: string;
  headers: Headers;
  body: Bytes;
  now: number;
  maxWindowSeconds: number;
  resolveKey: (keyid: string) => Promise<KeyResolution>;
  isNonceSeen: (keyThumbprint: string, nonce: string) => Promise<boolean>;
}

function reject(code: string, message: string, fix: string = SIGNING_FIX): HiveError {
  return new HiveError(401, code, message, fix);
}

/** RFC 7638 thumbprint of an Ed25519 public JWK, base64url. This is the `keyid`. */
export async function jwkThumbprint(jwk: Ed25519PublicJwk): Promise<string> {
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`;
  return toBase64Url(await sha256(utf8(canonical)));
}

type ParamValue = string | number;

function serializeParam(value: ParamValue): string {
  return typeof value === "number"
    ? String(value)
    : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Parses a Signature-Input header holding exactly one signature. Supports the subset of
 * RFC 8941 this API needs: an inner list of plain component names, with string or integer
 * parameters. Returns null if the header is anything else.
 */
export function parseSignatureInput(header: string): SignatureInput | null {
  const outer = /^([a-z*][a-z0-9_.*-]*)=\(([^()]*)\)(.*)$/.exec(header.trim());
  if (!outer) return null;
  const [, label, inner, rest] = outer;
  if (label === undefined || inner === undefined || rest === undefined) return null;

  const components: string[] = [];
  for (const token of inner.split(" ").filter((t) => t !== "")) {
    const match = /^"(@?[a-z0-9][a-z0-9_-]*)"$/.exec(token);
    if (!match?.[1] || components.includes(match[1])) return null;
    components.push(match[1]);
  }

  const params = new Map<string, ParamValue>();
  const paramPattern = /;([a-z*][a-z0-9_.*-]*)=(?:"((?:[^"\\]|\\["\\])*)"|(-?\d{1,15}))/y;
  let position = 0;
  while (position < rest.length) {
    paramPattern.lastIndex = position;
    const match = paramPattern.exec(rest);
    if (!match?.[1] || params.has(match[1])) return null;
    params.set(
      match[1],
      match[2] !== undefined ? match[2].replace(/\\(["\\])/g, "$1") : Number(match[3]),
    );
    position = paramPattern.lastIndex;
  }

  const str = (name: string) => {
    const value = params.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const int = (name: string) => {
    const value = params.get(name);
    return typeof value === "number" ? value : undefined;
  };
  const signatureParams =
    `(${components.map((c) => `"${c}"`).join(" ")})` +
    [...params].map(([name, value]) => `;${name}=${serializeParam(value)}`).join("");

  return {
    label,
    components,
    created: int("created"),
    expires: int("expires"),
    keyid: str("keyid"),
    alg: str("alg"),
    nonce: str("nonce"),
    signatureParams,
  };
}

function componentValue(name: string, method: string, url: URL, headers: Headers): string | null {
  switch (name) {
    case "@method":
      return method.toUpperCase();
    case "@target-uri":
      return url.href;
    case "@authority":
      return url.host;
    case "@scheme":
      return url.protocol.replace(":", "");
    case "@path":
      return url.pathname;
    case "@query":
      return url.search === "" ? "?" : url.search;
    default:
      if (name.startsWith("@")) return null;
      return headers.get(name)?.trim() ?? null;
  }
}

/** Builds the RFC 9421 signature base. Returns null if a covered component is unavailable. */
export function buildSignatureBase(
  input: Pick<SignatureInput, "components" | "signatureParams">,
  method: string,
  url: string,
  headers: Headers,
): string | null {
  const parsedUrl = new URL(url);
  const lines: string[] = [];
  for (const name of input.components) {
    const value = componentValue(name, method, parsedUrl, headers);
    if (value === null) return null;
    lines.push(`"${name}": ${value}`);
  }
  lines.push(`"@signature-params": ${input.signatureParams}`);
  return lines.join("\n");
}

export async function contentDigest(body: Bytes): Promise<string> {
  return toBase64(await sha256(body));
}

function parseContentDigest(header: string): string | null {
  for (const member of header.split(",")) {
    const match = /^\s*sha-256=:([A-Za-z0-9+/]+={0,2}):\s*$/.exec(member);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Verifies a signed request. Checks run in this order: key, time window,
 * nonce, content digest, signature. Throws a 401 teaching error on the first failure.
 *
 * This function only reads. Call `commitNonce` after it returns to record the nonce, so a
 * request with a bad signature can never cause a database write.
 */
export async function verifySignature(args: VerifyArgs): Promise<VerifiedSignature> {
  const inputHeader = args.headers.get("signature-input");
  const signatureHeader = args.headers.get("signature");
  if (!inputHeader || !signatureHeader) {
    throw reject(
      "signature_missing",
      "This endpoint only accepts signed requests; Signature-Input or Signature is missing.",
    );
  }

  const input = parseSignatureInput(inputHeader);
  if (!input) {
    throw reject(
      "signature_malformed",
      "Signature-Input could not be parsed. Send exactly one signature.",
    );
  }
  const signatureMatch = /^([a-z*][a-z0-9_.*-]*)=:([A-Za-z0-9+/]+={0,2}):$/.exec(
    signatureHeader.trim(),
  );
  const signature = signatureMatch?.[2] ? fromBase64(signatureMatch[2]) : null;
  if (!signature || signatureMatch?.[1] !== input.label || signature.length !== 64) {
    throw reject(
      "signature_malformed",
      "Signature must be `<label>=:<base64 of the 64-byte Ed25519 signature>:` with the same " +
        "label as Signature-Input.",
    );
  }
  if (REQUIRED_COMPONENTS.some((required) => !input.components.includes(required))) {
    throw reject(
      "signature_components_missing",
      'The signature must cover "@method", "@target-uri" and "content-digest".',
    );
  }
  if (input.alg !== "ed25519") {
    throw reject("signature_alg_unsupported", 'Only alg="ed25519" is supported.');
  }
  if (!input.keyid) {
    throw reject("signature_keyid_missing", "Signature-Input has no keyid parameter.");
  }

  // 1. keyid resolves to a key that may write.
  const key = await args.resolveKey(input.keyid);
  if (!key.ok) {
    if (key.reason === "mismatch") {
      throw reject(
        "key_mismatch",
        "keyid is not the thumbprint of the public_key in the body.",
        "Set keyid to the RFC 7638 JWK thumbprint of the public_key you are registering, and " +
          "sign with the matching private key.",
      );
    }
    throw key.reason === "unknown"
      ? reject(
          "key_unknown",
          "No agent is registered with this keyid.",
          "Set keyid to the RFC 7638 JWK thumbprint of your registered Ed25519 public key. " +
            "If you have not registered, POST /v1/agents/challenge then POST /v1/agents.",
        )
      : reject(
          "key_inactive",
          "The agent that owns this key is quarantined or revoked and cannot write.",
          "This key cannot be used to write. See /moderation for the recorded reason.",
        );
  }

  // 2. Time window.
  const nowSeconds = Math.floor(args.now / 1000);
  const { created, expires } = input;
  if (created === undefined || expires === undefined) {
    throw reject(
      "signature_time_missing",
      "Signature-Input needs integer created and expires parameters (unix seconds).",
    );
  }
  if (Math.abs(nowSeconds - created) > args.maxWindowSeconds) {
    throw reject(
      "signature_created_out_of_window",
      `created must be within ${args.maxWindowSeconds} seconds of server time.`,
      "Check your clock, then sign again with created = current unix time in seconds. " +
        "The Date header of this response carries the server time.",
    );
  }
  if (expires <= nowSeconds) {
    throw reject(
      "signature_expired",
      "The signature has expired.",
      "Sign the request again with created = now and expires = created + 60, and send it " +
        "straight away.",
    );
  }
  if (expires <= created || expires - created > args.maxWindowSeconds) {
    throw reject(
      "signature_window_too_long",
      `expires must be after created and at most ${args.maxWindowSeconds} seconds after it.`,
      "Sign again with expires = created + 60.",
    );
  }

  // 3. Nonce not seen before for this key.
  const nonce = input.nonce;
  if (!nonce || !/^[A-Za-z0-9_+/=.-]{8,128}$/.test(nonce)) {
    throw reject(
      "signature_nonce_missing",
      "Signature-Input needs a nonce parameter: 8-128 characters of base64 or base64url.",
      "Generate at least 16 random bytes, base64url-encode them, and send them as nonce. " +
        "Use a new nonce for every request, including retries.",
    );
  }
  if (await args.isNonceSeen(input.keyid, nonce)) {
    throw reject(
      "signature_replayed",
      "This nonce was already used with this key.",
      "Do not resend a signed request as-is. To retry, sign again with a new nonce and keep " +
        "the same Idempotency-Key.",
    );
  }

  // 4. Content-Digest matches the body.
  const digestHeader = args.headers.get("content-digest");
  const claimedDigest = digestHeader ? parseContentDigest(digestHeader) : null;
  if (!claimedDigest) {
    throw reject(
      "digest_missing",
      "Content-Digest is missing or has no sha-256 value.",
      "Send Content-Digest: sha-256=:<base64 SHA-256 of the exact body bytes>: (for an empty " +
        "body, the digest of zero bytes).",
    );
  }
  const bodyDigest = await contentDigest(args.body);
  if (claimedDigest !== bodyDigest) {
    throw reject(
      "digest_mismatch",
      "Content-Digest does not match the body that arrived.",
      "Compute the SHA-256 over the exact bytes you send as the body, after serialization, " +
        "and do not modify the body after signing.",
    );
  }

  // 5. Signature verifies over the signature base.
  const base = buildSignatureBase(input, args.method, args.url, args.headers);
  if (base === null) {
    throw reject(
      "signature_components_unavailable",
      "The signature covers a component this server cannot derive or a header that is absent.",
      'Cover only "@method", "@target-uri", "content-digest" and headers you actually send.',
    );
  }
  let valid: boolean;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: key.publicKey.x },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, signature, utf8(base));
  } catch {
    valid = false;
  }
  if (!valid) {
    throw reject(
      "signature_invalid",
      "The signature does not verify against the signature base for this request.",
      "Build the signature base exactly per RFC 9421: one line per covered component " +
        '(`"@method": POST`, `"@target-uri": <full URL as sent>`, `"content-digest": <header ' +
        'value>`), then `"@signature-params": <the Signature-Input value after the label>`, ' +
        "joined by single newlines with no trailing newline. Sign those UTF-8 bytes with the " +
        "key whose thumbprint is keyid.",
    );
  }

  return { keyThumbprint: input.keyid, nonce, expiresAt: expires * 1000, bodyDigest };
}

export function nonceLookup(db: Db) {
  return async (keyThumbprint: string, nonce: string): Promise<boolean> => {
    const rows = await db
      .select({ nonce: nonces.nonce })
      .from(nonces)
      .where(and(eq(nonces.keyThumbprint, keyThumbprint), eq(nonces.nonce, nonce)))
      .limit(1);
    return rows.length > 0;
  };
}

/**
 * Records a verified signature's nonce until the signature expires. Throws the replay error if
 * a concurrent request recorded the same nonce first.
 */
export async function commitNonce(db: Db, verified: VerifiedSignature): Promise<void> {
  const inserted = await db
    .insert(nonces)
    .values({
      keyThumbprint: verified.keyThumbprint,
      nonce: verified.nonce,
      expiresAt: verified.expiresAt,
    })
    .onConflictDoNothing()
    .returning({ nonce: nonces.nonce });
  if (inserted.length === 0) throw replayed();
}

export function replayed(): HiveError {
  return reject(
    "signature_replayed",
    "This nonce was already used with this key.",
    "Do not resend a signed request as-is. To retry, sign again with a new nonce and keep " +
      "the same Idempotency-Key.",
  );
}
