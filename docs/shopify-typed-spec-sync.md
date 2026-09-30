# Typed product specifications — implementation candidate

Status: local code and offline SQL verified. Not activated, not deployed, and no live product/metafield/database writes performed by this change's builder. Copy sync, commerce, product creation, media and existing manufacturer caches are separate.

## Scope and activation

Both `VERCEL_ENV=production` and exact `SHOPIFY_TYPED_SPEC_SYNC=enabled_v1` are required. Preview cannot write or dispatch. A second, private per-product approval is mandatory; the existing copy approval is never modified. Exact product, variant, Gallery UUID, both raw SKUs and approved handle must agree. Publication is pinned to `gid://shopify/Publication/79538258170`; products must remain active, published and single variant.

Apply `supabase/migrations/20260930_verified_typed_spec_sync.sql` after the existing verified copy migration. It creates private approvals, independent per-field baselines/current Gallery values, immutable receipts and a durable generation queue. Public readers can call only the value-only projection; private tables have no anon/authenticated access. Service-role direct writes are revoked; designated security-definer functions enforce the shared catalog lock, exact current identity and owned unexpired product lease.

Activate a reviewed existing product with admin-token `POST /api/admin/shopify/specs/bootstrap`:

```json
{
  "productId": "gid://shopify/Product/<verified product>",
  "variantId": "gid://shopify/ProductVariant/<verified variant>",
  "itemId": "<verified Gallery UUID>",
  "exactGallerySku": "<exact stored Gallery SKU>",
  "exactShopifySku": "<exact Shopify SKU>",
  "productHandle": "<exact approved handle>",
  "approvalId": "<reviewed activation identifier>",
  "evidenceId": "<retained reviewed evidence identifier>"
}
```

The activation RPC and initial baseline capture are separate transactions under the same product lease. A failed initial fetch leaves an approval with no baselines: no queued mutation or public facts appear, and an identical bootstrap retry finishes initialization. All nineteen baselines must be present before editing or queue admission. Gallery typed fields start explicitly absent, independently of Shopify typed values. Legacy descriptions, unlabeled dimensions and inventory/shipping weight are never parsed into facts. First initialization performs zero cross-system writes.

## Supported data

Merchant-owned PRODUCT namespace `toptik_specs`: `manufacturer_sku`, `manufacturer_model`, `material`, `height`, `width`, `depth`, `expanded_height`, `expanded_width`, `expanded_depth`, `volume`, `expanded_volume`, `net_weight`, `wheel_count`, `wheel_type`, `lock_type`, `expandable`, `color_name`, `warranty_text`, `additional_specs`.

Lengths normalize exactly to centimeters, volumes to liters and **net product weight** to kilograms. Rational decimal conversion preserves original numeric lexemes and units; binary rounding is not used. Additional spec sections preserve their headings and unknown fields. Prices, inventory, media, taxonomy, product copy and shipping measurements are outside this namespace.

