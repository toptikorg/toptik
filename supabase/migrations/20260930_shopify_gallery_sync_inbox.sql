-- Shopify integration foundation. This migration is code-only until manually
-- reviewed and applied; all sync tables are private except the narrow public
-- product-link projection (no public write policies).
-- Product events are an inbox, never direct instructions to overwrite catalog
-- content. Exact-SKU reconciliation belongs to a separately tested worker.

alter table public.carousel_items
  add column if not exists description_html text null,
  add column if not exists seo_title text null,
  add column if not exists seo_description text null,
  add column if not exists copy_updated_at timestamptz not null default now();

create table if not exists public.shopify_webhook_events (
  id uuid primary key default gen_random_uuid(),
  delivery_id text not null unique,
  topic text not null check (topic in ('products/create', 'products/update', 'products/delete')),
  shop_domain text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'review', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  received_at timestamptz not null default now(),
  claimed_at timestamptz,
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

create unique index if not exists shopify_gallery_bindings_item_unique_idx
  on public.shopify_gallery_bindings (carousel_item_id);

-- A deliberately small public projection for verified product-page navigation.
-- It contains no Shopify credential or private webhook data.
create table if not exists public.shopify_gallery_public_links (
  catalog_key text primary key,
  product_handle text not null default '',
  variant_id text not null default '0',
  is_published boolean not null,
  updated_at timestamptz not null default now(),
  check (not is_published or (product_handle ~ '^[a-z0-9][a-z0-9-]*$' and variant_id ~ '^[0-9]+$'))
);

alter table public.shopify_gallery_public_links enable row level security;
drop policy if exists "shopify_gallery_public_links_read" on public.shopify_gallery_public_links;
create policy "shopify_gallery_public_links_read"
  on public.shopify_gallery_public_links
  for select to anon, authenticated using (true);

grant select on public.shopify_gallery_public_links to anon, authenticated;

create table if not exists public.shopify_gallery_content_outbox (
  id uuid primary key default gen_random_uuid(),
  carousel_item_id uuid not null references public.carousel_items(id) on delete restrict,
  catalog_key text not null,
  content_hash text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'synced', 'failed', 'review')),
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  synced_at timestamptz,
  last_error text,
  unique (carousel_item_id, content_hash)
);

create table if not exists public.shopify_gallery_sync_state (
  catalog_key text primary key,
  last_synced_payload jsonb not null,
  last_synced_hash text not null,
  gallery_baseline_payload jsonb,
  shopify_baseline_payload jsonb,
  gallery_updated_at timestamptz not null default now(),
  shopify_updated_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);

-- Reconciliation includes external HTTP calls, so a row-claim transaction alone
-- cannot serialize two inbox/outbox workers for the same Shopify product.
-- The lease is longer than every sync route's hard 60-second runtime budget.
create table if not exists public.shopify_gallery_reconciliation_leases (
  product_gid text primary key,
  owner uuid not null,
  expires_at timestamptz not null
);
alter table public.shopify_gallery_reconciliation_leases enable row level security;

