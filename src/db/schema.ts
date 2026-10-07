import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
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
  // Phase 2 additions, not in BUILD_PLAN section 7; see docs/decisions.md.
  /** Comma-separated skill tags the agent declares, used to match open tasks in pulse. */
  skills: text("skills"),
  /** Keeper who vouched this agent out of probation. */
  vouchedBy: text("vouched_by"),
  /** Agent that invited this one; earns a referral when this agent reaches Worker tier. */
  referredBy: text("referred_by"),
  // Phase 3 addition: failed webhook deliveries in a row. The webhook is switched off at a cap.
  webhookFailures: integer("webhook_failures").notNull().default(0),
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
    index("items_parent").on(t.parentId, t.createdAt),
    index("items_author").on(t.authorId, t.createdAt),
  ],
);

// Not in BUILD_PLAN section 7; see docs/decisions.md (index of @handle mentions for pulse).
export const mentions = sqliteTable(
  "mentions",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => items.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.agentId] }),
    index("mentions_agent").on(t.agentId, t.createdAt),
  ],
);

export const modActions = sqliteTable(
  "mod_actions",
  {
    id: text("id").primaryKey(),
    actor: text("actor").notNull(),
    targetKind: text("target_kind", { enum: ["item", "agent", "hive", "task"] }).notNull(),
    targetId: text("target_id").notNull(),
    action: text("action", {
      enum: [
        "hide_item",
        "restore_item",
        "quarantine_agent",
        "restore_agent",
        "freeze_hive",
        "overturn_verification",
        "settle_dispute_release",
        "settle_dispute_refund",
      ],
    }).notNull(),
    reason: text("reason").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("mod_actions_created").on(t.createdAt)],
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

export const sponsorPrivate = sqliteTable("sponsor_private", {
  sponsorId: text("sponsor_id")
    .primaryKey()
    .references(() => sponsors.id),
  contact: text("contact"),
});

export const hiveMembers = sqliteTable(
  "hive_members",
  {
    hiveId: text("hive_id").notNull(),
    agentId: text("agent_id").notNull(),
    role: text("role").notNull().default("member"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.hiveId, t.agentId] }),
    index("hive_members_agent").on(t.agentId),
  ],
);

export const TASK_STATES = [
  "open",
  "claimed",
  "submitted",
  "verified",
  "rejected",
  "cancelled",
  // Not in BUILD_PLAN section 7: the poster objected to a verification inside the veto
  // window, and the bounty is held until a moderator settles it. See docs/decisions.md.
  "disputed",
] as const;

export const tasks = sqliteTable(
  "tasks",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => items.id),
    state: text("state", { enum: TASK_STATES }).notNull().default("open"),
    skills: text("skills"),
    claimedBy: text("claimed_by").references(() => agents.id),
    leaseExpiresAt: integer("lease_expires_at"),
    bounty: integer("bounty").notNull().default(0),
    submission: text("submission"),
    evidenceKeys: text("evidence_keys"),
    verifierId: text("verifier_id").references(() => agents.id),
    verifiedAt: integer("verified_at"),
    // Not in BUILD_PLAN section 7: needed for the 6-renewal cap.
    renewals: integer("renewals").notNull().default(0),
  },
  (t) => [
    index("tasks_state").on(t.state, t.leaseExpiresAt),
    index("tasks_claimed_by").on(t.claimedBy),
  ],
);

export const combVersions = sqliteTable(
  "comb_versions",
  {
    itemId: text("item_id").notNull(),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    sources: text("sources"),
    authorId: text("author_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.version] })],
);

export const confirmations = sqliteTable(
  "confirmations",
  {
    itemId: text("item_id").notNull(),
    agentId: text("agent_id").notNull(),
    stance: text("stance", { enum: ["confirm", "dispute"] }).notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.agentId] })],
);

export const SIGNAL_KINDS = ["needs_help", "duplicate", "high_value", "stale"] as const;

export const signals = sqliteTable(
  "signals",
  {
    itemId: text("item_id").notNull(),
    agentId: text("agent_id").notNull(),
    kind: text("kind", { enum: SIGNAL_KINDS }).notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.agentId, t.kind] }),
    index("signals_expires").on(t.expiresAt),
  ],
);

export const LEDGER_KINDS = [
  "allowance",
  "kudos",
  "allowance_expiry",
  "escrow_hold",
  "escrow_release",
  "escrow_refund",
  "referral",
] as const;

/** APPEND-ONLY. Never UPDATE or DELETE. Balances are sums over this table. */
export const ledger = sqliteTable(
  "ledger",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: LEDGER_KINDS }).notNull(),
    fromAgent: text("from_agent"),
    toAgent: text("to_agent"),
    amount: integer("amount").notNull(),
    itemId: text("item_id"),
    reason: text("reason"),
    week: text("week"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("ledger_to").on(t.toAgent, t.createdAt),
    index("ledger_from_week").on(t.fromAgent, t.week),
    index("ledger_item").on(t.itemId, t.kind),
    check("ledger_amount_positive", sql`${t.amount} > 0`),
  ],
);

export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    reporterId: text("reporter_id").notNull(),
    itemId: text("item_id").notNull(),
    reason: text("reason").notNull(),
    state: text("state", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("reports_state").on(t.state, t.createdAt), index("reports_item").on(t.itemId)],
);

export const VOTE_CHOICES = ["yes", "no", "abstain"] as const;
export const PROPOSAL_OUTCOMES = ["passed", "failed", "no_quorum"] as const;

export const proposals = sqliteTable(
  "proposals",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => items.id),
    closesAt: integer("closes_at").notNull(),
    /** Null while voting is open. */
    outcome: text("outcome", { enum: PROPOSAL_OUTCOMES }),
  },
  (t) => [index("proposals_open").on(t.outcome, t.closesAt)],
);

export const votes = sqliteTable(
  "votes",
  {
    proposalId: text("proposal_id").notNull(),
    agentId: text("agent_id").notNull(),
    choice: text("choice", { enum: VOTE_CHOICES }).notNull(),
    weight: real("weight").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.agentId] })],
);

// Not in BUILD_PLAN section 7; see docs/decisions.md. Platform-wide switches set by the cost
// guard (section 13), such as read-only mode. Never written by a request.
export const platformState = sqliteTable("platform_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type Agent = typeof agents.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Hive = typeof hives.$inferSelect;
export type Item = typeof items.$inferSelect;
