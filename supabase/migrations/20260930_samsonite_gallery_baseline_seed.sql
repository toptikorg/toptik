-- One reviewed, baseline-only persistence operation. No Shopify mutations,
-- outbox writes, eligibility changes, or updates of existing catalog rows.
create table if not exists public.shopify_gallery_seed_manifests (
  manifest_id text primary key,
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  source_file_sha256 text not null check (source_file_sha256 ~ '^[0-9a-f]{64}$'),
  manifest jsonb not null,
  applied_at timestamptz not null default now()
);
create table if not exists public.shopify_gallery_seed_receipts (
  catalog_key text primary key,
  manifest_id text not null references public.shopify_gallery_seed_manifests(manifest_id) on delete restrict,
  carousel_item_id uuid not null unique references public.carousel_items(id) on delete restrict,
  seed_snapshot jsonb not null
);
alter table public.shopify_gallery_seed_manifests enable row level security;
alter table public.shopify_gallery_seed_receipts enable row level security;

create or replace function public.reject_gallery_seed_evidence_change()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'SYNC_SEED_EVIDENCE_IMMUTABLE'; end;
$$;
drop trigger if exists gallery_seed_manifest_immutable on public.shopify_gallery_seed_manifests;
create trigger gallery_seed_manifest_immutable before update or delete on public.shopify_gallery_seed_manifests
  for each row execute function public.reject_gallery_seed_evidence_change();
drop trigger if exists gallery_seed_receipt_immutable on public.shopify_gallery_seed_receipts;
create trigger gallery_seed_receipt_immutable before update or delete on public.shopify_gallery_seed_receipts
  for each row execute function public.reject_gallery_seed_evidence_change();

-- Match the authenticated read's noncopy metadata, including hidden rows.
-- Explicitly tolerate absent historical flat columns only as JSON null.
create or replace function public.samsonite_seed_protected_catalog(p_seed_ids uuid[])
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', item.id, 'catalog_number', item.catalog_number, 'source_url', item.source_url,
      'cover_image_path', item.cover_image_path, 'display_order', item.display_order, 'is_active', item.is_active,
      'color', coalesce(to_jsonb(item)->'color', 'null'::jsonb),
      'dimensions', coalesce(to_jsonb(item)->'dimensions', 'null'::jsonb),
      'weight', coalesce(to_jsonb(item)->'weight', 'null'::jsonb),
      'sizes', coalesce(to_jsonb(item)->'sizes', 'null'::jsonb),
      'available_colors', coalesce(to_jsonb(item)->'available_colors', 'null'::jsonb),
      'tech_specs', item.tech_specs, 'colors', item.colors,
      'angles', (select coalesce(jsonb_agg(to_jsonb(angle) order by angle.id), '[]'::jsonb)
        from public.carousel_item_angles angle where angle.item_id = item.id)
    ) order by item.id), '[]'::jsonb) from public.carousel_items item where not (item.id = any(p_seed_ids))),
    'settings', (select coalesce(jsonb_agg(jsonb_build_object('id', settings.id,
      'autoplay_ms', settings.autoplay_ms, 'transition_mode', settings.transition_mode) order by settings.id), '[]'::jsonb)
      from public.carousel_settings settings)
  );
$$;

create or replace function public.samsonite_seed_current_receipt(p_item_id uuid, p_catalog_key text)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'item', (select to_jsonb(item) from public.carousel_items item where item.id=p_item_id),
    'angles', (select coalesce(jsonb_agg(to_jsonb(angle) order by angle.id), '[]'::jsonb)
      from public.carousel_item_angles angle where angle.item_id=p_item_id),
    'binding', (select to_jsonb(binding) from public.shopify_gallery_bindings binding where binding.catalog_key=p_catalog_key),
    'state', (select to_jsonb(state) from public.shopify_gallery_sync_state state where state.catalog_key=p_catalog_key),
    'public_link', (select to_jsonb(link) from public.shopify_gallery_public_links link where link.catalog_key=p_catalog_key)
  );
$$;

