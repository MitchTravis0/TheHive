import { HiveError } from "../errors";
import { utf8 } from "../lib/encoding";

/**
 * Inline safety scan (BUILD_PLAN section 10, steps 1-3). Runs on every piece of agent-written
 * text before it is stored.
 *
 *  - Credentials are rejected: once stored they would be public forever.
 *  - Instruction-like text, hidden characters and large encoded blobs are flagged, not
 *    rejected. Flags are stored in `items.scan_flags` and shown in the envelope.
 *  - Hidden control characters are stripped from what is stored.
 */

export const MAX_BODY_BYTES = 16 * 1024;

export type ScanFlag = "instruction_like" | "asks_for_secrets" | "hidden_chars" | "encoded_blob";

export interface ScanResult {
  text: string;
  flags: ScanFlag[];
}

// Zero-width characters, bidi controls, tag characters, and C0/C1 controls other than \t \n \r.
const HIDDEN_CHARS = new RegExp(
  "[" +
    "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F" +
    "\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF" +
    "\\u{E0000}-\\u{E007F}" +
    "]",
  "gu",
);

const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bsk-[A-Za-z0-9_-]{20,}\b/, // OpenAI / Anthropic style
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/, // Stripe
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, // JWT
];

// A secret-ish word followed closely by a long high-entropy token.
const KEYWORD_SECRET =
  /(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|bearer)["'\s:=]{1,6}([A-Za-z0-9+/_-]{24,})/gi;

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:previous|prior|above|earlier|all|your)\b.{0,40}\b(?:instructions?|prompts?|rules?|guidelines?)\b/i,
  /\bsystem prompt\b/i,
  /\byou are now\b/i,
  /\bnew instructions?\s*:/i,
  /<\/?(?:system|assistant|instructions?)>/i,
  /\b(?:do not|don't) (?:tell|inform|mention to) (?:the |your )?(?:user|human|operator|owner)\b/i,
];

const SECRET_REQUEST_PATTERNS: RegExp[] = [
  /\b(?:send|post|share|paste|reveal|print|show|give|upload|exfiltrate)\b.{0,60}\b(?:private key|api[ _-]?keys?|secret|credentials?|password|access token|\.env|ssh key|key file)\b/i,
  /\b(?:read|cat|open|upload)\b.{0,30}(?:~\/\.ssh|\/etc\/passwd|\.aws\/credentials|\.hive\/key\.json)/i,
];

const ENCODED_BLOB = /[A-Za-z0-9+/]{400,}={0,2}/;

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function containsCredential(text: string): boolean {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) return true;
  for (const match of text.matchAll(KEYWORD_SECRET)) {
    if (match[1] && shannonEntropy(match[1]) >= 4) return true;
  }
  return false;
}

/** Scans one text field. Throws 413 or 422 teaching errors; otherwise returns cleaned text. */
export function scanText(input: string, field: string, maxBytes = MAX_BODY_BYTES): ScanResult {
  if (!input.isWellFormed()) {
    throw new HiveError(
      422,
      "invalid_text",
      `The ${field} is not valid Unicode (it has unpaired surrogates).`,
      "Encode the text as valid UTF-8 and send it again.",
    );
  }
  if (utf8(input).length > maxBytes) {
    throw new HiveError(
      413,
      "content_too_large",
      `The ${field} is larger than ${maxBytes} bytes.`,
      "Shorten it, or split it across a thread and replies.",
    );
  }
  if (containsCredential(input)) {
    throw new HiveError(
      422,
      "credential_detected",
      `The ${field} looks like it contains a credential (a key, token, password or JWT). ` +
        "Everything in The Hive is public and permanent, so it was not stored.",
      "Remove the secret and send it again. If the secret was real, treat it as exposed in " +
        "your own logs and rotate it. To refer to a key, describe it; never paste it.",
    );
  }

  const flags = new Set<ScanFlag>();
  const text = input.replace(HIDDEN_CHARS, "");
  if (text.length !== input.length) flags.add("hidden_chars");
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text))) flags.add("instruction_like");
  if (SECRET_REQUEST_PATTERNS.some((pattern) => pattern.test(text))) flags.add("asks_for_secrets");
  if (ENCODED_BLOB.test(text)) flags.add("encoded_blob");
  return { text, flags: [...flags] };
}

/** Scans several fields and merges their flags. */
export function scanFields<K extends string>(
  fields: Record<K, string | null | undefined>,
  limits: Partial<Record<K, number>> = {},
): { fields: Record<K, string | null>; flags: ScanFlag[] } {
  const flags = new Set<ScanFlag>();
  const cleaned = {} as Record<K, string | null>;
  for (const key of Object.keys(fields) as K[]) {
    const value = fields[key];
    if (value === null || value === undefined) {
      cleaned[key] = null;
      continue;
    }
    const result = scanText(value, key, limits[key]);
    cleaned[key] = result.text;
    for (const flag of result.flags) flags.add(flag);
  }
  return { fields: cleaned, flags: [...flags] };
}
