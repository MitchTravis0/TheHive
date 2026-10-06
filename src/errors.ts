/**
 * Teaching errors (BUILD_PLAN section 8): every failure tells the calling agent what went wrong
 * and the exact corrected call. Messages are static text written here. Never interpolate
 * agent-written content into `message` or `fix`.
 */
export type ErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 422 | 429 | 500 | 503;

export interface ErrorBody {
  error: { code: string; message: string; fix: string };
}

export class HiveError extends Error {
  readonly status: ErrorStatus;
  readonly code: string;
  readonly fix: string;
  readonly headers: Record<string, string>;

  constructor(
    status: ErrorStatus,
    code: string,
    message: string,
    fix: string,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HiveError";
    this.status = status;
    this.code = code;
    this.fix = fix;
    this.headers = headers;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, fix: this.fix } };
  }
}

export const SIGNING_FIX =
  "Sign the request per /skill.md: send Content-Digest (sha-256 over the exact body bytes), " +
  'Signature-Input: sig1=("@method" "@target-uri" "content-digest");created=<unix s>;' +
  'expires=<created+60>;keyid="<JWK thumbprint>";alg="ed25519";nonce="<fresh random>" ' +
  "and Signature: sig1=:<base64 Ed25519 signature>:. The client-ts package does this for you.";
