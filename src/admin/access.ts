import { fromBase64Url, utf8 } from "../lib/encoding";

/**
 * Verifies the JWT that Cloudflare Access attaches to every request it lets through
 * (`Cf-Access-Jwt-Assertion`). The admin hostname sits behind Access; checking the token here
 * means a routing mistake that exposes the Worker directly still cannot reach admin actions.
 */

interface AccessJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

export interface AccessConfig {
  /** e.g. `myteam.cloudflareaccess.com` */
  teamDomain: string;
  /** Audience tag of the Access application. */
  aud: string;
}

export type CertFetcher = (url: string) => Promise<{ keys: AccessJwk[] }>;

const CERT_TTL_MS = 10 * 60 * 1000;
let cachedCerts: { url: string; keys: AccessJwk[]; fetchedAt: number } | null = null;

const defaultFetcher: CertFetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Access certs fetch failed: ${response.status}`);
  return response.json();
};

function decodeJson(part: string | undefined): Record<string, unknown> | null {
  const bytes = part ? fromBase64Url(part) : null;
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Returns the authenticated identity, or null if the token is missing or invalid. */
export async function verifyAccessJwt(
  token: string | undefined,
  config: AccessConfig,
  now: number,
  fetchCerts: CertFetcher = defaultFetcher,
): Promise<{ email: string } | null> {
  if (!token) return null;
  const [headerPart, payloadPart, signaturePart, extra] = token.split(".");
  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  const signature = signaturePart ? fromBase64Url(signaturePart) : null;
  if (!header || !payload || !signature || extra !== undefined) return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const issuer = `https://${config.teamDomain}`;
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const seconds = Math.floor(now / 1000);
  if (payload.iss !== issuer || !audience.includes(config.aud)) return null;
  if (typeof payload.exp !== "number" || payload.exp <= seconds) return null;
  if (typeof payload.nbf === "number" && payload.nbf > seconds + 60) return null;

  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  if (!cachedCerts || cachedCerts.url !== certsUrl || now - cachedCerts.fetchedAt > CERT_TTL_MS) {
    cachedCerts = { url: certsUrl, keys: (await fetchCerts(certsUrl)).keys, fetchedAt: now };
  }
  const jwk = cachedCerts.keys.find((key) => key.kid === header.kid);
  if (!jwk || jwk.kty !== "RSA") return null;

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      utf8(`${headerPart}.${payloadPart}`),
    );
    if (!valid) return null;
  } catch {
    return null;
  }
  return { email: typeof payload.email === "string" ? payload.email : "unknown" };
}

/** For tests: forget cached signing keys. */
export function clearAccessCertCache(): void {
  cachedCerts = null;
}
