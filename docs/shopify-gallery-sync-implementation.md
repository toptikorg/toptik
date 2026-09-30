# Shopify ↔ Gallery visible-copy synchronization

**Status:** implementation candidate in the Draft PR branch; not active and not production-verified. The code now targets automatic synchronization of customer-visible product title, description, SEO title, and SEO description in both directions. The Shopify app, webhook subscriptions, secrets, database migration, and an isolated test shop/project are not available in this worktree, so this is not yet a live integration.

## Field ownership and merge contract

| Data | Authority and behavior |
|---|---|
| Product title, visible description, SEO title, SEO description | Bidirectional, field-by-field merge. A one-sided edit propagates automatically to the other system. |
| Price, currency, inventory, sale status, variant/SKU identity, handle, publication | Shopify remains authoritative. This integration never writes these fields from Gallery. |
| Manufacturer specs, Gallery images/angles, brand/category/filter state, display order | Gallery/manufacturer workflow remains authoritative; not copied to Shopify by this copy-sync path. |

Merge behavior — field-by-field, with no silent data loss:

1. The sync unit is exactly one unique Gallery SKU row ↔ one Shopify product. The Gallery SKU must match exactly after whitespace/punctuation normalization and the already verified optional Mandarina Duck `-TU` suffix rule. No fuzzy title, color, image, handle, or partial-SKU matching is allowed. Missing, duplicate, changed, or many-to-one identities are quarantined; no copy is written until identity is unambiguous.
2. For each bound product, compare `title`, normalized customer description, `seoTitle`, and `seoDescription` separately against the last successfully agreed snapshot. A change in one field never grants permission to replace another field. `null` and empty SEO text are treated as an intentional empty value after binding; clearing a field propagates as a clear. A missing field in an older Gallery client payload means “not supplied” and preserves the stored value; it is not a clear operation.
3. Initial binding has no trustworthy last-agreed baseline. If one side alone has a non-empty value, copy that value to the empty side. If both sides already contain different non-empty values for the same field, preserve both, write a private `winner=review` conflict record, and hold that product in the review queue. Do not choose a historical winner based on a whole-record timestamp. Equal values establish the baseline directly. This protects existing copy during bootstrap.
4. After baseline: if only Gallery changed a field, Gallery wins that field; if only Shopify changed it, Shopify wins. If both changed the same field since baseline, compare Gallery `copy_updated_at` with Shopify product `updatedAt`; the later timestamp wins that field, and both source values plus timestamps and decision are written to the private deduplicated conflict audit. Exact ties, invalid timestamps, or missing timestamps resolve deterministically to Shopify and are audited. This is automatic for ordinary edits; only identity/initial-value ambiguity is held for review.
5. Timestamp caveat: Shopify exposes a product-level `updatedAt`, not a timestamp per copy field. An unrelated Shopify product edit can advance it. Therefore this rule is deterministic and protects non-overlapping edits, but simultaneous same-field edits have best-available—not perfect—ordering. We never claim true chronological last-writer-wins. Shopify wins ties/unknown ordering, and both versions remain in the audit.
6. A Gallery-originated write re-reads Shopify immediately before mutation and re-runs the merge if the snapshot changed. If another write still makes the candidate unsafe, stop and retry/review rather than overwrite. Shopify `productUpdate` has no atomic compare-and-swap token, so a very narrow third-party edit race remains between the final read and mutation; that limitation is explicit.
7. Shopify rich description HTML is rendered as safe readable plain text in the current Gallery editor. If Shopify is the winning source, its original HTML is left untouched in Shopify. If a Gallery user later edits that description, the Gallery plain-text paragraphs become Shopify paragraph HTML; original rich formatting, links, or embedded layout cannot be round-tripped by the current editor. Do not claim byte-for-byte rich-text sync. If preserving that formatting is required, the editor must gain a safe rich-text representation before activation.
8. Webhooks are signed, deduplicated triggers—not ordered truth. Every worker fetches the latest Shopify snapshot and reads the latest Gallery row; stale/replayed/out-of-order queue bodies never become content. Idempotent hashes avoid echo loops. Transient API/database errors retry with bounded attempts; permanent/identity/validation/readback conflicts stop in a private review/failure queue and never silently drop the source values.
9. Before and after every write, validate exact product/variant/SKU binding and allowed field set. Shopify writes are restricted to product `title`, `descriptionHtml`, and `seo.title/description`. Gallery writes are restricted to those four copy columns. Price, currency, inventory, availability/status, variant/SKU, handle, media, publication, manufacturer specs, filter/category, display order, and product existence are outside this contract and are never overwritten by this sync.
10. A Shopify deletion/unpublish deactivates only the verified Gallery purchase binding; it does not delete a Gallery row or its copy. A Shopify product that disappears, an image failure, or a missing variant never creates a blank public card. Shopify product creation does not automatically create a public Gallery item because an exact SKU alone cannot verify image, manufacturer data, category, or moderation state.
11. A stale Gallery admin save is rejected against `copy_updated_at`; reload is required before saving. Repeated saves and webhook retries are idempotent. A failed queue insert after a Gallery save is detected on a subsequent save/worker reconciliation; queue exhaustion and permanent failure remain visible to authenticated admins.
12. “Automatic” means normal, unambiguous edits propagate without double entry after setup. Initial conflicting copies, uncertain identity, many-to-one product mappings, unsupported rich formatting, exhausted retries, or concurrent write races are explicit exceptions: the system preserves source values and holds the affected item instead of guessing or overwriting.

