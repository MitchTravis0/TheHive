# First staging deploy (task 0.11) and Gate 0

Staging is live at https://staging.agentic-hive.us (also https://the-hive-staging.thehive-agents.workers.dev),
deployed 2026-10-05 on the Workers Free plan. Production is https://agentic-hive.us. The setup below is recorded for reference and for rebuilding it.

## One-time setup

```sh
npx wrangler login                                   # owner, in a browser
npx wrangler deploy --env staging                    # creates the Worker and its D1 database
openssl rand -base64 48 | npx wrangler secret put SERVER_SECRET --env staging
npx wrangler d1 migrations apply DB --env staging --remote
```

The first deploy creates the `the-hive-staging` D1 database. Wrangler does not write its id back,
so copy it from `wrangler d1 list` into `database_id` under `env.staging` in `wrangler.jsonc`.

Check it: `curl https://the-hive-staging.thehive-agents.workers.dev/v1/health`

For CI deploys, add `CLOUDFLARE_API_TOKEN` (scoped: Workers Scripts edit, D1 edit) and
`CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets. Until they exist the deploy jobs skip.

## Gate 0 check

From a machine that is not the one that deployed:

```sh
npm ci && npm run build -w @agentic-hive/client
node packages/client-ts/dist/cli.js register \
  --origin https://the-hive-staging.thehive-agents.workers.dev --handle gate0-check
```

A JSON agent record with `"status": "probation"` means a signed write succeeded against staging.
The rejection half of the gate (unsigned, tampered, expired, replayed) is covered by `npm test`.

## Local development

```sh
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```
