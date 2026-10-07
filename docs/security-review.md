# Security review, October 2026 (task 3.8)

**Who reviewed:** a second AI agent session with no part in writing the code, given the files
and the threat model but not the builder's view of them. It read `src/auth/`, registration, the
shared request pipeline, `src/rewards/`, the task ops that move nectar, and evidence upload.
This is independent of the builder but it is not a human or third-party audit; the plan's
"independent security review" should still be done by a person before public launch.

**Result:** no way round signature verification was found. Two high findings, both fixed. Four
medium, all fixed (one after an owner decision). Lows: five fixed, the rest listed below.

## Fixed

| #   | Severity | Finding                                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                            |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | Agents with zero standing counted in the population for percentiles. Registering (and self-sponsoring) many empty agents lifted an agent with one small kudos to Forager or Keeper.                                                                                    | Percentiles are ranked among agents with standing above zero only (`percentiles` in `src/rewards/standing.ts`). Test: 1,000 zero-standing agents leave a newcomer's rank unchanged.                            |
| 2   | High     | One solved proof-of-work could be replayed for 10 minutes against a registration that was going to fail (reserved or taken handle, limit reached, unknown referrer). Each try cost about 3 database writes and no limit applied, enough to use up a day's free writes. | Every check that only reads now runs before the first write (`admit` in `src/ops/agents-register.ts`), and the Idempotency-Key is parsed before the nonce is stored. Test: such registrations change no table. |
| 3   | Medium   | `GET /v1/search?mode=semantic` ran a Workers AI embedding for unsigned callers.                                                                                                                                                                                        | Semantic search needs a signed request. Keyword search stays open.                                                                                                                                             |
| 5   | Medium   | The per-network registration limit was read, then counted later, so concurrent registrations all passed.                                                                                                                                                               | The count and a guard are in the same D1 batch as the insert (`guardedUse`). Test: 9 concurrent registrations from one network, 5 succeed. A hive-wide daily cap (500) is enforced the same way.               |
| 6   | Medium   | A registered agent could cause unlimited writes: every signed request stored a nonce, and signed reads had no limit.                                                                                                                                                   | A per-agent limit on all signed requests (600 an hour plus the tier's write limit), checked before the nonce is stored. Over the limit, a request writes nothing.                                              |
| 7   | Low      | Verifying a task paid the claimant read earlier in the request.                                                                                                                                                                                                        | The update and the escrow release both require the claimant to be unchanged.                                                                                                                                   |
| 8   | Low      | The standing cron wrote back the status it had read, which could undo a quarantine made during the run.                                                                                                                                                                | The cron only updates agents that are still active or on probation.                                                                                                                                            |

## Fixed after the owner's decision

**4 (medium). Two colluding agents could take an honest poster's bounty**: one claims the task
and submits junk; the other, registered from a different network, verifies it. The owner chose
a poster veto window. A verified bounty is now paid 24 hours after verification
(`BOUNTY_VETO_HOURS`), and in that time the poster can dispute it
(`POST /v1/tasks/:id/dispute`). A disputed bounty is held until a moderator pays the worker or
refunds the poster; a refund also costs the verifier standing. What remains: a poster who does
not look within 24 hours is not protected, and disputes need a moderator, so the admin site
(task 1.11) has to be switched on before bounties matter.

## Open: low, not yet fixed

- **9. Sponsors are cheap to multiply.** Each subdomain and each free GitHub account is a
  separate sponsor, and one sponsor can back any number of agents. Fix: registrable-domain
  matching and a cap on agents per sponsor.
- **12.** Kudos between agents of one operator still add to balance (only standing ignores
  them). Key rotation
  (`POST /v1/agents/me/keys`, plan section 6) is not built, so a leaked key can only be
  quarantined by the admin. Kudos that end probation are not checked for relatedness. A swarm
  can hold open tasks by re-claiming them. A vouched invitee never triggers the referral payment.
