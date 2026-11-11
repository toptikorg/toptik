# Bounded media continuation

The ordinary media queue permits at most ten reconciliation entries in one claim, under the same absolute deadline and existing admission reserve. That covers up to six replacement phases, two timestamp-only guard reloads, final acceptance and commit. The bound is a service quantum, not a latency promise or permission to replay writes.

A fresh `verifiedCheckpoint` retains its existing meaning. A separate `replanCheckpoint` allows one reload per exact operation, step, phase, source fingerprint and target revision. Only the pre-attempt timestamp-only guard-refresh path can produce that cursor, after the existing SQL/RPC gate confirms `refreshed` or `unchanged` with no execution permission. The current lease is released. The next invocation reloads the persisted job, reacquires a lease, observes fresh guards, obtains the normal one-shot permit and performs the final pre-call check.

The reload cursor is not phase verification, an execution permit or progress. It does not earn in-flight queue priority by itself. Reloads and verified advancement share the same ten-call ceiling and absolute deadline. Repeated cursors stop. An existing attempt continues through immutable receipt recovery and never gains a reload cursor.

Busy, arbitrary pending, uncertain acknowledgements and asynchronous provider jobs still stop unless another existing verified transition authorizes continuation. This change adds no sleep loop, parallel worker, self-fetch, cache, deadline increase, migration, baseline rewrite or failed-row retry policy.

Production evidence from 2026-11-11 showed timestamp-only guard refreshes before detach and reorder. Each returned pending and required a later independent wakeup despite having created no mutation attempt. The new cursor makes that specific safe reload explicit. It does not establish the cause of the separate planning time-budget failures or guarantee that every product completes in one claim.

Rollback is code-only to the prior release. Keep journal entries, attempts, receipts, source reviews and baselines intact. A live canary must record source change, automatic destination update, actual completion time, restoration and both-side readback. Report internal target media replacements separately from pixel/content restoration.
