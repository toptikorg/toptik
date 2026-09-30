# New-product commercial finalization — isolated candidate

2026-09-30. **Local code only. No scope grants, API mutations, database changes, environment changes, or deployment.**

This is the next step after the existing creation worker reaches `draft_ready`. It does not adopt existing Shopify products. It includes the pure policy, one-call worker, GraphQL transport, concrete Supabase RPC bridge, default-off mode helper, and additive private SQL journal/finalizer. Server read/UI/scheduler integration and live acceptance remain open.

## Executable policy

`commerce-finalization.ts` validates a separately persisted merchant intent: positive selling price, shop currency, nullable compare-at price/barcode, explicit tax boolean, physical shipping, tracked inventory with `DENY`, `ACTIVE` / `publish_when_ready`, and an explicit available quantity including zero for every requested merchant-managed fulfillment location. Supplier facts cannot provide these values. Manufacturer net weight never becomes packaged shipping weight.

It requires the exact immutable `draft_ready` receipt, frozen pending revision, ready-proof SKU/manufacturer SKU/brand, custom ID (`toptikcoil.myshopify.com:gallery:<UUID>`), creation version, inactive Gallery row/source hash, independent copy, decoded ordered media fingerprint, fresh complete identity and location reads, and live owned creation **and** product leases. Held SKUs, existing approved identities, multi-variant products, duplicates, extra JSON properties, missing scopes, default-off and Preview all reject.

Minimal ordered steps:

1. Configure only the owned single variant's explicitly entered commerce if different.
2. Activate an explicitly selected location if needed. A missing level receives the stored merchant count; an existing inactive level omits both quantity arguments, preserving its stock.
3. Set differing available quantities with native `changeFromQuantity` CAS and a stable `@idempotent` UUID. This is an initial merchant-count command, never a recurring Gallery stock authority.
4. Opt in the exact variant to Online Store only if it was explicitly opted out.
5. Set the owned product `ACTIVE`, then publish to the fixed Online Store publication `79538258170`.
6. Independently read back every step. Only a complete successful sequence may emit the NEW-only finalizer payload.

`beginNextStep` returns `expectedVersion` and a started state containing the frozen exact request. Persist this by atomic SQL CAS **before** dispatch. A lost response or crash never resends a mutation: the next invocation only reads back. A matching result advances; a differing/partial result goes to review. A crash between durable start and dispatch can therefore require review even when nothing was sent. This deliberate stop avoids an unqualified retry.

After publication, stock can change through actual sales. Final binding captures current Shopify stock without restoring the initial merchant count. Gallery and Shopify copy baselines remain distinct. Existing82/frozen78 records, settings, outbox, descriptions, media, manufacturer specs, cost, packaged weight, customs and other channels are never mutation targets.

## Exact creation integration boundary

- Server loads `shopify_gallery_creation_intents` by the same UUID and exact `revision`; requires `frozen_at` and `record.input.commerce.storeIntent = publish_when_ready`.
- Server loads `shopify_gallery_creation_drafts` and the immutable successful `shopify_gallery_creation_events.patch.readbackProof`; requires stage `draft_ready`, exact receipt and `version`.
- `CreationProof.sourceIdentity` comes from the stored `ready_proof.draft`, **not a current client payload**. Commercial readback is the stored final configured snapshot. The receipt's commercial hash refers to its initial create response, which may differ; the policy preserves that distinction.
- Existing `claim_gallery_shopify_draft` acquires both leases. New persistence must recheck those owned leases, exact pending/merchant/creation revisions and `creation_assert_source` under the existing `toptik-gallery-copy-sync` lock before each transition.
- The new private commercial intent and journal are implemented in the additive SQL below: authenticated server stamps provenance; browser cannot submit receipts, snapshots, plans, context, hashes or authority. The hash is integrity/CAS metadata, not a signature or authorization mechanism.
- `finalize_gallery_shopify_public_creation` atomically inserts exact binding, independent copy state, immutable **new creation approval**, public link, and activates only its own new inactive Gallery row. A unique immutable finalization receipt supports exact no-op replay after a lost DB response; source/identity/leases are rechecked under the shared lock. It never calls the forward NEWONLY onboarding RPC or general catalog save.
- Recognize own in-flight product webhooks through creation custom ID/receipt and defer them until finalization; prevent duplicate forward onboarding. Preserve imported raw metadata privately. Once bound, normal copy/typed workers can use the actual per-side baselines.

