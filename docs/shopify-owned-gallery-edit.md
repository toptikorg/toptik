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
| Image description (alt text), including the cover | Global file alt text of that exact image | This card and any other product sharing the same file |

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
6. Write image alt text first. Before the copy mutation, read again and compare against the earlier source,
   allowing only our exact ALT changes and Shopify's matching `image.altText` mirrors. An independent copy,
   media or identity change stops the second mutation. Product copy sends changed fields only. Both transports
   have the same deadline, including a check after token acquisition; no new mutation starts after it expires.
7. Mark each mutation as attempted before waiting for its response. A first `fileUpdate` can partly apply, and a
   lost response can hide a completed mutation. Always attempt source readback and a Gallery rebuild within the
   remaining budget, without blindly resending. A success requires verified source values and a matching rebuilt
   card; a fully delivered lost-response request may therefore recover successfully. Otherwise return partial,
   uncertain, readback mismatch, or verified delivery with projection pending, preserving the editor's local work.

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
- QMMM1 permits exactly one technical marker in an edited ALT, retaining the same SKU, order and exact suffix
  at the end, including the live ` | SKU | תמונה n` spelling and the older numeric-only spelling.
  A foreign or repeated marker is refused even if it has no numeric order, because the source reader also
  recognizes SKU markers by substring when assigning media to colors.
- Titles are refused if empty, padded, longer than 120 characters or containing control characters; the same limits
  the source reader already enforces.
- Descriptions go through `assertSafeDescriptionHtml` and must be an exact HTML/text pair.

## Why images are not included yet

Image identity is not stored in a way that allows add, remove or reorder safely:

- FZT73 maps images to colors by a fixed list of Shopify media IDs and URLs, duplicated in
  `variant-source-policy.ts` and in `apply_fzt73_owned_projection` (SQL). Any image added, removed or moved makes
  both reject the projection on purpose.
- QMMM1 maps by the ` | SKU | n` token in each image's alt text, and rejects media it cannot assign.
  Its SQL projection also pins `expected_images` in `20261109150500_md20_owned_projection.sql`.
  Replacing only the TypeScript mapping would therefore not enable safe media edits in either family.
- The generic media runtime exists, but its read adapters reject products with more than one variant.
  Do not remove those guards or enable `SHOPIFY_MEDIA_SYNC` globally for this feature.

Supporting add/remove/reorder therefore needs a design decision and a migration (a data-driven image map replacing the
fixed lists in both families, with the same exact-identity checks), plus a narrowly scoped shared-product adapter
for the existing media journal/runtime and the Shopify create/attach/detach/reorder transport with
lost-response recovery, and a canary on a non-live product. This change does not attempt it.

Any future image-map bootstrap must preserve the exact seven approved color identities, use a reviewed hash
manifest and readback, and keep product leases, baselines and family-wide atomic projection guards. Unassigned
images require an explicit color choice or review; do not guess from filenames or URLs. Removal must detach
the product reference rather than delete the global file, and cannot remove a color's last image. Reordering
must preserve other colors' order and covers. A job ID alone is not proof of completed delivery.

## Limits worth knowing

- One Shopify product, so a title, description or SEO edit on one color changes every color. The editor says so.
- Shopify rewrites some HTML on save. Readback therefore compares descriptions with the existing equivalence rules,
  and the cards then show Shopify's version.
- `fileUpdate` changes a global file's alt text. **All file usage has not been audited**, so dedicated ownership
  is not established. The call never changes source, filename, product reference or order, but a shared file's
  ALT changes wherever that file is used. The editor discloses this scope.
- Shopify does not expose native compare-and-swap for this mutation. Fresh reads and minimal changed-field writes
  narrow the race window, but an independent Shopify Admin edit between the final read and the write may still
  be overwritten. The product lease serializes our own workers, not direct Shopify UI users.
- The route's write/recovery budget is 55 seconds inside its 60-second runtime; the existing product lease TTL
  is five minutes. Recovery can still run out of budget or lose the lease. It cannot claim successful projection
  when the guarded batch fails. The service checks its budget before each mutation, recovery read/rebuild
  and final card read; internal source/projection workers keep their own existing budget checks.