create or replace function public.acquire_shopify_reconciliation_lease(p_product_gid text, p_owner uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare affected integer;
begin
  if p_product_gid !~ '^gid://shopify/Product/[0-9]+$' or p_owner is null then return false; end if;
  -- Share this short transaction lock with the atomic Gallery save. Either its
  -- edit commits first, or it observes the active lease and asks for a retry.
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  insert into public.shopify_gallery_reconciliation_leases(product_gid, owner, expires_at)
  values (p_product_gid, p_owner, now() + interval '5 minutes')
  on conflict (product_gid) do update set owner = excluded.owner, expires_at = excluded.expires_at
  where shopify_gallery_reconciliation_leases.expires_at <= now();
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.release_shopify_reconciliation_lease(p_product_gid text, p_owner uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from public.shopify_gallery_reconciliation_leases
  where product_gid = p_product_gid and owner = p_owner;
$$;

-- Save copy and its durable delivery record together. Version validation and
-- writes happen under the same item row locks; a preflight SELECT in JS is not
-- sufficient because a worker can change the row before a later UPSERT.
create or replace function public.save_gallery_items_with_copy_cas(p_items jsonb, p_expected_versions jsonb)
returns table(id uuid) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  incoming jsonb;
  previous public.carousel_items%rowtype;
  saved public.carousel_items%rowtype;
  exists_before boolean;
  expected_version text;
  columns_sql text;
  projected_columns_sql text;
  content jsonb;
  previous_content jsonb;
  sku_key text;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_typeof(p_expected_versions) is distinct from 'object'
    or jsonb_array_length(p_items) > 5000 then
    raise exception 'SYNC_GALLERY_SAVE_INPUT_INVALID';
  end if;
  if (select count(*) <> count(distinct value->>'id') from jsonb_array_elements(p_items)) then
    raise exception 'SYNC_GALLERY_SAVE_DUPLICATE_ID';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_expected_versions) expected(item_id)
    where not exists (select 1 from jsonb_array_elements(p_items) item where item.value->>'id' = expected.item_id)
  ) then raise exception 'SYNC_GALLERY_DELETE_REQUIRES_ARCHIVE'; end if;
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  if exists (
    select 1 from public.shopify_gallery_reconciliation_leases lease
    join public.shopify_gallery_bindings binding on binding.product_gid = lease.product_gid
    join jsonb_array_elements(p_items) item on (item.value->>'id')::uuid = binding.carousel_item_id
    where lease.expires_at > now()
  ) then raise exception 'SYNC_COPY_BUSY_RETRY'; end if;

  for incoming in select value from jsonb_array_elements(p_items) order by value->>'id' loop
    if not (incoming ? 'id') or not (p_expected_versions ? (incoming->>'id')) then
      raise exception 'SYNC_COPY_VERSION_REQUIRED';
    end if;
    select * into previous from public.carousel_items item where item.id = (incoming->>'id')::uuid for update;
    exists_before := found;
    expected_version := p_expected_versions->>(incoming->>'id');
    if (exists_before and (expected_version is null or previous.copy_updated_at <> expected_version::timestamptz))
      or (not exists_before and expected_version is not null) then
      raise exception 'SYNC_COPY_STALE_EDIT_RELOAD';
    end if;
    -- The allowlist is fixed, while pg_attribute filters optional metadata
    -- columns absent in older deployments. Never alter unrelated table fields.
    select string_agg(format('%I', keys.key), ', ' order by keys.key),
           string_agg(format('record.%I', keys.key), ', ' order by keys.key)
      into columns_sql, projected_columns_sql
    from jsonb_object_keys(incoming) keys(key)
    join pg_attribute attr on attr.attrelid = 'public.carousel_items'::regclass
      and attr.attname = keys.key and not attr.attisdropped and attr.attnum > 0
    where keys.key = any(array['id','title','description','description_html','seo_title','seo_description','copy_updated_at',
      'catalog_number','source_url','cover_image_path','display_order','is_active','color',
      'dimensions','weight','sizes','available_colors','colors','tech_specs'])
      and (not exists_before or keys.key <> 'id');
    if exists_before then
      execute format('update public.carousel_items set (%s) = (select %s from jsonb_populate_record(null::public.carousel_items, $1) record) where id = $2 returning *',
        columns_sql, projected_columns_sql) using incoming, previous.id into saved;
    else
      execute format('insert into public.carousel_items (%s) select %s from jsonb_populate_record(null::public.carousel_items, $1) record returning *',
        columns_sql, projected_columns_sql) using incoming into saved;
    end if;
    content := jsonb_build_object('title',saved.title,'description',coalesce(saved.description,''),'descriptionHtml',saved.description_html,
      'seoTitle',saved.seo_title,'seoDescription',saved.seo_description);
    previous_content := case when exists_before then jsonb_build_object('title',previous.title,
      'description',coalesce(previous.description,''),'descriptionHtml',previous.description_html,'seoTitle',previous.seo_title,'seoDescription',previous.seo_description) else null end;
    sku_key := regexp_replace(upper(coalesce(saved.catalog_number,'')), '[^A-Z0-9]', '', 'g');
    if sku_key ~ '^P[0-9]{2}.*TU$' then sku_key := left(sku_key,length(sku_key)-2); end if;
    if content is distinct from previous_content and sku_key <> '' then
      insert into public.shopify_gallery_content_outbox
        (carousel_item_id,catalog_key,content_hash,payload,status,attempts,created_at,last_error)
      values (saved.id,sku_key,encode(pg_catalog.sha256(pg_catalog.convert_to(content::text,'UTF8')),'hex'),content,'pending',0,now(),null)
      on conflict (carousel_item_id,content_hash) do update set payload=excluded.payload,
        catalog_key=excluded.catalog_key,status='pending',attempts=0,created_at=now(),claimed_at=null,synced_at=null,last_error=null;
    end if;
    id := saved.id;
    return next;
  end loop;
