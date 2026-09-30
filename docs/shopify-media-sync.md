# Product media synchronization — reconciliation core

Status, 30 September 2026: **local implementation** of reconciliation, complete Shopify read/decoded-image adapter, strict staged transport requests and a one-phase worker with service-only ports. The query/parser and existing image decoder were verified against one live product read-only. Real write-service ports, deployed media journal, editor integration, active media queue and live media changes remain unimplemented/unverified. This is a required part of the requested complete synchronization, not a replacement for it.

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

## Complete Shopify read and image proof

`media-read-adapter.ts` uses API 2026-07 and the exact Online Store publication, product/variant IDs, both raw SKUs and handle. Product media count must be exact, all connections complete, one variant present, every media entry an image and both media/file status READY. Mixed video/3D, truncation, incomplete metadata, processing images and identity changes are held; none becomes deletion. The raw fingerprint includes order, alt, media update times and variant assignments, rather than relying only on product `updatedAt`.

Live API evidence revealed different image ID namespaces: `MediaImage.image.id` returns `ImageSource`, while `variant.image.id` can return `ProductImage`. Both IDs remain opaque. Variant media associations plus exact untransformed image URLs establish the relationship; numeric suffixes are never assumed equivalent.

`fetchDecodedShopifyMedia` reuses the existing production `verifyOnboardingImage` helper: bounded byte/pixel limits, approved Shopify CDN, public DNS, no redirects and actual image decoding. The orchestration in `media-decode-reader.ts` limits concurrency to two, preserves the caller's absolute deadline and re-reads the full media state afterward. It returns no partial batch. Decoded bytes do not establish cross-system identity until the private journal supplies exact ownership/import lineage; the read adapter never fabricates keys.

Read-only live acceptance, 30 September 2026 17:27:27 UTC: product `7550812619002`, variant `42465754808570` / exact Shopify SKU `P10SZV2405J`: all five images decoded (819,056 total bytes); one variant association retained. Full before/after query fingerprints match `47bdadc54e923ede213fc66f933e6f1e5c697cedbd0903638fb039b543c38c1f`. Source mutations: zero. Local evidence outside the repository: `outputs/media-read-canary-{response-v2,decoded,after-decode,complete}-20260930.json`. This is read/decoder proof only, not automatic media synchronization.

The shared GraphQL transport now rejects malformed response/error envelopes even when they contain apparently valid product data; provider error messages remain excluded from persisted error codes.

## Official API evidence checked 30 September 2026

- [fileUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fileUpdate): requires file/theme write access, updates READY files, supports product associations; reference removal can clear variant images. Current app scopes must be read before selecting this transport. No access expansion was performed.
- [FileUpdateInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/FileUpdateInput): exposes content/alt/reference fields and no compare-digest input.
- [productReorderMedia](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productReorderMedia): requires product write access and returns an asynchronous job. Receipt of a job is not completion.
- [productUpdateMedia](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productUpdateMedia): deprecated in favor of fileUpdate. Do not build a new long-lived feature around it solely to avoid proper scope/ownership handling.

Current installed-app scope read (30 September, 17:06:22 UTC): `write_themes` and `write_products` are present, so the documented file-update and product-reorder transport scopes are already available. `write_inventory` is absent. No scope was added or changed. Evidence: `outputs/media-sync-scope-gate-20260930.json` outside the repository; scope availability is not a media-write test.

Local focused tests cover both directions, independent baselines, conflicts, target-only assets, explicit removals, last-image protection, ordering, exact identity, uncertain acknowledgements and full readback. No live behavior has been verified for this new lane.

## Staged transport and one-shot worker, local implementation

`media-transport-read.ts` retains the whole ordered raw product-media collection, including PROCESSING/FAILED images and coexisting old/new IDs during replacement. These intermediate states are never coerced into unique logical asset keys. Every raw revision includes statuses, alt, media update times, image ID/URL/dimensions, order and variant assignment. Initial and final logical snapshots still require actual decoded-image evidence.

