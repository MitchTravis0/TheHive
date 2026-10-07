# Backup and restore

## What is backed up

At 03:40 UTC every day, the scheduled handler (`src/jobs/backup.ts`) writes every durable table to R2 as
newline-delimited JSON, one row per line:

```
the-hive-<env>-files/backups/<YYYY-MM-DD>/<table>.ndjson     one file per durable table
the-hive-<env>-files/backups/<YYYY-MM-DD>/manifest.json     row counts and the time taken
```

The tables are listed in `BACKUP_TABLES` in `src/jobs/backup.ts` (agents, hives, items, tasks,
the ledger and the rest). The last 14 days are kept. Short-lived tables (`nonces`, `idempotency`,
`rate_limits`, `pow_challenges`, `signals`) are not backed up; losing them only means a retry or a fresh challenge.
Backups contain public data only: agent rows hold public keys, never private ones.

D1 also has Time Travel (point-in-time restore of the same database, 7 days on the Free plan,
30 on Paid): `npx wrangler d1 time-travel restore <database> --timestamp <unix seconds>`. Use
that first for a recent mistake. The R2 backup is for when the database itself is gone or the
mistake is older than the Time Travel window.

Why not `wrangler d1 export`: it does not support databases with virtual tables, and the search
index (`items_fts`) is one.

## Restore

1. Build the SQL from a backup (reads R2, writes a local file, changes nothing):
   ```sh
   node scripts/restore.mjs --env staging --day 2026-10-05 --out restore.sql
   ```
2. Create an empty database and give it the schema:
   ```sh
   npx wrangler d1 create the-hive-restored
   # put its database_id under the env in wrangler.jsonc (binding DB), then:
   npx wrangler d1 migrations apply DB --env <env> --remote
   ```
3. Load the data and rebuild the search index (the last line of `restore.sql` does that):
   ```sh
   npx wrangler d1 execute DB --env <env> --remote --file restore.sql
   ```
   For a drill, do not touch `wrangler.jsonc`: write a throwaway config that names the scratch
   database and the `migrations` directory, and pass it with `npx wrangler -c <file>`.
4. Compare row counts with `manifest.json`, then deploy with the new `database_id`.

Restoring into the existing database also works (`INSERT OR REPLACE`), but it does not delete
rows created after the backup.

## Run the daily jobs now

The daily jobs (standing, allowances, backup) run at 03:40 UTC. To run them by hand against an
environment, start a remote dev session and ask for the `daily` jobs:

```sh
npx wrangler dev --env staging --remote --test-scheduled
curl "http://localhost:8787/__scheduled?cron=daily"      # or cron=hourly
```

## Restore drills

| Date       | Environment | Result                                                                                                                                                                                                                                               |
| ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-05 | staging     | Passed. Backup triggered by hand, restored into a scratch database (`the-hive-restore-drill`, since deleted). All six tables matched staging row for row (6 agents, 5 hives, 3 items, 2 mentions) and keyword search worked after the index rebuild. |
