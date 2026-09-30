-- Shopify integration foundation. This migration is code-only until manually
-- reviewed and applied; all three tables are private (no anon/auth policies).
-- Product events are an inbox, never direct instructions to overwrite catalog
-- content. Exact-SKU reconciliation belongs to a separately tested worker.

create table if not exists public.shopify_webhook_events (
  id uuid primary key default gen_random_uuid(),
  delivery_id text not null unique,
  topic text not null check (topic in ('products/create', 'products/update', 'products/delete')),
  shop_domain text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'review', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text
);

create index if not exists shopify_webhook_events_pending_idx
  on public.shopify_webhook_events (received_at)
  where status in ('pending', 'failed');

create table if not exists public.shopify_gallery_bindings (
  catalog_key text primary key,
  carousel_item_id uuid not null references public.carousel_items(id) on delete restrict,
  product_gid text not null,
  variant_gid text not null unique,
  product_handle text not null,
  is_published boolean not null,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists shopify_gallery_bindings_item_idx
  on public.shopify_gallery_bindings (carousel_item_id);

create table if not exists public.shopify_gallery_metafield_outbox (
  id uuid primary key default gen_random_uuid(),
  carousel_item_id uuid not null references public.carousel_items(id) on delete restrict,
  catalog_key text not null,
  content_hash text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'synced', 'failed', 'review')),
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  synced_at timestamptz,
  last_error text,
  unique (carousel_item_id, content_hash)
);

create index if not exists shopify_gallery_metafield_outbox_pending_idx
  on public.shopify_gallery_metafield_outbox (created_at)
  where status in ('pending', 'failed');

alter table public.shopify_webhook_events enable row level security;
alter table public.shopify_gallery_bindings enable row level security;
alter table public.shopify_gallery_metafield_outbox enable row level security;

-- Deliberately create no policies: only the server-side service role can access
-- the inbox, SKU bindings, and outbound queue. Never expose webhook payloads.
