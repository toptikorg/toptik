# Orphaned angle lineage after a URL relocation

An ordinary product can retain a shared logical media key in both baselines while the Gallery angle UUID is recreated and its storage URL changes to the current Shopify CDN URL. The previous orphan guard rejected the changed URL even when the files were byte-identical.

The changed-URL case now requires all of these conditions:

* Exactly one retired angle reference and one replacement at the exact current native URL; the retired physical row no longer exists.
* Both existing baselines already pair the same key with the current concrete SHA-256. No other key in either baseline uses those bytes.
* The immutable Gallery baseline proof has that exact decoded SHA and its original physical reference.
* The existing native baseline proof matches the current MediaImage ID, URL, decoded SHA, dimensions, MIME and byte length.
* Neither proof is a transformed transport receipt.

This retains a proven identity; it does not approve a new image, change either baseline, invent a transport receipt or merge visually similar photos. Normal exact-image review still gates registration of the new Gallery proof, and ordinary reconciliation decides all ALT, order and membership changes. The existing same-URL guard remains supported.

The old and current URLs need not share a host or path family. Identity comes from the exact bytes, the already paired baseline key and the retired physical row, rather than URL resemblance. Independent review remains mandatory for the new proof. Additional regression cases from Claude's cold review cover MIME, byte length, decoded checksum, height, duplicate proofs and cover-only identities.

Validation: the regression fails with MEDIA_PLANNING_EQUIVALENT_TARGET_EXISTS before the change. Positive, negative and real review-guard cases pass. An offline replay against preserved production context and downloaded bytes accepts the three proven SZV24 angled/back pairs. This is not live acceptance and does not establish that either whole product is resolved. Their other independent front/interior image identities remain separate and may still require review.

No migration, theme update or product publication is included. After owner-approved deployment, capture both products afresh and run ordinary reconciliation under its existing lease and review gates. Verify snapshots, audit and native media readback. Never clear the queue or mark a product done manually. Roll back code to 3675857 if necessary; retain any immutable observations and receipts.
