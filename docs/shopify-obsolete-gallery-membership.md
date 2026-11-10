# Retiring missing historical Gallery identities without changing media

This is an exceptional administrator decision, not an automatic reconciliation policy.
The motivating SZV shape has obsolete Gallery-only logical keys in an old baseline,
while the current Gallery already references the same four native Shopify photos.
The ordinary planner correctly refuses to assume that the missing keys were intentionally removed.

`POST /api/admin/shopify/media/obsolete-membership` uses the existing owner/admin
session or configured admin token. Session mutations require the existing same-origin
CSRF policy. Bodies are bounded to 1,024 bytes and responses are `no-store`.

## Preview

Send `{ "action": "preview", "itemId": "<exact item UUID>" }`.
The server resolves the approved enabled identity, acquires the product lease, and
uses the existing full capture and exact-image review gate. It rereads the complete
planning context after capture. No image approval, provenance, removal intent,
baseline, queue status, public content, image file, or historical operation is changed.

The proposal requires:

* Both current catalogs have the same ordered logical keys, content and ALT.
* Current Shopify semantics match its committed baseline.
* Each missing historical identity belongs only to the old Gallery baseline,
  has a `g-angle:<UUID>` key, and was never in the Shopify baseline or current set.
* There is no active or current-state operation, unknown historical operation,
  detached receipt, unrelated removal, missing current proof, or identity drift.
* A terminal conflict from a strictly older committed state may remain as immutable
  history. Its complete operation and step records are included in the proposal hash.
* A hypothetical pure plan after these decisions has zero conflicts, zero patches,
  zero orders and exactly unchanged projected current catalogs.

The result lists the exact missing keys and current source proofs, with a
`proposalHash` binding identity, state version, both baselines, both current snapshots,
raw Gallery revision and historical journal. Capture timestamps alone do not change
the proposal. This preview is not owner approval and is not live sync acceptance.

## Explicit decision

Only after the owner has reviewed that exact proposal, send its unchanged hash:

```json
{
  "action": "confirm",
  "itemId": "<exact item UUID>",
  "proposalHash": "<hash returned by preview>",
  "approval": "RETIRE_MISSING_GALLERY_KEYS_WITHOUT_MEDIA_CHANGES"
}
```

The server repeats capture and every guard under a new lease. A changed proposal
is refused before any decision. The authenticated actor is obtained from server auth,
never from the body. Each key is recorded through the existing immutable
`record_toptik_media_removal` RPC against the exact committed Gallery fingerprint.
Request UUIDs are deterministic for that proposal and key, so an identical retry
after a lost response cannot create another decision. The normal RPC still rejects
changed actors, reused requests and stale baselines.

Decisions are individually durable. A partial RPC failure is not rolled back or
reported as success. Preserve the response and inspect the journal; an identical
retry may complete only that identical proposal. Never invent a new hash or request
to get around a refusal. No retry loop is provided.

Existing intents for these keys must carry the deterministic request UUIDs of
that identical proposal. If a partial decision exists and the capture changes,
preflight refuses the changed proposal rather than appending a second intent for
the same key. The RPC's evidence schema has a strict allowlist, so no new `reason`
or `proposalHash` field is injected into it. Preserve the full proposal and returned
deterministic request UUIDs together in the governing audit record. SQL trusts the
service caller's actor UUID format; administrator role verification is performed by
the real authorization layer before that service caller is created.

After all acknowledgments, only the existing product reconciliation queue is
notified, with a null Shopify event. No signed event is fabricated and no blanket
Gallery editor deletion authority is added. The response is `decisionRecorded: true`,
`queued: true`, `syncVerified: false`. The ordinary worker independently captures,
validates, plans and commits. Queue acknowledgment is not completion.

## Acceptance and rollback

Before confirmation, save approved native and Gallery snapshots, state, queue,
historical journal and the exact proposal. After the ordinary worker runs, verify
its operation and refreshed state, exact current media IDs, URLs, ALT, order,
prices, variants and public records. Expected media transport steps: zero.
If the worker requests media review, mapping or another decision, leave it held.
The A83 image review is not waived by the A81 proposal.

No migration is required. Roll back code to its predecessor without deleting
immutable intents or historical records. A recorded owner decision cannot be
silently erased. Conflicting later edits must follow normal reconciliation.
No storefront crawling, theme publication, reactivation of hidden products,
image upload/delete, or manual baseline reset is part of this endpoint.
