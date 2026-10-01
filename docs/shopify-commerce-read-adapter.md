# Commerce runtime and merchant editing

Status: implemented and verified locally; no migration, flag, scope, product, inventory or publication was changed by this work. Live roundtrip remains unverified.

## Owned new products

`CommercePublicationEditor({itemId?, token?})` and `/api/admin/shopify/commerce` expose authenticated status and explicit merchant repairs. The existing creation scheduler calls `dispatchCommercialPublication(itemId, hop, absoluteDeadline)` after `draft_ready`; this only accepts a separate fixed-origin worker request. The worker automatically uses the exact frozen pending `publish_when_ready` intent and its server actor. Missing price/tax/shipping facts remain incomplete. No supplier price inference.

`commerce-runtime.ts` reads private source through `read_gallery_commerce_source`, claims the creation/product leases, builds the immutable plan, and uses the existing durable one-shot SQL journal before each native request. Lost dispatch/provider responses become readback-only recovery. Finalization creates the exact new binding, independent copy baselines and approval atomically, then activates only the receipt-owned Gallery row. Existing 82/78 records are preserved.

Normal operation is **not inventory managed**: `tracked:false`, stock `[]`; no locations, levels or quantity reads/writes and no `write_inventory` requirement. The bounded reader marks those unqueried connections incomplete (`false`), not verified empty. Required grants are `write_products` and `write_publications`. The older explicitly selected inventory mode remains guarded and is not enabled by the merchant routes.

The reader pins store/API2026-07/publication/App namespace; decodes exact images and repeats its source reads. Configuration, owned product, catalog identities, publication, native commerce, copy and media must satisfy the strict policy. Counts/pages are bounded; malformed, partial, mixed or drifted identities fail closed. The exact server creation receipt and frozen pending revision are mandatory; browser proof is never accepted.

## Existing approved products

`CommerceExistingEditor({itemId,token?})` loads only after the merchant opens its button, avoiding 82 automatic API/Shopify reads. `/api/admin/shopify/commerce-edit` uses root's token/session authorization and verified server actor. Shopify remains the display source; no second Gallery price authority is created.

Allowed changes: price, nullable compare-price/barcode, tax and shipping booleans; status ACTIVE/DRAFT/ARCHIVED is a separate save. Every native request includes only changed fields. Tracking, inventory quantities/locations, copy, media and typed manufacturer facts cannot be patched by this path. The read adapter pins exact product/variant/SKU/handle against the enabled stored binding/approval, including explicit SKU aliases. Unmapped legacy items are held rather than attached implicitly.

`20261001_shopify_commerce_edits.sql` stores one pending command per product, guarded by the shared product lease and fresh observed snapshot hash. SQL reconstructs the exact request and consumes one dispatch. A repeated command ID only reads and reconciles; accepted-but-unconfirmed stage/dispatch/provider results never trigger another send. Immutable readback receipts record confirmed or review. Status confirmation changes only the matched purchase-link publication flags. The full Gallery editor must refresh before Save All after a status update; its independent root editor CAS prevents stale overwrite.

**Native Shopify variant/product mutations provide no expected-version CAS parameter.** There is one fresh preflight read before SQL stage+dispatch. A simultaneous Shopify-admin write after that read, including during those RPCs, can race. Minimal payloads avoid overwriting unrelated fields; postread checks detect conflicting results without compensating whole-product writes. Local SQL CAS/leases do not eliminate the external race.

Default-off gate for both paths: Production plus `SHOPIFY_GALLERY_PUBLISH_MODE=publish_verified_v1`. Separate draft creation authorization alone never publishes. Fixed-origin continuation has bounded hops/deadlines and no blind retry. No new service or scope is installed.

## Dependency and acceptance gates

Apply the actual creation/pending/source-import chain, then `20260930_gallery_commercial_finalization.sql`, then `20261001_shopify_commerce_edits.sql`. Service-only RPCs, private RLS and SELECT-only service table access are checked locally. Root owns deployment, migration application, flag activation, shared scheduler/admin integration and live acceptance. Merchant facts and a genuine receipt-owned draft are required for live creation proof.

Local checks:

- `node --test tests/commerce-*.test.mjs` (focused policy/read/runtime/scheduler/native edits).
- `node scripts/verify-commercial-finalization-sql.mjs`: 321 executed assertions using actual migrations and real worker/DB bridge, zero stubbed functions and external calls; no-inventory finalization and existing-bound lost-response recovery; existing catalog preservation.
- Scoped ESLint and TypeScript. Full shared-repository QA is root-owned.

## Read-only schema evidence and sources

Existing root artifacts: `outputs/commerce-read-schema-probe-20260930.json` (five queries validated on2026-07 at18:29:11Z) and `outputs/commerce-actual-read-probe-20260930.json` (configuration/product resolver valid at18:32:15Z). The actual canary lacks owned creation metadata and was not a finalization candidate. Locations/levels returned ACCESS_DENIED; normal noninventory mode does not request them. No permission change followed. The new existing-bound reader uses the same established fields; its live full-query acceptance is tracked separately by root.

Official Shopify references:

- [productVariantsBulkUpdate](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/productVariantsBulkUpdate): minimal native variant updates with `write_products`.
- [productUpdate](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/productUpdate): separate product status request.
- [publishablePublish](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/publishablePublish): publication is separate from ACTIVE status.
- [ProductVariant](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/ProductVariant), [InventoryItem](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/InventoryItem): native read fields; packaged weight/cost never become manufacturer net weight or merchant price evidence.