create or replace function public.seed_samsonite_gallery_baselines(p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  manifest_key constant text := 'samsonite-2026-09-30-v1';
  approved_manifest_hash constant text := 'd9c4f52553b873ed27de0eb4dff48e79f756bd237b625d1b2fec483cfd2a48eb';
  approved_catalog_hash constant text := 'ddcf33ea07a03088ce4ac64d5127a1eae661df648d1a52e096d68086c6221333';
  approved_source_hash constant text := '20fe79f0ce7af46ccc923b5ad1d99cd5dd58e814bd5cc54cfbe4f3cf21d56cf0';
  seed_ids uuid[];
  current_hash text;
  prior_manifest public.shopify_gallery_seed_manifests%rowtype;
  row_data jsonb;
  incoming jsonb;
  v_catalog_key text;
  v_item_id uuid;
  columns_sql text;
  selected_columns_sql text;
  original_rows jsonb;
  outbox_ids uuid[];
  item_count integer := 0;
  angle_count integer := 0;
begin
  if jsonb_typeof(p_manifest) is distinct from 'object' or octet_length(p_manifest::text) > 2000000 then
    raise exception 'SYNC_SEED_MANIFEST_INVALID';
  end if;
  current_hash := encode(sha256(convert_to(p_manifest::text, 'UTF8')), 'hex');
  if current_hash <> approved_manifest_hash then raise exception 'SYNC_SEED_MANIFEST_MISMATCH'; end if;
  if jsonb_array_length(p_manifest->'rows') <> 57 then raise exception 'SYNC_SEED_COUNT_MISMATCH'; end if;
  select array_agg((entry->>'persistedItemId')::uuid order by entry->>'persistedItemId')
    into seed_ids from jsonb_array_elements(p_manifest->'rows') entry;
  if (select count(distinct identity) from unnest(seed_ids) identity) <> 57 then
    raise exception 'SYNC_SEED_IDENTITY_DUPLICATE';
  end if;

  -- Serialize with existing catalog saves and prevent direct metadata writers
  -- racing the fresh guard. A busy production catalog causes a bounded failure.
  perform set_config('lock_timeout', '3000ms', true);
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  lock table public.carousel_items, public.carousel_item_angles, public.carousel_settings,
    public.shopify_gallery_bindings, public.shopify_gallery_sync_state,
    public.shopify_gallery_public_links in share row exclusive mode;
  current_hash := encode(sha256(convert_to(public.samsonite_seed_protected_catalog(seed_ids)::text, 'UTF8')), 'hex');
  if current_hash <> approved_catalog_hash then raise exception 'SYNC_SEED_EXISTING_CATALOG_CHANGED'; end if;

  select * into prior_manifest from public.shopify_gallery_seed_manifests where manifest_id=manifest_key;
  if found then
    if prior_manifest.manifest_sha256 <> approved_manifest_hash or prior_manifest.manifest <> p_manifest
      or (select count(*) from public.shopify_gallery_seed_receipts where manifest_id=manifest_key) <> 57 then
      raise exception 'SYNC_SEED_RECEIPT_MISMATCH';
    end if;
    for row_data in select value from jsonb_array_elements(p_manifest->'rows') loop
      if not exists (select 1 from public.shopify_gallery_seed_receipts receipt
        where receipt.manifest_id=manifest_key and receipt.catalog_key=row_data->>'catalogKey'
          and receipt.carousel_item_id=(row_data->>'persistedItemId')::uuid
          and receipt.seed_snapshot=public.samsonite_seed_current_receipt(receipt.carousel_item_id, receipt.catalog_key)) then
        raise exception 'SYNC_SEED_ALREADY_APPLIED_STATE_CHANGED';
      end if;
    end loop;
    return jsonb_build_object('manifest_id',manifest_key,'inserted_items',0,'inserted_angles',0,'already_applied',true);
  end if;

  -- Fail on any existing identity, even an inactive record or a partial seed.
  -- No ON CONFLICT UPDATE/DO NOTHING can conceal a changed catalog.
  for row_data in select value from jsonb_array_elements(p_manifest->'rows') loop
    v_item_id := (row_data->>'persistedItemId')::uuid;
    v_catalog_key := row_data->>'catalogKey';
    if exists (select 1 from public.carousel_items item where item.id=v_item_id
      or regexp_replace(upper(coalesce(item.catalog_number,'')), '[^A-Z0-9]', '', 'g')=v_catalog_key)
      or exists (select 1 from public.shopify_gallery_bindings binding where binding.catalog_key=v_catalog_key
        or binding.carousel_item_id=v_item_id or binding.product_gid=row_data->'proposedBinding'->>'product_gid'
        or binding.variant_gid=row_data->'proposedBinding'->>'variant_gid')
      or exists (select 1 from public.shopify_gallery_sync_state state where state.catalog_key=v_catalog_key)
      or exists (select 1 from public.shopify_gallery_public_links link where link.catalog_key=v_catalog_key)
      or exists (select 1 from public.shopify_gallery_seed_receipts receipt where receipt.catalog_key=v_catalog_key or receipt.carousel_item_id=v_item_id)
      or exists (select 1 from public.carousel_item_angles angle where angle.id in
        (select (entry->>'id')::uuid from jsonb_array_elements(row_data->'proposedAngleInserts') entry)) then
      raise exception 'SYNC_SEED_EXISTING_IDENTITY_CONFLICT';
    end if;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(item) order by item.id),'[]'::jsonb) into original_rows
    from public.carousel_items item;
  select coalesce(array_agg(id order by id),array[]::uuid[]) into outbox_ids from public.shopify_gallery_content_outbox;
  insert into public.shopify_gallery_seed_manifests(manifest_id,manifest_sha256,source_file_sha256,manifest)
    values(manifest_key,approved_manifest_hash,approved_source_hash,p_manifest);

  for row_data in select value from jsonb_array_elements(p_manifest->'rows') loop
    incoming := row_data->'proposedItemInsert';
    v_item_id := (row_data->>'persistedItemId')::uuid;
    v_catalog_key := row_data->>'catalogKey';
    -- The reviewed snapshot has null flat metadata. Older schemas may omit
    -- only these five known optional null columns; all core fields are required.
    if exists (select 1 from jsonb_each(incoming) entry where not exists (
      select 1 from pg_attribute attr where attr.attrelid='public.carousel_items'::regclass
        and attr.attname=entry.key and attr.attnum>0 and not attr.attisdropped
    ) and not (entry.key=any(array['color','dimensions','weight','sizes','available_colors']) and entry.value='null'::jsonb)) then
      raise exception 'SYNC_SEED_SCHEMA_MISSING_REQUIRED_FIELD';
    end if;
    select string_agg(format('%I',entry.key),',' order by entry.key),
      string_agg(format('record.%I',entry.key),',' order by entry.key)
      into columns_sql, selected_columns_sql
      from jsonb_object_keys(incoming) entry(key)
      join pg_attribute attr on attr.attrelid='public.carousel_items'::regclass and attr.attname=entry.key
        and attr.attnum>0 and not attr.attisdropped;
    execute format('insert into public.carousel_items (%s) select %s from jsonb_populate_record(null::public.carousel_items,$1) record',
      columns_sql,selected_columns_sql) using incoming;
    insert into public.carousel_item_angles(id,item_id,angle_key,image_path,angle_order)
      select record.id,record.item_id,record.angle_key,record.image_path,record.angle_order
      from jsonb_populate_recordset(null::public.carousel_item_angles,row_data->'proposedAngleInserts') record;
    get diagnostics angle_count = row_count;
    item_count := item_count + 1;
    if angle_count <> jsonb_array_length(row_data->'proposedAngleInserts') then raise exception 'SYNC_SEED_ANGLE_COUNT_MISMATCH'; end if;

    insert into public.shopify_gallery_bindings(catalog_key,carousel_item_id,product_gid,variant_gid,product_handle,is_published,source_updated_at)
      select record.catalog_key,record.carousel_item_id,record.product_gid,record.variant_gid,record.product_handle,record.is_published,record.source_updated_at
      from jsonb_populate_record(null::public.shopify_gallery_bindings,row_data->'proposedBinding') record;
    insert into public.shopify_gallery_public_links(catalog_key,product_handle,variant_id,is_published)
      select record.catalog_key,record.product_handle,record.variant_id,record.is_published
      from jsonb_populate_record(null::public.shopify_gallery_public_links,row_data->'proposedPublicLink') record;
    insert into public.shopify_gallery_sync_state(catalog_key,last_synced_payload,last_synced_hash,
      gallery_baseline_payload,shopify_baseline_payload,gallery_updated_at,shopify_updated_at)
      select record.catalog_key,record.last_synced_payload,record.last_synced_hash,
        record.gallery_baseline_payload,record.shopify_baseline_payload,record.gallery_updated_at,record.shopify_updated_at
      from jsonb_populate_record(null::public.shopify_gallery_sync_state,row_data->'proposedBaseline') record;
    insert into public.shopify_gallery_seed_receipts(catalog_key,manifest_id,carousel_item_id,seed_snapshot)
      values(v_catalog_key,manifest_key,v_item_id,public.samsonite_seed_current_receipt(v_item_id,v_catalog_key));
  end loop;
  select count(*) into angle_count from public.carousel_item_angles angle where angle.item_id=any(seed_ids);
  if item_count <> 57 or angle_count <> 355 then raise exception 'SYNC_SEED_COUNT_MISMATCH'; end if;
  if original_rows is distinct from (select coalesce(jsonb_agg(to_jsonb(item) order by item.id),'[]'::jsonb)
    from public.carousel_items item where not (item.id=any(seed_ids))) then raise exception 'SYNC_SEED_EXISTING_ROWS_CHANGED'; end if;
  if encode(sha256(convert_to(public.samsonite_seed_protected_catalog(seed_ids)::text,'UTF8')),'hex') <> approved_catalog_hash then
    raise exception 'SYNC_SEED_EXISTING_CATALOG_CHANGED';
  end if;
  if outbox_ids is distinct from (select coalesce(array_agg(id order by id),array[]::uuid[]) from public.shopify_gallery_content_outbox) then
    raise exception 'SYNC_SEED_UNEXPECTED_OUTBOX_WRITE';
  end if;
  return jsonb_build_object('manifest_id',manifest_key,'inserted_items',item_count,'inserted_angles',angle_count,'already_applied',false);
end;
$$;

revoke all on table public.shopify_gallery_seed_manifests, public.shopify_gallery_seed_receipts from public, anon, authenticated, service_role;
grant select on table public.shopify_gallery_seed_manifests, public.shopify_gallery_seed_receipts to service_role;
revoke all on function public.reject_gallery_seed_evidence_change() from public, anon, authenticated, service_role;
revoke all on function public.samsonite_seed_protected_catalog(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.samsonite_seed_current_receipt(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.seed_samsonite_gallery_baselines(jsonb) from public, anon, authenticated;
grant execute on function public.seed_samsonite_gallery_baselines(jsonb) to service_role;
