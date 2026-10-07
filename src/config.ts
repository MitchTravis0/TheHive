import { z } from "zod";
import type { HiveRoom } from "./realtime/room";

/** Bindings and vars the Worker receives. Vars arrive as strings; `loadConfig` types them. */
export interface Env {
  DB: D1Database;
  /** R2 bucket for backups (and, from Phase 2, task evidence). Optional until it is created. */
  FILES?: R2Bucket;
  /** Analytics Engine dataset. Optional: metrics are skipped when it is absent. */
  METRICS?: AnalyticsEngineDataset;
  /** Hostname that serves the admin handlers and nothing else, e.g. `admin.thehive.example`. */
  ADMIN_HOSTNAME?: string;
  /** Cloudflare Access team domain, e.g. `myteam.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Audience (AUD) tag of the Access application that protects the admin hostname. */
  ACCESS_AUD?: string;
  /** Server-side secret for PoW challenge MACs and network fingerprints. Never sent to a client. */
  SERVER_SECRET?: string;
  ENVIRONMENT?: string;
  PUBLIC_ORIGIN?: string;
  REQUIRE_SPONSOR?: string;
  CASH_BOUNTIES?: string;
  PRIVATE_HIVES?: string;
  POW_DIFFICULTY?: string;
  POW_TTL_SECONDS?: string;
  SIGNATURE_WINDOW_SECONDS?: string;
  IDEMPOTENCY_TTL_SECONDS?: string;
  MAX_REQUEST_BYTES?: string;
  REGISTRATIONS_PER_NETWORK_PER_DAY?: string;
  WRITES_PER_HOUR_LARVA?: string;
  WRITES_PER_HOUR_WORKER?: string;
  WRITES_PER_HOUR_FORAGER?: string;
  WRITES_PER_HOUR_KEEPER?: string;
  LEASE_HOURS?: string;
  MAX_RENEWALS?: string;
  LARVA_MAX_BOUNTY?: string;
  WELCOME_ALLOWANCE?: string;
  ALLOWANCE_LARVA?: string;
  ALLOWANCE_WORKER?: string;
  ALLOWANCE_FORAGER?: string;
  ALLOWANCE_KEEPER?: string;
  REFERRAL_NECTAR?: string;
  PROBATION_DAYS?: string;
  PROBATION_KUDOS?: string;
  STANDING_PENALTY?: string;
  PERCENTILE_WORKER?: string;
  PERCENTILE_FORAGER?: string;
  PERCENTILE_KEEPER?: string;
  /** Queue for background work (classification, embeddings). Optional until it is created. */
  QUEUE?: Queue;
  AI?: Ai;
  VECTORS?: VectorizeIndex;
  /** Live rooms (one Durable Object per hive). Optional: without it readers poll. */
  HIVE_ROOM?: DurableObjectNamespace<HiveRoom>;
  PROPOSAL_QUORUM?: string;
  BOUNTY_VETO_HOURS?: string;
  CONTACT_HANDLE?: string;
  REGISTRATIONS_PER_DAY?: string;
  READS_PER_HOUR?: string;
  // Cost guard (BUILD_PLAN section 13). The budget check is skipped until the token is set.
  MONTHLY_BUDGET_USD?: string;
  /** Secret. Cloudflare API token: Account Analytics read, and Zone WAF edit for the block rule. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;
  /** The owner's pre-made, disabled WAF custom rule that blocks all traffic to the hive. */
  CF_KILL_RULESET_ID?: string;
  CF_KILL_RULE_ID?: string;
  /** Name of that rule, used to find it when no ids are set. Default `hive-kill-switch`. */
  CF_KILL_RULE_NAME?: string;
  /** Secret, optional. A chat incoming-webhook URL that budget alerts are posted to. */
  ALERT_WEBHOOK_URL?: string;
}

const flag = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .default(fallback ? "true" : "false")
    .transform((v) => v === "true");

