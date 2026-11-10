# Staged Gallery review of a new image for an ordinary product

Status, 10 November 2026: **local implementation, uncommitted, not reviewed, not deployed.** It adds no
business-data migration. It makes no Shopify write, no Gallery catalog write and no live call; nothing in the queue, the
worker, the themes or the shared multi-color products (FZT73, QMMM1/MD20) is touched. Everything below is covered
by local tests against the production code with in-memory storage and database fakes. What is *not* proven is
listed under "Not proven here".

## The gap

An administrator can upload an image in the Gallery editor, but the catalog save refuses every new or changed
image address unless a signed review exists for exactly that card, SKU, variant and address
(`assertReviewedCatalogSave`). The only signed review that existed is the native Shopify review
(`MediaReviewRecord`, `reviewed-media-record.ts`). By design it accepts only an image that is already in Shopify
(a `cdn.shopify.com` address and an existing `MediaImage` id). An image that exists only in the Gallery could
therefore never be approved, so an ordinary product could not get a new image from the Gallery at all.

This adds a second, separate kind of receipt for exactly that case. The native review, its schema, its signing
domain and its tests are unchanged and stay strict.

## What the merchant does

1. Uploads the image as before. The status line now says it must be confirmed in the product card.
2. A framed panel appears in that product card for every new upload: the enlarged image, the title, the SKU, a
   checkbox ("I checked the image by eye: this is the model and color of this product, not another") and an
   optional note.
3. Ticking the box enables the confirm button. The server checks the card, copies the image to its permanent place
   and signs a receipt (below). On success the panel disappears and the upload address in the form is replaced by
   the confirmed copy, in the same place on the same card. Nothing else in the form changes.
4. Saves as usual. While any new upload of an ordinary product is unconfirmed, "save all" stops before sending
   anything and says why. A confirmation counts as a pending upload while it runs, so saving, reloading and
   importing wait for it, and a result that arrives after a reload is discarded.

Shared multi-color products keep their own media editor and their own refusal; the panel is never shown for them.

## What the server does

`POST /api/admin/shopify/media/staged-review` (`staged-review/route.ts`):

1. Same gate as the native review route: `authorizeGalleryAdmin(req, { sessionMutation: true })`. A browser session
   needs a verified owner/admin role, same origin and JSON. The automation token keeps working. Nothing runs
   before this.
2. The body is at most 4096 bytes with exactly these keys: `itemId`, `uploadUrl`, `reviewedExactSkuColor: true`,
   `reviewedCatalogNumber`, `expectedRevision`, and an optional note. No product, variant or SKU identity is ever
   taken from the request.
3. The identity comes from the approved binding: exactly one enabled `shopify_gallery_copy_eligibility` row for
   that card, validated by `assertVerifiedCopyApproval`. No row, several rows, or a disabled row means
   `STAGED_MEDIA_NOT_ELIGIBLE`.
4. The Gallery catalog must still agree with the binding (same card, same SKU, same Shopify variant), and what the
   administrator was looking at must be what is signed: `reviewedCatalogNumber` must equal the approved SKU and
   `expectedRevision` must equal the card's current `editorRevision`. Otherwise `STAGED_MEDIA_IDENTITY_CHANGED` or
   `STAGED_MEDIA_STALE_ITEM`, before any store read or copy. The editor sends the SKU and version of the *saved*
   card, not of unsaved local edits.
5. Shopify must still describe exactly that product and variant (`fetchShopifyMediaRead`, read only).
6. `stageReviewedGalleryUpload`: only an upload made by the editor for exactly this card is accepted (the address
   `.../carousel-media/items/<card>/(cover|angles)/<uuid>.<ext>` on the project's storage host, no query,
   fragment, port, credentials or percent-encoding). The bytes are fetched and fully decoded; only JPEG, PNG and
   WebP are staged and the type comes from the decoded bytes, never from the file name; the deny list is checked by
   address and by SHA-256; the bytes are copied **without overwrite** to `sync-staged/<card>/<sha256>.<ext>` and
   read back (SHA-256, size, type, width, height must all equal the original); only then is the receipt stored.