`media-transport-requests.ts` builds API 2026-07 operations only: create a new owned file from a verified immutable staged object, associate it with the exact product, reassign the one exact variant, detach one product reference, or reorder the exact full membership. Alt changes also clone an owned file instead of editing a possibly shared file. No global file deletion or overwriting source/alt on an existing shared file exists. Creation uses deterministic operation/asset filenames and `RAISE_ERROR`; a lost response permits read-only recovery, never a second blind create. Acknowledgements and asynchronous Job IDs are not completion.

`media-transport-journal-intent.ts` binds each actual request hash to the exact normalized private SQL intent. `step` is a stable logical asset index shared by its phases; `phaseIndex` identifies individual mutation attempts. JSONB key order is not semantic identity. The private operation must retain the original pre-call request/guard for uncertain recovery instead of rebuilding it from changed current media.

`media-transport-worker.ts` loads a server-owned job, checks existing required scopes, acquires the shared product lease, obtains a one-shot journal permit and immediately re-reads both sides before making at most one Shopify mutation. All accepted and lost responses transition to readback/recovery. A prior attempt never authorizes another mutation. A change before the outbound call holds the operation; baseline advancement requires SQL-validated complete recovery evidence.

Every worker port receives an absolute deadline. Actual mutation execution stops five seconds before the overall deadline, leaving four seconds for persistent uncertainty/readback and one second for best-effort lease cleanup. The lease must outlive the invocation plus five seconds; cleanup failure cannot override a durable verified outcome. Caller-side Promise.race is an additional bound, not cancellation: concrete HTTP ports must check their deadline before dispatch and abort accordingly. An already-correct terminal order is completed through SQL's verifiedNoop path with no API mutation; a permit to execute empty moves is rejected.

Current worker ports are not yet connected to the deployed services. Structural `StagedMediaSource`/`OwnedMediaReceipt` objects must be resolved from immutable private proofs; browser-supplied receipt fields are never authority. After association, refresh the owned media observation (including updatedAt) before reassigning the variant. The `mediaId` mutation's treatment of all variant-media associations is not proven live: full readback must show the intended assignment before old-reference removal is allowed. If the platform retains the old association, hold it; do not infer that removal is safe.

The SQL logical journal and additive transport-substep candidate have been integrated locally. Neither has been deployed. In addition to the 155+81 synthetic fixture assertions, 639 executed checks load 16 actual repository migrations and the captured82 Gallery products/478 angle rows plus78 verified bindings/baselines. The real identity and lease functions execute without stubs, all28 protected tables remain unchanged through migration/rollback/bootstrap/recovery, and every media eligibility starts disabled. This proves local schema compatibility and preservation, not live synchronization. Managed Supabase storage schema/policies, original timestamps absent from the capture, decoded media proofs and live API effects are excluded from that claim. The renderer and indexing state are unchanged.

Additive media migration order: `20260930_media_sync_journal.sql` then `20260930_media_transport_substeps.sql`, after the existing verified copy eligibility and shared lease migrations. The actual validation chain also includes onboarding, typed specs, draft creation, pending intents and source imports. Do not apply all same-date files alphabetically. Source captured manifest and all migration hashes/order are recorded in local `work/media-sync-journal-20260930/qa-production-chain-result.json` and `TRANSPORT-CONTRACT.md`.

Before storage staging, read the live bucket's allowed MIME types. The repository's original bucket migration allows JPEG/PNG/WebP, not AVIF; describing AVIF in the media protocol is not evidence it can be uploaded. No live bucket setting was changed. Direct deletion of a currently variant-linked image remains held until the intended replacement association has its own verified policy/proof.

Additional official contracts: [duplicate resolution enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/FileCreateInputDuplicateResolutionMode), [fileCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fileCreate), [variant mediaId](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductVariantsBulkInput). The pinned installed API is 2026-07; the linked latest documentation identified that same version on 30 September 2026.
