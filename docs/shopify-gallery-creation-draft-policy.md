# Gallery → Shopify: new private draft lane

Implemented locally on `c6b5ef0`; **not deployed or enabled**. Existing 78 approved products, copy queues, stock, publications, SEO visibility and public Gallery remain unchanged.

## Executable path

1. `POST /api/admin/shopify/drafts` with `{draft: GalleryCreationDraft}` validates the exact new item, rich HTML/text pair, merchant commerce, 1–10 real image URLs, allowed brand and explicit manufacturer/store SKU mapping. It atomically creates an **inactive** Gallery row, ordered angles and private durable intent via `reserve_gallery_shopify_draft`. Repeating the same UUID/source returns that intent; another UUID with the same normalized SKU is refused.
2. `schedule-creation.ts` starts a bounded worker after the response, with at most eight fixed-origin continuation wakeups. `PATCH` resumes the same UUID; `GET ?id=<uuid>` gives private status and Shopify IDs without source/commerce bodies.
3. `creation-runtime.ts` reads actual shop currency, installed app identity and its pre-existing unique PRODUCT `id` definition; scans all variant statuses and Gallery active/inactive rows; downloads and decodes exact image bytes. `creation-policy.ts` freezes source plus image identity. No supplier price, guessed inventory, generic image or manufacturer SKU substitution is accepted.
4. The SQL lease/source CAS records `create_started` **before** the only `productCreate` call. The mutation includes DRAFT status and app-owned custom ID `toptikcoil.myshopify.com:gallery:<UUID>` plus frozen source hash. No productSet/upsert, collections, inventory or publication mutation exists.
5. Initial response IDs, commercial values and version are recorded immutably. Before configuring only the returned default variant, a fresh read must match both product version and the initial commercial fingerprint. Known selling price/barcode/tax fields are applied; omitted fields retain their original values. The request is recorded as `variant_started` before sending.
6. A fresh exact readback checks copy, SKU, all commercial fields, unpublished DRAFT status, and ordered Shopify images against the frozen hashes. SQL stores that evidence atomically before `draft_ready`. Gallery remains inactive and unbound; no existing approval/baseline record changes.

## Activation boundary

- Requires `VERCEL_ENV=production` **and** `SHOPIFY_GALLERY_CREATE_MODE=draft_only`. Missing/off/Preview is refused before reservations or Shopify mutations.
- Apply the additive `20260930_gallery_shopify_draft_creation.sql` only after review. Applying schema alone does not ingest or create products.
- Requires actual installed app's `app--<app-id>--toptik_gallery.source_item_id` PRODUCT metafield definition, type `id`, uniqueness enabled. This implementation reads it and refuses absence; it never silently installs a definition or requests permissions.
- Uses existing server-side app credentials and service-role client. Every HTTP entry requires the existing admin token. No client receives secrets, private readiness evidence or GraphQL access.
- The existing Gallery editor is not rewired by this change. A future UI can submit the strict private draft contract; ordinary existing-item saves never create a product implicitly.

## Recovery and preservation

- A lost create response is reconciled by the custom ID; creation is **never resent** after a started/uncertain receipt. When the initial commercial response cannot be proved, the owned draft is placed under review rather than guessed or overwritten.
- A lost variant response is reconciled through actual readback; configure is not resent. A changed merchant price, tax flag or barcode is preserved, including when product `updatedAt` did not change.
- A replayed SQL acknowledgement is historical evidence, never authority for a second external send. Source/UUID/SKU reservations and immutable event records protect concurrent duplicate requests.
- Shopify product mutations do not offer general version CAS. The draft lease, fresh version/commercial comparison and unpublished scope reduce the external race; they are not a cross-system transaction.
- Image readiness uses exact frozen byte identity, not merely successful decoding. Shopify transformations that alter bytes remain under review in this conservative version. A later approved pixel-equivalence verifier is needed before treating transformed bytes as equivalent.
- Unknown price/tax/stock stay unknown. Draft creation does not prove sellability. Public activation, location-aware inventory and a binding/approval finalizer are separate and absent from this version.

## Verification

- Executable local fixtures cover full create/configure/readback flow, lost external/SQL responses, repeated requests, competing lease, source CAS, unchanged-version commerce edits, rich HTML/list formatting, SKU collisions, media drift and default-off routes.
- `scripts/verify-gallery-draft-creation-sql.mjs` executes PostgreSQL-compatible PGlite fixtures against the existing frozen 82 rows / 78 approvals. The harness verifies atomic rollback, immutable receipts, lease ownership, exact replay, source drift and private permissions.
- Official API shapes checked against Shopify Admin API 2026-07: `productByIdentifier`, `productCreate`, `productVariantsBulkUpdate`, `metafieldDefinitions` and `Product.resourcePublicationsCount`.
- **NOT TESTED:** real Shopify draft creation, real unique-metafield enforcement/atomicity, live image transformation, deployment, UI creation and public publication. Passing local fixtures is not live completion.