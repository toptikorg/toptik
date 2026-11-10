# Native reorder acceptance follow-up

PR202 fixed the actual multi-image native variant error and worker self-invocation. Its next live add canary created and attached one real photo, then stopped at reorder. The original provider acknowledgement was not retained; the journal truthfully records ACK_INVALID and READBACK_MISMATCH, not a provider rejection.

The observed native graph had the exact requested order and unchanged variant associations/primary images. Only product.updatedAt and 12 repositioned media.updatedAt values changed. The old TypeScript and SQL compared those media objects byte-for-byte. Separately, the numeric-only Job GID parser cannot accept Shopify's official UUID Job example in the pinned [2026-07 productReorderMedia response](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/productReorderMedia).

The temporary file47020283461882 was detached from Product7524873044218 only. All15 original photos, their order, URLs, ALT, dimensions and statuses, all4 native variant associations and primary images were read back restored. Timestamps cannot be rolled back: the new source fingerprint is a6bece8479247e0c0e0cd061fc2f3eced8cab3ac5a0d142af4774978afd516f2, not the prior e300037d6f661c68a0a02fd26b39a7cfc2d72476c06dee970b8290034667fe2e. The operation remains review. No global file was deleted and no further canary was started.

## Narrow changes

* ACK parsing and job polling accept a bounded opaque Shopify Job GID, including the documented UUID. Missing/null jobs, wrong GID type or host and injected separators remain invalid. There is no synchronous-success fallback.
* Only reorder may accept nondecreasing updatedAt on a media ID whose actual array index changed. Every content field, ID, URL, ALT, size, status, association, primary and unchanged-position timestamp remains exact. The real observed graph and fingerprint are retained. Global fingerprint checks and other phases stay strict. TypeScript retains microsecond precision and PostgreSQL rejects nonfinite timestamps.
* The new migration replaces only the reorder branch of assert_delta through a private helper. The prior rejected-write resolver remains unchanged and still refuses reorder attempts.
* A separate service-only restored-reorder resolver handles only this failure class: one verified newly-created file; prior create/attach phases verified; one reorder move targeting only that file; the file absent from the restored product; exact original semantic graph and order; timestamp drift only on the IDs affected by that precise move; unchanged card projections/CAS; and a fresh hash-bound owner approval. A delayed move targeting any original image is refused.
* Resolution records immutable restored_reorder_review history, cancels the failed operation and refreshes source metadata through the existing atomic projection function. It does not adopt different content, erase attempts or pretend the failed operation succeeded.

## Release and acceptance

Apply20261110060051_verified_owned_reorder_contract.sql before dependent code, only after owner approval of this release. A migration alone does not resolve any operation. Verify service-only grants, exact commit, Ready Production and live build-version. Then prepare fresh native/card evidence and the reviewed resolution package. Repeat the real add/order/cover/remove canaries with new request IDs and restore them completely. Automatic source-to-Gallery delivery and ordinary staged upload remain separate acceptance requirements.

The isolated PostgreSQL tests reproduce the observed moved-timestamp graph, negative identity/content/CAS/late-job/permissions cases, and terminal audit replay. TypeScript tests include the official UUID Job and timestamp precision. Local tests, CI and Preview builds do not prove live acceptance.

Frozen local validation: 2,146 tests total, 2,080 passed,66 skipped,zero failed. Lint and production build passed, with only two unchanged pre-existing lint warnings. Independent cold review passed on migration SHA-2560591d0a3bcc46b5a8e513a19efe348246064ca2f7effd4b6658adf862e7aa952. The exact final native transport, timestamp precision and isolated SQL code were included in these checks.

Rollback: stop new shared writes and retain private maps, fresh snapshots and immutable journals. Do not revert to the numeric-only Job parser or the multiple-native-image planner. Restore customer content from the exact preimage; preserve legitimate advanced metadata and the audit trail.
