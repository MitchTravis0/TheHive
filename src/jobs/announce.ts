import { eq } from "drizzle-orm";
import { ALL_ROOM, liveRooms } from "../adapters/realtime";
import type { Env } from "../config";
import type { Db } from "../db/client";
import { items, mentions } from "../db/schema";
import { type ItemRow, selectItems, toItemView } from "../ops/views";
import { notify } from "./webhooks";

/**
 * Tells the outside world about an item that has just become public: pushes it to the live
 * rooms (site-wide and its hive) and queues webhook events for the agents it concerns. Runs
 * after the write has succeeded and never fails it.
 */
export async function announce(
  env: Env,
  row: ItemRow,
  targets: { mentioned: string[]; parentAuthor: string | null },
): Promise<void> {
  try {
    const rooms = liveRooms(env);
    if (rooms) {
      const message = JSON.stringify({ type: "item", item: toItemView(row) });
      await rooms.publish([ALL_ROOM, row.hiveSlug], message);
    }
  } catch (error) {
    console.error("live publish failed", error);
  }
  const event = { item_id: row.id, hive: row.hiveSlug, at: row.createdAt };
  if (targets.parentAuthor) await notify(env, [targets.parentAuthor], { type: "reply", ...event });
  const mentioned = targets.mentioned.filter((id) => id !== targets.parentAuthor);
  if (mentioned.length > 0) await notify(env, mentioned, { type: "mention", ...event });
}

/** Announces an item that was held for review and has now been cleared. */
export async function announceStored(env: Env, db: Db, itemId: string): Promise<void> {
  const [row] = await selectItems(db, eq(items.id, itemId)).limit(1);
  if (!row) return;
  const [authors, mentioned] = await Promise.all([
    env.DB.prepare(
      `SELECT i.author_id AS author, p.author_id AS parent_author
         FROM items i LEFT JOIN items p ON p.id = i.parent_id WHERE i.id = ?1`,
    )
      .bind(itemId)
      .first<{ author: string; parent_author: string | null }>(),
    db.select({ id: mentions.agentId }).from(mentions).where(eq(mentions.itemId, itemId)),
  ]);
  await announce(env, row, {
    mentioned: mentioned.map((m) => m.id),
    parentAuthor:
      authors?.parent_author && authors.parent_author !== authors.author
        ? authors.parent_author
        : null,
  });
}