All native Shopify dimension, volume and weight units are accepted, including yards, US pints/quarts, and imperial fluid ounces/pints/quarts. Ambiguous shorthand such as `oz` or `gal` is rejected. The official supported unit names were checked against [Shopify metafield types](https://shopify.dev/docs/apps/build/metafields/list-of-data-types) on 30 September 2026.

Clears remain disabled in v1. Null/empty edits are rejected, observed remote disappearance produces a conflict, and a nonempty clear-control map stops reconciliation. The pure adapter contains an explicitly gated tombstone prototype for later work; runtime never enables it. Ordinary typed writes CAS-guard both their changed fields and the empty `toptik_specs_sync.clear_state_v1` control map. No physical metafield deletion is attempted.

## Editor and automatic processing

An enabled production admin dashboard links to `/dashboard/specs`. Its session-admin API is `/api/panel/shopify/specs`; mutating browser requests require same origin. Only edited keys and their own Gallery versions are submitted. The server constructs `merchant` provenance from the authenticated operation/request ID. Browser input cannot declare manufacturer verification. Raw field values and provenance stay in private receipts, not the public projection.

For the approved operator harness, `GET /api/admin/shopify/specs/fields?productId=<encoded Product GID>` requires the existing `x-admin-token`. It observes exact private identity, all nineteen fields with `galleryVersion`/`stateVersion` and independent baselines, current Shopify values, and field definitions. It does not initialize, advance baselines or queue writes. Response is private/no-store.

The same token endpoint accepts `PATCH` with a strict object:

```json
{
  "productId": "gid://shopify/Product/<verified product>",
  "variantId": "gid://shopify/ProductVariant/<verified variant>",
  "itemId": "<verified Gallery UUID>",
  "exactGallerySku": "<exact stored Gallery SKU>",
  "exactShopifySku": "<exact Shopify SKU>",
  "productHandle": "<exact approved handle>",
  "requestId": "<new UUID for this merchant action>",
  "changes": { "material": "<verified material>", "net_weight": { "value": "<verified value>", "unit": "kilograms" } },
  "versions": { "material": 1, "net_weight": 1 }
}
```

Use versions from the fresh GET, not the example constants. Complete exact identity is rechecked inside the product lease; only changed typed fields are saved with CAS. A `202` response means durably queued, **not propagated or verified live**. Statuses: `401` unauthorized; `404` feature disabled; `400` malformed/unsupported request shape; `413` body above 500,000 bytes; `409` stale version, changed identity or other held operation. The endpoint cannot rewrite catalog metadata, angles, settings or commerce fields.

`edit_toptik_spec_fields` saves edited fields and enqueues work atomically. A repeated request ID with identical values, intent and expected versions returns its original receipt. The regenerated server observation timestamp is the only field excluded from the retry fingerprint. A changed request using the same ID is rejected.

Exported integration hooks from `typed-spec-worker.ts`:

- `typedSpecSyncEnabled()` — exact environment gate.
- `enqueueTypedSpecProduct(db, productGid)` — signed product-event admission; only initialized, approved products.
- `drainTypedSpecQueue(db, absoluteDeadline)` — `{processed, failed, reviewed, continuationNeeded}`.
- `recoverTypedSpecQueue(db)` — enqueue at most 100 initialized enabled approvals without unfinished work, oldest first. One drifted identity is skipped, without blocking other products.
- `typedSpecQueueStatus(db)` — private scalar counts.
- `withTypedSpecLease`, `readTypedState`, `initializeTypedSpecsUnderLease` — explicit bootstrap/editor integration.

Each reconcile compares current values against independent Gallery and Shopify baselines. Only changed fields propagate. Concurrent different changes to one field conflict; other safe fields can complete. Shopify writes always include explicit current `compareDigest`, including `null` for verified absence. Fresh exact identity and target CAS are checked before writing, and fresh source/target readback is required before baseline changes. If Shopify accepted a mutation but its reply was lost, the next attempt acknowledges matching values without issuing the mutation again.

The dedicated worker and fixed-origin dispatcher are separate from the copy worker budget. A 40-second drain reserves cleanup inside its deadline, including release, queue completion and pending lookup. After real progress only, pending work can continue through a bounded chain. Busy/time-budget rows return pending without consuming retry attempts; real failures retry at most five claims, and conflicts remain review. A new event/edit resets retry attempts. No paid cron or new permission scope is required.

Signed product events keep the existing copy inbox and its worker independent of optional typed admission errors. Unsafe numeric IDs, object coercion and mismatched GraphQL IDs cannot select a typed product; delete events do not enqueue typed edits. Daily typed recovery runs alongside the copy drain and catches its own failures. After copy reconciliation has released its lease, the two bounded wakeup requests run in parallel, so the tail costs at most one eight-second acceptance window. Each consumer still serializes actual writes through the shared product lease. A typed chain stops at hop 100 and records a stable error code if work remains.

## Public rendering

`public_toptik_typed_specs` exposes only exact Gallery identity and validated typed values for current enabled bindings. Disabled, drifted, unpublished or duplicate identities are excluded. The server overlays known labels while preserving unknown manufacturer sections and category/color metadata. Partial typed dimensions do not erase a legacy combined dimension string; all three explicit axes are needed.

Likewise, a legacy combined wheel row is preserved until both typed wheel count and type exist. A partial type is displayed separately as `סוג גלגלים`, preserving any still-untyped count in the original row.

For an uncached product with a manufacturer source URL, typed presentation stays separate until the existing lazy/session lookup resolves. It does not masquerade as a complete cache or suppress legacy facts. Public values are escaped plain strings; rich HTML, private provenance and revisions are never sent as spec presentation.

## Verification and limits

Focused tests exercise schema/unit fidelity, mandatory CAS, unchanged-field preservation, both directions, conflicts, uncertain-write recovery, default-off/Preview isolation, bounded continuation and lazy legacy rendering. Actual PGlite executes the project's existing migrations plus this migration: 41 identity/baseline/ACL checks and 38 activation/editor/queue/public-projection checks. The offline SQL harnesses are retained in `work/typed-spec-sync-draft-20260930/typed-spec-runtime-sql.test.mjs` and `typed-spec-runtime-flow.test.mjs`; they use the existing isolated PGlite package, not a new application dependency.

Final local candidate verification (30 September 2026): **356/356 repository tests pass**, full ESLint passes, and `next build --webpack` passes including TypeScript and all routes. The admin editor is explicitly dynamic with a per-request role gate. The cold reviewer independently reran all **79 actual-schema PGlite assertions** and found no remaining blocker. Checks used the package-script commands via the available Node binary; `npm` was not on this resumed shell's PATH. There were no dependency changes. Build/test success remains local evidence, not live acceptance.

Live canary acceptance remains required: edit an officially verified real material/net-weight value, observe the automatic event/queue and exact Shopify metafield readback, verify the live MAIN product specification and Gallery modal, then exercise the reverse direction. Verify all unrelated product copy, price, inventory and media unchanged. No synthetic product or invented manufacturer fact is needed.
