# Shopify ↔ Gallery synchronization: implementation status

**Status: secure inbox foundation in code; no synchronization is active.** This worktree does not have a Shopify custom app/token, webhook signing secret, deployed database migration, or separate test shop. Do not merge or enable production until the remaining worker and integration checks are complete.

## Scope contract

- Shopify owns product/variant identity, handle, publication status, price, inventory, and sale availability.
- The Gallery owns its curated Hebrew title and description, display order, verified manufacturer specifications, and reviewed image set.
- Link records only on one exact, normalized SKU on each side. Ambiguous/missing SKU, duplicate SKU, unknown item, and conflicting identity go to review; do not guess, create a public item, or delete an existing item.
- Shopify updates may refresh the Gallery's private Shopify binding and publication state. They must not replace Gallery copy, specs, order, or images.
- Gallery changes may write only dedicated `toptik_gallery` Shopify metafields using `metafieldsSet` on an exactly bound product/variant. Do not change Shopify core title, description, media, variants, price, inventory, tags, or publication status. Do not use `productSet`.
- Webhook delivery is an event trigger, not an ordered source of truth. A worker must fetch current Shopify data by product GID, compare timestamps, and be idempotent before changing a binding.

## Present in this branch

- `POST /api/webhooks/shopify/products` verifies HMAC over the raw body, the configured shop domain, an allowlisted product topic, and payload shape before touching storage.
- The endpoint inserts into a private deduplicated inbox. Shopify retry of an already accepted delivery returns 200.
- Migration `20260930_shopify_gallery_sync_inbox.sql` defines private webhook-event, exact-SKU binding, and outbound metafield outbox tables. RLS is enabled and no public policies are created.
- No event processor, reconciliation schedule, Shopify GraphQL client, outbox producer, or metafield writer is included yet. Thus neither direction is synchronized by this patch.

## Required before a real test

1. Create/install a first-party custom app for the TopTik store and request only the product read/write access needed for product identity and dedicated metafields. Confirm the exact app and scope set in Shopify Admin; do not broaden access for unrelated commerce operations.
2. Set `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_WEBHOOK_SECRET`, and a private Admin API access token as Vercel secrets only after the app exists. No secret values belong in code, docs, logs, or the public client.
3. Apply the migration to an isolated Supabase test project first. Keep all new tables private to service-role server code.
4. Subscribe to `products/create`, `products/update`, and `products/delete`; use webhook delivery IDs for idempotency and `updated_at`/trigger timestamps because Shopify does not guarantee event order.
5. Implement and test the worker: read Shopify's current record, normalize SKUs on both sides, require a one-to-one match, write only binding/publication metadata, and send every unmatched/conflicting case to a review queue.
6. Implement the outbox producer from the Gallery's approved content fields and the GraphQL writer for the dedicated metafield namespace. Use compare-and-set protection so an external edit is not overwritten silently; surface conflicts for review.
7. Verify both directions in a development Shopify store and isolated Supabase database, including duplicate/reordered webhook deliveries, SKU changes, unpublished products, retries, rate limits, and rollback. Then request a separate production activation review.

Shopify documents webhook delivery IDs/HMAC headers and warns that event order is not guaranteed: https://shopify.dev/docs/apps/build/webhooks. Subscription setup: https://shopify.dev/docs/apps/build/webhooks/subscribe. `metafieldsSet` is atomic and supports compare-and-set via `compareDigest`: https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet.
