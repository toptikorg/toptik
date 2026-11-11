# Media planning timing

`toptik.media.planning_timing` emits one bounded diagnostic per reconciliation invocation. It records the server-owned product GID, outcome, allowlisted error code, elapsed milliseconds, capture count and aggregated stage counts/durations. It never includes URLs, image bytes, customer data, request bodies, credentials or arbitrary error messages.

The instrumentation is invocation-local. It does not cache captures, change deadlines, skip evidence gates, alter queue state or schedule retries. Failure in error inspection or logging cannot replace the reconciliation result or original exception.

`lastStage` means the last measured operation, not a proven throwing check. Lease release and local computation have no separate duration. An outcome returned as `review` or `pending` has no thrown error; its durable queue diagnostic remains authoritative. Stage totals need not equal total elapsed time.

## Production investigation

For KL974001, FZT11001 and a successful comparison product, filter runtime logs by event name and exact product GID. Compare capture count, capture duration, context/register/observe timings and total elapsed time. Do not reconstruct missing historical timings from queue timestamps.

On 2026-11-11, the deployed SQL allowed failed rows to be claimed on a later worker wakeup after `least(attempts,36) * 10 minutes`. The counter was lifetime claims, not consecutive budget failures. `recover_toptik_media_work` called `enqueue_routine`; it was not proof of a direct failed-to-pending transition. A future bounded retry policy requires an explicit episode counter and an exhaustion hold preserved by routine recovery and enqueue paths. This change implements no such policy.

Roll back this code through the previous release if diagnostic behavior is defective. No migration, product edit, image mutation or historical ledger rewrite is involved.
