# Failure-based media queue backoff, prepared release

Status: local implementation and tests only. No merge, hosted migration, queue replay or production verification.

## Problem and behavior

The existing lifetime `attempts` counter increments on every claim, including successful partial steps. Its use for retry delay can hold a first failure for six hours after a long successful run. The new `failure_streak` counts matching-generation failed finishes, caps at36, and resets only on a matching-generation `done`. The lifetime diagnostic remains untouched. Failed rows wait10minutes per failure, capped at360minutes; monitor `retry_due_at` uses the same expression.

Migration: `supabase/migrations/20261112055049_media_queue_failure_streak.sql`, generated with official Supabase CLI3.1.0 `migration new`. No hosted CLI command used.

## Migration safety and consumers

Consumers: existing claim RPC (including the legacy wrapper), finish RPC, queue keep/defer/recover and routine helper, liveness monitor. Only finish/claim/liveness definitions change. Ordering, exclusions, leases, identity guards, API response shape, ACLs, security-definer ownership and hardened search paths remain unchanged.

Backfill is conservative for ALL unfinished rows, including pending/processing/review: capped lifetime attempts is retained because prior failures cannot be reconstructed from status alone. Done rows start at0. Failed rows with anomalous0attempts start at1, tightening rather than shortening their delay. Existing statuses, timestamps, claim/generation/evidence/last-error fields remain byte-for-byte unchanged by the migration. New failures cannot overflow the bounded counter. A superseded generation finish neither increments nor resets the failure history.

Pending/progress, review, keep, defer, enqueue and recover do not reset the counter. A genuine enqueue still makes pending work eligible immediately as before, but its next failure retains chronic-failure history. No function is dropped/recreated, so existing function ACLs and dependent objects remain intact. `CREATE OR REPLACE FUNCTION` preserves ownership and permissions per PostgreSQL documentation: https://www.postgresql.org/docs/current/sql-createfunction.html .

## Acceptance

Tests run the actual forward SQL, not the earlier in-memory overlay. Cover first/chronic failures, cap, monitoring, transitions, conservative conversion, stale claims/generations, permissions/RLS, unchanged guards, exclusions, healthy-work fairness, defer/keep/recover, and rollback. The existing historical queue migration suites still test their historical contracts, while the new suite separately applies the forward migration on top of the complete queue fixture.

PGlite is single-process. Real multi-session PostgreSQL lock-contention, hosted Supabase advisors and production catalog/queue impact are NOT TESTED. `FOR UPDATE SKIP LOCKED` and lease predicates are preserved in the exact function-definition comparison, but this is not a concurrent-server load test. No browser change requires visual acceptance; a future approved release must still verify live read-only monitor output and build version without invoking the stopped workflow.

## Release gate and rollback

Owner approval requested only after exact-version QA and cold review. Do not apply merely because tests pass: the queue is shared with the safety-stopped workflow. Confirm the permitted operational scope and preserve that stop before any hosted apply. No permission here to replay products, generate media inputs, run workers, change guards or alter schedules.

A source merge does not apply SQL and is not production proof. An approved release needs a bounded migration window, confirmed current schema/function definitions, migration success and read-only liveness/ACL readback. No catalog mutations are an acceptance prerequisite for this change.

Operator-only rollback file: `docs/media-queue-failure-streak-rollback.sql`. Restores the previous three function definitions without changing queue rows or dropping the counter. It is not an automatically applied migration. A later re-enable requires a new reviewed forward migration restoring the functions, not replaying the original ADD COLUMN. Lock timeout3seconds and statement timeout30seconds make lock conflict fail the transaction rather than wait indefinitely. No destructive data rollback is required.

## Reproducible upgraded regression pass

Run npm run test:media-queue-upgrade. It requires the installed local PGlite engine and fails if absent, sets the explicit test-only upgrade mode, and runs the five existing suites (46 tests) after the actual migration. The SQL fixtures are upgraded through tests/helpers/queue-failure-streak-regression-upgrade.mjs; directly inserted historical rows seed the equivalent converted counter. The claim-formula regex explicitly selects failure_streak in upgraded mode and attempts in historical mode. Other behavioral assertions are retained. The same offline pass is included in CI; no database credentials or hosted connection are used.
