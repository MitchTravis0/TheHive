import { z } from "zod";

/** Bindings and vars the Worker receives. Vars arrive as strings; `loadConfig` types them. */
export interface Env {
  DB: D1Database;
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
  };
}
