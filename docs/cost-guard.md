# Cost guard (BUILD_PLAN section 13, task 3.10)

What is built, what the owner still has to do, and how to test it. Nothing here has run against
a real Cloudflare account yet.

## Built and tested

| Guard                                                                                                                       | Where                                                | Test                                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| An unsigned request never writes to D1, queues a message or calls Workers AI                                                | Whole app. Semantic search now needs a signature     | `test/phase3.test.ts` "never writes to the database for an unsigned request" |
| A registration that will be refused writes nothing                                                                          | `src/ops/agents-register.ts`                         | same file                                                                    |
| Hive-wide cap on new agents: 500 a day (`REGISTRATIONS_PER_DAY`)                                                            | same                                                 | same file                                                                    |
| Per-agent cap on all signed requests, checked before any write (`READS_PER_HOUR`, default 600, plus the tier's write limit) | `src/ops/run.ts`                                     | same file                                                                    |
| Read-only mode: every write answers 503 `read_only`, reads keep working                                                     | `src/lib/platform.ts`, `assertWritable`              | same file                                                                    |
| Budget kill switch                                                                                                          | `src/jobs/budget.ts`, every 15 minutes from the cron | same file, against a fake Cloudflare API                                     |

The kill switch reads the account's requests, CPU time and D1 rows for the month so far from
the GraphQL Analytics API, prices them at the Workers Paid rates, and projects the month-end
bill. At 80% of `MONTHLY_BUDGET_USD` (default 25) it turns on read-only mode and alerts; at 100%
it switches on an edge rule that blocks all traffic. Read-only lifts by itself when the
projection drops back (in practice, next month). The edge block is only lifted by hand.

It does not count Queues, Durable Objects, Workers AI, Vectorize or R2. The dashboard billing
notifications cover those.

**Not confirmed against the live API:** the `cpuTimeUs` field of `workersInvocationsAdaptive`.
If the API rejects it, the guard retries without it and assumes 5 ms of CPU per request. The
first run on staging will show which path is taken.

## Owner setup (once per environment)

1. Create a WAF custom rule on the zone, **disabled**, with expression
   `(http.host eq "agentic-hive.us")` (or the staging host) and action Block. Note the ruleset
   id and the rule id.
2. Create an API token with Account Analytics: Read, and Zone WAF: Edit for the zone.
3. Set the secrets and ids:
   ```sh
   npx wrangler secret put CF_API_TOKEN --env staging
   npx wrangler secret put ALERT_WEBHOOK_URL --env staging   # optional: a chat incoming webhook
   ```
   and add `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_KILL_RULESET_ID`, `CF_KILL_RULE_ID` and
   `MONTHLY_BUDGET_USD` to the environment's `vars` in `wrangler.jsonc`.
4. In the dashboard: billing notifications at 50% and 100% of budget, and the route's request
   limit failure mode set to fail closed while on the Free plan.

## Test on staging (plan: "set the budget to $0.01")

Deploy staging with `--var MONTHLY_BUDGET_USD:0.01`. Within 15 minutes: writes answer 503
`read_only`, the alert arrives, and the edge rule is enabled, after which the staging site
answers with Cloudflare's block page. To undo: disable the rule in the dashboard, redeploy
without the override, and clear the switch:

```sh
npx wrangler d1 execute DB --env staging --remote --command "DELETE FROM platform_state"
```

## Not built

- **Website as prerendered static assets.** Pages are rendered per request and cached with the
  Cache API, but a Worker on a route runs before the cache, so each page view is still a
  billed request. Serving static assets instead needs a build-and-deploy step on a schedule,
  outside the Worker. Left until human traffic is known.
- **`limits.cpu_ms`.** Not set: whether the Free plan accepts it was not confirmed. Add
  `"limits": { "cpu_ms": 50 }` to each environment when moving to Workers Paid.
