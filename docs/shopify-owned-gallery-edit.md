# Gallery edits of Shopify-owned color products (FZT73, QMMM1)

Status, 9 November 2026: **local implementation, not released.** Everything below is covered by local
tests against the production projection code and an emulation of the private SQL guards. No migration is
needed, nothing was deployed and no live Shopify write has been made. The release and canary steps at the
end need the owner's explicit approval.

## What is supported

FZT73 (four colors) and QMMM1/MD20 (three colors) are one Shopify product each, shown as one Gallery card
per color. Their cards are projections of the Shopify product. From a color card the merchant can now edit,
and the edit reaches the store:

| Edit on a card | What changes in Shopify | Who sees it |
| --- | --- | --- |
| Title | Product title (FZT73 cards carry the title plus ` בצבע <color>`; that suffix is kept) | All colors |
| Description (rich editor) | Product description HTML | All colors |
| SEO title / SEO description | Product SEO fields (the card shows them with the color suffix; see limits) | All colors |
| Image description (alt text), including the cover | Alt text of that exact image | That color only |

Not supported from the Gallery, and shown as such in the editor: adding, removing, replacing or reordering
images, catalog number, hiding or showing a color. Those stay in Shopify. See "Why images are not included".

## Flow

`POST /api/admin/shopify/owned/edit` (admin token), implemented by `applyOwnedGalleryEdit`:

1. Take the same product reconciliation lease the webhook worker uses. Busy means 409, nothing happens.
2. Refuse a stale form: the card version (`copy_updated_at`, `editor_revision`) must be the one the editor loaded.
3. Rebuild every color from the current Shopify product first. This proves the projection can follow
   (baselines exist, no unresolved legacy outbox row, no hidden Gallery edit) before anything is written. A Shopify
   change the editor never saw moves the card version, so the form is stale and must be reloaded: an edit is never
   merged blindly into newer store content.
4. Plan against the live product (`planOwnedEdit`, pure). Each edited field must still show in Shopify exactly what the
   editor loaded, otherwise `SYNC_OWNED_COPY_CONFLICT`. A value Shopify already holds is not written again.
5. Read Shopify again immediately before writing; stop if it moved (Shopify has no compare-and-swap).
6. Write: image alt text first, then product copy. A failure after the first write is reported as partial.
7. Read back, then rebuild every color from Shopify with the existing projection. The cards change only now,
   after Shopify accepted the edit, so a refused or conflicting edit leaves the Gallery exactly as it was and no
   unsent Gallery edit exists for the projection to trip over.

The Gallery catalog-wide save keeps rejecting owned-card changes (`repository-admin.ts`, unchanged), and the editor
now refuses to send a pending owned edit through it instead of dropping it silently.

## Safety rules enforced in `owned-edit-plan.ts`

- A card value is written back only if it can be projected forward to exactly the same text. The color suffix,
  the 160-character SEO description window and the QMMM1 alt token (` | SKU | n`) cannot be approximated.
- A SEO description is not replaced when the card hides sentences that Shopify has (the card window is 160 characters);
  that would silently delete store text.
- Every color must still project after the change, not only the edited one. A SEO title that fits the black card but is
  too long for the longest color name is refused, otherwise the whole family would stop syncing afterwards.
- The cover alt text and the first image's alt text are the same Shopify field; two different values are refused.
- Titles are refused if empty, padded, longer than 120 characters or containing control characters; the same limits
  the source reader already enforces.
- Descriptions go through `assertSafeDescriptionHtml` and must be an exact HTML/text pair.

## Why images are not included yet

Image identity is not stored in a way that allows add, remove or reorder safely:

- FZT73 maps images to colors by a fixed list of Shopify media IDs and URLs, duplicated in
  `variant-source-policy.ts` and in `apply_fzt73_owned_projection` (SQL). Any image added, removed or moved makes
  both reject the projection on purpose.
- QMMM1 maps by the ` | SKU | n` token in each image's alt text, and rejects media it cannot assign.
- The generic media pipeline (`media-*.ts`) is documented as not activated and as single-variant only.

Supporting add/remove/reorder therefore needs a design decision and a migration (a data-driven image map replacing the
fixed FZT73 lists, with the same exact-identity checks), plus the Shopify create/attach/detach/reorder transport with
lost-response recovery, and a canary on a non-live product. This change does not attempt it.

## Limits worth knowing

- One Shopify product, so a title, description or SEO edit on one color changes every color. The editor says so.
- Shopify rewrites some HTML on save. Readback therefore compares descriptions with the existing equivalence rules,
  and the cards then show Shopify's version.
- `fileUpdate` changes alt text on the file itself. These products' images are dedicated product uploads; the call
  never changes a file's source, filename, product reference or order. A file shared with another product would show the new
  alt text there as well.
- The route can take up to about a minute (several Shopify reads, up to 15 image checks). The lease is held meanwhile.
- If Shopify accepts the edit but the cards cannot be rebuilt, the answer is `SYNC_OWNED_EDIT_DELIVERED_PROJECTION_PENDING`;
  the webhook Shopify sends for the edit rebuilds them. A partial result is `SYNC_OWNED_EDIT_PARTIAL`.

## Release and canary (needs explicit approval)

No DDL. Code deploy only, after CI, `npm test`, `npm run lint`, `npm run build`.

1. Confirm production state first: the adoption `prepare` endpoints show each color's baseline and any unresolved outbox
   row. The preflight rebuild in step 3 refuses to write while any exist.
2. Canary on one color, reversible, with the owner present: change one image alt text, wait for the cards, restore the
   original. Then one description edit on FZT73 and the same on QMMM1, each restored after readback. Record the Shopify
   `updatedAt`, the card versions and the private baseline before and after.
3. Only then announce the feature as live. Until the canary passes, treat it as unverified on production.

Rollback: revert the application commit through the normal path. No schema or data was added. Edits already delivered
stay in Shopify, which is the source of truth for these products; restore any of them by editing again.
