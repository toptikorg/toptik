# Integrated synchronization release — 1 October 2026

Status: **candidate, not activated or verified in Production**. PR28 is separately live at `4e4bb1db2f1be1ab791992f819cf32998ed6fc53`; it is included in this branch. Existing indexing settings are unchanged.

## Scope now implemented

- Existing administrator sessions and the advanced existing token entry both reach the Gallery editor. Interactive mutations use the established server role and origin policy; machine workers retain token authentication.
- Atomic catalog/settings/angle saves with editor revisions prevent stale-tab replacement. Incomplete private reads fail closed. Uploads remain attached to the original UUID and reject stale responses; imports preserve revisions.
- Two-way typed specification changes and explicit clears with provenance and independent baselines. Clears require the matching MAIN theme consumer.
- Durable two-way media planning, image identity checks, product-scoped changes, immutable operation journals and uncertain-response recovery.
- Current Shopify commerce fields in the editor, minimal-field updates and readback; draft creation and verified publication use the merchant's original intent.
- Exact, one-time admission of the already-published OSV04 product; no duplicate product creation.
- No inventory management, new scopes, invented quantities or stock gates.

See `shopify-admin-sync-runtime-20261001.md` for field ownership, merge limits, flags and merchant workflow.

## Integration defects fixed before release

1. A partial settings/items/binding/angles read could have become a saveable incomplete catalog. Administrative reads now reject it.
2. Upload completion could target an item by its old list position. UUID and catalog-generation guards now prevent this; conflicting editor actions wait for uploads.
3. New-product finalization did not account for the new editor revision trigger. Its full-row guard now permits only the expected single revision increment and activation.
4. Token-authenticated catalog saves passed the wrong media principal. The trusted route now supplies the exact fixed principal already allowed by the media queue; session UUID and copy identity remain unchanged.

## Evidence and release boundary

- Integrated suite: **1,061/1,061 passed**, zero skipped (2026-10-01 05:25 UTC).
- ESLint passed without warnings at 05:25 UTC; TypeScript and the real Next webpack build passed at 05:26 UTC (39 static pages generated).
- Exact assembled v5 SQL: **306 assertions passed** against actual migration fixtures; 82 items, 478 angles, 78 bindings and all 13 prior catalog/copy tables preserved. Forced late failure rolls back; repeat application rejects.
- Separate real-chain checks: editor CAS 375; media/bootstrap 385; commercial finalizer 323; typed clear/admission 44; OSV04 admission 74. These are local PostgreSQL-compatible fixtures, not live synchronization evidence.
- Shopify read-only scope/schema checks confirmed existing product/publication access and current exact-variant commerce reads. No additional inventory scope is required.

The frozen v5 bundle is 359,080 bytes, SHA-256 `60916329301446649dd8c4f3642623dc08e6c0ab790f0f22a011be77867ebac8`. Its 15 source migration hashes were rechecked with zero mismatches. The operational artifacts and catalog backup are outside this repository in `outputs/toptik-sync-release-preflight-20261001/` in the project workspace. Do not replay all repository migrations or apply superseded v4.

## Still required for live completion

1. Restore authenticated browser access to the existing Supabase SQL Editor; apply the exact v5 transaction and verify `DDL_ONLY_VERIFIED_NOT_ACTIVATED`, 13 preserved tables and readback.
2. Deploy the reviewed commit with new flags off and verify actual Production SHA and the existing public purchase flow.
3. Publish and live-verify the exact MAIN typed-clear consumer before enabling explicit clears.
4. Initialize independent baselines, admit only exact approved identities, then activate and verify each lane through ordinary authenticated changes and final destination readback in both directions.
5. Record individual acceptance evidence for admin access, copy, typed values/clears, media, commerce, creation/publication and Back. A lane not exercised remains NOT TESTED.

At this record's creation, no new schema, flags, template consumer or this integrated application candidate had been deployed. The Chrome extension was unresponsive; that is an access blocker, not evidence that a platform rejected the migration. There is no fallback through a privileged application RPC.

Recovery: preserve old data and immutable journals; disable the affected lane and roll back application code when appropriate. Application rollback does not reverse an already-verified Shopify write.
