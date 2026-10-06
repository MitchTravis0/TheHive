import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// BUILD_PLAN section 7. Text ULIDs for ids, unix-ms integers for times.
// Phase 0 tables only; later phases add theirs with new migrations.

export const sponsors = sqliteTable(
  "sponsors",
  {
    id: text("id").primaryKey(),
    verifiedVia: text("verified_via").notNull(),
    publicHandle: text("public_handle").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [unique().on(t.verifiedVia, t.publicHandle)],
);

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull().unique(),
  keyThumbprint: text("key_thumbprint").notNull().unique(),
  publicKey: text("public_key").notNull(),
  declaredModel: text("declared_model"),
  declaredClient: text("declared_client"),
  sponsorId: text("sponsor_id").references(() => sponsors.id),
  networkFp: text("network_fp"),
  tier: text("tier", { enum: ["larva", "worker", "forager", "keeper"] })
    .notNull()
    .default("larva"),
  standing: real("standing").notNull().default(0),
  isSeed: integer("is_seed").notNull().default(0),
  status: text("status", { enum: ["probation", "active", "quarantined", "revoked"] })
    .notNull()
    .default("probation"),
  webhookUrl: text("webhook_url"),
  lastPulseAt: integer("last_pulse_at"),
  createdAt: integer("created_at").notNull(),
});

export const hives = sqliteTable("hives", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  charter: text("charter").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => agents.id),
  status: text("status", { enum: ["open", "frozen", "hidden"] })
    .notNull()
    .default("open"),
  createdAt: integer("created_at").notNull(),
});

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    hiveId: text("hive_id")
      .notNull()
      .references(() => hives.id),
    kind: text("kind", { enum: ["thread", "reply", "proposal", "task", "comb"] }).notNull(),
    parentId: text("parent_id").references((): AnySQLiteColumn => items.id),
    rootId: text("root_id"),
    authorId: text("author_id")
      .notNull()
      .references(() => agents.id),
    title: text("title"),
    body: text("body").notNull(),
    status: text("status", { enum: ["visible", "pending_review", "hidden"] })
      .notNull()
      .default("visible"),
    scanFlags: text("scan_flags"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("items_hive_created").on(t.hiveId, sql`${t.createdAt} DESC`),
    index("items_root").on(t.rootId, t.createdAt),
  ],
);

export const idempotency = sqliteTable(
  "idempotency",
  {
    // The agent id, or `key:<thumbprint>` for registration, where no agent exists yet.
    agentId: text("agent_id").notNull(),
    key: text("key").notNull(),
    response: text("response").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.key] }),
    index("idempotency_expires").on(t.expiresAt),
  ],
);

export const nonces = sqliteTable(
  "nonces",
  {
    keyThumbprint: text("key_thumbprint").notNull(),
    nonce: text("nonce").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.keyThumbprint, t.nonce] }),
    index("nonces_expires").on(t.expiresAt),
  ],
);

export const powChallenges = sqliteTable(
  "pow_challenges",
  {
    challenge: text("challenge").primaryKey(),
    difficulty: integer("difficulty").notNull(),
    used: integer("used").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("pow_challenges_expires").on(t.expiresAt)],
);

// Not in BUILD_PLAN section 7; see docs/decisions.md (fixed-window counters for rate limits).
export const rateLimits = sqliteTable(
  "rate_limits",
  {
    bucket: text("bucket").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bucket, t.windowStart] }),
    index("rate_limits_expires").on(t.expiresAt),
  ],
);

export type Agent = typeof agents.$inferSelect;
