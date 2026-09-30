-- Reviewed existing-catalog COPYONLY activation. No product/content/commerce writes.
-- Apply after the sync inbox, patch and baseline seed migrations.
-- Reviewed catalog handles use ASCII letters/digits and Hebrew letters only.
-- A new character repertoire requires a reviewed SQL/runtime change.
create or replace function public.shopify_safe_product_handle(p_handle text)
returns boolean language sql immutable parallel safe set search_path = public, pg_temp as $$
  select coalesce(length(p_handle) between 1 and 255
    and p_handle ~ '^[A-Za-z0-9א-ת][A-Za-z0-9א-ת-]*$', false);
$$;

alter table public.shopify_gallery_public_links
  drop constraint if exists shopify_gallery_public_links_check;
alter table public.shopify_gallery_public_links
  add constraint shopify_gallery_public_links_check check
  (not is_published or (public.shopify_safe_product_handle(product_handle) and variant_id ~ '^[0-9]+$'));

create table if not exists public.shopify_gallery_copy_activations (
  approval_id text primary key,
  manifest_sha256 text not null,
  source_file_sha256 text not null,
  manifest jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists public.shopify_gallery_copy_eligibility (
  product_gid text primary key check (product_gid ~ '^gid://shopify/Product/[0-9]+$'),
  catalog_key text not null unique check (catalog_key ~ '^[A-Z0-9]+$'),
  carousel_item_id uuid not null unique references public.carousel_items(id) on delete restrict,
  variant_gid text not null unique check (variant_gid ~ '^gid://shopify/ProductVariant/[0-9]+$'),
  exact_gallery_sku text not null,
  exact_shopify_sku text not null,
  approved_product_handle text not null check (public.shopify_safe_product_handle(approved_product_handle)),
  allowed_fields text[] not null default array['title','description','seoTitle','seoDescription']
    check (allowed_fields = array['title','description','seoTitle','seoDescription']),
  enabled boolean not null default false,
  approval_id text not null references public.shopify_gallery_copy_activations(approval_id),
  approved_source_updated_at timestamptz not null,
  alias_evidence jsonb not null,
  approved_at timestamptz not null default now()
);
create table if not exists public.shopify_gallery_copy_activation_receipts (
  catalog_key text primary key references public.shopify_gallery_copy_eligibility(catalog_key),
  approval_id text not null references public.shopify_gallery_copy_activations(approval_id),
  snapshot jsonb not null
);
create table if not exists public.shopify_gallery_copy_activation_events (
  approval_id text not null references public.shopify_gallery_copy_activations(approval_id),
  event_kind text not null check (event_kind in ('created','enabled')),
  occurred_at timestamptz not null default now(),
  primary key (approval_id,event_kind)
);
create or replace function public.reject_shopify_copy_approval_mutation()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'shopify_gallery_copy_eligibility' and tg_op = 'UPDATE'
    and to_jsonb(new)-'enabled' = to_jsonb(old)-'enabled' then return new; end if;
  raise exception 'SYNC_COPY_APPROVAL_IMMUTABLE';
end;
$$;
do $$ declare v_table text; begin
  foreach v_table in array array['shopify_gallery_copy_activations','shopify_gallery_copy_eligibility',
    'shopify_gallery_copy_activation_receipts','shopify_gallery_copy_activation_events'] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',v_table);
    execute format('grant select on public.%I to service_role',v_table);
    execute format('drop trigger if exists immutable_copy_approval on public.%I',v_table);
    execute format('create trigger immutable_copy_approval before update or delete on public.%I for each row execute function public.reject_shopify_copy_approval_mutation()',v_table);
  end loop;
end $$;

-- Shared transaction check: approval can never be inferred from normalized SKU.
create or replace function public.assert_shopify_verified_copy_identity(
  p_item_id uuid,p_catalog_key text,p_exact_sku text,p_product_gid text,p_variant_gid text,p_exact_shopify_sku text
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from public.shopify_gallery_copy_eligibility e
    join public.carousel_items i on i.id=e.carousel_item_id
    join public.shopify_gallery_bindings b on b.catalog_key=e.catalog_key
    join public.shopify_gallery_sync_state s on s.catalog_key=e.catalog_key
    where e.enabled and e.carousel_item_id=p_item_id and e.catalog_key=p_catalog_key
      and e.exact_gallery_sku=p_exact_sku and e.exact_shopify_sku=p_exact_shopify_sku
      and e.product_gid=p_product_gid and e.variant_gid=p_variant_gid
      and e.allowed_fields=array['title','description','seoTitle','seoDescription']
      and i.catalog_number=e.exact_gallery_sku
      and b.carousel_item_id=e.carousel_item_id and b.product_gid=e.product_gid and b.variant_gid=e.variant_gid
      and b.product_handle=e.approved_product_handle and b.is_published
      and s.gallery_baseline_payload is not null and s.shopify_baseline_payload is not null
  ) or (select count(*) from public.shopify_gallery_bindings where product_gid=p_product_gid) <> 1
    or (select count(*) from public.carousel_items i where
      regexp_replace(regexp_replace(upper(coalesce(i.catalog_number,'')),'[^A-Z0-9]','','g'),'^(P[0-9]{2}.*)TU$','\1')=p_catalog_key) <> 1
  then raise exception 'SYNC_COPY_APPROVAL_MISSING_OR_CHANGED'; end if;
end;
$$;

-- Narrow read-only authorization immediately before the external Shopify call.
-- The caller still owns the bounded product lease throughout that HTTP request.
create or replace function public.assert_shopify_verified_copy_write(
  p_item_id uuid,p_catalog_key text,p_exact_sku text,p_product_gid text,p_variant_gid text,
  p_expected_version timestamptz,p_exact_shopify_sku text,p_lease_owner uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform set_config('lock_timeout','3000ms',true);
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  perform public.assert_shopify_verified_copy_identity(p_item_id,p_catalog_key,p_exact_sku,p_product_gid,p_variant_gid,p_exact_shopify_sku);
  if p_lease_owner is null or not exists (select 1 from public.shopify_gallery_reconciliation_leases
    where product_gid=p_product_gid and owner=p_lease_owner and expires_at>clock_timestamp() for update)
  then raise exception 'SYNC_COPY_LEASE_LOST'; end if;
  if p_expected_version is null or not exists (select 1 from public.carousel_items
    where id=p_item_id and copy_updated_at=p_expected_version for update)
  then raise exception 'SYNC_COPY_STALE_EDIT_RELOAD'; end if;
  return true;
end;
$$;

create or replace function public.patch_shopify_verified_copy(
  p_item_id uuid,p_catalog_key text,p_exact_sku text,p_product_gid text,p_variant_gid text,
  p_expected_version timestamptz,p_copy jsonb,p_exact_shopify_sku text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform set_config('lock_timeout','3000ms',true);
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  perform public.assert_shopify_verified_copy_identity(p_item_id,p_catalog_key,p_exact_sku,p_product_gid,p_variant_gid,p_exact_shopify_sku);
  return public.patch_shopify_canary_copy(p_item_id,p_catalog_key,p_exact_sku,p_product_gid,p_variant_gid,p_expected_version,p_copy);
end;
$$;

-- Shopify -> Gallery copy uses its OWN unexpired product lease and creates no
-- outbound event. Description text and raw HTML are one atomic field pair.
create or replace function public.apply_shopify_verified_copy(
  p_item_id uuid,p_catalog_key text,p_exact_sku text,p_product_gid text,p_variant_gid text,
  p_expected_version timestamptz,p_copy jsonb,p_exact_shopify_sku text,p_lease_owner uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_previous public.carousel_items%rowtype; v_version timestamptz; v_content jsonb;
begin
  if p_item_id is null or p_expected_version is null
    or jsonb_typeof(p_copy) is distinct from 'object'
    or not (p_copy ?& array['title','description','descriptionHtml','seoTitle','seoDescription'])
    or exists (select 1 from jsonb_object_keys(p_copy) key where key not in ('title','description','descriptionHtml','seoTitle','seoDescription'))
    or jsonb_typeof(p_copy->'title') is distinct from 'string' or length(p_copy->>'title') not between 1 and 120
    or jsonb_typeof(p_copy->'description') is distinct from 'string' or length(p_copy->>'description') > 50000
    or jsonb_typeof(p_copy->'descriptionHtml') not in ('string','null') or length(p_copy->>'descriptionHtml') > 250000
    or jsonb_typeof(p_copy->'seoTitle') not in ('string','null') or length(p_copy->>'seoTitle') > 512
    or jsonb_typeof(p_copy->'seoDescription') not in ('string','null') or length(p_copy->>'seoDescription') > 5000
  then raise exception 'SYNC_COPY_PATCH_INVALID'; end if;
  perform set_config('lock_timeout','3000ms',true);
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  perform public.assert_shopify_verified_copy_identity(p_item_id,p_catalog_key,p_exact_sku,p_product_gid,p_variant_gid,p_exact_shopify_sku);
  if p_lease_owner is null or not exists (select 1 from public.shopify_gallery_reconciliation_leases
    where product_gid=p_product_gid and owner=p_lease_owner and expires_at>clock_timestamp() for update)
  then raise exception 'SYNC_COPY_LEASE_LOST'; end if;
  select * into v_previous from public.carousel_items where id=p_item_id for update;
  if v_previous.copy_updated_at is distinct from p_expected_version then raise exception 'SYNC_COPY_STALE_EDIT_RELOAD'; end if;
  v_content := jsonb_build_object('title',v_previous.title,'description',coalesce(v_previous.description,''),
    'descriptionHtml',v_previous.description_html,'seoTitle',v_previous.seo_title,'seoDescription',v_previous.seo_description);
  if v_content=p_copy then return jsonb_build_object('changed',false,'copyUpdatedAt',v_previous.copy_updated_at); end if;
  update public.carousel_items set title=p_copy->>'title',description=nullif(p_copy->>'description',''),
    description_html=p_copy->>'descriptionHtml',seo_title=p_copy->>'seoTitle',seo_description=p_copy->>'seoDescription',
    copy_updated_at=greatest(clock_timestamp(),v_previous.copy_updated_at+interval '1 microsecond')
    where id=p_item_id returning copy_updated_at into v_version;
  return jsonb_build_object('changed',true,'copyUpdatedAt',v_version);
end;
$$;

create or replace function public.verified_copy_current_receipt(p_item_id uuid,p_catalog_key text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'copy',jsonb_build_object('title',i.title,'description',i.description,'descriptionHtml',i.description_html,'seoTitle',i.seo_title,'seoDescription',i.seo_description),
    'copyUpdatedAt',i.copy_updated_at,'sku',i.catalog_number,
    'binding',(select to_jsonb(b) from public.shopify_gallery_bindings b where b.catalog_key=p_catalog_key),
    'state',(select to_jsonb(s) from public.shopify_gallery_sync_state s where s.catalog_key=p_catalog_key),
    'public_link',(select to_jsonb(l) from public.shopify_gallery_public_links l where l.catalog_key=p_catalog_key))
  from public.carousel_items i where i.id=p_item_id;
$$;
create or replace function public.verified_copy_protected_tables()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'items',(select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') from public.carousel_items i),
    'angles',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.carousel_item_angles a),
    'settings',(select coalesce(jsonb_agg(to_jsonb(s) order by id),'[]') from public.carousel_settings s),
    'outbox',(select coalesce(jsonb_agg(to_jsonb(o) order by id),'[]') from public.shopify_gallery_content_outbox o),
    'inbox',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from public.shopify_webhook_events e));
$$;

create or replace function public.activate_shopify_verified_catalog(p_manifest jsonb,p_enable boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_manifest_id constant text := 'verified-existing78-copy-activation-20260930-v1';
  v_manifest_hash constant text := '2ee25dd75e64c7858bc2f6d138fff7ab36055a8cf8b4936d6c499e1a3d38b87c';
  v_source_hash constant text := '73dc8b7b0946266ab647c214126f9e23619f674188989e24fe0811a6200bae10';
  v_row jsonb; v_expected jsonb; v_item public.carousel_items%rowtype;
  v_binding public.shopify_gallery_bindings%rowtype;
  v_state public.shopify_gallery_sync_state%rowtype;
  v_link public.shopify_gallery_public_links%rowtype;
  v_shopify jsonb; v_gallery_copy jsonb; v_receipt jsonb; v_protected jsonb;
  v_key text; v_id uuid; v_product text; v_variant text; v_exists boolean;
  v_new_count integer := 0; v_changed boolean := false; v_enabled boolean;
begin
  if p_enable is null or jsonb_typeof(p_manifest) is distinct from 'object'
    or octet_length(p_manifest::text)>6000000
    or p_manifest->>'manifestId' is distinct from v_manifest_id
    or encode(pg_catalog.sha256(pg_catalog.convert_to(p_manifest::text,'UTF8')),'hex') <> v_manifest_hash
    or jsonb_array_length(p_manifest->'rows') <> 78
    or jsonb_array_length(p_manifest->'expectedGallery') <> 82
  then raise exception 'SYNC_COPY_ACTIVATION_MANIFEST_MISMATCH'; end if;
  perform set_config('lock_timeout','3000ms',true);
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  lock table public.carousel_items,public.carousel_item_angles,public.carousel_settings,
    public.shopify_gallery_bindings,public.shopify_gallery_sync_state,public.shopify_gallery_public_links,
    public.shopify_gallery_content_outbox,public.shopify_webhook_events,
    public.shopify_gallery_copy_eligibility,public.shopify_gallery_copy_activations,
    public.shopify_gallery_copy_activation_receipts,public.shopify_gallery_copy_activation_events
    in share row exclusive mode;
  if exists (select 1 from public.shopify_gallery_reconciliation_leases l
    join jsonb_array_elements(p_manifest->'rows') r on l.product_gid=r.value->'shopifySnapshot'->>'id'
    where l.expires_at>clock_timestamp())
  then raise exception 'SYNC_COPY_BUSY_RETRY'; end if;
  if (select count(*) from public.carousel_items) <> 82 then raise exception 'SYNC_COPY_ACTIVATION_CATALOG_CHANGED'; end if;
  for v_expected in select value from jsonb_array_elements(p_manifest->'expectedGallery') loop
    select * into v_item from public.carousel_items where id=(v_expected->>'id')::uuid;
    if not found or v_item.catalog_number is distinct from v_expected->>'catalog_number'
      or v_item.copy_updated_at is distinct from (v_expected->>'copy_updated_at')::timestamptz
      or jsonb_build_object('title',v_item.title,'description',v_item.description,
        'descriptionHtml',v_item.description_html,'seoTitle',v_item.seo_title,'seoDescription',v_item.seo_description)
        is distinct from v_expected->'copy'
    then raise exception 'SYNC_COPY_ACTIVATION_CATALOG_CHANGED'; end if;
  end loop;
  v_protected := public.verified_copy_protected_tables();
  select exists(select 1 from public.shopify_gallery_copy_activations where approval_id=v_manifest_id) into v_exists;
  if v_exists then
    if not exists(select 1 from public.shopify_gallery_copy_activations where approval_id=v_manifest_id
      and manifest_sha256=v_manifest_hash and source_file_sha256=v_source_hash and manifest=p_manifest)
      or (select count(*) from public.shopify_gallery_copy_eligibility where approval_id=v_manifest_id) <> 78
      or (select count(*) from public.shopify_gallery_copy_activation_receipts where approval_id=v_manifest_id) <> 78
    then raise exception 'SYNC_COPY_ACTIVATION_RECEIPT_CHANGED'; end if;
    for v_row in select value from jsonb_array_elements(p_manifest->'rows') loop
      if not exists (select 1 from public.shopify_gallery_copy_activation_receipts r
        where r.catalog_key=v_row->>'catalogKey' and r.approval_id=v_manifest_id
          and r.snapshot=public.verified_copy_current_receipt((v_row->>'galleryItemId')::uuid,v_row->>'catalogKey'))
      then raise exception 'SYNC_COPY_ACTIVATION_RECEIPT_CHANGED'; end if;
    end loop;
  else
    if exists(select 1 from public.shopify_gallery_copy_eligibility)
      or exists(select 1 from public.shopify_gallery_copy_activations)
    then raise exception 'SYNC_COPY_ACTIVATION_APPROVAL_CONFLICT'; end if;
    insert into public.shopify_gallery_copy_activations(approval_id,manifest_sha256,source_file_sha256,manifest)
      values(v_manifest_id,v_manifest_hash,v_source_hash,p_manifest);
    for v_row in select value from jsonb_array_elements(p_manifest->'rows') order by value->>'catalogKey' loop
      v_key:=v_row->>'catalogKey'; v_id:=(v_row->>'galleryItemId')::uuid;
      v_shopify:=v_row->'shopifySnapshot'; v_product:=v_shopify->>'id';
      v_variant:=v_shopify->'variants'->0->>'id';
      v_gallery_copy:=v_row->'galleryCopy';
      if v_row->'issues' is not null and v_row->'issues'<>'[]'::jsonb
        or v_shopify->>'status' is distinct from 'ACTIVE' or v_shopify->>'publishedOnPublication' is distinct from 'true'
        or jsonb_array_length(v_shopify->'variants')<>1
        or v_shopify->'variants'->0->>'sku' is distinct from v_row->>'shopifySku'
        or not public.shopify_safe_product_handle(v_shopify->>'handle')
        or v_row->'identityEvidence'->>'liveProductGid' is distinct from v_product
        or v_row->'identityEvidence'->>'liveVariantGid' is distinct from v_variant
        or v_row->'identityEvidence'->>'gallerySku' is distinct from v_row->>'gallerySku'
        or v_row->'identityEvidence'->>'shopifySku' is distinct from v_row->>'shopifySku'
        or (select count(*) from public.carousel_items i where
          regexp_replace(regexp_replace(upper(coalesce(i.catalog_number,'')),'[^A-Z0-9]','','g'),'^(P[0-9]{2}.*)TU$','\1')=v_key) <> 1
        or not exists(select 1 from public.carousel_items i where i.id=v_id and i.catalog_number=v_row->>'gallerySku')
      then raise exception 'SYNC_COPY_ACTIVATION_IDENTITY_INVALID'; end if;
      if v_row->'expectedBinding' is distinct from 'null'::jsonb then
        select * into v_binding from public.shopify_gallery_bindings where catalog_key=v_key;
        select * into v_state from public.shopify_gallery_sync_state where catalog_key=v_key;
        select * into v_link from public.shopify_gallery_public_links where catalog_key=v_key;
        if to_jsonb(v_binding) is distinct from to_jsonb(jsonb_populate_record(null::public.shopify_gallery_bindings,v_row->'expectedBinding'))
          or to_jsonb(v_state) is distinct from to_jsonb(jsonb_populate_record(null::public.shopify_gallery_sync_state,v_row->'expectedState'))
          or to_jsonb(v_link) is distinct from to_jsonb(jsonb_populate_record(null::public.shopify_gallery_public_links,v_row->'expectedPublicLink'))
        then raise exception 'SYNC_COPY_ACTIVATION_BASELINE_CHANGED'; end if;
      else
        if exists(select 1 from public.shopify_gallery_bindings b where b.catalog_key=v_key or b.carousel_item_id=v_id
          or b.product_gid=v_product or b.variant_gid=v_variant)
          or exists(select 1 from public.shopify_gallery_sync_state where catalog_key=v_key)
          or exists(select 1 from public.shopify_gallery_public_links where catalog_key=v_key)
        then raise exception 'SYNC_COPY_ACTIVATION_BINDING_CONFLICT'; end if;
        insert into public.shopify_gallery_bindings(catalog_key,carousel_item_id,product_gid,variant_gid,product_handle,is_published,source_updated_at)
          values(v_key,v_id,v_product,v_variant,v_shopify->>'handle',true,(v_shopify->>'updatedAt')::timestamptz);
        insert into public.shopify_gallery_sync_state(catalog_key,last_synced_payload,last_synced_hash,
          gallery_baseline_payload,shopify_baseline_payload,gallery_updated_at,shopify_updated_at)
          select v_key,b.last_synced_payload,b.last_synced_hash,b.gallery_baseline_payload,b.shopify_baseline_payload,
            b.gallery_updated_at,b.shopify_updated_at
          from jsonb_populate_record(null::public.shopify_gallery_sync_state,v_row->'proposedBaseline') b;
        insert into public.shopify_gallery_public_links(catalog_key,product_handle,variant_id,is_published)
          values(v_key,v_shopify->>'handle',replace(v_variant,'gid://shopify/ProductVariant/',''),true);
        select * into v_binding from public.shopify_gallery_bindings where catalog_key=v_key;
        select * into v_state from public.shopify_gallery_sync_state where catalog_key=v_key;
        select * into v_link from public.shopify_gallery_public_links where catalog_key=v_key;
        v_new_count:=v_new_count+1;
      end if;
      if v_binding.product_gid is distinct from v_product or v_binding.variant_gid is distinct from v_variant
        or v_binding.carousel_item_id is distinct from v_id or v_binding.product_handle is distinct from v_shopify->>'handle'
        or not v_binding.is_published or v_binding.source_updated_at is distinct from (v_shopify->>'updatedAt')::timestamptz
        or v_state.gallery_baseline_payload is distinct from v_gallery_copy
        or v_state.gallery_updated_at is distinct from (v_row->>'galleryCopyUpdatedAt')::timestamptz
        or v_state.shopify_updated_at is distinct from (v_shopify->>'updatedAt')::timestamptz
        or v_state.shopify_baseline_payload->>'title' is distinct from v_shopify->>'title'
        or v_state.shopify_baseline_payload->>'descriptionHtml' is distinct from v_shopify->>'descriptionHtml'
        or v_state.shopify_baseline_payload->>'seoTitle' is distinct from v_shopify->>'seoTitle'
        or v_state.shopify_baseline_payload->>'seoDescription' is distinct from v_shopify->>'seoDescription'
        or v_state.shopify_baseline_payload is null
        or v_link.product_handle is distinct from v_shopify->>'handle' or not v_link.is_published
        or v_link.variant_id is distinct from replace(v_variant,'gid://shopify/ProductVariant/','')
        or (select count(*) from public.shopify_gallery_bindings where product_gid=v_product)<>1
      then raise exception 'SYNC_COPY_ACTIVATION_FRESH_COPY_MISMATCH'; end if;
      insert into public.shopify_gallery_copy_eligibility(product_gid,catalog_key,carousel_item_id,variant_gid,
        exact_gallery_sku,exact_shopify_sku,approved_product_handle,approval_id,approved_source_updated_at,alias_evidence)
        values(v_product,v_key,v_id,v_variant,v_row->>'gallerySku',v_row->>'shopifySku',v_shopify->>'handle',
          v_manifest_id,(v_shopify->>'updatedAt')::timestamptz,v_row->'identityEvidence');
      insert into public.shopify_gallery_copy_activation_receipts(catalog_key,approval_id,snapshot)
        values(v_key,v_manifest_id,public.verified_copy_current_receipt(v_id,v_key));
    end loop;
    if v_new_count<>20 then raise exception 'SYNC_COPY_ACTIVATION_COUNT_MISMATCH'; end if;
    insert into public.shopify_gallery_copy_activation_events(approval_id,event_kind) values(v_manifest_id,'created');
    v_changed:=true;
  end if;
  if p_enable and exists(select 1 from public.shopify_gallery_copy_eligibility where approval_id=v_manifest_id and not enabled) then
    update public.shopify_gallery_copy_eligibility set enabled=true where approval_id=v_manifest_id;
    insert into public.shopify_gallery_copy_activation_events(approval_id,event_kind) values(v_manifest_id,'enabled');
    v_changed:=true;
  end if;
  if public.verified_copy_protected_tables() is distinct from v_protected
    then raise exception 'SYNC_COPY_ACTIVATION_UNEXPECTED_WRITE'; end if;
  select bool_and(enabled) into v_enabled from public.shopify_gallery_copy_eligibility where approval_id=v_manifest_id;
  return jsonb_build_object('changed',v_changed,'eligibleCount',78,'newBaselineCount',v_new_count,'enabled',v_enabled);
end;
$$;

revoke all on function public.shopify_safe_product_handle(text) from public,anon,authenticated;
grant execute on function public.shopify_safe_product_handle(text) to service_role;
revoke all on function public.reject_shopify_copy_approval_mutation() from public,anon,authenticated,service_role;
revoke all on function public.assert_shopify_verified_copy_identity(uuid,text,text,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.assert_shopify_verified_copy_write(uuid,text,text,text,text,timestamptz,text,uuid) from public,anon,authenticated;
grant execute on function public.assert_shopify_verified_copy_write(uuid,text,text,text,text,timestamptz,text,uuid) to service_role;
revoke all on function public.verified_copy_current_receipt(uuid,text) from public,anon,authenticated;
revoke all on function public.verified_copy_protected_tables() from public,anon,authenticated;
grant execute on function public.verified_copy_current_receipt(uuid,text),public.verified_copy_protected_tables() to service_role;
revoke all on function public.patch_shopify_verified_copy(uuid,text,text,text,text,timestamptz,jsonb,text) from public,anon,authenticated;
revoke all on function public.apply_shopify_verified_copy(uuid,text,text,text,text,timestamptz,jsonb,text,uuid) from public,anon,authenticated;
revoke all on function public.activate_shopify_verified_catalog(jsonb,boolean) from public,anon,authenticated;
grant execute on function public.patch_shopify_verified_copy(uuid,text,text,text,text,timestamptz,jsonb,text),
  public.apply_shopify_verified_copy(uuid,text,text,text,text,timestamptz,jsonb,text,uuid),
  public.activate_shopify_verified_catalog(jsonb,boolean) to service_role;