The context and projection hashes must be assembled by a strict server adapter from complete bounded reads. Hashes must include raw protected data rather than a caller's assertion. Canonical object keys use deterministic code-point ordering. Hashes from this module and PostgreSQL `jsonb::text` are distinct formats and must not be compared implicitly.

## Current missing gates

1. Existing installed app lacks `write_inventory` (local read-only evidence: `../../outputs/toptik-inventory-capability-gap-20260930.md`). This policy always requires it even when a requested count already happens to match. Existing `write_products` and `write_publications` are also required. User/app permission to mutate inventory must be checked after an explicitly authorized scope update; no update was attempted here.
2. Accessible real location IDs, allowed merchant fulfillment locations, current level states and packaged-weight/shipping behavior are not yet established. No location or quantity is invented. Other inventory properties are protected by fingerprint; the policy does not set weight/customs/cost or fulfillment-service configuration.
3. No genuine new live candidate with merchant-confirmed price/currency/location quantities/tax intent has been selected. Synthetic tests do not authorize a test product in the store.
4. The SQL and RPC bridge are locally implemented and executed, but not migrated live. Authenticated normal editor inputs, concrete complete read adapter, in-flight webhook handling and scheduling remain required before activation. Publication defaults off independently of draft creation.
5. Native price/status/publication mutations have no version CAS argument. Owned app leases plus fresh full prewrite/readback detect observed changes; they cannot lock another Shopify app or a manual edit in the network gap. No all-fields atomicity or automatic rollback/delete is claimed. A conflict preserves the actual Shopify state for review.

## Official Shopify 2026-07 API evidence

Versioned URLs currently redirect to `latest`, whose header identifies **2026-07**. Input schema and release notes take precedence over stale example snippets.

