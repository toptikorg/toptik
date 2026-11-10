# Ordinary media: live failure and completion contract

## Observed on 10 November 2026

PR204 passed local checks and CI774, then was released with explicit owner approval of the connected-Preview limitation. The new ordinary-product upload review returned HTTP200, stored immutable reviewed bytes, and preserved the exact SKU. One changed-only save added a genuine new side photograph to KF901003. The normal worker and scheduled wakeups verified stage_source, create_owned, associate, and append-order no-op, with one native creation.

The source JPEG SHA was `edc7eb5226a3e752f1ba0d782d86ebaa1442c69ceb09d623183d3e314f5032aa`. Shopify recompressed it to `2dc417c252afed43df08bc4304542f0b530bc35f3dea69e7df940b2ebbd047a9`. The verified artifact records both identities. Native MediaImage47022322909434 belongs to operation ed2b053e-77a9-456a-83fa-56a2eb5d3298. Final capture stopped with MEDIA_REVIEW_REQUIRED because no native import provenance had been registered before that capture. The product retained its five original pictures and the genuine sixth test picture. Baseline11 was not advanced. This was not a successful final acceptance.

The earlier local roundtrip supplied native provenance itself and kept the same fake bytes. It verified consumption of supplied lineage, not the missing artifact-to-provenance bridge. That evidence must not be used to claim real automatic completion after recompression.

## Scoped repair

The service worker derives native import provenance from sealed, verified creation and association receipts before final capture. It binds the product, variant, SKU, item, logical image key, original semantic content identity, native MediaImage ID, URL, decoded bytes and image metadata. Registration still uses the private SQL provenance contract under the same lease. Native ownership remains reference_only. New attach/replace sources still require their explicit exact-product image review. ALT-only clones may inherit authority solely from the exact immutable baseline image and version; parent and result deny lists still apply. Neither an equal checksum nor a matching filename is sufficient authority.

The generic reorder repair changes only post-reorder acceptance. Valid timestamps may advance for images whose position changed, including images shifted by a move. Unchanged positions and all other media fields, source fences, identities, native primary and variant associations remain strict. Pre-call guards and final readback are unchanged. A later per-image change after accepted reorder remains a concurrent-change hold.

The queue repair maps only the exact SYNC_COPY_APPROVAL_MISSING_OR_CHANGED failure to an explicit review hold. Unknown failures retain their existing diagnostics. It does not authorize publishing, restore removed products, reset baselines, or change routine recovery scheduling.

## Release and acceptance gates

1. Freeze and cold-review the exact combined revision. Run npm test, npm run lint and npm run build, then wait for CI and Preview. Record the connected-Preview limitation truthfully.
2. Obtain explicit owner approval for this specific release. Apply its provenance and reorder migrations before code. Check predecessor definitions, ACLs and migration readback. Merge only the approved, passing head and verify the production domain commit.
3. Resume the existing durable KF901003 operation through an authenticated supported wakeup. Re-read its source, catalog, registry and queue first. Do not create another file, invent native provenance, seed a manual image review to bypass the bug, or mark the operation successful by hand.
4. Verify both platforms, the final native receipt, semantic key, source-to-rendition lineage and all original IDs. Test only reversible changes covered by the owner approval. Do not issue a risky reorder with the old contract.
5. Remove only the test angle and its current native product reference, restore the original order and content, and read both sides again. No fileDelete and no history deletion. Revisions and timestamps legitimately advance.

The local fixture checks are not a connected browser save or Safari proof. A provider simulation and isolated PostgreSQL test are not a live production PASS.

## Remaining catalog holds

A fresh 07:44UTC read found 283 MEDIA_REVIEW_REQUIRED rows:281 had no active operation, one had an uncertain attach chain, and the current canary had a verified attach chain. This repair does not prove that the281 independent holds are resolved. Separate exact-product reviews, existing-receipt validation and content decisions remain necessary where indicated. No bulk retry or content adoption is included.

All eleven historical generic failed rows were read again in Shopify: nine removed Mandarina products were unpublished from the Online Store, and two Urbify products were archived. They must remain unpublished. Queue classification is not proof of a storefront error.

The canonical Master retains the live state, deployment, migration ledgers, acceptance evidence and rollback reference. Local before/receipt files preserve the failed canary without replacing that Master. The unsigned storefront monitoring hold remains in effect.