The four synchronized fields cover the customer-visible store copy and product SEO snippet requested here. The protocol does not promise byte-for-byte HTML formatting preservation; Shopify rich-text HTML is converted to readable plain text in the Gallery editor and emitted back as safe paragraph HTML.

## Candidate implementation

- Signed `/api/webhooks/shopify/products` endpoint validates the raw-body HMAC, expected shop, allowed topic, bounded body, and unique delivery ID before storing a private inbox row.
- Exact SKU reconciliation updates private bindings and the small public product-link projection only. Unpublished handles and variant IDs are scrubbed from that public projection.
- Gallery admin now carries separate SEO title/description fields and queues actual visible-copy edits. Shopify Admin GraphQL updates only product `title`, `descriptionHtml`, and `seo`; it does not update price, inventory, variants, handle, media, status, or publication.
- Shopify product-update events fetch and reconcile the latest visible copy back into the Gallery.
- Shopify webhook and Gallery-save responses schedule the worker immediately. A daily guarded Vercel cron is a recovery sweep; it does nothing useful until the migration and required Shopify secrets/subscriptions are installed.
- Private conflict audit, retry queues, bounded status endpoint, stale-claim handling, idempotent content hashes, and public-link projection are in the candidate migration/code.
- If the content outbox insert fails after the Gallery database save, a later Save All rechecks binding/state drift and re-enqueues the unsynchronized content. If the sync migration is absent, existing Gallery saves retain legacy fallbacks but no Shopify sync is active.

## Not covered by this implementation

- Automatic creation of a new Gallery item for every new Shopify product. A verified matching image, manufacturer data, brand/category, and moderation/publication state are still required before a new product can appear publicly.
- Bidirectional price/inventory sync. Shopify remains their source of truth; the Gallery currently links to the exact live Shopify product/variant.
- Per-variant SEO/title fields. Shopify exposes the product title/description/SEO at product level. Products with multiple Gallery rows must not use each row as a separate writer; those mappings are held from copy sync.
- In-app conflict editing UI. Normal and same-field concurrent edits resolve automatically; private audit rows retain the losing value. Operational status is available to authenticated admin only.
- A conflict-resolution action/UI for `winner=review` bootstrap mismatches. The sync now safely pauses these products and retains both values, but an authorized operator flow to choose/merge a baseline must exist before activating sync against a catalog that contains such mismatches.
- Live end-to-end verification. No Shopify custom app/token/webhook secret, applied migration, or isolated dev store + Supabase project was available. No real Shopify write was attempted.

## Required setup and release gates

### One-product production canary gate

- The first live activation must set SHOPIFY_SYNC_CANARY_SKU to exactly one verified SKU. Missing, malformed, comma-separated, or semicolon-separated values disable the worker; no broad allowlist is accepted.
- Webhook reconciliation and Gallery outbox writes are restricted to that normalized exact SKU. Other product events are acknowledged without catalog writes. Delete events for the canary are held for review and never deactivate it during the canary.
- The bootstrap endpoint accepts one Shopify product ID, reads that product, verifies exactly one variant has the configured canary SKU, and queues only that product. It never scans or queues the whole Shopify catalog.
- Keep the SKU canary active through both directions and live readback. Only after the one-SKU round-trip passes should a separately reviewed rollout change expand the eligible catalog.
- The canary gate limits which product the worker can mutate; it does not replace correct Shopify app scopes, signed webhooks, server-side secrets, or Supabase protections.

1. Install a first-party Shopify custom app with only the read/write product scopes needed for product snapshots and product-copy mutation. Keep tokens server-side as Vercel Secrets.
2. Configure the expected `*.myshopify.com` domain, Admin API token, `SHOPIFY_WEBHOOK_SECRET`, Online Store publication GID, and API version. Never log or document secret values.
3. Apply the candidate migration in an isolated Supabase project first; verify RLS/grants, RPC claim behavior, conflict deduplication, copy version checks, and the public projection with anon/authenticated/service-role roles.
4. Register signed Shopify webhooks for product create/update/delete. Confirm actual webhook payloads and Shopify SEO fields are available from the Admin API snapshot.
5. Seed existing catalog bindings in a controlled bootstrap, then test single and multiple variants/products, exact SKU normalization, duplicate/missing/unmatched SKU, initial copy adoption, blank SEO values, edits in both directions, disjoint edits, simultaneous same-field changes, timestamp ties, stale/reordered webhook deliveries, deletion/unpublish, HTML entities/formatting, Shopify throttling, worker retries, stale admin save rejection, and read-back.
6. Verify customer-facing Shopify pages and Gallery items live after each round trip, and confirm protected commerce fields do not change. Test rollback and re-run/idempotency.
7. Only then prepare a separate Production activation and rollback plan. Production stays unchanged until all isolated tests pass and the rollout is explicitly approved.

Official API references: [Shopify `productUpdate`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productUpdate), [Shopify webhooks](https://shopify.dev/docs/apps/build/webhooks), and [webhook subscriptions](https://shopify.dev/docs/apps/build/webhooks/subscribe).
