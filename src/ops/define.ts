import type { z } from "zod";
import type { Ed25519PublicJwk } from "../auth/signature";
import type { Config, Env } from "../config";
import type { Db } from "../db/client";
import type { Agent } from "../db/schema";

/**
 * One op, three surfaces (BUILD_PLAN section 5). An operation is defined once here with Zod
 * input and output schemas; REST routes, MCP tools and the OpenAPI document are generated from
 * the definition. Routes and tool handlers never contain logic of their own.
 */

export type OpAuth =
  /** No signature. A public op must never write to D1, enqueue, or call Workers AI. */
  | "public"
  /** Signed by a registered agent whose status is `active` or `probation`. */
  | "agent"
  /** Signed by the key carried in the input itself. Only registration uses this. */
  | "self";

export interface OpContext {
  env: Env;
  config: Config;
  db: Db;
  /** Unix ms, fixed for the duration of the request. */
  now: number;
  /** The verified caller. Null for `public` and `self` ops. */
  agent: Agent | null;
  /** Thumbprint of the key that signed the request. Null for `public` ops. */
  keyThumbprint: string | null;
  /** True when authentication already counted this request against the write limit. */
  writeCounted?: boolean;
  /** Keyed hash of the caller's /24 or /48 network. */
  networkFp: () => Promise<string>;
  /** Runs work after the response is sent (cache writes). Absent outside a request. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface OpShape<Input, Output> {
  /** Stable snake_case identifier; becomes the OpenAPI operationId. */
  name: string;
  summary: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Hono-style path under the app root, e.g. `/v1/hives/:slug/items`. */
  path: string;
  auth: OpAuth;
  successStatus?: 200 | 201;
  /** Edge cache lifetime in seconds for public GET responses. Omit for no caching. */
  cacheSeconds?: number;
  /** `self` ops: the public key in the input that must have signed the request. */
  selfKey?: (input: Input) => Ed25519PublicJwk;
  /**
   * Runs after signature verification and before any database write. Must not write. Use it
   * for checks that make a write expensive to earn, such as proof-of-work.
   */
  precheck?: (ctx: OpContext, input: Input) => Promise<void>;
  handler: (ctx: OpContext, input: Input) => Promise<Output>;
}

export interface OpDefinition<I extends z.ZodType, O extends z.ZodType> extends OpShape<
  z.output<I>,
  z.input<O>
> {
  /** Path params, query params and the JSON body are merged into one object, then parsed. */
  input: I;
  output: O;
}

/** An op with its input/output types erased, as stored in the registry. */
export interface Op extends OpShape<unknown, unknown> {
  input: z.ZodType;
  output: z.ZodType;
}

export function defineOp<I extends z.ZodType, O extends z.ZodType>(def: OpDefinition<I, O>): Op {
  if (def.auth === "self" && !def.selfKey) {
    throw new Error(`op ${def.name}: auth "self" requires selfKey`);
  }
  return def as unknown as Op;
}
