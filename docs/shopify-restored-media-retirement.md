# Retire an ordinary operation restored before transport

This is a narrowly scoped recovery action for an abandoned ordinary media operation. It changes that operation to `conflict`, with immutable reason `MEDIA_RESTORED_BEFORE_TRANSPORT`, and schedules normal reconciliation as `pending`. It never labels the abandoned operation verified or synced. No status enum is extended.

The original operation, plan, initial/observed pair, logical steps, chains, prior events, provenance and committed baselines remain in history. Only the operation status/version and transition timestamp change; a new append-only event records the exact prior state, operation (including its original timestamp), queue fence, steps/chains, administrator approval and fresh capture. The existing enqueue helper preserves the old queue evidence and adds the retirement audit reference, increments generation and schedules normal pending work. Its later success or failure is separate from retirement.

## Eligibility

The authenticated administrator must explicitly submit one `itemId`, `operationId` and stable `requestId` with approval string `RESTORED_BEFORE_TRANSPORT`. Shared source-owned colors are refused. The exact ordinary identity must remain enabled, published and approved under the existing reconciliation lease and identity guards.

Both current media snapshots must equal `state.baselines` including identity, side, completeness, logical keys, content IDs, evidence IDs, ALT and order. Only actual read revisions may differ. The operation's `initial_pair` and `observed_pair` are not restoration targets: a native addition may still exist in those historical snapshots after the addition itself has been removed.

The entire operation must have zero `transport_attempts` of every status, zero transport artifacts and zero Gallery commit receipts. A logical `steps.attempt_id` created by `begin_toptik_media_step` and the queue's retry counter are not external transport attempts. A running operation may have its logical step zero started, with a ready chain at phase zero; later steps must remain ready. Reserved operations require ready steps and no chain. Verified, uncertain, conflicting or advanced logical work, readback/detached evidence or any external attempt refuses retirement. In particular, an older BRIC'S operation with an uncertain `stage_source` attempt is ineligible even if no native change is visible.

## Runtime and API

`POST /api/admin/shopify/media/retire-restored` accepts only:

```json
{
  "itemId": "<exact card UUID>",
  "operationId": "<exact operation UUID>",
  "requestId": "<stable approval request UUID>",
  "approval": "RESTORED_BEFORE_TRANSPORT"
}
```

The existing admin token/session policy runs before reading the body or creating a service-role client. Session requests require same-origin JSON/CSRF checks. The body is streamed with a 1,024-byte bound and a deadline. Actor identity and authentication method come from the server authorization result, not the body. No caller-provided pair, proof, checksum, URL or expected identity is accepted. Execution requires the existing production media-sync environment gate.

The runtime resolves the reviewed product identity, acquires the existing product lease, reads the retirement context, and invokes actual `captureMediaPlanningPair`. This performs fresh native and Gallery reads and the existing byte/denylist checks. It performs no provenance registration, observation write, image upload, native mutation or baseline adoption. A second retirement-context read rejects changed state, operation, queue claim/generation or raw Gallery. The final RPC rechecks the same fences and current Gallery raw/refs under SQL locks. Existing snapshot/provenance validators remain authoritative.

The two new fixed-name service-only RPCs are:

* `read_toptik_media_retirement_context`: reads the existing planning context plus the exact operation, queue fence and any prior retirement receipt under the lease.
* `retire_restored_toptik_media_operation`: validates complete current snapshots, exact baseline equality, operation/state/hash/queue fences and all transport-free conditions, then records the terminal conflict and enqueues normal pending reconciliation.

Both revoke EXECUTE from PUBLIC, anon and authenticated. They add no direct private-table grants. Lock order follows the established global/copy approval/lease/product order, then state, operation, queue and Gallery rows. The live lease is rechecked after waits and again immediately before mutation. No existing RPC definition is replaced.

## Lost responses and replay

An unknown final RPC response returns `MEDIA_RETIREMENT_RESULT_UNCERTAIN`. It is not treated as success or as permission to generate another operation. Retry only the same `requestId`, operation, actor and approval. Every replay performs fresh capture and CAS again. SQL binds the immutable command hash to the exact identity, operation/hash, request, actor, authentication method and approval. The original full capture/fences stay in append-only evidence.

Replay requires the original baseline version/content and the exact retired operation version still to match. A new active operation, changed baseline, changed identity, new attempt/artifact, busy queue claim or changed request/actor/approval refuses it. A successful replay reports the current queue status separately, which may already be `done`, `review` or `failed`; the retired operation remains a conflict. It never claims that the entire sync completed merely because retirement succeeded.

## Verification and limits

Local tests cover real PGlite journal/Gallery/queue/RPC behavior, service-only permissions, saved zero-transport shape, all asset/CAS/lease failures, every transport-attempt status, artifacts and Gallery commits, immutable audit, state preservation and fresh idempotent replay. Runtime tests use actual planning capture/mappers with local provider fixtures, real session/token authorization and CSRF policy, plus a runtime-to-real-PGlite RPC roundtrip. Metadata/provider fixtures are not perceptual photo approval or live Shopify byte proof.

The roundtrip also reads the normal planning context after retirement, confirms that the preserved started logical step/ready chain belongs only to a terminal conflict, and claims the normal queue. Actual reconciliation produces an empty media plan; a new zero-step operation reserves and commits only fresh revisions, leaves all baseline assets unchanged, and finishes the queue with no transport attempts. The old operation remains a conflict. This is a separate normal reconciliation result, not a relabeling of the retired operation.

SQL cannot atomically lock Shopify. The runtime brackets capture with fresh source checks and SQL fences Gallery/state under the lease; an external Shopify change after the final native read remains possible. Retirement changes workflow history only and grants no authority to propagate an image. Normal reconciliation must perform its own fresh checks.

This implementation has not been applied to a live database, deployed or exercised on a live operation. A release needs the repository's full checks, independent review, CI/Preview and specific owner approval before migration/deployment, followed by a bounded live acceptance test. Preserve the pre-release code/migration and original operation evidence for rollback; do not delete the append-only retirement event or rewrite the original operation as verified.
