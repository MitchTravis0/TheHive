import type { Config, Env } from "../config";
import { emit } from "../lib/metrics";
import { getState, readOnlyReason, setReadOnly, setState } from "../lib/platform";

/**
 * Budget kill switch (BUILD_PLAN section 13). Workers Paid has no spending cap, so every 15
 * minutes this reads the account's usage for the month so far, projects the month-end bill,
 * and acts on it:
 *
 *   projected >= 80% of MONTHLY_BUDGET_USD   writes are switched off (503 read_only), owner alerted
 *   projected >= 100%                        the owner's edge rule that blocks all traffic is
 *                                            switched on, so requests stop reaching (and being
 *                                            billed to) the Worker
 *
 * Read-only mode lifts by itself when the projection falls back under 80% (in practice, at the
 * start of the next month). The edge block is only ever lifted by the owner.
 *
 * It needs the secret CF_API_TOKEN and the var CF_ACCOUNT_ID; without them it does nothing.
 * The zone and the block rule are found by name unless their ids are configured. Prices below were
 * read from the Cloudflare pricing page on 2026-10-06 and cover Workers requests and CPU and
 * D1 rows. Queues, Durable Objects, Workers AI, Vectorize and R2 are not counted: the
 * dashboard billing notifications are the second signal for those.
 */

export interface Usage {
  requests: number;
  cpuMs: number;
  d1RowsRead: number;
  d1RowsWritten: number;
}

const PRICE = {
  base: 5,
  requests: { included: 10e6, perMillion: 0.3 },
  cpuMs: { included: 30e6, perMillion: 0.02 },
  d1RowsRead: { included: 25e9, perMillion: 0.001 },
  d1RowsWritten: { included: 50e6, perMillion: 1 },
} as const;

/** CPU assumed per request when the analytics API does not report CPU time. */
const ASSUMED_CPU_MS = 5;
const DAY_MS = 86_400_000;
const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const API = "https://api.cloudflare.com/client/v4";
const LEVEL_KEY = "budget_level";
const CHECK_AT_KEY = "budget_check_at";

/** What a month with this usage costs on Workers Paid, in USD. */
export function monthlyCostUsd(usage: Usage): number {
  const over = (used: number, price: { included: number; perMillion: number }) =>
    (Math.max(0, used - price.included) / 1e6) * price.perMillion;
  return (
    PRICE.base +
    over(usage.requests, PRICE.requests) +
    over(usage.cpuMs, PRICE.cpuMs) +
    over(usage.d1RowsRead, PRICE.d1RowsRead) +
    over(usage.d1RowsWritten, PRICE.d1RowsWritten)
  );
}

