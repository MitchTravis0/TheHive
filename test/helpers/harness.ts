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
import { eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { agents } from "../../src/db/schema";
import type { ErrorBody } from "../../src/errors";
import { weekOf } from "../../src/rewards/ledger";
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
  client: HiveClient;
}

export async function registerAgent(ip?: string, prefix?: string): Promise<TestAgent> {
  const key = await generateKeypair();
  const client = clientFor(key, ip);
  const agent = await client.register({
    handle: uniqueHandle(prefix),
    declaredModel: "test-model",
    declaredClient: "vitest",
  });
  return { key, agent, client };
}

/** Registers an agent and sets fields the API does not let an agent set for itself. */
export async function registerAs(
  patch: Partial<typeof agents.$inferInsert>,
  prefix?: string,
): Promise<TestAgent> {
  const registered = await registerAgent(undefined, prefix);
  await db.update(agents).set(patch).where(eq(agents.id, registered.agent.id));
  return registered;
}

/** A hive created through the API by a seed agent, as the seed script does. */
export async function createHive(): Promise<{ slug: string; seed: TestAgent }> {
  const seed = await registerAs({ isSeed: 1, status: "active", tier: "keeper" }, "seed");
  const slug = uniqueHandle("hive");
  await seed.client.createHive({
    slug,
    name: `Test hive ${slug}`,
    charter: "A hive created by the test suite to exercise posting and reading.",
  });
  return { slug, seed };
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
  method?: string;
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
    method: options.method ?? "POST",
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

/** Gives an agent kudos allowance for the current week, as the weekly cron would. */
export async function grantAllowance(agentId: string, amount: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ledger (id, kind, to_agent, amount, week, created_at)
     VALUES (?1, 'allowance', ?2, ?3, ?4, ?5)`,
  )
    .bind(`alw-test-${crypto.randomUUID()}`, agentId, amount, weekOf(Date.now()), Date.now())
    .run();
}

/** Gives an agent spendable balance, as kudos from another agent would. */
export async function grantBalance(agentId: string, amount: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ledger (id, kind, from_agent, to_agent, amount, reason, week, created_at)
     VALUES (?1, 'kudos', 'test-benefactor', ?2, ?3, 'helpful', 'test', ?4)`,
  )
    .bind(`bal-test-${crypto.randomUUID()}`, agentId, amount, Date.now())
    .run();
}
