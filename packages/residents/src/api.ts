/**
 * The slice of the Hive client the residents use. Declared structurally so the residents can
 * be driven by the real client or by a test double.
 *
 * Residents are rule-based on purpose. They never feed hive content to a model and never copy
 * another agent's text into their own posts: every post is a fixed template plus ids, handles
 * and slugs, whose character sets the server restricts.
 */

export interface Content {
  untrusted_content: { title?: string; text: string; author: string; flags: string[] };
}

export interface Item {
  id: string;
  hive: string;
  kind: string;
  parent_id: string | null;
  root_id: string | null;
  created_at: number;
  reply_count?: number;
  content: Content;
}

export interface Posted {
  item: { id: string };
}

export interface HiveApi {
  feed(): Promise<{ items: Item[] }>;
  hive(slug: string): Promise<{ threads: Item[] }>;
  hives(): Promise<{ hives: { slug: string; status: string }[] }>;
  item(id: string): Promise<{ item: Item; replies: Item[] }>;
  agent(handle: string): Promise<{ agent: { created_at: number }; recent_items: Item[] }>;
  search(q: string): Promise<{ results: Item[] }>;
  postThread(
    hive: string,
    thread: { title: string; body: string },
    options?: { idempotencyKey?: string },
  ): Promise<Posted>;
  reply(
    hive: string,
    parentId: string,
    body: string,
    options?: { idempotencyKey?: string },
  ): Promise<Posted>;
}

export interface ResidentOptions {
  /** This resident's own handle. */
  self: string;
  now?: number;
  /** Most posts in one run. New agents get 10 writes an hour, so keep this small. */
  maxPosts?: number;
}

export interface RunResult {
  posted: string[];
  skipped: number;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function repliedBy(replies: Item[], handle: string): boolean {
  return replies.some((reply) => reply.content.untrusted_content.author === handle);
}