7. Only safe error codes (`STAGED_MEDIA_*`, `MEDIA_*`) reach the browser; the editor shows a specific Hebrew
   message for each.

Why `sync-staged/` and not the runtime's `sync-media/`: the SQL transport functions pin the transport's own staged
source to `sync-media/<card>/<sha>` (the `stagedSourceUrl` and `storagePath` checks in
`20260930_media_transport_substeps.sql` and the later storage-repair migrations). A different prefix keeps this
approval from being mistaken for, or colliding with, that copy, and the content-addressed name makes the copy
self-checking.

### Storage policy replay continuity

The fresh live inspection on 10 November found `storage.objects` RLS enabled, public SELECT only for this
bucket, and no RLS bypass or service-role membership for `anon` or `authenticated`. No current live browser-write
vulnerability was observed. Migration `20261110062842_staged_media_service_only_writes.sql` only reconciles
historical migration replay by dropping the three exact `carousel_media_auth_insert/update/delete` policies.
It aborts if object RLS is disabled and preserves buckets, public reads, grants and unrelated policies. Writes
continue through the existing server/service role. Isolated PGlite tests exercise actual SQL role permissions
on both `items/` and `sync-staged/`; they do not claim to test the live Storage upload API.

## The receipt

`staged-media-review-record.ts`: version 1, kind `staged_gallery_upload`, with the identity, the approval id, the
upload path, the staged path and address, the SHA-256, type, size, width, height, the note, the reviewing
administrator and time, and `reviewedExactSkuColor: true`. Every field is checked with an exact key set, including
that the staged path and address are the ones derived from the card, SHA-256 and type.

- Signed with HMAC-SHA256 under the service-role key, domain string `toptik:staged-gallery-media-review:v1\n`.
  The native review uses a different domain, so a record of one kind can never verify as the other.
- Stored in the existing private bucket `toptik-media-reviews` under `staged-v1/<card>/<hash>.json`, uploaded
  without upsert and read back. The path hash covers identity, address and SHA-256, so confirming the same bytes
  again for the same card is an idempotent replay that keeps the first receipt. A public or unreadable bucket, a
  wrong signature, a foreign file or a record under the wrong card stops the load; nothing is skipped silently.
- `loadReviewedMedia` and `loadReviewedMediaForItems` return the native entries plus the staged entries of that
  card. An entry carries `decodedSha256`, so the existing guards approve only those exact bytes.

## Where the receipt is honored

Through the existing guards, unchanged, because the entry has the same shape:

- `assertReviewedCatalogSave` (catalog save): approves the staged address only for its own card id, SKU and
  variant, and re-reads the bytes of every changed address before the revision-checked save.
- `isReviewedMedia`, `isReviewedMediaProof`, `exactGalleryCopySource`, `assertReviewedMediaOperation` (media
  planning and queued steps): a Gallery proof of the staged image is reviewed by the receipt; a proof for any other
  bytes, any other card or any other variant is not.
- `assertNotDeniedMedia`: the deny list still wins over a receipt.

## What is not changed

- No Shopify write. The image reaches Shopify only through the normal media sync after the catalog save, under the
  existing planner, transport and review checks.
- The catalog save, its per-card `editorRevision` check and the settings revision are unchanged. The receipt is
  deliberately **not** bound to a revision: it states "these bytes are this product", while the save's own revision
  check protects the card from concurrent edits. The version is checked when the confirmation is requested, and
  again, unchanged, when the card is saved.
- No new business-data table or change to `group-media-*`, `owned-media-*`, the worker or the themes.
- Review items are not marked approved by this code, and no existing review is changed.

## Rules and the tests that hold them

