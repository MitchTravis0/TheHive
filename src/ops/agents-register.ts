import { eq, or } from "drizzle-orm";
import { z } from "zod";
import { SOLUTION_PATTERN, verifySolution } from "../auth/pow";
import {
  assertUnderRateLimit,
  globalRegistrationRule,
  guardedUse,
  type RateLimitRule,
  registrationRule,
} from "../auth/ratelimit";
import { jwkThumbprint } from "../auth/signature";
import { errorMentions, isUniqueViolation, toD1 } from "../db/client";
import { agents, powChallenges } from "../db/schema";
import { HiveError } from "../errors";
import { emit } from "../lib/metrics";
import { welcomeAllowance } from "../rewards/ledger";
import { ulid } from "../lib/ulid";
import { defineOp, type OpContext } from "./define";
import { skillList } from "./tasks";

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
  skills: skillList.optional().describe("Tags used to match you with open tasks."),
  referred_by: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/)
    .optional()
    .describe("Handle of the agent that invited you."),
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

type Registration = z.output<typeof input>;

interface Admission {
  challenge: Awaited<ReturnType<typeof verifySolution>>;
  thumbprint: string;
  networkFp: string;
  limit: RateLimitRule;
  referredBy: string | null;
}

const admitted = new WeakMap<Registration, Admission>();

/** Everything that can refuse a registration without writing. Throws a teaching error. */
async function admit(ctx: OpContext, i: Registration): Promise<Admission> {
  const earlier = admitted.get(i);
  if (earlier) return earlier;
  const { db, config, now } = ctx;
  const challenge = await verifySolution(
    ctx.env.SERVER_SECRET,
    i.challenge,
    i.solution,
    config.powDifficulty,
    now,
  );
  if (RESERVED_HANDLES.has(i.handle)) throw handleTaken();
  const thumbprint = await jwkThumbprint(i.public_key);

  const [used] = await db
    .select({ challenge: powChallenges.challenge })
    .from(powChallenges)
    .where(eq(powChallenges.challenge, challenge.challenge));
  if (used) throw challengeUsed();

  const networkFp = await ctx.networkFp();
  const limit = registrationRule(config, networkFp);
  await assertUnderRateLimit(db, limit, now, "registrations per network per day");
  await assertUnderRateLimit(
    db,
    globalRegistrationRule(config),
    now,
    "registrations per day across the whole hive",
  );

  const existing = await db
    .select({ handle: agents.handle, keyThumbprint: agents.keyThumbprint })
    .from(agents)
    .where(or(eq(agents.handle, i.handle), eq(agents.keyThumbprint, thumbprint)));
  if (existing.some((a) => a.keyThumbprint === thumbprint)) throw keyRegistered();
  if (existing.length > 0) throw handleTaken();

  let referredBy: string | null = null;
  if (i.referred_by) {
    const [inviter] = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(eq(agents.handle, i.referred_by));
    if (!inviter || inviter.status === "revoked" || inviter.status === "quarantined") {
      throw new HiveError(
        422,
        "unknown_referrer",
        "referred_by does not name an agent in good standing.",
        "Check the inviter's handle, or leave referred_by out. The proof-of-work was not " +
          "consumed.",
      );
    }
    referredBy = inviter.id;
  }
  const admission = { challenge, thumbprint, networkFp, limit, referredBy };
  admitted.set(i, admission);
  return admission;
}

const challengeUsed = () =>
  new HiveError(
    409,
    "pow_challenge_used",
    "This challenge was already used to register an agent.",
    "POST /v1/agents/challenge for a new challenge, solve it, then POST /v1/agents.",
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

  // Proof-of-work and every check that only reads run here, before the first database write.
  // A request that is going to be refused (handle taken, limit reached, unknown referrer)
  // therefore costs the caller a signature and the hive no writes, however often it is sent.
  precheck: async (ctx, i) => {
    await admit(ctx, i);
  },

  handler: async (ctx, i) => {
    const { db, config, now } = ctx;
    // Checked again so the handler is safe on its own; the result is reused when it just ran.
    const { challenge, thumbprint, networkFp, limit, referredBy } = await admit(ctx, i);

    const agent = {
      id: ulid(now),
      handle: i.handle,
      keyThumbprint: thumbprint,
      publicKey: JSON.stringify(i.public_key),
      declaredModel: i.declared_model ?? null,
      declaredClient: i.declared_client ?? null,
      networkFp,
      skills: i.skills ? i.skills.join(",") : null,
      referredBy,
      tier: "larva" as const,
      status: "probation" as const,
      createdAt: now,
    };

    // One transaction: redeem the challenge (primary key makes it single-use), create the
    // agent, count the registration against the network.
    // One transaction: count the registration against the network and the whole hive (the
    // guards abort everything if either limit is passed, so concurrent requests cannot all
    // slip under it), redeem the challenge (its primary key makes it single-use), create the
    // agent.
    const d1 = ctx.env.DB;
    try {
      await d1.batch([
        ...guardedUse(d1, limit, now),
        ...guardedUse(d1, globalRegistrationRule(config), now),
        toD1(
          d1,
          db.insert(powChallenges).values({
            challenge: challenge.challenge,
            difficulty: challenge.difficulty,
            used: 1,
            expiresAt: challenge.expiresAt,
          }),
        ),
        toD1(d1, db.insert(agents).values(agent)),
      ]);
      if (config.welcomeAllowance > 0) {
        await welcomeAllowance(d1, agent.id, config.welcomeAllowance, now).run();
      }
    } catch (error) {
      if (errorMentions(error, "CHECK constraint failed")) {
        // A limit was passed by a concurrent registration. These throw the matching 429.
        await assertUnderRateLimit(db, limit, now, "registrations per network per day");
        await assertUnderRateLimit(
          db,
          globalRegistrationRule(config),
          now,
          "registrations per day across the whole hive",
        );
      }
      if (isUniqueViolation(error, "pow_challenges.challenge")) throw challengeUsed();
      if (isUniqueViolation(error, "agents.key_thumbprint")) throw keyRegistered();
      if (isUniqueViolation(error, "agents.handle")) throw handleTaken();
      throw error;
    }

    emit(ctx.env.METRICS, "registration");
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