- `SYNC_OWNED_EDIT_PARTIAL` means readback found some intended changes and the Gallery was rebuilt from the actual
  source. `SYNC_OWNED_EDIT_UNCERTAIN` means a mutation was attempted but its full outcome or projection could not
  be established. Neither means that nothing changed. A raw provider rejection also does not prove no change.
- `SYNC_OWNED_EDIT_DELIVERED_PROJECTION_PENDING` requires verified delivery in Shopify, but the Gallery rebuild
  failed. **ALT-only `fileUpdate` has not been proven to emit `products/update` or create a durable retry here.**
  No automatic refresh deadline is promised. An operator must re-read both sides and run the existing guarded
  reconciliation before claiming completion. Never retry the original mutation solely because a response was lost.
- Existing private projection baselines and receipts protect reconstruction, and the service logs a bounded
  success event. They are not a durable before/after mutation journal. No new operation log or retry queue is
  introduced in this release; preserve external canary evidence and record unresolved delivery explicitly.

## Release and canary (needs explicit approval)

No DDL. Code deploy only, after CI, `npm test`, `npm run lint`, `npm run build`.

### Local validation, 9 November 2026

- Full `npm test`: 1,966 tests, 1,900 passed, 66 skipped, zero failures.
- Full lint: exit 0; two pre-existing unused-variable warnings in
  `scripts/verify-existing-media-25mp-sql.mjs`, outside this change.
- Independent cold review rechecked the late-input merge, ambiguous first mutation recovery,
  the ALT-to-copy concurrent-edit check and unambiguous QMMM1 technical markers.
- CUA in-app Chromium exercised the real editor and route/service with an isolated loopback fixture.
  All API requests were intercepted, dummy images were local, and the Next process had no production
  credentials. This was not a production or Vercel Preview test.
- Observed desktop viewport 1441 by 1000 and mobile viewport 391 by 844: shared-family title save,
  QMMM1 rich-description save, exact ALT save, global-save refusal with pending owned edits,
  ordinary changed-only save, missing ALT marker refusal, and an uncertain-result warning retaining
  local text. No form inputs or buttons extended beyond either viewport; no browser error log appeared.
- Other injected failure variants and late input were covered by unit tests, not all repeated
  interactively. Real iPhone, Safari and production writes were not tested in this local session.
- Read-only live preflight at 18:51 to 18:53 UTC found all seven owned cards matching their Shopify
  source, approved identities, private baselines and published bindings. There was no open owned-card
  outbox or active product lease. The final planner accepted all 13 real QMMM1 ALT suffixes locally.
  This confirms current parity, not a new write/restore round trip. Nineteen historical webhook failures
  for the two families still exist; the grouped codes alone do not establish their underlying cause.

Local evidence stays in the workspace `work/` directory and is not application code:
`final-suffix-test-20261109.log`, `final-suffix-lint-20261109.log`,
`owned-edit-ui-browser-evidence-20261109.json`, `owned-edit-live-preflight-20261109.json`
and `owned-edit-hardening-20261109.json`. The earlier hardening manifest predates the Hebrew ALT fix;
use the release commit/tree and final test logs to identify the released candidate.

1. Confirm production state first: the adoption `prepare` endpoints show each color's baseline and any unresolved outbox
   row. The preflight rebuild in step 3 refuses to write while any exist.
2. Canary on one approved exact image, reversible, with the owner present: preserve its original global ALT and
   choose a minimal change after acknowledging potential shared-file effects. Read Shopify, Gallery and baselines
   after delivery, restore the original, then verify both sides again. Follow with one description edit on FZT73
   and the same on QMMM1, each restored after readback. Record Shopify `updatedAt`, card versions and private baselines
   before and after. Separately prove the recovery path for ALT-only projection failure before claiming automatic retry.
3. Only then announce the feature as live. Until the canary passes, treat it as unverified on production.

Rollback: revert the application commit through the normal path. No schema or data was added. Edits already delivered
stay in Shopify, which is the source of truth for these products; restore any of them by editing again.
