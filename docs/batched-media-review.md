# Per-product image review batches

`POST /api/admin/shopify/media/review/batch` accepts an array of one to four existing review bodies for a single exact product identity. It uses the existing administrator authentication and session CSRF policy. Actor identity is server-derived. No Shopify mutation, image upload, baseline reset, publication change or role grant is performed.

For four images, the route reads the catalog once and the native product twice, instead of repeating those reads for every image. Each source is still captured, decoded, checked against its exact expected SHA and checked against the denied-media registry. All four captures must pass, and the native fingerprint must remain unchanged, before the first review is saved. An inactive or unpublished Gallery binding is rejected; the native reader independently checks publication and exact identity.

Each review uses the existing immutable signed storage path, including readback. The queue is requested once after all saves return successfully. `complete: true` means review registration completed, never synchronization acceptance (`syncVerified` remains false).

There is no batch-wide storage transaction. On failure the response includes only verified `registered` receipts. `attemptedMediaId` identifies a save with an uncertain outcome, if any. A failed queue request returns `queued: null`, because an RPC timeout does not prove that no queue update committed. Do not replay blindly: inspect the immutable record and current identity, then submit only unresolved entries. Never remove valid receipts to simulate rollback.

The limit is four images and 64 KiB of streamed JSON, with a five-second body-read budget and a 45-second work deadline inside the 60-second platform budget. Larger products use multiple sequential batches. A slow source can fail the group before any record is stored. There are no internal retries or concurrent image captures. Existing workers and independently authenticated review requests may run concurrently; signed exact-image reviews do not grant permission to overwrite newer product data, and ordinary worker freshness/concurrency checks still apply.

This optimization does not fix unstable CDN encodings. A checksum mismatch remains a rejection. It does not change request headers to pass a review and does not substitute a checksum learned from an unreviewed response.

Both the single-image and batch routes return an authenticated `observation` on a checksum mismatch, containing the actual failed capture's SHA, MIME type, dimensions and byte count, together with the expected SHA and media ID. This is diagnostic data only, never an approval. It avoids attributing a failed request's bytes to a later, separate diagnostic fetch. Encoding variance in the A81 incident remains an unproven hypothesis.

Validation: exercise actual handler logic with real record parsing and injected transport/storage failures, including denied auth, bounds, mixed identities, removed products, last-image checksum failure, concurrent native change, partial storage failure and uncertain enqueue outcome. Production speed and the positive authenticated Preview flow remain unverified until separately exercised under the release gate.
