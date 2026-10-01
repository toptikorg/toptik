# Gallery administration and synchronization — 1 October 2026

Release state: integrated candidate, **not yet verified in Production**. Production remains the separately verified PR28 purchase-link release until the release record says otherwise. This document supersedes older implementation-status paragraphs; retain historical evidence.

## Merchant workflow

- Open `https://admin.toptik.co.il/admin`. Use the existing administrator account. Session authorization uses the unchanged server role policy; background routes still require their existing server token. Passwords are entered by the account owner.
- Find an existing product by title or SKU. Title, rich description, SEO title/description, cover/angles and alt text are editable. The saved raw catalog, not public presentation repairs, is the edit source.
- Typed specifications and commercial fields open only on request, avoiding a burst of 82 Shopify reads. Commercial fields read the current exact Shopify variant.
- The obsolete translation button is removed: its API had already been retired under GAL-009. Rich and plain descriptions remain editable without calling a translation service.
- Save All commits catalog fields, settings, angles and the copy/media queues atomically. It requires the revisions the browser originally read. A stale tab gets a conflict instead of overwriting a later worker/merchant update; unsaved browser values remain available.
- Hiding a Gallery item retains its identity and history. Shopify publication status is a separate explicit control. A bound SKU is not casually reassigned to another item.
- New products use the normal creation form/import intent. `publish_when_ready` means the server completes draft creation, verifies the exact product/media/price and publishes it automatically. Incomplete or ambiguous identity stays private. It never guesses a price or creates a duplicate SKU.

## Field contract

| Data | Rule |
|---|---|
| Title, rich description, SEO | Existing field-level two-way merge. Compare each side with its independent baseline. Independent field edits combine. Same-field simultaneous copy edits use the existing timestamp policy (Shopify wins ties) and retain a private conflict audit. HTML and its display text are one field. |
| Typed manufacturer/merchant specifications | Explicit typed units and provenance. No parsing or mass replacement of legacy measurement strings. Existing values on the two sides become independent initial baselines. Conflicting same-field edits retain evidence for review. |
| Product pictures, alt, ordering | Exact identity plus decoded-image evidence. Match initial assets only with unambiguous byte identity; preserve unmatched initial assets independently. New changes use durable operations, immediate preflight and readback. A failed request is not a deletion. |
| Image removal | Requires authenticated editor intent or signed Shopify delivery. Detach this product reference only; never delete a shared global file. Protect the last target image. |
| Price, compare-at price, barcode, tax, shipping, status | Shopify is the stored commerce record; the Gallery panel edits that exact variant directly, with an immutable command, fresh preflight, changed fields only and readback. No second manual update. |
| Inventory | Outside scope. No invented quantities, inventory scope expansion, location setup or stock gate. New approved products use untracked inventory; existing tracking is preserved. |
| IDs and identity | Shopify product/variant IDs, Gallery UUID and exact SKU/approved mapping must agree. Similar titles, punctuation assumptions or color guesses cannot join products. |

## Failure and concurrency rules

1. Save catalog data and queues together; a mid-save database exception rolls the transaction back.
2. Workers share the existing per-product lease. Persistent command/phase journals distinguish not-sent, sent/uncertain, and verified states.
3. After a lost response, read the destination before retry. Do not resend a non-idempotent creation, upload, publish or commercial command blindly.
4. Advance baselines only after exact destination readback. A local test, HTTP acceptance or Preview does not prove synchronization.
5. Bootstrap only identities already admitted by exact approved copy/creation evidence. It makes independent baselines without initial cross-writes. Explicitly disabled identities remain disabled.
6. Shopify native product/variant mutations do not offer universal remote version CAS. Minimal field writes, fresh preflight, owned local leases and post-write conflict detection reduce risk; they do not eliminate a simultaneous native-Admin edit in the final remote race window.

## Release gates and recovery

- Preserve the exact current catalog backup and additive SQL hashes. Apply only reviewed migrations through the legitimate SQL editor; no blanket migration replay.
- Deploy with new lanes disabled, verify the Production SHA and public purchase flow, then enable and prove each lane with an exact product and real readback. Keep unrelated product hashes stable.
- Existing copy sync must continue working. No new orders, payments, email or inventory operations are required for these checks.
- On a new-lane failure disable only that flag; retain journals and uncertain-operation receipts. Application rollback does not undo Shopify changes.
- The release record must separately report admin access, copy both ways, typed values/clears both ways, media both ways, commerce, new-product publication, public product link and Back. Unperformed checks remain NOT TESTED.

## Flags (Production only)

- `SHOPIFY_TYPED_SPEC_SYNC=enabled_v1`
- `SHOPIFY_MEDIA_SYNC=enabled_v1`
- `SHOPIFY_GALLERY_CREATE_MODE=draft_only`
- `SHOPIFY_GALLERY_PUBLISH_MODE=publish_verified_v1`
- `SHOPIFY_TYPED_SPEC_CLEAR_CONSUMER=typed-spec-clear-aware-v2` — only after the matching MAIN theme consumer is verified on a live product page.

The create flag enables the draft stage. The separate publish flag enables the verified finalization stage; both are needed for automatic public creation. Preview must not dispatch live writes even if it reads the shared catalog.

Initialize and verify independent baselines for all admitted identities before announcing automatic synchronization. An edit made before initial capture is starting state, not evidence of propagation. Typed clear markers match the current displayed value; Liquid cannot distinguish a later edit returning to the identical prior value without the backend reconciling the marker. Do not claim a universal remote revision lock.