end;
$$;

-- Keep independent pre-sync snapshots so existing copy differences are never
-- mistaken for new edits and overwritten during the first live bootstrap.
alter table public.shopify_gallery_sync_state
  add column if not exists gallery_baseline_payload jsonb,
  add column if not exists shopify_baseline_payload jsonb;

-- Preserve both values for private audit when concurrent edits collide.
-- Initial side-specific snapshots prevent pre-existing copy differences from
-- being mistaken for new edits during the first canary synchronization.
create table if not exists public.shopify_gallery_sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  conflict_key text not null unique,
  catalog_key text not null,
  carousel_item_id uuid not null references public.carousel_items(id) on delete restrict,
  product_gid text not null,
  field_name text not null check (field_name in ('title', 'description', 'seo_title', 'seo_description')),
  gallery_value text,
  shopify_value text,
  winner text not null check (winner in ('gallery', 'shopify', 'review')),
  gallery_updated_at timestamptz not null,
  shopify_updated_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Conditional binding update prevents a slow older webhook worker from
-- replacing a newer product handle/publication state. Unique identity conflicts
-- return false for human review; they never steal another SKU's binding.
create or replace function public.upsert_shopify_gallery_binding(
  p_catalog_key text,
  p_carousel_item_id uuid,
  p_product_gid text,
  p_variant_gid text,
  p_product_handle text,
  p_is_published boolean,
  p_source_updated_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.shopify_gallery_bindings%rowtype;
  affected integer;
begin
  if p_catalog_key !~ '^[A-Z0-9]+$'
    or p_product_gid !~ '^gid://shopify/Product/[0-9]+$'
    or p_variant_gid !~ '^gid://shopify/ProductVariant/[0-9]+$'
    or p_product_handle !~ '^[a-z0-9][a-z0-9-]*$'
    or p_source_updated_at is null then
    return false;
  end if;

  select * into existing
  from public.shopify_gallery_bindings
  where catalog_key = p_catalog_key
  for update;

  if found then
    if existing.carousel_item_id <> p_carousel_item_id
      or existing.product_gid <> p_product_gid
      or existing.variant_gid <> p_variant_gid then
      return false;
    end if;
    if existing.source_updated_at is not null and p_source_updated_at <= existing.source_updated_at then
      return true; -- stale event ignored; existing verified public link remains current
    end if;
    update public.shopify_gallery_bindings
      set product_handle = p_product_handle,
          is_published = p_is_published,
          source_updated_at = p_source_updated_at,
          synced_at = now()
      where catalog_key = p_catalog_key;
  else
    insert into public.shopify_gallery_bindings (
      catalog_key, carousel_item_id, product_gid, variant_gid, product_handle,
      is_published, source_updated_at, synced_at
    ) values (
      p_catalog_key, p_carousel_item_id, p_product_gid, p_variant_gid, p_product_handle,
      p_is_published, p_source_updated_at, now()
    ) on conflict do nothing;
    get diagnostics affected = row_count;
    if affected = 0 then return false; end if;
  end if;

  insert into public.shopify_gallery_public_links (
    catalog_key, product_handle, variant_id, is_published, updated_at
  ) values (
    p_catalog_key,
    case when p_is_published then p_product_handle else '' end,
    case when p_is_published then regexp_replace(p_variant_gid, '^gid://shopify/ProductVariant/', '') else '0' end,
    p_is_published, now()
  ) on conflict (catalog_key) do update set
    product_handle = excluded.product_handle,
    variant_id = excluded.variant_id,
    is_published = excluded.is_published,
    updated_at = excluded.updated_at;

  return true;
end;
$$;

-- Deactivate selected keys only when the Shopify snapshot is not older than
-- the binding. This runs atomically with the public-link projection update.
create or replace function public.deactivate_shopify_gallery_keys(
  p_product_gid text,
  p_catalog_keys text[],
  p_source_updated_at timestamptz
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed_keys text[];
begin
  if p_product_gid !~ '^gid://shopify/Product/[0-9]+$' or p_source_updated_at is null then
    return 0;
  end if;

  with changed as (
    update public.shopify_gallery_bindings
      set is_published = false, source_updated_at = p_source_updated_at, synced_at = now()
      where product_gid = p_product_gid
        and catalog_key = any(coalesce(p_catalog_keys, array[]::text[]))
        and (source_updated_at is null or source_updated_at <= p_source_updated_at)
      returning catalog_key
  ) select array_agg(catalog_key) into changed_keys from changed;

  if coalesce(array_length(changed_keys, 1), 0) > 0 then
    update public.shopify_gallery_public_links
      set is_published = false, product_handle = '', variant_id = '0', updated_at = now()
      where catalog_key = any(changed_keys);
  end if;
  return coalesce(array_length(changed_keys, 1), 0);
end;
$$;

-- Deactivate (never delete) bindings only when the event is at least as recent
-- as the binding currently stored. Null source timestamp is reserved for a
-- confirmed hard delete and may deactivate unconditionally.
create or replace function public.deactivate_shopify_gallery_product(
  p_product_gid text,
  p_source_updated_at timestamptz default null
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed_keys text[];
begin
  with changed as (
    update public.shopify_gallery_bindings
      set is_published = false, synced_at = now()
      where product_gid = p_product_gid
        and (p_source_updated_at is null or source_updated_at is null or source_updated_at <= p_source_updated_at)
      returning catalog_key
  ) select array_agg(catalog_key) into changed_keys from changed;

  if coalesce(array_length(changed_keys, 1), 0) > 0 then
    update public.shopify_gallery_public_links
      set is_published = false, product_handle = '', variant_id = '0', updated_at = now()
      where catalog_key = any(changed_keys);
  end if;
  return coalesce(array_length(changed_keys, 1), 0);
end;
$$;

create index if not exists shopify_gallery_content_outbox_pending_idx
  on public.shopify_gallery_content_outbox (created_at)
  where status in ('pending', 'failed');

alter table public.shopify_webhook_events enable row level security;
alter table public.shopify_gallery_bindings enable row level security;
alter table public.shopify_gallery_content_outbox enable row level security;
alter table public.shopify_gallery_sync_state enable row level security;
alter table public.shopify_gallery_sync_conflicts enable row level security;

-- Atomically claim work to tolerate overlapping cron invocations and Shopify
-- retries. Stale claims become available after 15 minutes; attempts are capped.
create or replace function public.claim_shopify_webhook_events(p_limit integer default 20)
returns setof public.shopify_webhook_events
language sql
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select id
    from public.shopify_webhook_events
    where attempts < 5
      and (status in ('pending', 'failed') or (status = 'processing' and claimed_at < now() - interval '15 minutes'))
    order by received_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 20), 50))
  )
  update public.shopify_webhook_events as event
    set status = 'processing', attempts = event.attempts + 1, claimed_at = now()
    from candidates
    where event.id = candidates.id
    returning event.*;
