import { and, eq } from "drizzle-orm";
import { vectorIndex, type VectorIndex } from "../adapters/vectors";
import type { Env } from "../config";
import { createDb, type Db } from "../db/client";
import { hives, items, modActions } from "../db/schema";
import { emit } from "../lib/metrics";
import { ulid } from "../lib/ulid";
import { type Classifier, workersAiClassifier } from "../safety/classify";
import type { QueueMessage } from "./queue";

/**
 * Queue consumer. Two kinds of message, both carrying only an item id:
 *  - classify: run the safety classifier on a flagged item (section 10).
 *      clear     -> visible
 *      violation -> hidden, with a public mod_actions row
 *      unsure    -> stays pending_review for the admin queue
 *  - embed: index the item for semantic search.
 */

export async function classifyItem(
  db: Db,
  classifier: Classifier,
  itemId: string,
  now: number,
): Promise<"clear" | "violation" | "unsure" | "skipped"> {
  const [item] = await db
    .select({ id: items.id, title: items.title, body: items.body, status: items.status })
    .from(items)
    .where(eq(items.id, itemId));
  if (!item || item.status !== "pending_review") return "skipped";

  const verdict = await classifier(`${item.title ?? ""}\n\n${item.body}`);
  const pending = and(eq(items.id, item.id), eq(items.status, "pending_review"));
  if (verdict === "clear") {
    await db.update(items).set({ status: "visible", updatedAt: now }).where(pending);
  } else if (verdict === "violation") {
    await db.batch([
      db.update(items).set({ status: "hidden", updatedAt: now }).where(pending),
      db.insert(modActions).values({
        id: ulid(now),
        actor: "classifier",
        targetKind: "item",
        targetId: item.id,
        action: "hide_item",
        reason: "Hidden automatically: the safety classifier judged this content unsafe.",
        createdAt: now,
      }),
    ]);
  }
  return verdict;
}

export async function embedItem(db: Db, index: VectorIndex, itemId: string): Promise<boolean> {
  const [item] = await db
    .select({
      id: items.id,
      title: items.title,
      body: items.body,
      status: items.status,
      kind: items.kind,
      hive: hives.slug,
    })
    .from(items)
    .innerJoin(hives, eq(items.hiveId, hives.id))
    .where(eq(items.id, itemId));
  if (!item) return false;
  if (item.status !== "visible") {
    await index.remove([item.id]);
    return false;
  }
  await index.upsert(item.id, `${item.title ?? ""}\n${item.body}`, {
    hive: item.hive,
    kind: item.kind,
  });
  return true;
}

export async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  const db = createDb(env.DB);
  const index = vectorIndex(env);
  const classifier = env.AI ? workersAiClassifier(env.AI) : null;
  for (const message of batch.messages) {
    try {
      const body = message.body;
      if (body.type === "classify" && classifier) {
        const verdict = await classifyItem(db, classifier, body.itemId, Date.now());
        emit(env.METRICS, "classified", [verdict]);
        // A cleared item becomes searchable.
        if (verdict === "clear" && index) await embedItem(db, index, body.itemId);
      } else if (body.type === "embed" && index) {
        await embedItem(db, index, body.itemId);
      }
      message.ack();
    } catch (error) {
      console.error("queue message failed", message.body.type, error);
      message.retry();
    }
  }
}
