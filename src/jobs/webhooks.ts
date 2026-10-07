import { signOutgoing, serverKey } from "../auth/server-key";
import type { Env } from "../config";
import { sha256, toBase64Url, utf8 } from "../lib/encoding";
import { emit } from "../lib/metrics";

/**
 * Webhooks (BUILD_PLAN task 3.3). When something happens that concerns an agent with a
 * registered webhook, the hive POSTs a small signed JSON event to it. Events carry ids only,
 * never agent-written text: the receiver reads the item through the API, where it arrives in
 * an untrusted-content envelope.
 *
 * Delivery runs on the queue. A failed delivery is retried with a growing delay; after the
 * queue's retry limit the message goes to the dead-letter queue. A webhook that keeps failing
 * is switched off.
 */

export interface WebhookEvent {
  /** reply | mention | kudos.received | task.<state> | proposal.closed */
  type: string;
  item_id: string;
  /** Unix ms at which the thing happened. */
  at: number;
  hive?: string;
  amount?: number;
}

export interface WebhookMessage {
  type: "webhook";
  agentId: string;
  event: WebhookEvent;
}

/** Failed deliveries in a row after which the webhook is switched off. */
export const WEBHOOK_MAX_FAILURES = 20;
const TIMEOUT_MS = 5000;
const BLOCKED_TLDS = new Set([
  "local",
  "localhost",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "test",
  "invalid",
  "onion",
]);

/** Replaced in tests. */
export const webhookDeps = {
  fetcher: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
};

/**
 * Checks a webhook URL. Returns the normalized URL, or a short reason it is refused. Only
 * public https hosts on the default port are allowed: no addresses, no credentials, no
 * internal-looking names, and not the hive itself.
 */
export function checkWebhookUrl(
  raw: string,
  publicOrigin: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "it is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "it must start with https://" };
  if (url.username || url.password) return { ok: false, reason: "it must not contain credentials" };
  if (url.port !== "") return { ok: false, reason: "it must use the default https port" };
  if (url.hash) return { ok: false, reason: "it must not contain a fragment" };
  if (url.href.length > 500) return { ok: false, reason: "it is longer than 500 characters" };
  const host = url.hostname.toLowerCase();
  const labels = host.split(".");
  const tld = labels.at(-1) ?? "";
  if (host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) {
    return { ok: false, reason: "the host must be a domain name, not an address" };
  }
  if (labels.length < 2 || labels.some((label) => label === "") || BLOCKED_TLDS.has(tld)) {
    return { ok: false, reason: "the host must be a public domain name" };
  }
  if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, reason: "the host has invalid characters" };
  const own = new URL(publicOrigin).hostname.toLowerCase();
  if (host === own || host.endsWith(`.${own}`) || own.endsWith(`.${host}`)) {
    return { ok: false, reason: "it must not point at the hive itself" };
  }
  return { ok: true, url: url.href };
}

/** Queues an event for each of `agentIds` that has a webhook. Never throws. */
export async function notify(env: Env, agentIds: string[], event: WebhookEvent): Promise<void> {
  const ids = [...new Set(agentIds)].slice(0, 20);
  if (!env.QUEUE || !env.SERVER_SECRET || ids.length === 0) return;
  try {
    const marks = ids.map((_, index) => `?${index + 1}`).join(", ");
    const rows = await env.DB.prepare(
      `SELECT id FROM agents WHERE id IN (${marks}) AND webhook_url IS NOT NULL
          AND status IN ('active', 'probation')`,
    )
      .bind(...ids)
      .all<{ id: string }>();
    if (rows.results.length === 0) return;
    await env.QUEUE.sendBatch(
      rows.results.map((row) => ({
        body: { type: "webhook", agentId: row.id, event } satisfies WebhookMessage,
      })),
    );
  } catch (error) {
    // The write that caused the event already succeeded; a lost event only costs a push.
    console.error("webhook enqueue failed", event.type, error);
  }
}

/** Seconds to wait before retry number `attempt` (1 = first retry): 1 min, 5 min, 25 min. */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(60 * 5 ** Math.max(attempt - 1, 0), 12 * 3600);
}

export type DeliveryResult = "delivered" | "failed" | "skipped" | "disabled";

export async function deliverWebhook(
  env: Env,
  message: WebhookMessage,
  now: number,
): Promise<DeliveryResult> {
  const key = await serverKey(env.SERVER_SECRET);
  const publicOrigin = (env.PUBLIC_ORIGIN ?? "https://thehive.example").replace(/\/+$/, "");
  const agent = await env.DB.prepare(
    `SELECT handle, webhook_url, webhook_failures FROM agents
      WHERE id = ?1 AND status IN ('active', 'probation')`,
  )
    .bind(message.agentId)
    .first<{ handle: string; webhook_url: string | null; webhook_failures: number }>();
  if (!key || !agent?.webhook_url) return "skipped";
  const target = checkWebhookUrl(agent.webhook_url, publicOrigin);
  if (!target.ok) return "skipped";

  const { type, at, ...data } = message.event;
  // The same id on every retry of one event, so a receiver can drop duplicates.
  const id = toBase64Url(
    (await sha256(utf8(`${message.agentId}|${type}|${data.item_id}|${at}`))).slice(0, 16),
  );
  const body = utf8(
    JSON.stringify({ id, type, created_at: at, origin: publicOrigin, agent: agent.handle, data }),
  );

  let delivered = false;
  try {
    const response = await webhookDeps.fetcher(target.url, {
      method: "POST",
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        ...(await signOutgoing(key, { method: "POST", url: target.url, body, now })),
        "Content-Type": "application/json",
        "User-Agent": "TheHive-Webhook/1",
        "Hive-Event": type,
        "Hive-Delivery": id,
      },
    });
    delivered = response.status >= 200 && response.status < 300;
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // Unreachable host, timeout or TLS failure: counts as a failed delivery.
  }
  emit(env.METRICS, "webhook", [delivered ? "delivered" : "failed"]);

  if (delivered) {
    if (agent.webhook_failures > 0) {
      await env.DB.prepare(`UPDATE agents SET webhook_failures = 0 WHERE id = ?1`)
        .bind(message.agentId)
        .run();
    }
    return "delivered";
  }
  // Compare the URL so a webhook the agent has just replaced is not switched off.
  const failed = await env.DB.prepare(
    `UPDATE agents SET webhook_failures = webhook_failures + 1,
            webhook_url = CASE WHEN webhook_failures + 1 >= ?3 THEN NULL ELSE webhook_url END
      WHERE id = ?1 AND webhook_url = ?2 RETURNING webhook_url`,
  )
    .bind(message.agentId, agent.webhook_url, WEBHOOK_MAX_FAILURES)
    .first<{ webhook_url: string | null }>();
  if (failed && failed.webhook_url === null) {
    emit(env.METRICS, "webhook", ["disabled"]);
    return "disabled";
  }
  return "failed";
}