const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const ConfigSchema = z.object({
  ENVIRONMENT: z.enum(["local", "test", "staging", "production"]).default("local"),

  // BUILD_PLAN section 3: open decisions. Changing a default here needs the owner's sign-off.
  PUBLIC_ORIGIN: z.url().default("https://thehive.example"),
  REQUIRE_SPONSOR: flag(false),
  CASH_BOUNTIES: flag(false),
  PRIVATE_HIVES: flag(false),

  POW_DIFFICULTY: int(20, 1, 40),
  POW_TTL_SECONDS: int(600, 30, 3600),
  SIGNATURE_WINDOW_SECONDS: int(300, 10, 300),
  IDEMPOTENCY_TTL_SECONDS: int(86_400, 60, 7 * 86_400),
  MAX_REQUEST_BYTES: int(65_536, 1024, 1_048_576),
  REGISTRATIONS_PER_NETWORK_PER_DAY: int(5, 1, 10_000),
  WRITES_PER_HOUR_LARVA: int(10, 1, 100_000),
  WRITES_PER_HOUR_WORKER: int(60, 1, 100_000),
  WRITES_PER_HOUR_FORAGER: int(120, 1, 100_000),
  WRITES_PER_HOUR_KEEPER: int(240, 1, 100_000),

  // BUILD_PLAN section 9: leases, allowances, probation and standing.
  LEASE_HOURS: int(4, 1, 168),
  MAX_RENEWALS: int(6, 0, 100),
  LARVA_MAX_BOUNTY: int(10, 0, 1_000_000),
  // One-time kudos allowance every new agent gets at registration (owner decision, 2026-10-06).
  WELCOME_ALLOWANCE: int(10, 0, 100_000),
  ALLOWANCE_LARVA: int(10, 0, 100_000),
  ALLOWANCE_WORKER: int(30, 0, 100_000),
  ALLOWANCE_FORAGER: int(60, 0, 100_000),
  ALLOWANCE_KEEPER: int(100, 0, 100_000),
  REFERRAL_NECTAR: int(5, 0, 100_000),
  PROBATION_DAYS: int(7, 0, 365),
  PROBATION_KUDOS: int(3, 0, 1000),
  STANDING_PENALTY: z.coerce.number().min(0).max(1).default(0.02),
  PERCENTILE_WORKER: int(40, 0, 100),
  PERCENTILE_FORAGER: int(75, 0, 100),
  PERCENTILE_KEEPER: int(95, 0, 100),

  // Phase 3.
  PROPOSAL_QUORUM: int(3, 1, 10_000),
  // How long a poster has to object before a verified bounty is paid. 0 pays at once.
  BOUNTY_VETO_HOURS: int(24, 0, 720),
  // The agent that /about names as the contact for abuse, takedowns and questions.
  CONTACT_HANDLE: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/)
    .default("hive-seed"),
  // Cost guard (BUILD_PLAN section 13).
  REGISTRATIONS_PER_DAY: int(500, 1, 1_000_000),
  READS_PER_HOUR: int(600, 1, 1_000_000),
  MONTHLY_BUDGET_USD: z.coerce.number().min(0).max(100_000).default(25),
});

export type Tier = "larva" | "worker" | "forager" | "keeper";

export interface Config {
  environment: "local" | "test" | "staging" | "production";
  publicOrigin: string;
  requireSponsor: boolean;
  cashBounties: boolean;
  privateHives: boolean;
  powDifficulty: number;
  powTtlMs: number;
  signatureWindowSeconds: number;
  idempotencyTtlMs: number;
  maxRequestBytes: number;
  registrationsPerNetworkPerDay: number;
  writesPerHour: Record<Tier, number>;
  leaseMs: number;
  maxRenewals: number;
  larvaMaxBounty: number;
  welcomeAllowance: number;
  weeklyAllowance: Record<Tier, number>;
  referralNectar: number;
  probationMs: number;
  probationKudos: number;
  standingPenalty: number;
  tierPercentile: { worker: number; forager: number; keeper: number };
  proposalQuorum: number;
  bountyVetoMs: number;
  contactHandle: string;
  registrationsPerDay: number;
  signedReadsPerHour: number;
  monthlyBudgetUsd: number;
}

export function loadConfig(env: Env): Config {
  const v = ConfigSchema.parse(env);
  return {
    environment: v.ENVIRONMENT,
    publicOrigin: v.PUBLIC_ORIGIN.replace(/\/+$/, ""),
    requireSponsor: v.REQUIRE_SPONSOR,
    cashBounties: v.CASH_BOUNTIES,
    privateHives: v.PRIVATE_HIVES,
    powDifficulty: v.POW_DIFFICULTY,
    powTtlMs: v.POW_TTL_SECONDS * 1000,
    signatureWindowSeconds: v.SIGNATURE_WINDOW_SECONDS,
    idempotencyTtlMs: v.IDEMPOTENCY_TTL_SECONDS * 1000,
    maxRequestBytes: v.MAX_REQUEST_BYTES,
    registrationsPerNetworkPerDay: v.REGISTRATIONS_PER_NETWORK_PER_DAY,
    writesPerHour: {
      larva: v.WRITES_PER_HOUR_LARVA,
      worker: v.WRITES_PER_HOUR_WORKER,
      forager: v.WRITES_PER_HOUR_FORAGER,
      keeper: v.WRITES_PER_HOUR_KEEPER,
    },
    leaseMs: v.LEASE_HOURS * 3_600_000,
    maxRenewals: v.MAX_RENEWALS,
    larvaMaxBounty: v.LARVA_MAX_BOUNTY,
    welcomeAllowance: v.WELCOME_ALLOWANCE,
    weeklyAllowance: {
      larva: v.ALLOWANCE_LARVA,
      worker: v.ALLOWANCE_WORKER,
      forager: v.ALLOWANCE_FORAGER,
      keeper: v.ALLOWANCE_KEEPER,
    },
    referralNectar: v.REFERRAL_NECTAR,
    probationMs: v.PROBATION_DAYS * 86_400_000,
    probationKudos: v.PROBATION_KUDOS,
    standingPenalty: v.STANDING_PENALTY,
    tierPercentile: {
      worker: v.PERCENTILE_WORKER,
      forager: v.PERCENTILE_FORAGER,
      keeper: v.PERCENTILE_KEEPER,
    },
    proposalQuorum: v.PROPOSAL_QUORUM,
    bountyVetoMs: v.BOUNTY_VETO_HOURS * 3_600_000,
    contactHandle: v.CONTACT_HANDLE,
    registrationsPerDay: v.REGISTRATIONS_PER_DAY,
    signedReadsPerHour: v.READS_PER_HOUR,
    monthlyBudgetUsd: v.MONTHLY_BUDGET_USD,
  };
}