$$;

create or replace function public.claim_shopify_gallery_outbox(p_limit integer default 20)
returns setof public.shopify_gallery_content_outbox
language sql
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select id
    from public.shopify_gallery_content_outbox
    where attempts < 5
      and (status in ('pending', 'failed') or (status = 'processing' and claimed_at < now() - interval '15 minutes'))
    order by created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 20), 50))
  )
  update public.shopify_gallery_content_outbox as queued
    set status = 'processing', attempts = queued.attempts + 1, claimed_at = now()
    from candidates
    where queued.id = candidates.id
    returning queued.*;
$$;

revoke all on function public.claim_shopify_webhook_events(integer) from public, anon, authenticated;
revoke all on function public.acquire_shopify_reconciliation_lease(text, uuid) from public, anon, authenticated;
revoke all on function public.release_shopify_reconciliation_lease(text, uuid) from public, anon, authenticated;
revoke all on function public.save_gallery_items_with_copy_cas(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.claim_shopify_gallery_outbox(integer) from public, anon, authenticated;
revoke all on function public.upsert_shopify_gallery_binding(text, uuid, text, text, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.deactivate_shopify_gallery_product(text, timestamptz) from public, anon, authenticated;
revoke all on function public.deactivate_shopify_gallery_keys(text, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.claim_shopify_webhook_events(integer) to service_role;
grant execute on function public.acquire_shopify_reconciliation_lease(text, uuid) to service_role;
grant execute on function public.release_shopify_reconciliation_lease(text, uuid) to service_role;
grant execute on function public.save_gallery_items_with_copy_cas(jsonb, jsonb) to service_role;
grant execute on function public.claim_shopify_gallery_outbox(integer) to service_role;
grant execute on function public.upsert_shopify_gallery_binding(text, uuid, text, text, text, boolean, timestamptz) to service_role;
grant execute on function public.deactivate_shopify_gallery_product(text, timestamptz) to service_role;
grant execute on function public.deactivate_shopify_gallery_keys(text, text[], timestamptz) to service_role;

-- Do not depend on Supabase's project-specific default privileges. Workers use
-- direct PostgREST table access as well as the security-definer RPCs above.
revoke all on table public.shopify_webhook_events,
  public.shopify_gallery_bindings, public.shopify_gallery_content_outbox,
  public.shopify_gallery_sync_state, public.shopify_gallery_sync_conflicts,
  public.shopify_gallery_reconciliation_leases from public, anon, authenticated, service_role;
grant usage on schema public to service_role;
grant select, insert, update on table public.shopify_webhook_events,
  public.shopify_gallery_content_outbox, public.shopify_gallery_sync_state to service_role;
grant select on table public.shopify_gallery_bindings to service_role;
grant select, insert on table public.shopify_gallery_sync_conflicts to service_role;
-- Binding/projection changes and lease ownership remain RPC-only.
revoke all on table public.shopify_gallery_public_links from public, anon, authenticated, service_role;
grant select on table public.shopify_gallery_public_links to anon, authenticated, service_role;
-- Preserve any pre-existing admin privileges, and guarantee the narrower
-- direct read/CAS-copy update access needed by the sync worker itself.
grant select on table public.carousel_items to service_role;
grant update (title, description, description_html, seo_title, seo_description, copy_updated_at)
  on table public.carousel_items to service_role;

-- Deliberately create no policies for the inbox, bindings, outbox, sync state,
-- or conflict audit: only service_role may read/write them.
-- state: only server-side service-role code can access these tables. The only
-- public surface is the narrow, verified product-link projection above.
