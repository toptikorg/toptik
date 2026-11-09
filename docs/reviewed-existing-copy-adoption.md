# Reviewed existing-product copy coverage

This is an operator plan/apply boundary, not an automatic bootstrap or new public API. No live
adoption or database migration was executed while implementing it.

## Current observed gap

The 2026-11-09 read-only audit found 409 ACTIVE, Online-Store-published products and 414 public
Gallery cards. The 407 single-variant products comprise 405 with generic copy approval/baselines
and two Porsche Design products without them. Seven other cards are the separately managed
FZT73/QMMM1 families and intentionally have their own baselines. Inventory zero was never used
to decide availability. Drafts, archived/unlisted products and withdrawn publications stay excluded.

The two Porsche products already have exact bindings, but Gallery and Shopify copy differ:
Gallery has the old `Porsche Carry-On` title, no rich HTML and no SEO values. Shopify has Hebrew
product titles, rich descriptions and SEO. Silently inserting a baseline would conceal this difference.
Their binding watermarks also contain an observation date later than Shopify's actual `updatedAt`.

## Review contract

`planExistingCopyAdoption(observation, resolution)` validates exact shop, single variant, raw SKU,
binding, current published link, Gallery identity, approved vendor and explicit product type. It
refuses existing eligibility/state or any unresolved Gallery edit. It produces complete before
snapshots, per-field differences, source/Gallery SHA-256 fingerprints and an exact plan hash.

The default `preserve_both` creates independent future baselines without changing either copy.
An `adopt_shopify` package is a different hash and explicitly proposes overwriting only Gallery
title, paired description and SEO with the freshly reviewed Shopify copy. Neither package approves
itself. The owner must review the exact diff/hash and select that package before an operator applies it.
Porsche Design and the four existing supported brands are recognized by exact vendor/type values;
there is no title/SKU brand guess or permission to create/publish another product.

The private runtime adapter exposes `prepareExistingCopyAdoption` and `commitExistingCopyAdoption`.
The host/operator must bind the approval actor to the authenticated owner, not a browser assertion.
There is deliberately no UI route, worker call, replay loop or automatic application. It reads at
most two variants and 50 media records, fails on truncation, uses the configured exact Online Store
publication, re-reads before commit and holds the ordinary product reconciliation lease.

The atomic SQL boundary compares all original Gallery, binding and public-link rows again under
locks, refuses newly inserted approval/state/open edits and records the immutable reviewed plan,
approval evidence, eligibility and independent baselines together. The optional selected copy
change is in that same transaction. It does not change Shopify, media, prices, inventory, publication,
identities, display order or the existing binding watermark. Receipts recover lost replies without
resubmitting a commit. Source and Gallery readback flags are separate from the receipt itself.

## Poisoned watermark policy

No migration or adoption lowers `source_updated_at`. The publication function may acknowledge
an older source only if every affected binding and its public link already match the exact desired
publication/identity tuple. This is a zero-write no-op. A publication, handle, variant or link change
still raises `SYNC_PUBLICATION_STALE_SNAPSHOT`. A later genuine Shopify edit advances its native
version normally. Historical failed/review rows are preserved; admission never labels them processed.

## Release and acceptance

1. Run focused planner/runtime and actual isolated PostgreSQL migration tests, full tests, lint and
   build, then independent cold review. Apply the additive migration before deploying its adapter.
2. Prepare fresh per-product packages and show both the default independent-baseline choice and
   the explicit Gallery overwrite diff. The saved packages are review evidence, not fresh execution
   authority. An owner-approved hash must still match immediately before commit.
3. Commit one product only. Verify its immutable receipt, full unchanged Shopify snapshot, exact
   selected Gallery copy, independent baselines, unchanged watermark/links and no manufactured outbox.
   Do not apply the second product while the first result is uncertain or fails readback.
4. For ordinary-product title/SEO acceptance, first approve concrete meaningful before/after text,
   then make one change through the existing authenticated editor. Prove actual Shopify fields,
   Gallery fields and event/outbox receipts. An HTML-only marker cannot prove title or SEO writes.
5. Separately make an approved native Shopify correction/restore and observe a genuine processed
   webhook plus Gallery change without calling an edit/reconcile endpoint. Do not treat a manual
   worker run or queue counts alone as automatic-forward proof. Record the two directions separately.
6. Media acceptance is a separate approved operation: addition/replacement/order/deletion needs
   exact file/variant ownership, perceptual image QA, durable intent and readback. This copy admission
   neither approves a media baseline nor resolves `MEDIA_REVIEW_REQUIRED`.

Stop on source/Gallery/hash/version/watermark drift, an open edit/lease, partial/uncertain results,
identity/publication changes or failed readback. Never retry a mutation blindly. Preserve all receipts.
The receipt contains the exact original Gallery copy for a separately reviewed restoration; do not
restore it through the ordinary editor if that would send old Gallery copy into Shopify. A code
rollback preserves the additive schema and audit history. Disabling a newly approved eligibility
row is an explicit operator action; it is not a reason to delete evidence or lower a watermark.

Local verification is not production verification, an owner approval, complete catalog parity,
an atomic cross-system snapshot, or proof of durable scheduling/retry.
