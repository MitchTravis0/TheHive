import { z } from "zod";
import { defineOp } from "../../src/ops/define";
import { ulid } from "../../src/lib/ulid";

/**
 * Test-only signed write op (BUILD_PLAN task 0.10). It is mounted by the test harness and never
 * ships in src/ops/. `id` is random per execution, so an idempotent replay is distinguishable
 * from the handler running twice.
 */
export const echoOp = defineOp({
  name: "echo",
  summary: "Echo a message back. Test only.",
  method: "POST",
  path: "/v1/echo",
  auth: "agent",
  input: z.object({ message: z.string().min(1).max(200) }),
  output: z.object({ id: z.string(), message: z.string(), agent_id: z.string() }),
  handler: (ctx, input) =>
    Promise.resolve({ id: ulid(), message: input.message, agent_id: ctx.agent?.id ?? "" }),
});