| Rule | Tests |
| --- | --- |
| Only the editor's own upload of this card is a source; look-alikes never reach the network | `staged-media-review-record` (upload path), `staged-media-upload` (first test) |
| Identity is derived on the server from the enabled binding; the request cannot supply it | `staged-media-review-route` (binding, identity derivation, malformed requests) |
| The confirmation is bound to the SKU on screen and the loaded card version | `staged-media-review-route` (SKU and version test), `staged-upload-editor` (request and handler tests), `admin-editor-changed-only` (staged ii, iii) |
| Permissions: unauthenticated and non-admin requests touch nothing | `staged-media-review-route` (first test) |
| Copy never overwrites, is read back byte for byte, and a failed readback stores no receipt | `staged-media-upload` (copy, readback, reuse, storage-failure tests) |
| Byte replacement: a receipt approves only the bytes it names; the deny list wins | `staged-media-review-record` (changed bytes, deny list), `staged-media-review-store` (stored receipt conflicts) |
| Reuse: confirming the same bytes again is a replay, never a second or different receipt | `staged-media-review-store` (replay), `staged-media-review-record` (path determinism) |
| Wrong association: another card, SKU, variant or address is not approved | `staged-media-review-record` (catalog save, runtime lineage), `staged-media-review-store` (other identity) |
| The native review stays strict and its signature cannot verify as a staged receipt (and the reverse) | `staged-media-review-record` (domain separation, native schema) |
| An unconfirmed upload never reaches a request; a stale card is still refused by its revision check | `admin-editor-changed-only` (staged i to iv), `staged-upload-editor` (page wiring) |
| A late or failed confirmation never changes the form | `staged-upload-editor` (handler tests) |

## Not proven here

- **Production canary.** No live call of this new route has been made. A local roundtrip now exercises the real
  signed store/guard, planner, CAS provenance, immutable copier, runtime assembly, Shopify transport/recovery and
  final readback using fake DNS, HTTP, GraphQL and RPC I/O. The approved `sync-staged/` source is copied into
  `sync-media/` before native creation. A lost reply recovers without another create. This does not prove actual
  production Storage/Shopify behavior; one reversible ordinary-product canary remains required.
- **Browser scope.** The actual component and admin stylesheet were reviewed in an isolated IAB fixture at measured
  391x844 and1440x1000 CSS viewports, with a local placeholder image and synthetic callbacks. Image loading, no
  horizontal overflow, checkbox enablement, busy/success/error states, missing-version/disabled guards and
  preservation of a separate draft were observed. Keyboard interaction passed. Pointer actions under IAB mobile
  emulation did not activate the control, so real mobile touch is not claimed. No connected Preview or production
  editor save, live upload-address display or Safari/WebKit test is claimed by that fixture.
- **Viewing-to-copy integrity.** Live read-only policy checks at06:21/06:22UTC on10November2026 verified that
  storage.objects has RLS enabled and only the public SELECT policy. anon/authenticated are neither superusers nor
  BYPASSRLS nor members of service_role. The historical authenticated write policies are absent in production.
  All current app writes use service-role server paths with no overwrite. The included replay migration removes
  exactly those three historical policies in environments built from older migrations, preserving reads,
  grants, buckets and unrelated policies. It is not a claim of a current live vulnerability. Privileged service
  writes remain trusted; later workers still recheck the signed SHA before any native mutation.
- An upload whose file name has no ordinary extension (the upload route keeps whatever follows the last dot) is not
  recognized as an editor upload, gets no panel, and is refused at save exactly as before.
- Products without an enabled copy binding cannot be confirmed (`STAGED_MEDIA_NOT_ELIGIBLE`); the save is refused
  for them exactly as before.

## Checks

Integration base: master50b68bfff8fe2440345cfbce6c0409acebe61908 afterPR203. Independent cold review passed, including
76 focused tests and12 real authorization-gate cases with local requests. Three additional worker roundtrip tests
cover actual protocol functions, forged evidence and lost replies. Storage replay tests use native PostgreSQL
roles and RLS. These remain separate from production acceptance. Screenshots and evidence are in the root work
and outputs directories; the canonical Google Master remains the project authority.

```bash
node --test tests/staged-media-review-record.test.mjs tests/staged-media-review-store.test.mjs tests/staged-media-upload.test.mjs tests/staged-media-review-route.test.mjs tests/staged-upload-editor.test.mjs tests/admin-editor-changed-only.test.mjs
npm test
npx tsc --noEmit
npx eslint src tests/helpers
```
