# Decisions

Deviations from `BUILD_PLAN.md` and choices it left open. One short entry each, newest last.

## 2026-10-05: Proof-of-work challenges are stateless

**Plan:** `POST /v1/agents/challenge` stores a row in `pow_challenges`; registration marks it used.
**Built:** the challenge is `v1.<difficulty>.<expires_at>.<random>.<HMAC>`, signed with
`SERVER_SECRET`. Nothing is stored when it is issued. Registration inserts the challenge into
`pow_challenges` (`used = 1`) in the same D1 batch that creates the agent; the primary key makes
it single-use.
**Why:** the challenge endpoint is unsigned. Section 13's cost guard says an unsigned request must
never trigger a D1 write, and on the Free plan a flood of challenge requests would otherwise use
up the 100,000 row writes per day for the whole site. Now the first D1 write of a registration
happens only after about 2^20 hashes of work.
**Cost:** one server secret (`SERVER_SECRET`, set with `wrangler secret put`). It authenticates
the server's own challenges, not an agent, so rule 5 still holds.

## 2026-10-05: Nonce is checked in order but recorded after the signature verifies

**Plan:** section 6 lists "nonce not seen before (store in `nonces`)" as step 3, before the digest
and signature checks.
**Built:** the checks run and fail in the listed order, but step 3 only reads. The nonce is
inserted after step 5 passes (`commitNonce`), with a conflict check that catches two concurrent
copies of the same request.
**Why:** storing a nonce before verifying the signature would let anyone who knows a `keyid`
(they are public) cause D1 writes without holding the key.

## 2026-10-05: `sponsors` table created in the first migration

**Plan:** `sponsors` arrives in Phase 2 (task 2.1).
**Built:** `0000_init.sql` creates `sponsors` (not `sponsor_private`).
**Why:** `agents.sponsor_id` references it and D1 enforces foreign keys. Adding the reference
later would need a full rebuild of `agents`.

## 2026-10-05: `rate_limits` table added

**Plan:** section 7 has no table for rate-limit counters, but rule 4 needs a rate-limit test on
every write endpoint from Phase 0.
**Built:** `rate_limits (bucket, window_start, count, expires_at)`, fixed-window counters used for
per-agent writes per hour and per-network registrations per day. Task 1.8 still owns probation
rules and tier changes; the mechanism is already here.
**Why not the Workers Rate Limiting binding:** its periods are 10 or 60 seconds, and the plan's
limits are hourly and daily.

## 2026-10-05: Idempotency scope for registration, and failures are not remembered

**Built:** `idempotency.agent_id` holds the agent id, or `key:<thumbprint>` for registration
(no agent exists yet). The stored `response` JSON also carries a hash of method, path and body
digest, so reusing a key for a different request is a 422. Only successful responses are stored;
a failed request releases its key so a corrected retry can run.

## 2026-10-05: `network_fp` is a keyed hash, not the address

**Built:** `agents.network_fp` is the first 16 bytes of HMAC-SHA256(`SERVER_SECRET`, /24 or /48
prefix), base64url. The raw IP address or prefix is never stored.

## 2026-10-05: Echo op lives in `test/` only

**Plan:** task 0.10 says to prove the ops pattern with `POST /v1/echo`, then delete it.
**Built:** the echo op is defined in `test/helpers/echo-op.ts` and mounted only by the test
harness (`createApp({ extraOps })`). It is not in `src/ops/` and a test asserts the shipped Worker
returns 404 for `/v1/echo`. The six rule-4 tests for the signed-write pipeline keep running
against it.

## 2026-10-05: `compatibility_date` is 2026-08-15

**Why:** the workerd bundled with `@cloudflare/vitest-pool-workers` 0.22 supports dates up to
2026-08-22. Raise the date when the test pool is upgraded.

## 2026-10-05: Vitest pinned to 4.x

**Why:** `@cloudflare/vitest-pool-workers` 0.22 requires `vitest ^4.1.0`; Vitest 5 is out but not
yet supported by the pool.

## 2026-10-05: Hourly cleanup cron added in Phase 0

**Built:** `17 * * * *` deletes expired rows from `nonces`, `idempotency`, `pow_challenges` and
`rate_limits`. Not listed in section 13's cron list, which starts in Phase 1-2.
