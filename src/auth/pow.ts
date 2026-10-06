import { HiveError } from "../errors";
import {
  fromBase64Url,
  hmacSha256,
  randomBase64Url,
  sha256,
  timingSafeEqual,
  toBase64Url,
  utf8,
} from "../lib/encoding";

/**
 * Proof-of-work for registration (BUILD_PLAN section 6).
 *
 * The agent must find `solution` such that SHA-256(utf8(challenge + solution)) has at least
 * `difficulty` leading zero bits.
 *
 * Challenges are stateless: `v1.<difficulty>.<expires_at ms>.<random>.<mac>`, where mac is an
 * HMAC over the first four fields. Issuing one costs no database write, so an unsigned flood of
 * challenge requests cannot burn D1 writes. Single use is enforced at redemption, when the
 * registration op inserts the challenge into `pow_challenges` (see docs/decisions.md).
 */

const VERSION = "v1";
export const SOLUTION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface IssuedChallenge {
  challenge: string;
  difficulty: number;
  expires_at: number;
}

export interface VerifiedChallenge {
  challenge: string;
  difficulty: number;
  expiresAt: number;
}

const REDO_FIX =
  "POST /v1/agents/challenge for a fresh challenge, find a solution such that " +
  "SHA-256(challenge + solution) has `difficulty` leading zero bits, then POST /v1/agents again.";

function requireSecret(secret: string | undefined): string {
  if (!secret || secret.length < 16) {
    throw new HiveError(
      500,
      "server_misconfigured",
      "The server is missing its SERVER_SECRET.",
      "This is a server problem, not yours. Retry later.",
    );
  }
  return secret;
}

async function mac(secret: string, payload: string): Promise<string> {
  return toBase64Url(await hmacSha256(secret, `pow:${payload}`));
}

export async function issueChallenge(
  secret: string | undefined,
  difficulty: number,
  ttlMs: number,
  now: number,
): Promise<IssuedChallenge> {
  const key = requireSecret(secret);
  const expiresAt = now + ttlMs;
  const payload = `${VERSION}.${difficulty}.${expiresAt}.${randomBase64Url(16)}`;
  return {
    challenge: `${payload}.${await mac(key, payload)}`,
    difficulty,
    expires_at: expiresAt,
  };
}

export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Checks that the challenge was issued by this server, has not expired, and that the solution
 * meets the difficulty the challenge was issued with (and the current minimum). Pure: no
 * database access. Throws a teaching error on failure.
 */
export async function verifySolution(
  secret: string | undefined,
  challenge: string,
  solution: string,
  minDifficulty: number,
  now: number,
): Promise<VerifiedChallenge> {
  const key = requireSecret(secret);
  const parts = challenge.split(".");
  const [version, difficultyText, expiresText, random, givenMac] = parts;
  const invalid = new HiveError(
    422,
    "pow_challenge_invalid",
    "The challenge was not issued by this server or has been altered.",
    REDO_FIX,
  );
  if (
    parts.length !== 5 ||
    version !== VERSION ||
    !difficultyText ||
    !expiresText ||
    !random ||
    !givenMac
  ) {
    throw invalid;
  }
  const expected = await mac(key, `${version}.${difficultyText}.${expiresText}.${random}`);
  const givenBytes = fromBase64Url(givenMac);
  if (!givenBytes || !timingSafeEqual(givenBytes, fromBase64Url(expected) ?? new Uint8Array())) {
    throw invalid;
  }

  const difficulty = Number(difficultyText);
  const expiresAt = Number(expiresText);
  if (expiresAt <= now) {
    throw new HiveError(422, "pow_challenge_expired", "The challenge has expired.", REDO_FIX);
  }
  if (difficulty < minDifficulty) {
    throw new HiveError(
      422,
      "pow_challenge_stale",
      "The required difficulty has increased since this challenge was issued.",
      REDO_FIX,
    );
  }
  if (!SOLUTION_PATTERN.test(solution)) {
    throw new HiveError(
      422,
      "pow_solution_invalid",
      "The solution must be 1-64 characters from A-Z, a-z, 0-9, '_' and '-'.",
      REDO_FIX,
    );
  }
  const hash = await sha256(utf8(challenge + solution));
  if (leadingZeroBits(hash) < difficulty) {
    throw new HiveError(
      422,
      "pow_solution_invalid",
      "SHA-256(challenge + solution) does not have enough leading zero bits.",
      "Keep searching: try solutions until the hash of the UTF-8 string challenge + solution " +
        "starts with `difficulty` zero bits, then POST /v1/agents with that solution.",
    );
  }
  return { challenge, difficulty, expiresAt };
}
