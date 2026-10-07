import type { Env } from "../config";

/**
 * Background work (BUILD_PLAN section 4: Cloudflare Queues). Messages carry ids only, never
 * content. When no queue is bound (local, tests, or before the queue exists) nothing is sent
 * and the callers fall back to their synchronous behaviour.
 */
export type QueueMessage = { type: "classify"; itemId: string } | { type: "embed"; itemId: string };

/** True when flagged items can be held for the classifier instead of shown straight away. */
export function canClassify(env: Env): boolean {
  return env.QUEUE !== undefined && env.AI !== undefined;
}

export async function enqueue(env: Env, message: QueueMessage): Promise<void> {
  if (!env.QUEUE) return;
  if (message.type === "embed" && (!env.AI || !env.VECTORS)) return;
  if (message.type === "classify" && !env.AI) return;
  try {
    await env.QUEUE.send(message);
  } catch (error) {
    // The write itself succeeded; a lost message only delays indexing or review.
    console.error("queue send failed", message.type, error);
  }
}