- [InventoryQuantityInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryQuantityInput): current CAS field is `changeFromQuantity`. [2026-04 release notes](https://shopify.dev/release-notes/2026-04) remove the old compareQuantity/ignoreCompareQuantity names and document preserving inactive-level quantities when activation omits them.
- [inventorySetQuantities](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities), [inventoryActivate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryActivate), [idempotent requests](https://shopify.dev/docs/api/usage/idempotent-requests): inventory writes require `write_inventory`; these operations use the required stable idempotency directive. No request uses null to bypass CAS.
- [productVariantsBulkUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkUpdate) and [InventoryItemInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryItemInput): single-variant configuration, partial updates disabled; only explicit allowed commerce fields are sent.
- [productUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productUpdate) and [publishablePublish](https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishablePublish): status and publication are separate operations. Only the exact Online Store publication is requested.
- [2026-07 variant publication change](https://shopify.dev/changelog/posts/publish-and-unpublish-product-variants-independently-from-product): the same publishing mutation accepts ProductVariant IDs; variants default to published while product status/publication still controls visibility. The adapter must read variant opt-out state, not infer it solely from a hidden parent product.
- [InventoryItemMeasurement](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItemMeasurement): shipment weight describes the packaged item. Manufacturer product net weight is not equivalent.

## Local verification

Run from the project root (uses existing sibling dependencies; no install):

```powershell
node --test work/gallery-commerce-finalization-20260930/commerce-finalization.test.mjs
node work/gallery-commerce-finalization-20260930/typecheck.mjs
```

Initial policy gate: **26/26 offline tests and strict TypeScript passed**, with independent cold review and rerun. Follow-up guards explicitly require the frozen pending publication intent, preserve raw null Gallery descriptions, and accept actual stock changes only after the final publication step. No database execution or live checkout/public rendering was tested in this policy milestone.

## Added executable worker and transport

`commerce-worker.ts` now runs the state machine through narrow persistence/read/send ports. It performs **at most one external mutation per invocation**, saves and confirms started state before dispatch, requires a separate atomic owned/source dispatch assertion, and uses absolute deadlines (40 seconds total, final three seconds reserved for lease release). Port implementations must obey deadlines, including auth waits. Pending work has a read-only recovery path; there is no loop or blind network retry. Successful completion needs automatic bounded scheduling in integration.

`commerce-transport.ts` fixes the shop/API version, passes `retry:false`, and rejects malformed envelopes, GraphQL errors and userErrors without exposing provider messages. It consumes a full GraphQL envelope. The existing `shopifyAdminGraphql` returns already-validated **data**, so its bridge must wrap that result as `{data}` explicitly; passing bare data is not a compatible port. The worker sends only a request constructed by this policy, matched by the immutable SQL intent. Do not expose the transport as a browser GraphQL proxy.

`commerce-worker.test.mjs` uses actual temporary-file journal serialization between worker calls and a fake Shopify endpoint. It verifies rejected CAS, accepted-but-lost SQL start, accepted/rejected lost Shopify responses, frozen dispatch checks, lost finalizer response, bounded admission, and safe diagnostics. This demonstrates recovery logic; it is **not** a substitute for the separate actual PostgreSQL journal/RLS/atomic-finalizer verification reported below.

Run all isolated checks:

```powershell
node --test work/gallery-commerce-finalization-20260930/*.test.mjs
node work/gallery-commerce-finalization-20260930/typecheck.mjs
```

Current pure/runtime result: **43/43 tests; strict TypeScript passed.** Independent cold skim found no blocker in worker/transport ports scope. The isolated handoff originally left the root checkout untouched; these modules and the migration have now been integrated locally into the root candidate. No live writes or permission changes were attempted.

## Actual SQL and concrete persistence bridge

`20260930_gallery_commercial_finalization.sql` adds six private RLS tables. Service has SELECT only; narrow service-only RPCs perform writes. Anon/authenticated cannot read private state or execute these RPCs; service cannot execute helpers. Immutable intent history, stage history, per-index dispatch records and final receipts cannot be updated/deleted. No migration backfill, jobs, approvals, outbox writes or Shopify actions occur on migration application.

| RPC | Exact parameters / result |
|---|---|
| `save_gallery_creation_commerce` | `(p_intent jsonb, p_expected_revision text)` → exact canonical merchant intent. Null revision is a new save; exact replay does not overwrite merchant edits. Requires the own `draft_ready` source and frozen pending publication intent. |
| `reserve_gallery_commercial_finalization` | `(p_plan jsonb, p_state jsonb, p_owner uuid)` → StoredFinalization. Reconstructs minimal steps in SQL, checks hashes and actual immutable creation readback, freezes merchant record. |
| `claim_gallery_commercial_finalization` | `(p_id uuid,p_owner uuid,p_seconds integer default60)` → StoredFinalization or null if busy. Reuses the existing dual creation/product lease. Bound receipts are read-only replay. |
| `save_gallery_commercial_finalization` | `(p_id uuid,p_owner uuid,p_expected_version bigint,p_state jsonb,p_observed_at timestamptz default null)` → StoredFinalization. SQL reconstructs the exact native request and expected single-field/state delta. ACK requires a consumed dispatch record and fresh observed timestamp; review never permits a retry. |
| `dispatch_gallery_commercial_finalization` | `(p_id uuid,p_owner uuid,p_expected_version bigint)` → true exactly once per job/index; a second call rejects. Caller must treat a lost response as uncertain and never send. |
| `finalize_gallery_shopify_public_creation` | `(p_request jsonb,p_owner uuid)` → `{receiptId,productGid,variantGid}`. `p_request` is `buildFinalizerRequest(...).args`, including full `p_snapshot`. Copies baselines independently, admits only current stock changes after publication, adds a new immutable COPY-only approval and activates only its owned row. |
| `read_finalized_gallery_creation_items` | `(p_item_ids uuid[])` → `{finalizedItemIds:string[]}`. At most1000 unique nonnull IDs; empty input returns empty; exact completed receipt/plan/draft/current SKU uniqueness/binding/eligibility/activation joins. No copied product descriptions, prices or private proof returned. |

`commerce-database.ts` implements these persistence ports against an existing service-role Supabase client, with per-RPC maximum3s, original absolute deadlines, safe error codes and no automatic retry. `release` uses the unchanged `release_gallery_shopify_draft` RPC. `commerce-mode.ts` enables the worker only for **`VERCEL_ENV=production` and `SHOPIFY_GALLERY_PUBLISH_MODE=publish_verified_v1`**. Missing/other values are off. The SQL does not read deployment environment variables; authenticated server integration must enforce the feature gate.

The actual creation receipt identity is its **draft/Gallery UUID plus immutable creation version**: the existing table has no separate receipt UUID. Consequently `CreationProof.receiptId` is the Gallery UUID. The SQL derives its source from the current frozen pending record, stored ready proof and successful immutable creation event. `readbackCopyMediaFingerprint` is the canonical hash of `{copy: readbackProof.snapshot.copy, media: readbackProof.media with only verifiedAt removed from each}`. `galleryRowFingerprint` uses the existing SQL `creation_source_hash` representation; do not recompute it with JS JSON hashing.

### Required order and integration gate

1. Existing carousel schema/metadata/tech-spec/colors migrations; copy inbox → copy patch → verified catalog activation.
2. Existing draft creation → pending intents → source imports.
3. This commercial migration last, inside the operator's reviewed atomic deployment wrapper. No schema change was applied outside PGlite here.
4. Port policy/worker/transport/database/mode TypeScript modules, authenticated complete read adapter, normal editor save and scheduler. Read current granted scopes and location permissions; missing `write_inventory` stops before any request.
5. **Before any finalizer can activate a row:** update the existing private-draft catalog/import classification. The old code regards every retained creation receipt as private and rejects an active row. Use the new bounded classification RPC to exclude only exact completed IDs from that private set. Missing RPC may return no completed IDs solely for the exact missing-function error; permission/transient/malformed errors fail closed. Never delete the historical draft receipt. Root owns this integration change.

Completed IDs stay ordinary after legitimate title/copy edits or Gallery inactivation; current raw SKU drift, normalized duplicate SKU (including inactive rows), changed/missing binding or wrong immutable approval returns no completed ID. Existing approval `enabled` and present publication flags are not historical creation status.

### Actual-schema execution

```powershell
node work/gallery-commerce-finalization-20260930/verify-commercial-sql.mjs
```

This loads the actual root `e3b3e22` migration chain and pinned78 activation manifest into PGlite; **zero SQL functions are stubbed**. The old82 Gallery copy/identity records and actual78 bindings/baselines/approvals are seeded from the reviewed manifest; old angles/noncopy metadata are synthetic preservation fixtures, not a live database dump. It executes ordinary pending save→creation reservation→immutable draft receipt→merchant save→journal→exact finalizer, then the real TypeScript worker and concrete RPC bridge with mocked Shopify.

Author run: **219 checks passed** before the final two classification identity regressions. Independent cold reviewer executed the exact final SQL: **221 checks passed**, with no remaining blocker in the bounded CAS/ACL/one-shot/finalizer scope. Final SQL SHA-256: `6529b305e5256dc18b6d2d39780c87157a4a50dbb1c04c347ee8a8cc7d75994a`. Coverage includes ACL/RLS/helper grants, JSON hash parity, source/revision/lease changes, frozen merchant CAS, malformed/unknown fields, native request tampering, repeated dispatch refusal, fresh readback, initial save lost after commit, Shopify response lost after acceptance, finalizer rollback, forced outbox/wrong-binding triggers, raw-null baselines, preserved raw imported color/dimension/spec claims and supplier price (never used for sale price), post-publication sales and immutable receipt replay. All existing82/78 rows are checked for preservation. These checks do not establish live scopes, real inventory quantities, public rendering or physical mobile behavior.


## Root candidate integration

The five production modules now reside in `src/lib/shopify`; the migration is in `supabase/migrations`; 43 policy/worker tests and their helper are in `tests`. Run `node --test tests/commerce-finalization.test.mjs tests/commerce-worker.test.mjs` from the repository. The original isolated SQL harness and evidence remain in the task workspace under `work/gallery-commerce-finalization-20260930`. The catalog and import bridge now use the exact finalized-item classification RPC. None of this has been activated or published; complete real-source read adapters and automatic editor/scheduler wiring remain required.
