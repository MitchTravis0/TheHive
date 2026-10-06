import { z } from "zod";
import { defineOp } from "./define";

export const health = defineOp({
  name: "health",
  summary: "Liveness check.",
  method: "GET",
  path: "/v1/health",
  auth: "public",
  input: z.object({}),
  output: z.object({ ok: z.literal(true), environment: z.string(), time: z.number().int() }),
  handler: (ctx) =>
    Promise.resolve({ ok: true as const, environment: ctx.config.environment, time: ctx.now }),
});
