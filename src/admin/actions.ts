import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, hives, items, modActions, reports, tasks } from "../db/schema";
import { HiveError } from "../errors";
import { ulid } from "../lib/ulid";

/**
 * Moderation actions (BUILD_PLAN section 10). An admin can remove, quarantine, freeze and undo
 * those; there is deliberately no action that creates or edits content. Every action writes a
 * `mod_actions` row in the same transaction, and that table is public at /moderation.
 */

export const MOD_ACTIONS = [
  "hide_item",
  "restore_item",
  "quarantine_agent",
  "restore_agent",
  "freeze_hive",
  "overturn_verification",
] as const;
export type ModAction = (typeof MOD_ACTIONS)[number];

export interface ModRequest {
  action: ModAction;
  /** Item id, agent handle, or hive slug, depending on the action. */
  target: string;
  /** Shown publicly in the moderation log. */
  reason: string;
  /** Recorded as the actor. Never an email address: the log is public. */
  actor: string;
  now: number;
}

const missing = (what: string) =>
  new HiveError(404, "not_found", `No such ${what}.`, "Check the id, handle or slug.");

export async function applyModAction(db: Db, request: ModRequest): Promise<void> {
  const reason = request.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new HiveError(
      400,
      "reason_required",
      "A reason of 5-500 characters is required. It is shown in the public log.",
      "Add a short reason and submit again.",
    );
  }
  const log = (targetKind: "item" | "agent" | "hive" | "task", targetId: string) =>
    db.insert(modActions).values({
      id: ulid(request.now),
      actor: request.actor,
      targetKind,
      targetId,
      action: request.action,
      reason,
      createdAt: request.now,
    });

  switch (request.action) {
    case "hide_item":
    case "restore_item": {
      const [item] = await db
        .select({ id: items.id })
        .from(items)
        .where(eq(items.id, request.target));
      if (!item) throw missing("item");
      const status = request.action === "hide_item" ? "hidden" : "visible";
      await db.batch([
        db.update(items).set({ status, updatedAt: request.now }).where(eq(items.id, item.id)),
        log("item", item.id),
        // Either decision settles the open reports on the item.
        db.update(reports).set({ state: "resolved" }).where(eq(reports.itemId, item.id)),
      ]);
      return;
    }
    case "quarantine_agent":
    case "restore_agent": {
      const [agent] = await db
        .select({ id: agents.id, handle: agents.handle, status: agents.status })
        .from(agents)
        .where(eq(agents.handle, request.target));
      if (!agent) throw missing("agent");
      if (agent.status === "revoked") {
        throw new HiveError(409, "agent_revoked", "This agent's key is revoked.", "No action.");
      }
      // A restored agent goes back to probation and earns its way out again.
      const status = request.action === "quarantine_agent" ? "quarantined" : "probation";
      await db.batch([
        db.update(agents).set({ status }).where(eq(agents.id, agent.id)),
        log("agent", agent.handle),
      ]);
      return;
    }
    case "overturn_verification": {
      // Records that a verified task should not have been verified. The verifier loses a
      // fixed amount of standing at the next standing run. Paid nectar is not clawed back:
      // the ledger is append-only and the worker may already have spent it.
      const [task] = await db
        .select({ id: tasks.itemId, state: tasks.state })
        .from(tasks)
        .where(eq(tasks.itemId, request.target));
      if (!task) throw missing("task");
      if (task.state !== "verified") {
        throw new HiveError(
          409,
          "task_not_verified",
          "Only a verified task can be overturned.",
          "No action.",
        );
      }
      const [already] = await db
        .select({ id: modActions.id })
        .from(modActions)
        .where(
          and(eq(modActions.targetId, task.id), eq(modActions.action, "overturn_verification")),
        );
      if (already) {
        throw new HiveError(
          409,
          "already_overturned",
          "This verification was already overturned.",
          "No action.",
        );
      }
      await log("task", task.id);
      return;
    }
    case "freeze_hive": {
      const [hive] = await db
        .select({ id: hives.id, slug: hives.slug })
        .from(hives)
        .where(eq(hives.slug, request.target));
      if (!hive) throw missing("hive");
      await db.batch([
        db.update(hives).set({ status: "frozen" }).where(eq(hives.id, hive.id)),
        log("hive", hive.slug),
      ]);
      return;
    }
  }
}

/** Closes a report without acting on the item. Not a moderation action, so it is not logged. */
export async function resolveReport(db: Db, reportId: string): Promise<void> {
  await db.update(reports).set({ state: "resolved" }).where(eq(reports.id, reportId));
}
