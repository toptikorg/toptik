# Full catalog synchronization release

Status: implementation and offline acceptance, not deployed or adopted in production. The canonical TopTik Google Doc remains the project authority. This file explains the release and its acceptance boundaries, not a second project Master.

## Scope

The read-only 9 November 2026 audit found 409 active Online Store products, represented by 414 published Gallery color cards. There are 407 ordinary products and two explicitly bound shared products, FZT73 and QMMM1. Draft, archived, unlisted and editorially hidden items must remain protected. Zero tracked inventory is not an availability decision.

Ordinary products retain the existing copy and image pipeline. The new shared-product registry provides explicit per-color media IDs, order and primary image. Title, description and SEO remain product-wide in Shopify; image ALT remains file-wide. The editor explains these scopes. New unassigned native photos require an explicit color selection. Read operations never adopt a map.

## What changed

* Shared media operations freeze the intent, all native associations, the source fingerprint, map version, actor, affected cards and durable phases. Product leases and card CAS protect both workers and editors. A lost response resumes the same operation, never a second create or detach.
* Uploads are decoded, placed at an immutable content-addressed Storage path with no upsert, read back, then used by a journaled Shopify operation. Removal detaches a product reference; no global `fileDelete` exists in this pipeline.
* One color edit changes native associations only for affected colors. A no-op produces no native mutation. Unbound references and other colors' order and covers remain protected.
* Every phase needs exact complete native readback. Gallery projection and all family baselines commit atomically. A final native graph read and copy/SEO projection comparison occur after the DB commit, including on completed-receipt replay. Drift is review, not success or an automatic replacement write.
* Pending operations continue through the existing media worker and cron. The editor's resume control is a fallback. A pending job or mutation ACK is not a completed synchronization.
* The ordinary editor can reorder photos and select a primary photo. Removing a cover alias promotes the next image instead of leaving the removed photo as a cover. Last-image removal is blocked.
* Two Porsche Design products have a reviewed copy-adoption path with exact source/Gallery/watermark hashes. A stale publication snapshot is accepted only as a verified no-op with an already identical binding and public link. No watermark is lowered.

## Database and API

Apply these migrations before their dependent code, only with the specific production approval:

1. `20261109202034_owned_group_media_registry.sql`
2. `20261109202211_catalog_copy_reviewed_adoption.sql`

They do not seed a registry, approve media or mutate Shopify. Private schemas, explicit service-role function grants and revoked anonymous/authenticated access keep authority on the server. Initial adoption requires a separately reviewed exact package and current lease/CAS checks. Existing source-owned guards remain active.

`GET /api/admin/shopify/owned/media?itemId=...` lazily reads the editor. `POST` accepts a strict edit or same-request-ID resume. Cookie mutations require verified admin authorization, same origin and JSON. No caller-supplied proof or arbitrary product/query is accepted. Leases and provider reads are bounded within the request budget.

The authenticated `GET ...&view=source` is a narrow read-only audit of either known shared product using pinned Admin API 2026-07. It needs no Gallery DB client, adoption or write permission. It resolves the connector's newer-schema inability to expose the deprecated native primary-image field once the code has been released. Never infer primary media from list position.

## Evidence and remaining data work

Local tests cover real isolated PGlite migrations, role denial, atomic rollback, CAS, leases, native withdrawal, exact deltas, receipt/ACK identity, lost responses, query-string image URLs, append-only failure evidence, and copy/SEO/ALT after image changes in both families. Mock I/O does not prove production delivery.

The actual editor was exercised in a separate local Next fixture at CSS 1440 by 1000 and 391 by 844. Ordering, primary selection, upload, remove, last-image protection, pending reload, lost-response recovery, an unrecorded request, review refusal, explicit new-photo color assignment, unrelated-color preservation and independent copy-draft preservation were checked. These are component/DOM proofs, not real-session, deployed API or production browser acceptance. Fixture data was labeled LOCAL QA. Browser viewport overrides were reset and the temporary tab closed.

The read-only data packages remain unapproved. Of 319 ordinary held/missing-baseline products, 282 have matching URLs, order and effective ALT, 29 have ALT differences, seven differ in photo sets, and one has a cover/angle ALT alias conflict. Matching URLs do not constitute current decoded-byte proof. Three separately failed products require exact ALT/lineage decisions. There are 36 ordinary missing media baselines; the two shared products need their own map adoption. Two Porsche copy differences and the historical unbound P10ZJT0624U are held separately. No queue was replayed or marked done for this release preparation.

Shared map candidates preserve all seven current Gallery cards: FZT73 maps 15 photos, QMMM1 maps 13 and explicitly excludes the 12 previously reviewed legacy photos. Native primary-image readback is still required before adoption. An earlier package note about adding every native association on the first edit is superseded by the affected-color-only phase builder; adoption itself performs no native association mutation.

## Live acceptance after approval

1. Back up the exact current source, Gallery projections, baselines, bindings and queues. Revalidate the production commit, environment, scopes, migration definitions, native primary images and approved package hashes. Stop on drift or a new edit.
2. Apply the reviewed migration, deploy the approved commit and verify that Production and its public/admin aliases serve that commit. A Ready Preview proves a build; missing private configuration must not be repaired by copying production secrets into Preview.
3. Adopt each exact shared map only if the reviewed projection diff and current native identity match. Resolve ordinary media reviews with current decoded evidence and explicit removal intent. Bootstrap missing baselines one identity at a time. Never turn a historic hold into a success merely to clear a dashboard.
4. Run scoped reversible canaries for ordinary products and each shared family in both directions: copy/title/SEO, new photo, ordering, primary selection and product-reference removal. Preserve all unrelated fields and restore only with fresh expected versions. Verify independent Shopify and DB reads, real signed webhooks, exact live editor behavior and pending-worker recovery. Record what was not tested.
5. Update the same canonical Master at the top and in history with commit, PR, deployment, migrations, adoption/canary receipts, current counts, unresolved items and rollback. Only then claim the observed live scope is complete.

## Rollback

Before map adoption or media writes, a code rollback retains the previous production behavior because the registry is unseeded. After adoption, first stop new media writes and preserve registry/journal evidence. Reverting to legacy hard-coded readers while a registered map contains new photos is unsafe. Resolve or restore each in-flight operation from its exact before graph under a fresh lease/CAS; do not overwrite a newer external change. Keep shared files and historical evidence. Do not drop the private schema or globally delete files as a rollback shortcut.
