import { type FileStore, R2FileStore } from "../adapters/files";
import type { Env } from "../config";

/**
 * Daily backup. Dumps every table to newline-delimited JSON in the file store under
 * `backups/<YYYY-MM-DD>/<table>.ndjson`, plus a manifest with row counts. Restore with
 * `scripts/restore.mjs`. Not `wrangler d1 export`: that does not support virtual tables.
 */

// Parents before children, so a restore can insert in this order with foreign keys on.
// Short-lived tables (nonces, idempotency, rate_limits, pow_challenges, signals) are not
// backed up.
export const BACKUP_TABLES = [
  "sponsors",
  "sponsor_private",
  "agents",
  "hives",
  "hive_members",
  "items",
  "mentions",
  "tasks",
  "comb_versions",
  "confirmations",
  "ledger",
  "proposals",
  "votes",
  "reports",
  "mod_actions",
] as const;

const PAGE = 500;
const KEEP_DAYS = 14;

export interface BackupManifest {
  taken_at: number;
  tables: Record<string, number>;
}

export async function dumpTable(d1: D1Database, table: string): Promise<string[]> {
  const lines: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await d1
      .prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ?1 OFFSET ?2`)
      .bind(PAGE, offset)
      .all();
    for (const row of page.results) lines.push(JSON.stringify(row));
    if (page.results.length < PAGE) return lines;
  }
}

export async function backupTo(
  store: FileStore,
  d1: D1Database,
  now: number,
): Promise<BackupManifest> {
  const day = new Date(now).toISOString().slice(0, 10);
  const manifest: BackupManifest = { taken_at: now, tables: {} };
  for (const table of BACKUP_TABLES) {
    const lines = await dumpTable(d1, table);
    await store.put(
      `backups/${day}/${table}.ndjson`,
      lines.length > 0 ? lines.join("\n") + "\n" : "",
      "application/x-ndjson",
    );
    manifest.tables[table] = lines.length;
  }
  await store.put(`backups/${day}/manifest.json`, JSON.stringify(manifest), "application/json");

  // Keep the last KEEP_DAYS daily backups.
  const cutoff = new Date(now - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const old = (await store.list("backups/")).filter((key) => (key.split("/")[1] ?? "") < cutoff);
  await store.delete(old);
  return manifest;
}

export async function runBackup(env: Env, now: number): Promise<BackupManifest | null> {
  if (!env.FILES) {
    console.warn("backup skipped: no FILES bucket bound");
    return null;
  }
  const manifest = await backupTo(new R2FileStore(env.FILES), env.DB, now);
  console.log("backup complete", JSON.stringify(manifest));
  return manifest;
}
