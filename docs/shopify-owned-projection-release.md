# Source-owned color projections: release and verification

This change fixes the worker trying to use the general Gallery editor save while
holding the product reconciliation lease. It does not remove that editor guard.
FZT73 and QMMM1/MD20 now use separate, identity-bound RPCs with an owned live
lease, copy/editor CAS, exact media assignments and an atomic color batch.

## Ownership and truthful queue results

Ordinary approved one-product/one-color bindings retain the existing bidirectional
copy merge. FZT73 and QMMM1 are shared Shopify products with per-color Gallery
projections. Their shared copy/media are Shopify-owned; editing those fields in
the Gallery is not a supported outbound write. The editor marks copy read-only
and links each family to its own Shopify product. No price, inventory, product
status or new catalog admission is changed by this patch.

Source-owned outbox edits go to review, never `synced` merely because an inbound
projection was rebuilt. A normal inbound projection needs an identical initial
baseline, or its current Gallery projection must still equal the prior baseline.
Unknown differences and open outbound edits stop the batch for review.

The admin-only adoption endpoints provide an explicit exit from that review:

- `/api/admin/shopify/fzt73/adoption`
- `/api/admin/shopify/md20/adoption`

`prepare` returns each exact before/proposed projection, versions, identities and
outbox decisions with `approved:false`. `adopt` requires the exact manifest hash,
a unique approval ID, recorded approval evidence and fresh authenticated Shopify
reads/media validation. Review every selected color and every proposed discard
before approval. Record Tal's approval reference; an API token alone is not
evidence that Tal approved a particular manifest.

Adoption atomically verifies the complete before state, writes the projection and
baseline, and preserves an audit. Discard decisions are bound to the immutable
observed outbox ID, hash, creation time and payload. They are separate terminal
records, not invented delivery receipts. A new or changed edit blocks again.
An idempotent replay returns the historical receipt only. Source drift after a
commit returns a conflict plus the receipt, not a claim of current convergence.

Hidden/missing Gallery rows are never recreated or reactivated. Draft, archived,
unlisted or withdrawn Shopify products do not reactivate Gallery entries. New
media outside the exact reviewed per-color assignments require a separate review.

## Required release order

Release authorization recorded on 9 November 2026: Tal approved both the FZT73
and MD20 migrations/code deployment. Data adoption is approved only for the four
FZT73 colors at hash
`8da4c93b49fbbb2ec32207267bbef3654cb2fae0efe9299c23f7643e557c54cc`,
with fresh revalidation and no new open edits. MD20 data adoption and Shopify
theme publication are not approved by these migration authorizations. Equal
MD20 source/Gallery baselines may initialize through the guarded normal worker
without replacing product content. Migration must precede production deployment.

1. Run focused SQL/worker/endpoint tests, `npm test`, `npm run lint` and
   `npm run build`, cold-review the exact diff, and require green CI.
2. Preserve fresh Shopify/DB snapshots, manifests, exact hashes and the recorded
   approval. Do not treat local capture files as permanently current.
3. Obtain the specific release/DDL approval. Apply the additive migrations
   `20261109130444_fzt73_owned_projection.sql` and
   `20261109150500_md20_owned_projection.sql` using the normal migration workflow.
   Do not change or bypass `save_gallery_catalog_atomic`.
4. Deploy the tested code and verify the actual production alias/commit.
5. Re-prepare the manifests. If a before/source state differs, obtain approval for
   the changed result before adoption. Three MD20 colors captured on 9 November
   matched their source, so a fresh equal bootstrap may require no content adoption.
   The FZT73 capture differed only in teal image alt text incorrectly saying burgundy.
6. Resume only exact current relevant events. Do not reset historical failed or
   review queues in bulk, especially for products Tal explicitly removed.
7. Read back the Gallery rows, angles, private baseline/receipts and Shopify data.
   Check actual purchase links and desktop/mobile presentation when available.

Publication timestamp repairs are a separate, unreleased operation. Five legacy bindings
(three QMMM1 colors and ORI05500024/ORI05500909) carry source versions later than
fresh Shopify `updatedAt`. The stale-snapshot guard is preserved; safe
database codes are still masked in the released publication path. A diagnostic
patch is retained separately. Do not silently rewrite those versions during
projection or adoption. Revalidate identities, preserve before data, and use a
separately approved atomic repair. Historical masked `WRITE_FAILED` entries alone
do not prove which database guard failed.

## Evidence and limits before release

The real QMT58 Havana description correction propagated Shopify to Gallery at
13:05 UTC on 9 November. A reversible nonvisual HTML-attribute probe entered the
approved Gallery patch RPC at 13:13, was read back from Shopify and sync state at
13:15, and restoration was confirmed from both at 13:20. Price stayed ILS 706;
product identity, images and public facts were preserved. This verifies that
specific existing one-to-one path, not every field or every catalog item.

The final release suite passed 1,787 tests, with 66 pre-existing skips. SQL tests
execute the new migrations in PGlite, including owner, expiry, CAS, batch rollback,
cross-color media, hidden rows, adoption/audit and changed-outbox cases. An isolated
PostgreSQL 17 two-connection FZT73 test also verified blocking and lease expiry
after waiting. Production DDL/adoption and live source-owned convergence remain
unverified until the release sequence is completed. The storefront theme gate
still returned HTTP 429 and is a separate outstanding publication gate.

## Rollback

Pause further adoption/replay on a failed readback. Keep all audit records and
before snapshots. Revert the application commit through the normal reviewed path;
leave the additive private SQL functions/tables in place until a reviewed reverse
migration is prepared. Application rollback alone does not restore adopted copy.
Restore only the exact affected Gallery fields/angles/baselines from the recorded
before state after fresh CAS/identity checks. Never blanket-restore the whole
catalog or reactivate a removed item. An applied discard decision is audit history;
restoring an edit requires a new explicit operation, not deletion of its history.
