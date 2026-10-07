#!/usr/bin/env node
// Turns one day's backup in R2 into a SQL file that rebuilds the durable tables.
// See docs/backup.md for the full procedure.
//
//   node scripts/restore.mjs --env staging --day 2026-10-05 --out restore.sql
//
// It only reads from R2 and writes a local file. Applying the file is a separate, explicit step:
//   npx wrangler d1 execute <database> --remote --file restore.sql
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

// Parents before children. Keep in step with BACKUP_TABLES in src/jobs/backup.ts.
const TABLES = [
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
];

const { values } = parseArgs({
  options: {
    env: { type: "string", default: "staging" },
    day: { type: "string" },
    out: { type: "string", default: "restore.sql" },
    bucket: { type: "string" },
  },
});
if (!values.day || !/^\d{4}-\d{2}-\d{2}$/.test(values.day)) {
  console.error("Usage: node scripts/restore.mjs --env <env> --day YYYY-MM-DD [--out file.sql]");
  process.exit(1);
}
const bucket = values.bucket ?? `the-hive-${values.env}-files`;
const work = mkdtempSync(join(tmpdir(), "hive-restore-"));

function fetchObject(key) {
  const file = join(work, key.replaceAll("/", "_"));
  execFileSync(
    "npx",
    ["wrangler", "r2", "object", "get", `${bucket}/${key}`, "--file", file, "--remote"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  return readFileSync(file, "utf8");
}

const literal = (value) => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
};

const manifest = JSON.parse(fetchObject(`backups/${values.day}/manifest.json`));
const sql = [
  `-- Restore of ${bucket}/backups/${values.day}, taken ${new Date(manifest.taken_at).toISOString()}`,
];
for (const table of TABLES) {
  const rows = fetchObject(`backups/${values.day}/${table}.ndjson`)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  if (rows.length !== manifest.tables[table]) {
    console.error(
      `${table}: manifest says ${manifest.tables[table]} rows, file has ${rows.length}`,
    );
    process.exit(1);
  }
  for (const row of rows) {
    const columns = Object.keys(row);
    sql.push(
      `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns
        .map((column) => literal(row[column]))
        .join(", ")});`,
    );
  }
  console.log(`${table}: ${rows.length} rows`);
}
// Row ids are new after a restore, so the search index is rebuilt from the items table.
sql.push("INSERT INTO items_fts(items_fts) VALUES('rebuild');");
writeFileSync(values.out, sql.join("\n") + "\n");
console.log(`Wrote ${values.out}`);
