# Shared-product media registry

This extends the two explicitly bound source-owned products, FZT73 and QMMM1, without granting ordinary products a multi-variant exception. Single-variant products retain the existing media pipeline. Registry reads are lazy and do not adopt data.

## Identity and bootstrap

`owned-media-plan.ts` validates a complete Shopify graph and an explicit manifest containing every bound item/variant/SKU, ordered native `MediaImage` IDs, a separate cover ID and any reviewed excluded IDs. No filename, ALT token or color-name inference is used after registration. Every image must be assigned or explicitly reviewed as excluded. Initial adoption requires an owner approval record, lease, exact source fingerprint, complete current card versions and original source-owned baselines. All cards and the registry commit atomically. An ALT/copy difference between an old derived Gallery fallback and the actual native value must be reviewed before adoption; it is not silently treated as equality.

Without a registry, the original exact-image and token rules remain. Before the migration, only an explicit missing-RPC response for the registry read enables this fallback. Permission, malformed-response and network failures do not.

## Both directions

Native observations use complete media order, variant associations and primary images. Known deletion/reorder is projected by ID. New images with an exact native bound-variant association can enter that color; unassigned images remain visible for explicit assignment. Removing the last image stops the operation. A Gallery edit may not silently change a sibling color's shared-image order or detach a file still referenced by another bound or unbound variant.

An observed native change and reservation of the ensuing Gallery command occur in one transaction. The immutable command retains the original browser request and authenticated server actor. Native writes occur only after preparation. Copy/SEO/ALT projection remains map-aware after image changes and rechecks exact variant count, selected color options, full graph identity and current source media. Titles retain the existing family-specific color suffix rule.

## Durable execution

An operation freezes its intent, source graph, map version, card CAS versions and logical phases. `begin` grants one execution permit per phase. A started or uncertain mutation is observed and recovered, never blindly repeated. Attach placeholders resolve only from prior verified private creation artifacts. Mutation acknowledgements do not advance the cursor. Full graph readback must match the frozen delta before `recovered` advances one phase atomically. Reorder/cover no-ops also need journaled full readback.

The dispatcher claim is separate from the product reconciliation lease. It retains the original actor and retries pending observation; review is not success. Running operations make source workers return retryable `SYNC_RECONCILIATION_BUSY`, so webhooks do not project an intermediate native graph. Final commit validates the resolved frozen manifest and every original card CAS version, then updates the registry, old source-owned baselines and all active cards in one transaction. Removed/hidden cards are not recreated or enabled. A request receipt remains readable after completion, preventing a lost response from creating a second operation.

## Database boundary and rollout

Migration `20261109202034_owned_group_media_registry.sql` creates private RLS tables and service-role-only RPCs. Browser roles and direct service-role table access are denied. Existing source-owned projection functions retain identity, publication, outbox, baseline, lease and editor CAS checks; only expected image/cover lookup uses the registered manifest. The migration aborts if the exact legacy function shape is unfamiliar.

Apply the migration before dependent code. No data seed or Shopify mutation runs inside the migration. Review/bootstrap each exact group separately, then run reversible native/Gallery canaries with independent readbacks and restoration. Rollback must drain or explicitly resolve pending operations first; reverting code while a registered map contains new photos can make the legacy exact-image reader reject it. Preserve the registry/journal/audit rather than deleting evidence.

Offline regression coverage uses real PGlite migrations and the actual copy service/worker/planner modules with synthetic I/O. It covers both groups, atomic rollback, role denial, CAS, owner lease, receipt replay, one-shot/no-op phases, native delta rejection, explicit assignment, source identity drift and copy/SEO/ALT edits after image add/remove/reorder. It does not prove live Shopify delivery, provider image decoding, deployed cron timing, browser behavior or production adoption. Those require the release acceptance evidence.

Shopify has no native compare-and-swap across its Admin UI. Product leases coordinate this application's workers; an independent Shopify edit can still race between a final native read and mutation. Fresh graph checks, narrow phases and complete readback detect conflicts but do not make third-party writes atomic. File ALT is global to a file, so ALT canaries require explicitly approved file scope. This pipeline never calls `fileDelete`.
