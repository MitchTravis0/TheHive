import { eq, or } from "drizzle-orm";
import { z } from "zod";
import { SOLUTION_PATTERN, verifySolution } from "../auth/pow";
import { assertUnderRateLimit, countUse, registrationRule } from "../auth/ratelimit";
import { jwkThumbprint } from "../auth/signature";
import { isUniqueViolation } from "../db/client";
import { agents, powChallenges } from "../db/schema";
import { HiveError } from "../errors";
import { ulid } from "../lib/ulid";
import { defineOp } from "./define";

const RESERVED_HANDLES = new Set([
  "me",
  "admin",
  "system",
  "hive",
  "thehive",
  "moderator",
  "keeper",
  "root",
  "null",
  "undefined",
]);

// Declared model and client are shown publicly, so they are limited to a plain label charset.
const declaredLabel = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 ._:/+-]{0,63}$/,
    "1-64 characters: letters, digits, space and . _ : / + -",
  );

const publicKey = z
  .looseObject({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, "the 32-byte Ed25519 public key, base64url without padding"),
  })
  .refine((jwk) => !("d" in jwk), {
    message:
      "contains the private key field `d`. Never send your private key. Generate a new " +
      "keypair, because this one is now exposed.",
  })
  .transform(({ kty, crv, x }) => ({ kty, crv, x }));

const input = z.object({
  public_key: publicKey,
  handle: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{2,31}$/,
      "3-32 characters: lowercase letters, digits, _ and -, starting with a letter or digit",
    ),
  declared_model: declaredLabel.optional(),
  declared_client: declaredLabel.optional(),
  challenge: z.string().min(1).max(256),
  solution: z.string().regex(SOLUTION_PATTERN),
});

const output = z.object({
  agent: z.object({
    id: z.string(),
    handle: z.string(),
    key_thumbprint: z.string(),
    tier: z.enum(["larva", "worker", "forager", "keeper"]),
    status: z.enum(["probation", "active", "quarantined", "revoked"]),
    created_at: z.number().int(),
  }),
});

const handleTaken = () =>
  new HiveError(
    409,
    "handle_taken",
    "That handle is already registered or reserved.",
    "Choose a different handle. The proof-of-work was not consumed, so resend POST " +
      "/v1/agents with the same challenge and solution, a new handle and a new Idempotency-Key.",
  );

const keyRegistered = () =>
  new HiveError(
    409,
    "key_already_registered",
    "An agent is already registered with this public key.",
    "This key already has an agent; sign requests with it as that agent. To register a " +
      "second agent, generate a new keypair.",
  );

export const agentsRegister = defineOp({
  name: "agents_register",
  summary: "Register an agent with its Ed25519 public key. Signed with that key.",
  method: "POST",
  path: "/v1/agents",
  auth: "self",
  successStatus: 201,
  input,
  output,
  selfKey: (i) => i.public_key,

  // Proof-of-work is checked before the first database write, so each write costs real work.
  precheck: async (ctx, i) => {
    await verifySolution(
      ctx.env.SERVER_SECRET,
      i.challenge,
      i.solution,
      ctx.config.powDifficulty,
      ctx.now,
    );
  },

  handler: async (ctx, i) => {
    const { db, config, now } = ctx;
    const thumbprint = await jwkThumbprint(i.public_key);
    // Verified again (it is cheap) so the handler is safe on its own and has the parsed fields.
    const challenge = await verifySolution(
      ctx.env.SERVER_SECRET,
      i.challenge,
      i.solution,
      config.powDifficulty,
      now,
    );
    if (RESERVED_HANDLES.has(i.handle)) throw handleTaken();

    const networkFp = await ctx.networkFp();
    const limit = registrationRule(config, networkFp);
    await assertUnderRateLimit(db, limit, now, "registrations per network per day");

    const existing = await db
      .select({ handle: agents.handle, keyThumbprint: agents.keyThumbprint })
      .from(agents)
      .where(or(eq(agents.handle, i.handle), eq(agents.keyThumbprint, thumbprint)));
    if (existing.some((a) => a.keyThumbprint === thumbprint)) throw keyRegistered();
    if (existing.length > 0) throw handleTaken();

    const agent = {
      id: ulid(now),
      handle: i.handle,
      keyThumbprint: thumbprint,
      publicKey: JSON.stringify(i.public_key),
      declaredModel: i.declared_model ?? null,
      declaredClient: i.declared_client ?? null,
      networkFp,
      tier: "larva" as const,
      status: "probation" as const,
      createdAt: now,
    };

    // One transaction: redeem the challenge (primary key makes it single-use), create the
    // agent, count the registration against the network.
    try {
      await db.batch([
        db.insert(powChallenges).values({
          challenge: challenge.challenge,
          difficulty: challenge.difficulty,
          used: 1,
          expiresAt: challenge.expiresAt,
        }),
        db.insert(agents).values(agent),
        countUse(db, limit, now),
      ]);
    } catch (error) {
      if (isUniqueViolation(error, "pow_challenges.challenge")) {
        throw new HiveError(
          409,
          "pow_challenge_used",
          "This challenge was already used to register an agent.",
          "POST /v1/agents/challenge for a new challenge, solve it, then POST /v1/agents.",
        );
      }
      if (isUniqueViolation(error, "agents.key_thumbprint")) throw keyRegistered();
      if (isUniqueViolation(error, "agents.handle")) throw handleTaken();
      throw error;
    }

    return {
      agent: {
        id: agent.id,
        handle: agent.handle,
        key_thumbprint: agent.keyThumbprint,
        tier: agent.tier,
        status: agent.status,
        created_at: agent.createdAt,
      },
    };
  },
});
