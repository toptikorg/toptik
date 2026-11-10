# Corrections from the PR 201 live acceptance run

This release is a focused follow-up to PR 201. It is not a certification that every historical catalog hold has been resolved. The canonical TopTik Google Doc remains the authority.

## Observed failures

The live FZT73 canary created and decoded one exact real-photo copy, attached it to the product, then received a native userError when it attempted to append four media IDs to a variant that already had its primary. The old journal retained `GROUP_MEDIA_WRITE_REJECTED`, not the individual provider error codes. The operation stopped in review. No second create was sent.

Shopify's pinned [2026-07 MediaUserErrorCode contract](https://shopify.dev/docs/api/admin-graphql/2026-07/enums/MediaUserErrorCode) documents `TOO_MANY_MEDIA_PER_INPUT_PAIR` and `PRODUCT_VARIANT_ALREADY_HAS_MEDIA`. A private per-color photo map does not authorize multiple native variant images. Keep additional angles in the product gallery and the explicit reviewed map.

Only the new file's product reference was removed during recovery. All 15 original photos, all four native variant association lists and primary images were independently read back with the exact pre-canary fingerprint. The global file was retained. The failed operation remains review until the new audited restoration function is approved and applied; it is never silently marked verified.

Separately, real copy webhooks were queued behind hundreds of daily publication-recovery rows. A manual owned/edit preflight eventually refreshed the restored copy and then rejected its stale CAS. That does **not** prove automatic webhook delivery. Runtime logs also recorded `MEDIA_CONTINUATION_NOT_ACCEPTED_HTTP_508`. Vercel documents [508 for self-invocation loops](https://vercel.com/docs/errors/infinite_loop_detected).

## Corrected behavior

* The shared phase planner never appends gallery angles to native variants. A changed primary uses one `productVariantsBulkUpdate(mediaId)` operation. Non-primary addition/order changes leave native variant associations intact. Unexpected multiple existing native associations require review before replacement.
* TypeScript and the private SQL acceptance gate agree on exact one-primary replacement and preserve every other native variant. Multi-image append is refused locally, before dispatch. A no-op remains zero native writes.
* Provider rejection evidence stores at most ten bounded enum codes. Raw provider messages, headers and credentials are not logged. Rejected operations still require readback and remain review.
* The media worker executes one bounded batch and never recursively fetches itself. Pending work remains durable for an independent webhook, editor or existing cron wakeup. No headers, user agents or proxy tricks bypass Vercel's protection.
* Inbox claims prioritize genuine updates over a row that has **both** the publication-recovery delivery prefix and its recovery marker. Retry limits, stale-claim timeout, row locks and the limit of 50 remain unchanged. This does not replay failed/review history or manufacture new inbox events.

## Migration and restored-review resolution

Apply `20261110052632_reviewed_media_recovery_and_live_queue_priority.sql` before dependent code, only after the owner approves this specific release. It replaces two private verification functions, adds one service-only restoration function and adjusts the existing bounded inbox claim. It does not resolve an operation or mutate a product by itself.

`resolve_restored_toptik_owned_media_review` is deliberately narrow. It requires the product lease; exact registry version, before manifest and source fingerprint; current card CAS and unchanged projections; a hash-bound owner decision; an explicitly rejected write; and no uncertain dispatch or attempted async reorder. Only the observed create/attach/append failure class is eligible. A missing or changed preimage stops it.

The function records a new immutable `restored_rejected_review` event and changes the restored operation to `cancelled`. It leaves all original phase attempts, failed evidence, created-file provenance and customer content intact. It does not reset a baseline, clear other holds, delete a file or label the failed operation as successful. Replays require the same exact resolution package.

## Validation and production acceptance

Local validation: 2,126 tests, 2,060 passed, 66 skipped, zero failed. Lint passed with two unchanged pre-existing warnings, and the production build passed. Independent cold review covered the final migration and native transport changes. Isolated PostgreSQL tests reproduce a rejected historical journal, verify role denial, exact preimage/CAS/approval, uncertain-dispatch refusal, replay/audit protection, one-cover readback and a real update ahead of 240 recovery rows.

After owner approval: apply the migration, verify its grants and exact definitions, deploy the approved commit, verify Production/alias commit, then resolve only the already restored FZT73 operation using fresh source/card evidence. Repeat the actual live add/order/cover/remove canaries with a **new** request ID. Independently verify every native delta, the Gallery projection, automatic source-to-Gallery delivery and complete restoration. Do not infer live success from this document, CI or a Ready Preview.

Ordinary staged-upload review is being developed in a separate branch. It is not included in this release. The 283 historical media holds, copy-adoption differences and removed-product protections remain untouched.

## Rollback

The new private resolution is terminal and audited; rolling code back does not erase that history. Do not revert to a planner that appends multiple native images. Stop new shared-media writes if a new acceptance failure is found, preserve receipts and restore only the exact product preimage under fresh checks. Reverting the inbox priority affects scheduling only; preserve pending rows and retry counters. Never delete the registry, evidence or shared files.