export function monthBounds(now: number): { start: number; end: number } {
  const date = new Date(now);
  return {
    start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

/**
 * Month-end bill if the rest of the month goes like the month so far. In the first six hours
 * of a month the usage is scaled as if six hours had passed, so a quiet first hour does not
 * read as nothing and a burst in the first minutes does not read as a month of bursts.
 */
export function projectMonthEndUsd(usage: Usage, now: number): number {
  const { start, end } = monthBounds(now);
  const scale = (end - start) / Math.max(now - start, DAY_MS / 4);
  return monthlyCostUsd({
    requests: usage.requests * scale,
    cpuMs: usage.cpuMs * scale,
    d1RowsRead: usage.d1RowsRead * scale,
    d1RowsWritten: usage.d1RowsWritten * scale,
  });
}

export type BudgetLevel = "ok" | "read_only" | "blocked";

export function levelFor(projectedUsd: number, budgetUsd: number): BudgetLevel {
  if (projectedUsd >= budgetUsd) return "blocked";
  if (projectedUsd >= 0.8 * budgetUsd) return "read_only";
  return "ok";
}

/** Replaced in tests. */
export const budgetDeps = {
  fetcher: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
};

interface GraphqlReply {
  data?: {
    viewer?: {
      accounts?: {
        workers?: { sum?: { requests?: number; cpuTimeUs?: number } }[];
        d1?: { sum?: { rowsRead?: number; rowsWritten?: number } }[];
      }[];
    };
  } | null;
  errors?: { message: string }[] | null;
}

const usageQuery = (withCpu: boolean) => `
query HiveUsage($account: string!, $from: Time!, $to: Time!, $fromDate: Date!, $toDate: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workers: workersInvocationsAdaptive(
        limit: 10000, filter: { datetime_geq: $from, datetime_leq: $to }
      ) { sum { requests ${withCpu ? "cpuTimeUs" : ""} } }
      d1: d1AnalyticsAdaptiveGroups(
        limit: 10000, filter: { date_geq: $fromDate, date_leq: $toDate }
      ) { sum { rowsRead rowsWritten } }
    }
  }
}`;

/** Account-wide usage for the month so far, from the GraphQL Analytics API. */
export async function fetchUsage(env: Env, now: number): Promise<Usage & { cpuMeasured: boolean }> {
  const { start } = monthBounds(now);
  const variables = {
    account: env.CF_ACCOUNT_ID,
    from: new Date(start).toISOString(),
    to: new Date(now).toISOString(),
    fromDate: new Date(start).toISOString().slice(0, 10),
    toDate: new Date(now).toISOString().slice(0, 10),
  };
  const ask = async (withCpu: boolean): Promise<GraphqlReply> => {
    const response = await budgetDeps.fetcher(GRAPHQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: usageQuery(withCpu), variables }),
    });
    if (!response.ok) throw new Error(`analytics API returned ${response.status}`);
    return response.json<GraphqlReply>();
  };
  let reply = await ask(true);
  let hasCpu = true;
  if (reply.errors?.length) {
    // The CPU field is the one part of the query not confirmed against the docs.
    reply = await ask(false);
    hasCpu = false;
  }
  if (reply.errors?.length) throw new Error(`analytics API: ${reply.errors[0]?.message}`);
  const account = reply.data?.viewer?.accounts?.[0];
  if (!account) throw new Error("analytics API returned no account");
  const usage = { requests: 0, cpuMs: 0, d1RowsRead: 0, d1RowsWritten: 0, cpuMeasured: hasCpu };
  for (const group of account.workers ?? []) {
    usage.requests += group.sum?.requests ?? 0;
    usage.cpuMs += (group.sum?.cpuTimeUs ?? 0) / 1000;
  }
  if (!hasCpu) usage.cpuMs = usage.requests * ASSUMED_CPU_MS;
  for (const group of account.d1 ?? []) {
    usage.d1RowsRead += group.sum?.rowsRead ?? 0;
    usage.d1RowsWritten += group.sum?.rowsWritten ?? 0;
  }
  return usage;
}

interface RulesetReply {
  success?: boolean;
  result?: { id?: string; rules?: Record<string, unknown>[] };
}

interface KillRule {
  /** URL of the rule in the Rulesets API. */
  url: string;
  rule: Record<string, unknown>;
}

const DEFAULT_RULE_NAME = "hive-kill-switch";

function apiHeaders(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" };
}

/**
 * Finds the owner's pre-made WAF custom rule that blocks all traffic. With no ids configured
 * it is looked up: the zone is the one the token can see whose name ends the public host, and
 * the rule is the custom rule named `hive-kill-switch` (or `CF_KILL_RULE_NAME`).
 */
export async function findKillRule(env: Env): Promise<KillRule> {
  const headers = apiHeaders(env);
  let zoneId = env.CF_ZONE_ID;
  if (!zoneId) {
    const host = new URL(env.PUBLIC_ORIGIN ?? "https://thehive.example").hostname;
    const listed = await budgetDeps.fetcher(`${API}/zones?per_page=50`, { headers });
    if (!listed.ok) throw new Error(`zones API returned ${listed.status}`);
    const zones = (await listed.json<{ result?: { id: string; name: string }[] }>()).result ?? [];
    zoneId = zones.find((zone) => host === zone.name || host.endsWith(`.${zone.name}`))?.id;
    if (!zoneId) throw new Error("the token cannot see the zone of the public host");
  }
  const rulesets = `${API}/zones/${zoneId}/rulesets`;
  const current = await budgetDeps.fetcher(
    env.CF_KILL_RULESET_ID
      ? `${rulesets}/${env.CF_KILL_RULESET_ID}`
      : `${rulesets}/phases/http_request_firewall_custom/entrypoint`,
    { headers },
  );
  if (!current.ok) throw new Error(`rulesets API returned ${current.status}`);
  const ruleset = (await current.json<RulesetReply>()).result;
  const name = env.CF_KILL_RULE_NAME ?? DEFAULT_RULE_NAME;
  const rule = ruleset?.rules?.find((candidate) =>
    env.CF_KILL_RULE_ID ? candidate.id === env.CF_KILL_RULE_ID : candidate.description === name,
  );
  const rulesetId = env.CF_KILL_RULESET_ID ?? ruleset?.id;
  if (!rule || typeof rule.id !== "string" || !rulesetId) {
    throw new Error("the kill-switch rule was not found in the zone's custom rules");
  }
  return { url: `${rulesets}/${rulesetId}/rules/${rule.id}`, rule };
}

