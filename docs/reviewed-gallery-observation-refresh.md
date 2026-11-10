# Reviewed current bytes under an unchanged Gallery URL

`MEDIA_GALLERY_OBSERVATION_REUSED` can occur when a CDN serves newly encoded bytes at an unchanged image URL. After a human approves those exact current bytes, capture produces new provenance but the Gallery catalog revision still identifies an older immutable observation. The old observation must remain intact.

The worker first follows the ordinary capture and observation path. Only this exact collision can enter a service-only refresh. The service gate loads signed review records and requires the current exact product, variant, URL and byte digest for every changed Gallery evidence ID. A baseline or historical transformed-image receipt alone cannot approve a refresh.

The RPC holds the existing identity lease and catalog advisory lock, refuses active transport, and requires the old raw catalog to remain identical. Logical keys, physical angle references, membership, order, source URLs and ALT cannot change through this path. The RPC advances only the private observation epoch, appends an observation and an immutable audit receipt, and preserves the old observation and all baselines. Normal reconciliation and its guarded commit subsequently decide whether a baseline can advance.

No public catalog row, file, Shopify product, price or publication is changed by refresh. A crash after epoch creation can resume through the ordinary observer without creating a second receipt. Unsupported collisions remain in review rather than retrying indefinitely.

Migration `20261110191500_reviewed_gallery_observation_refresh.sql` must be applied before deploying the code. Local acceptance uses the actual capture mapper, real review guard, RPC ports, worker and isolated Postgres functions. It reproduces the old collision, verifies zero transport steps, and verifies resume after a crash. Production acceptance must re-read current signed approvals and the four held products, run ordinary reconciliation, and compare native and Gallery data with the saved snapshots. A successful build or a registered approval alone is not completion.

Rollback: restore the preceding application commit through the approved deployment process. Keep the additive RPC, epoch history and audit records; do not delete immutable records or reset baselines. A refreshed epoch remains readable by the preceding application code. The migration grants execution only to `service_role` and grants no direct table writes to that role.
