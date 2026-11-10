# Ordinary media lineage and restored-operation recovery

The PR205 ordinary canary verified a new Gallery photo, ALT/order propagation, native ALT back-sync and restoration to the original five photos. An additional native reattachment then exposed a different boundary: planning had the full immutable provenance, but execution discovery omitted the two ancestors needed to reach the original signed staged-image review. The source was parked before the first target transport attempt. The test reference was detached again and both sides were independently read back as the original five-photo catalog.

The exact held operation is `c22286e9-f3d6-4420-b845-4b3ce9bbe438` for `KF901003`. These incident identifiers document a real acceptance case; the implementation grants no SKU-specific bypass. It does not treat the held operation as successful.

## Changes

- Discovery returns a bounded same-product, same-logical-key, same-content ancestor closure. The existing exact-image review guard still decides approval. No review, content, provenance or baseline is invented or changed by discovery.
- An authenticated restored-before-transport action may retire one exact zero-transport operation as a documented terminal conflict. It captures the current pair on the server under the existing lease, requires exact committed-baseline assets on both sides and rechecks operation/state/queue/Gallery fences. Normal reconciliation is enqueued separately; its eventual completion is not implied by retirement.
- A separate authenticated read-only diagnostic captures one current native image through the production Node/Sharp path. It reports the exact byte tuple with an explicit unavailable baseline comparison. It cannot approve media, enqueue work or mutate data.
- SQL files check out as LF on Windows as well as CI. The regression uses a genuine isolated Git checkout with `core.autocrlf=true` and a failing unprotected control. Existing deployed migration blobs and raw SQL test loading remain unchanged.

## Migration order

Both new migrations must be approved and applied before code promotion:

1. `20261110084327_media_discovery_lineage_closure.sql`. The read RPC's normalized predecessor MD5 is `117b992c3fb04f6d62494ee695cb2af2`; its expected normalized result is `3a3540b19374affdb5d68bbd29aa44b0`. It preserves the existing signature, OID, owner, ACL, security and configuration. Raw production predecessor MD5 observed on 10 November was `87387298fe41b86d044eb216f775f57c`.
2. `20261110084942_ordinary_restored_retirement.sql`. It adds only the two fixed-name service-role retirement RPCs. It does not change status enums, existing RPC definitions, baselines or private-table grants. PUBLIC, anon and authenticated have no EXECUTE permission.

Neither applying these migrations nor deploying this code adopts historical catalog differences. The old BRIC'S uncertain `stage_source` operation has a transport attempt and is explicitly ineligible for the new zero-transport retirement.

## Verification contract

The ancestry regression uses the actual SQL stage/create/associate/register path, a real signed staged-record save/load in an isolated provider fixture and the actual review guard. Original direct-only discovery fails the review; ancestor-aware discovery succeeds without granting approval. Missing, unsigned or corrupted review still fails. Foreign product/key/content, missing parents, cycles, depth limits, ACLs, idempotence and unexpected predecessor mutations are covered.

Retirement tests use real PGlite journal/queue/Gallery/RPC behavior and the actual runtime capture path. They test every attempt status, artifacts, Gallery commits, stale state/op/queue, changed media/ALT/order/evidence, wrong identity, lease expiry after waits, actor/request replay, immutable audit and the normal no-op reconciliation after retirement. A lost or malformed final RPC response is uncertain and requires the same request ID plus audit; it is not a successful response.

The release gate remains full `npm test`, `npm run lint`, `npm run build`, independent review, exact-head CI and Preview. A Ready Preview proves build/deployment only. Connected save acceptance must be reported separately, including any owner-approved limitation.

## Live acceptance and rollback

After the owner approves this specific release, apply migrations, verify ACL/function readbacks, promote the exact CI head and verify the live build version. Re-read the restored five-photo product and retire only the exact held no-transport operation through the guarded action. Observe normal reconciliation completing separately. Then repeat native add/order/remove using only the existing genuine test file, actual signed webhooks and fresh readbacks from both platforms. Preserve evidence before any failure and restore only the test reference; never alter the five original media IDs, prices, stock, copy or native primary associations.

The remaining catalog review holds are separate. An unchanged URL does not establish unchanged encoded bytes; a changed encoded digest does not prove a changed visible photo. Do not bulk approve, discard differences, revive withdrawn products or reset baselines. Do not resume unsigned storefront scans during the current coordination hold.

Code rollback is the previously verified production commit `910b0047569f4197b999c03d0d8d64ff49556bac`. Leave additive RPCs and append-only receipts in place unless a separately reviewed rollback is required. Never undo a retirement by rewriting its original history as verified. Reconcile only through fresh normal gates.