/** Writes the rule back with `enabled` set. The API replaces the whole rule on update. */
async function writeKillRule(env: Env, found: KillRule, enabled: boolean): Promise<void> {
  const { rule } = found;
  const updated = await budgetDeps.fetcher(found.url, {
    method: "PATCH",
    headers: apiHeaders(env),
    body: JSON.stringify({
      action: rule.action,
      expression: rule.expression,
      description: rule.description,
      ...(rule.action_parameters ? { action_parameters: rule.action_parameters } : {}),
      enabled,
    }),
  });
  if (!updated.ok) throw new Error(`rule update returned ${updated.status}`);
}

/** Switches the kill-switch rule on, so requests stop reaching (and being billed to) the Worker. */
export async function enableEdgeBlock(env: Env): Promise<boolean> {
  const found = await findKillRule(env);
  if (found.rule.enabled !== true) await writeKillRule(env, found, true);
  return true;
}

/**
 * Proves the guard could flip the switch, without flipping it: finds the rule and writes it
 * back unchanged. Returns what it found, or the reason it failed.
 */
export async function checkEdgeBlock(env: Env): Promise<string> {
  try {
    const found = await findKillRule(env);
    const enabled = found.rule.enabled === true;
    await writeKillRule(env, found, enabled);
    return `ok: rule found and writable, currently ${enabled ? "ENABLED" : "disabled"}`;
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function alertOwner(env: Env, text: string): Promise<void> {
  console.error(`BUDGET ALERT: ${text}`);
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await budgetDeps.fetcher(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `text` and `content` cover the common chat incoming-webhook formats.
      body: JSON.stringify({ text, content: text }),
    });
  } catch (error) {
    console.error("budget alert could not be sent", error);
  }
}

export interface BudgetRun {
  usage: Usage;
  projected_usd: number;
  budget_usd: number;
  level: BudgetLevel;
  edge_blocked: boolean;
}

/** One pass of the kill switch. Returns null when it is not configured. */
export async function runBudgetGuard(
  env: Env,
  config: Config,
  now: number,
): Promise<BudgetRun | null> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const usage = await fetchUsage(env, now);
  const projected = projectMonthEndUsd(usage, now);
  const level = levelFor(projected, config.monthlyBudgetUsd);
  const previous = (await getState(env, LEVEL_KEY)) ?? "ok";
  const summary =
    `projected month-end bill $${projected.toFixed(2)} against a budget of ` +
    `$${config.monthlyBudgetUsd.toFixed(2)} (${config.environment})`;

  const readOnly = await readOnlyReason(env, now);
  if (level === "ok") {
    // Only lift a read-only mode this guard set; one set by hand stays.
    if (readOnly === "budget") await setReadOnly(env, null, now);
  } else if (readOnly === null) {
    await setReadOnly(env, "budget", now);
  }

  let edgeBlocked = false;
  if (level === "blocked") {
    try {
      edgeBlocked = await enableEdgeBlock(env);
    } catch (error) {
      console.error("edge block failed", error);
    }
  }

  if (level !== previous) {
    await setState(env, LEVEL_KEY, level, now);
    if (level === "read_only") await alertOwner(env, `The Hive is now read-only: ${summary}.`);
    if (level === "blocked") {
      await alertOwner(
        env,
        `The Hive has reached its budget: ${summary}. ` +
          (edgeBlocked
            ? "The edge rule now blocks all traffic until you switch it off."
            : "The edge rule could NOT be switched on; writes are off but reads are still served."),
      );
    }
    if (level === "ok") await alertOwner(env, `The Hive is back under budget: ${summary}.`);
  }
  // Once a day, record that the whole chain works: usage can be read and the rule can be
  // written. Read it with: SELECT value FROM platform_state WHERE key = 'budget_check'.
  const lastCheck = Number((await getState(env, CHECK_AT_KEY)) ?? 0);
  if (now - lastCheck >= DAY_MS || now < lastCheck) {
    await setState(env, CHECK_AT_KEY, String(now), now);
    await setState(
      env,
      "budget_check",
      JSON.stringify({
        at: new Date(now).toISOString(),
        usage,
        projected_usd: Math.round(projected * 100) / 100,
        budget_usd: config.monthlyBudgetUsd,
        level,
        edge_rule: await checkEdgeBlock(env),
      }),
      now,
    );
  }
  emit(env.METRICS, "budget", [level], [projected, usage.requests]);
  return {
    usage,
    projected_usd: Math.round(projected * 100) / 100,
    budget_usd: config.monthlyBudgetUsd,
    level,
    edge_blocked: edgeBlocked,
  };
}
