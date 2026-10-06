import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  generateKeypair,
  HiveClient,
  type HiveKeypair,
  type RegisteredAgent,
  signRequest,
  type SignRequestOptions,
} from "../../packages/client-ts/src/index";
import { createApp } from "../../src/app";
import { createDb } from "../../src/db/client";
import type { ErrorBody } from "../../src/errors";
import { echoOp } from "./echo-op";

export const ORIGIN = "https://thehive.example";
export const app = createApp({ extraOps: [echoOp] });
export const db = createDb(env.DB);

export async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

let counter = 0;
export function uniqueHandle(prefix = "agent"): string {
  return `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

/** A fresh address in its own /24, so registration limits do not leak between tests. */
export function uniqueIp(): string {
  const n = crypto.getRandomValues(new Uint8Array(3));
  return `${((n[0] ?? 0) % 200) + 20}.${n[1]}.${n[2]}.7`;
}

export function clientFor(key: HiveKeypair, ip: string = uniqueIp()): HiveClient {
  return new HiveClient({
    origin: ORIGIN,
    key,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("CF-Connecting-IP", ip);
      return call(new Request(input, { ...init, headers }));
    },
  });
}

export interface TestAgent {
  key: HiveKeypair;
  agent: RegisteredAgent;
}

export async function registerAgent(ip?: string): Promise<TestAgent> {
  const key = await generateKeypair();
  const agent = await clientFor(key, ip).register({
    handle: uniqueHandle(),
    declaredModel: "test-model",
    declaredClient: "vitest",
  });
  return { key, agent };
}

export async function getChallenge(): Promise<{ challenge: string; difficulty: number }> {
  const response = await call(new Request(`${ORIGIN}/v1/agents/challenge`, { method: "POST" }));
  return response.json();
}

export interface SignedOptions {
  sign?: Partial<SignRequestOptions>;
  idempotencyKey?: string | null;
  headers?: Record<string, string>;
  /** Replace the body after signing, to simulate tampering in transit. */
  sendBody?: string;
}

/** Builds a signed JSON POST. Pieces can be overridden to construct invalid requests. */
export async function signedPost(
  key: HiveKeypair,
  path: string,
  body: unknown,
  options: SignedOptions = {},
): Promise<Request> {
  const signed = await signRequest({
    method: "POST",
    url: ORIGIN + path,
    body: JSON.stringify(body),
    key,
    ...options.sign,
  });
  const headers = new Headers({
    ...signed.headers,
    "Content-Type": "application/json",
    ...options.headers,
  });
  if (options.idempotencyKey !== null) {
    headers.set("Idempotency-Key", options.idempotencyKey ?? crypto.randomUUID());
  }
  return new Request(ORIGIN + path, {
    method: "POST",
    headers,
    body: options.sendBody ?? signed.body,
  });
}

export async function errorCode(response: Response): Promise<string> {
  const body: ErrorBody = await response.json();
  expectTeachingError(body);
  return body.error.code;
}

function expectTeachingError(body: ErrorBody): void {
  if (!body.error?.code || !body.error.message || !body.error.fix) {
    throw new Error(`not a teaching error: ${JSON.stringify(body)}`);
  }
}
