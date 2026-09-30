# Product media synchronization — reconciliation core

Status, 30 September 2026: **local implementation only** in `media-sync-core.ts`. There is no network/database adapter, editor integration, active queue or live media change in this increment. This is a required part of the requested complete synchronization, not a replacement for it.

## Reconciliation contract

Exact product GID, variant GID, Gallery UUID, both raw SKUs and approved handle identify one product. Each image has a server-owned immutable cross-system key; filenames, positions, similar colors or guessed URLs never establish identity. The private mapping must retain platform media IDs, original URLs, decoded byte hashes and verified import lineage. Shopify may recompress an uploaded image, so an observed target hash is associated only through the successful exact import receipt, not by accepting a similar image.

Initial source-specific values and sequences become independent baselines without copying them. A complete current snapshot and revision are mandatory. Content, alt text, membership and order are separate logical fields. The planner merges independent changes in either direction, keeps target-only images, and holds differing concurrent changes to the same field. Unchanged differences do not trigger replacement. Same desired values after an uncertain acknowledgement do not cause another write.

Removal requires a private authenticated-editor intent or verified signed Shopify event tied to the original baseline fingerprint. A timeout, failed image decode, omitted page, filtered public response or incomplete pagination cannot mean deletion. Removal only detaches a product reference; it never deletes the global Shopify file or Supabase object. The target's last image is protected. If a source has really removed all images, public display must follow the existing no-empty-product-card policy while the data remains recoverable.

A successfully propagated detach whose response was lost is acknowledged only with a trusted private operation/readback receipt. It must bind the original source intent, both baseline fingerprints, exact key, operation UUID and current target-absence readback revision. It does not require another human removal action and does not send a second detach. The future adapter must read this receipt from its private journal, never from browser-supplied JSON.

Replacement allocates an owned image and switches only this product reference; it must never replace bytes of a shared Shopify file. Alt changes must similarly check file ownership/references before using a global file API. Simultaneous content and alt edits merge independently. Reorder preserves unrelated target-only images in their relative order. Ambiguous insertion anchors and conflicting reorders are held for resolution.

Independent new images inserted concurrently into the same gap merge deterministically by immutable key, while retaining each source's own new-image sequence. This prevents the planner itself from creating opposite orders. A held image-membership conflict cannot be reordered as a side effect of another source's addition.

Every plan carries whole-source and whole-target fingerprint/revision preconditions. Immediate pre-write reads must match. The final readback validates every image's identity/content/alt and order, including unchanged images. A plan/projection is not permission to advance baselines; only verified platform readback can do that.

## Adapter requirements still to implement

- Private mappings, immutable operation receipts and generation queue with the shared existing product lease; recovery of uncertain writes without duplicate upload/attachment.
- Source reads of all product media, rejecting truncation, unsupported mixed-media loss, identity drift and incomplete/processing assets. Validate exact shop ownership and single-variant eligibility before changes.
- Same-origin authenticated Gallery edits, per-image versions and explicit detach intent, integrated with the existing editor rather than a required second manual update.
- Shopify webhook admission and automatic worker wakeups; failures must not disable existing copy/spec synchronization.
- Decode real images using bounded allowed-host fetch, exact current product identity, byte/pixel limits, and durable source-to-target lineage. Reuse the existing Shopify CDN verifier where applicable; Gallery uploads must be limited to the existing project's owned storage paths.
- Attach new owned image, wait for READY, verify decoded target, then switch a reference. Store reorder job ID before retry and verify the completed ordered list.
- Add explicit product-reference detachment only; never `fileDelete`. Preserve variant image assignments or report a conflict rather than clearing them as a side effect.
- Native media APIs lack `compareDigest`/expected-version fields. A local lease serializes this application's operations, but cannot lock an independent Shopify Admin edit. Fresh reads plus full readback are mandatory and this residual concurrent-write window must remain documented; do not claim atomic cross-system media CAS.
- Authenticated conflict resolution with retained losing values, followed by exact live canary acceptance in both directions and preservation checks for all unrelated products/copy/commerce.

## Official API evidence checked 30 September 2026

- [fileUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fileUpdate): requires file/theme write access, updates READY files, supports product associations; reference removal can clear variant images. Current app scopes must be read before selecting this transport. No access expansion was performed.
- [FileUpdateInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/FileUpdateInput): exposes content/alt/reference fields and no compare-digest input.
- [productReorderMedia](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productReorderMedia): requires product write access and returns an asynchronous job. Receipt of a job is not completion.
- [productUpdateMedia](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productUpdateMedia): deprecated in favor of fileUpdate. Do not build a new long-lived feature around it solely to avoid proper scope/ownership handling.

Current installed-app scope read (30 September, 17:06:22 UTC): `write_themes` and `write_products` are present, so the documented file-update and product-reorder transport scopes are already available. `write_inventory` is absent. No scope was added or changed. Evidence: `outputs/media-sync-scope-gate-20260930.json` outside the repository; scope availability is not a media-write test.

Local focused tests cover both directions, independent baselines, conflicts, target-only assets, explicit removals, last-image protection, ordering, exact identity, uncertain acknowledgements and full readback. No live behavior has been verified for this new lane.
