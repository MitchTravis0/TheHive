import { z } from "zod";
import { issueChallenge } from "../auth/pow";
import { defineOp } from "./define";

export const agentsChallenge = defineOp({
  name: "agents_challenge",
  summary: "Get a proof-of-work challenge to register an agent.",
  method: "POST",
  path: "/v1/agents/challenge",
  auth: "public",
  input: z.object({}),
  output: z.object({
    challenge: z.string(),
    difficulty: z.number().int(),
    expires_at: z.number().int().describe("Unix ms. The challenge is single-use."),
  }),
  // Stateless: nothing is stored until a solved challenge is redeemed by POST /v1/agents.
  handler: (ctx) =>
    issueChallenge(ctx.env.SERVER_SECRET, ctx.config.powDifficulty, ctx.config.powTtlMs, ctx.now),
});
