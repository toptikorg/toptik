-- FZT73 only: an owned worker may update a color only after proving the exact
-- prior source projection is still present. No generic editor lease bypass.
begin;
create schema if not exists toptik_fzt73_private;
revoke all on schema toptik_fzt73_private from public, anon, authenticated, service_role;
create table if not exists toptik_fzt73_private.baselines (
  item_id uuid primary key, catalog_key text unique not null, product_gid text not null,
  variant_gid text unique not null, projection jsonb not null, updated_at timestamptz not null default clock_timestamp()
);
revoke all on toptik_fzt73_private.baselines from public, anon, authenticated, service_role;
create table if not exists toptik_fzt73_private.adoption_audit (
  approval_id uuid primary key, product_gid text not null, manifest_hash text not null,
  manifest jsonb not null, approval_evidence jsonb not null, previous_baselines jsonb not null, previous_outbox jsonb not null,
  receipt jsonb not null default '{}'::jsonb, created_at timestamptz not null default clock_timestamp()
);
create table if not exists toptik_fzt73_private.discarded_outbox (
  outbox_id uuid not null, content_hash text not null, created_at timestamptz not null, payload jsonb not null, payload_hash text not null,
  approval_id uuid not null references toptik_fzt73_private.adoption_audit(approval_id),
  primary key(outbox_id,content_hash,created_at,payload_hash)
);
revoke all on toptik_fzt73_private.adoption_audit,toptik_fzt73_private.discarded_outbox from public, anon, authenticated, service_role;

create or replace function public.apply_fzt73_owned_projection(
  p_product_gid text, p_owner uuid, p_item_id uuid, p_catalog_key text, p_variant_gid text,
  p_expected_version timestamptz, p_expected_revision bigint, p_projection jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  expected_variant text; expected_item uuid; row_item public.carousel_items%rowtype;
  current_projection jsonb; prior_projection jsonb; desired jsonb; desired_angles jsonb;
  lease_owner uuid; lease_expires timestamptz; expected_images text[];
begin
  if p_product_gid is distinct from 'gid://shopify/Product/7524873044218' or p_owner is null then
    raise exception 'SYNC_FZT73_IDENTITY_INVALID';
  end if;
  case p_catalog_key
    when 'P10FZT73001' then expected_item:='341df0c7-7a31-4e77-87c0-a683082c3cd7'; expected_variant:='gid://shopify/ProductVariant/42361904398586';
    when 'P10FZT7308Q' then expected_item:='78e341a9-90f8-4b5a-a215-8bdf5f4f5321'; expected_variant:='gid://shopify/ProductVariant/42449044799738';
    when 'P10FZT7324B' then expected_item:='7bd35662-0989-4b96-aafd-f6a77ba6d72f'; expected_variant:='gid://shopify/ProductVariant/42449044832506';
    when 'P10FZT7327D' then expected_item:='8890d9f2-d927-42e2-9006-f287a46ef137'; expected_variant:='gid://shopify/ProductVariant/42449044865274';
    else raise exception 'SYNC_FZT73_IDENTITY_INVALID';
  end case;
  -- These exact verified URLs mirror FZT73_MEDIA in variant-source-policy.ts.
  -- Reject every cross-color, missing or reordered image in SQL as well as TS.
  expected_images := case p_catalog_key
    when 'P10FZT73001' then array[
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_01.jpg?v=1643057405',
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_02.jpg?v=1643057423',
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_03.jpg?v=1643057436',
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_04.jpg?v=1643057448']
    when 'P10FZT7308Q' then array[
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_08Q_01.jpg?v=1645446059',
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_08Q_02.jpg?v=1645446079',
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_08Q_03.jpg?v=1645446094']
    when 'P10FZT7324B' then array[
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_24B_01.jpg?v=1645446116',
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_24B_03.jpg?v=1645446137',
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_24B_04.jpg?v=1645446160',
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_24B_05.jpg?v=1645446192']
    when 'P10FZT7327D' then array[
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_27D_01.jpg?v=1645446229',
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_27D_02.jpg?v=1645446251',
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_27D_03.jpg?v=1645446301',
      'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_27D_04.jpg?v=1645446322']
  end;
  if p_item_id is distinct from expected_item or p_variant_gid is distinct from expected_variant
    or p_expected_version is null or p_expected_revision is null
    or jsonb_typeof(p_projection) is distinct from 'object'
    or not p_projection ?& array['title','description','description_html','seo_title','seo_description','cover_image_path','cover_image_alt','angles']
    or (select count(*) from jsonb_object_keys(p_projection)) <> 8
    or jsonb_typeof(p_projection->'title') is distinct from 'string'
    or jsonb_typeof(p_projection->'cover_image_path') is distinct from 'string'
    or jsonb_typeof(p_projection->'angles') is distinct from 'array'
  then raise exception 'SYNC_FZT73_INPUT_INVALID'; end if;
  if jsonb_array_length(p_projection->'angles') not between 1 and 20
    or exists(select 1 from jsonb_array_elements(p_projection->'angles') a where jsonb_typeof(a) is distinct from 'object'
       or not a ?& array['angle_key','angle_order','image_path','image_alt']
       or (select count(*) from jsonb_object_keys(a)) <> 4
       or jsonb_typeof(a->'angle_key') is distinct from 'string'
       or jsonb_typeof(a->'angle_order') is distinct from 'number'
       or jsonb_typeof(a->'image_path') is distinct from 'string')
  then raise exception 'SYNC_FZT73_INPUT_INVALID'; end if;
  select jsonb_agg(a order by (a->>'angle_order')::integer, a->>'angle_key', a->>'image_path') into desired_angles
    from jsonb_array_elements(p_projection->'angles') a;
  if jsonb_array_length(desired_angles) <> cardinality(expected_images)
    or exists(select 1 from jsonb_array_elements(desired_angles) with ordinality a(value,n)
      where a.value->>'image_path' is distinct from expected_images[a.n::integer]
        or a.value->>'angle_key' is distinct from a.n::text
        or (a.value->>'angle_order')::integer <> a.n)
  then raise exception 'SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED'; end if;
  if (select count(distinct a->>'angle_key') from jsonb_array_elements(desired_angles) a) <> jsonb_array_length(desired_angles)
    or (select count(distinct a->>'image_path') from jsonb_array_elements(desired_angles) a) <> jsonb_array_length(desired_angles)
    or p_projection->>'cover_image_path' is distinct from desired_angles->0->>'image_path'
  then raise exception 'SYNC_FZT73_INPUT_INVALID'; end if;
  desired := jsonb_set(p_projection,'{angles}',desired_angles);
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  select owner, expires_at into lease_owner, lease_expires from public.shopify_gallery_reconciliation_leases
    where product_gid=p_product_gid for update;
  if lease_owner is distinct from p_owner or lease_expires is null or lease_expires <= clock_timestamp() then
    raise exception 'SYNC_FZT73_LEASE_REQUIRED';
  end if;
  select * into row_item from public.carousel_items where id=p_item_id for update;
  if not found or row_item.catalog_number is distinct from p_catalog_key or not row_item.is_active then
    raise exception 'SYNC_FZT73_REMOVED_OR_HIDDEN';
  end if;
  if row_item.copy_updated_at is distinct from p_expected_version or row_item.editor_revision is distinct from p_expected_revision then
    raise exception 'SYNC_COPY_CONCURRENT_UPDATE';
  end if;
  if (select count(*) from public.shopify_gallery_bindings where carousel_item_id=p_item_id) <> 1
    or not exists(select 1 from public.shopify_gallery_bindings where carousel_item_id=p_item_id and catalog_key=p_catalog_key
      and product_gid=p_product_gid and variant_gid=p_variant_gid)
    or (select count(*) from public.carousel_items i where
       regexp_replace(regexp_replace(upper(coalesce(i.catalog_number,'')),'[^A-Z0-9]','','g'),'^(P[0-9]{2}.*)TU$','\1')=p_catalog_key) <> 1
  then raise exception 'SYNC_FZT73_IDENTITY_CONFLICT'; end if;
  if exists(select 1 from public.shopify_gallery_content_outbox o where o.carousel_item_id=p_item_id
    and o.status in ('pending','processing','review','failed') and not (o.status='review' and exists(
      select 1 from toptik_fzt73_private.discarded_outbox d where d.outbox_id=o.id
        and d.content_hash=o.content_hash and d.created_at=o.created_at and d.payload=o.payload))) then raise exception 'SYNC_FZT73_BASELINE_REQUIRED'; end if;
  perform 1 from public.carousel_item_angles where item_id=p_item_id for update;
  select jsonb_build_object('title',row_item.title,'description',row_item.description,'description_html',row_item.description_html,
    'seo_title',row_item.seo_title,'seo_description',row_item.seo_description,'cover_image_path',row_item.cover_image_path,
    'cover_image_alt',row_item.cover_image_alt,'angles',coalesce((select jsonb_agg(jsonb_build_object('angle_key',a.angle_key,
       'angle_order',a.angle_order,'image_path',a.image_path,'image_alt',a.image_alt) order by a.angle_order,a.angle_key,a.image_path)
       from public.carousel_item_angles a where a.item_id=p_item_id),'[]'::jsonb)) into current_projection;
  select projection into prior_projection from toptik_fzt73_private.baselines
    where item_id=p_item_id and catalog_key=p_catalog_key and product_gid=p_product_gid and variant_gid=p_variant_gid for update;
  if not found then
    if current_projection is distinct from desired then raise exception 'SYNC_FZT73_BASELINE_REQUIRED'; end if;
    insert into toptik_fzt73_private.baselines(item_id,catalog_key,product_gid,variant_gid,projection)
      values(p_item_id,p_catalog_key,p_product_gid,p_variant_gid,desired);
    if lease_expires <= clock_timestamp() then raise exception 'SYNC_FZT73_LEASE_REQUIRED'; end if;
    return jsonb_build_object('status','baseline_recorded','copyUpdatedAt',row_item.copy_updated_at);
  end if;
  if current_projection is distinct from prior_projection then raise exception 'SYNC_FZT73_EDITORIAL_CHANGED'; end if;
  if current_projection is distinct from desired then
    update public.carousel_items set title=desired->>'title', description=desired->>'description',
      description_html=desired->>'description_html', seo_title=desired->>'seo_title', seo_description=desired->>'seo_description',
      cover_image_path=desired->>'cover_image_path', cover_image_alt=desired->>'cover_image_alt',
      copy_updated_at=greatest(clock_timestamp(), row_item.copy_updated_at+interval '1 microsecond')
      where id=p_item_id;
    update public.carousel_item_angles a set angle_key=v->>'angle_key', angle_order=(v->>'angle_order')::integer, image_alt=v->>'image_alt'
      from jsonb_array_elements(desired_angles) v where a.item_id=p_item_id and a.image_path=v->>'image_path';
    insert into public.carousel_item_angles(id,item_id,angle_key,angle_order,image_path,image_alt)
      select gen_random_uuid(),p_item_id,v->>'angle_key',(v->>'angle_order')::integer,v->>'image_path',v->>'image_alt'
      from jsonb_array_elements(desired_angles) v where not exists(select 1 from public.carousel_item_angles a
        where a.item_id=p_item_id and a.image_path=v->>'image_path');
    delete from public.carousel_item_angles a where a.item_id=p_item_id
      and not exists(select 1 from jsonb_array_elements(desired_angles) v where v->>'image_path'=a.image_path);
    update toptik_fzt73_private.baselines set projection=desired,updated_at=clock_timestamp() where item_id=p_item_id;
  end if;
  if lease_expires <= clock_timestamp() then raise exception 'SYNC_FZT73_LEASE_REQUIRED'; end if;
  select * into row_item from public.carousel_items where id=p_item_id;
  return jsonb_build_object('status',case when current_projection is distinct from desired then 'updated' else 'unchanged' end,
    'copyUpdatedAt',row_item.copy_updated_at);
end $$;
-- The public entry point is one transaction for all submitted colors. Even an
-- owner-authenticated caller cannot commit only the first rows of a bad batch.
create or replace function public.apply_fzt73_owned_batch(p_product_gid text,p_owner uuid,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare entry jsonb; outcome jsonb; outcomes jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_entries) is distinct from 'array' or jsonb_array_length(p_entries) not between 1 and 4
    or (select count(*) from jsonb_array_elements(p_entries)) <>
       (select count(distinct e->>'itemId') from jsonb_array_elements(p_entries) e)
    or exists(select 1 from jsonb_array_elements(p_entries) e where jsonb_typeof(e) is distinct from 'object'
       or not e ?& array['itemId','catalogKey','variantGid','expectedVersion','expectedRevision','projection']
       or (select count(*) from jsonb_object_keys(e)) <> 6)
  then raise exception 'SYNC_FZT73_INPUT_INVALID'; end if;
  for entry in select value from jsonb_array_elements(p_entries) order by value->>'itemId' loop
    outcome:=public.apply_fzt73_owned_projection(p_product_gid,p_owner,(entry->>'itemId')::uuid,
      entry->>'catalogKey',entry->>'variantGid',(entry->>'expectedVersion')::timestamptz,
      (entry->>'expectedRevision')::bigint,entry->'projection');
    outcomes:=outcomes||jsonb_build_array(jsonb_build_object('itemId',entry->>'itemId','result',outcome));
  end loop;
  return jsonb_build_object('items',outcomes);
end $$;
-- This function checks database evidence only. An authenticated admin service
-- must separately re-read and verify Shopify source against this exact manifest
-- before invoking it. This migration alone is not a deployable workflow.
create or replace function public.resolve_fzt73_source_adoption(p_product_gid text,p_owner uuid,p_approval_id uuid,
  p_manifest jsonb,p_expected_hash text,p_approval_evidence jsonb) returns jsonb language plpgsql security definer
  set search_path = pg_catalog, pg_temp as $$
declare
  previous toptik_fzt73_private.adoption_audit%rowtype; entry jsonb; o jsonb;
  item public.carousel_items%rowtype; actual jsonb; baseline_before jsonb := '[]'::jsonb;
  outbox_before jsonb := '[]'::jsonb; entries jsonb := '[]'::jsonb; result jsonb;
  lease_owner uuid; lease_expires timestamptz; recorded_hash text; expected_outbox integer; actual_outbox integer;
begin
  if p_product_gid is distinct from 'gid://shopify/Product/7524873044218' or p_owner is null or p_approval_id is null
    or jsonb_typeof(p_manifest) is distinct from 'object' or p_manifest->>'productGid' is distinct from p_product_gid
    or p_manifest->>'action' is distinct from 'adopt_shopify_source' or jsonb_typeof(p_manifest->'entries') is distinct from 'array'
    or jsonb_array_length(p_manifest->'entries') not between 1 and 4 or p_expected_hash !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_approval_evidence) is distinct from 'object'
    or not p_approval_evidence ?& array['approvedBy','approvedAt','reviewReference']
    or (select count(*) from jsonb_object_keys(p_approval_evidence)) <> 3
    or p_approval_evidence->>'approvedBy' is distinct from 'Tal'
    or jsonb_typeof(p_approval_evidence->'approvedAt') is distinct from 'string'
    or coalesce(length(p_approval_evidence->>'reviewReference'),0) not between 1 and 500
  then raise exception 'SYNC_FZT73_MANIFEST_INVALID'; end if;
  perform (p_approval_evidence->>'approvedAt')::timestamptz;
  recorded_hash := encode(pg_catalog.sha256(pg_catalog.convert_to(p_manifest::text,'UTF8')),'hex');
  if recorded_hash is distinct from p_expected_hash then raise exception 'SYNC_FZT73_MANIFEST_MISMATCH'; end if;
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  select * into previous from toptik_fzt73_private.adoption_audit where approval_id=p_approval_id;
  if found then
    if previous.manifest_hash is distinct from recorded_hash or previous.product_gid is distinct from p_product_gid
      or previous.approval_evidence is distinct from p_approval_evidence
      then raise exception 'SYNC_FZT73_APPROVAL_CONFLICT'; end if;
    return previous.receipt;
  end if;
  select owner,expires_at into lease_owner,lease_expires from public.shopify_gallery_reconciliation_leases
    where product_gid=p_product_gid for update;
  if lease_owner is distinct from p_owner or lease_expires is null or lease_expires<=clock_timestamp()
    then raise exception 'SYNC_FZT73_LEASE_REQUIRED'; end if;
  if (select count(*) from jsonb_array_elements(p_manifest->'entries')) <>
     (select count(distinct v->>'itemId') from jsonb_array_elements(p_manifest->'entries') v)
    then raise exception 'SYNC_FZT73_MANIFEST_INVALID'; end if;
  for entry in select value from jsonb_array_elements(p_manifest->'entries') order by value->>'itemId' loop
    if jsonb_typeof(entry->'outbox') is distinct from 'array' or jsonb_typeof(entry->'before') is distinct from 'object'
      or jsonb_typeof(entry->'projection') is distinct from 'object'
      then raise exception 'SYNC_FZT73_MANIFEST_INVALID'; end if;
    select * into item from public.carousel_items where id=(entry->>'itemId')::uuid for update;
    if not found or not item.is_active or item.catalog_number is distinct from entry->>'catalogKey'
      then raise exception 'SYNC_FZT73_REMOVED_OR_HIDDEN'; end if;
    if item.copy_updated_at is distinct from (entry->>'expectedVersion')::timestamptz
      or item.editor_revision is distinct from (entry->>'expectedRevision')::bigint
      then raise exception 'SYNC_COPY_CONCURRENT_UPDATE'; end if;
    perform 1 from public.carousel_item_angles where item_id=item.id for update;
    select jsonb_build_object('title',item.title,'description',item.description,'description_html',item.description_html,
      'seo_title',item.seo_title,'seo_description',item.seo_description,'cover_image_path',item.cover_image_path,
      'cover_image_alt',item.cover_image_alt,'angles',coalesce((select jsonb_agg(jsonb_build_object('angle_key',a.angle_key,
        'angle_order',a.angle_order,'image_path',a.image_path,'image_alt',a.image_alt) order by a.angle_order,a.angle_key,a.image_path)
        from public.carousel_item_angles a where a.item_id=item.id),'[]'::jsonb)) into actual;
    if actual is distinct from entry->'before' then raise exception 'SYNC_FZT73_MANIFEST_MISMATCH'; end if;
    perform 1 from public.shopify_gallery_content_outbox where carousel_item_id=item.id for update;
    select count(*) into actual_outbox from public.shopify_gallery_content_outbox q where q.carousel_item_id=item.id
      and q.status in ('pending','processing','review','failed') and not (q.status='review' and exists(
        select 1 from toptik_fzt73_private.discarded_outbox d where d.outbox_id=q.id and d.content_hash=q.content_hash and d.created_at=q.created_at and d.payload=q.payload));
    expected_outbox:=jsonb_array_length(entry->'outbox');
    if actual_outbox<>expected_outbox or (select count(distinct v->>'id') from jsonb_array_elements(entry->'outbox') v)<>expected_outbox
      then raise exception 'SYNC_FZT73_OUTBOX_CHANGED'; end if;
    for o in select value from jsonb_array_elements(entry->'outbox') loop
      if o->>'decision' is distinct from 'discarded' or not exists(select 1 from public.shopify_gallery_content_outbox q
        where q.id=(o->>'id')::uuid and q.carousel_item_id=item.id and q.catalog_key=entry->>'catalogKey'
          and q.content_hash=o->>'contentHash' and q.created_at=(o->>'createdAt')::timestamptz and q.status=o->>'status' and q.payload=o->'payload'
          and q.status in ('pending','processing','review','failed') and not (q.status='review' and exists(
            select 1 from toptik_fzt73_private.discarded_outbox d where d.outbox_id=q.id and d.content_hash=q.content_hash and d.created_at=q.created_at and d.payload=q.payload)))
      then raise exception 'SYNC_FZT73_OUTBOX_CHANGED'; end if;
    end loop;
    select baseline_before||jsonb_build_array(jsonb_build_object('itemId',item.id,'baseline',
      (select to_jsonb(b) from toptik_fzt73_private.baselines b where b.item_id=item.id))) into baseline_before;
    select outbox_before||coalesce((select jsonb_agg(to_jsonb(q) order by q.id) from public.shopify_gallery_content_outbox q
      join jsonb_array_elements(entry->'outbox') v on q.id=(v->>'id')::uuid),'[]'::jsonb) into outbox_before;
    entries:=entries||jsonb_build_array(jsonb_build_object('itemId',entry->>'itemId','catalogKey',entry->>'catalogKey',
      'variantGid',entry->>'variantGid','expectedVersion',entry->>'expectedVersion',
      'expectedRevision',entry->'expectedRevision','projection',entry->'projection'));
  end loop;
  insert into toptik_fzt73_private.adoption_audit(approval_id,product_gid,manifest_hash,manifest,approval_evidence,previous_baselines,previous_outbox)
    values(p_approval_id,p_product_gid,recorded_hash,p_manifest,p_approval_evidence,baseline_before,outbox_before);
  for entry in select value from jsonb_array_elements(p_manifest->'entries') loop
    for o in select value from jsonb_array_elements(entry->'outbox') loop
      insert into toptik_fzt73_private.discarded_outbox(outbox_id,content_hash,created_at,payload,payload_hash,approval_id)
        values((o->>'id')::uuid,o->>'contentHash',(o->>'createdAt')::timestamptz,o->'payload',
          encode(pg_catalog.sha256(pg_catalog.convert_to((o->'payload')::text,'UTF8')),'hex'),p_approval_id);
      update public.shopify_gallery_content_outbox set status='review',last_error='SYNC_FZT73_REVIEW_DISCARDED'
        where id=(o->>'id')::uuid;
    end loop;
    insert into toptik_fzt73_private.baselines(item_id,catalog_key,product_gid,variant_gid,projection)
      values((entry->>'itemId')::uuid,entry->>'catalogKey',p_product_gid,entry->>'variantGid',entry->'before')
      on conflict(item_id) do update set projection=excluded.projection,updated_at=clock_timestamp()
        where toptik_fzt73_private.baselines.catalog_key=excluded.catalog_key
          and toptik_fzt73_private.baselines.product_gid=excluded.product_gid
          and toptik_fzt73_private.baselines.variant_gid=excluded.variant_gid;
    if not found then raise exception 'SYNC_FZT73_IDENTITY_CONFLICT'; end if;
  end loop;
  result:=public.apply_fzt73_owned_batch(p_product_gid,p_owner,entries);
  for entry in select value from jsonb_array_elements(p_manifest->'entries') loop
    select * into item from public.carousel_items where id=(entry->>'itemId')::uuid;
    if not found or not item.is_active then raise exception 'SYNC_COPY_READBACK_MISMATCH'; end if;
    select jsonb_build_object('title',item.title,'description',item.description,'description_html',item.description_html,
      'seo_title',item.seo_title,'seo_description',item.seo_description,'cover_image_path',item.cover_image_path,
      'cover_image_alt',item.cover_image_alt,'angles',coalesce((select jsonb_agg(jsonb_build_object('angle_key',a.angle_key,
        'angle_order',a.angle_order,'image_path',a.image_path,'image_alt',a.image_alt) order by a.angle_order,a.angle_key,a.image_path)
        from public.carousel_item_angles a where a.item_id=item.id),'[]'::jsonb)) into actual;
    if actual is distinct from entry->'projection' then raise exception 'SYNC_COPY_READBACK_MISMATCH'; end if;
  end loop;
  if lease_expires<=clock_timestamp() then raise exception 'SYNC_FZT73_LEASE_REQUIRED'; end if;
  result:=jsonb_build_object('status','adopted','approvalId',p_approval_id,'manifestHash',recorded_hash,'items',result->'items');
  update toptik_fzt73_private.adoption_audit set receipt=result where approval_id=p_approval_id;
  return result;
end $$;
create or replace function public.fingerprint_fzt73_adoption_manifest(p_manifest jsonb)
returns text language sql immutable security invoker set search_path = pg_catalog, pg_temp as $$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(p_manifest::text,'UTF8')),'hex')
$$;
create or replace function public.read_fzt73_adoption_receipt(p_approval_id uuid,p_manifest_hash text,p_approval_evidence jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare a toptik_fzt73_private.adoption_audit%rowtype;
begin
  select * into a from toptik_fzt73_private.adoption_audit where approval_id=p_approval_id;
  if not found then return null; end if;
  if a.manifest_hash is distinct from p_manifest_hash or a.approval_evidence is distinct from p_approval_evidence
    then raise exception 'SYNC_FZT73_APPROVAL_CONFLICT'; end if;
  return a.receipt;
end $$;
create or replace function public.read_fzt73_unresolved_outbox(p_item_id uuid)
returns jsonb language sql security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'contentHash',q.content_hash,'createdAt',q.created_at,
    'status',q.status,'payload',q.payload,'decision',null) order by q.id),'[]'::jsonb)
  from public.shopify_gallery_content_outbox q
  where q.carousel_item_id=p_item_id and q.status in ('pending','processing','review','failed')
    and exists(select 1 from public.shopify_gallery_bindings b where b.carousel_item_id=p_item_id
      and b.product_gid='gid://shopify/Product/7524873044218')
    and not(q.status='review' and exists(select 1 from toptik_fzt73_private.discarded_outbox d
      where d.outbox_id=q.id and d.content_hash=q.content_hash and d.created_at=q.created_at and d.payload=q.payload));
$$;
revoke all on function public.apply_fzt73_owned_projection(text,uuid,uuid,text,text,timestamptz,bigint,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.apply_fzt73_owned_batch(text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.apply_fzt73_owned_batch(text,uuid,jsonb) to service_role;
revoke all on function public.resolve_fzt73_source_adoption(text,uuid,uuid,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.resolve_fzt73_source_adoption(text,uuid,uuid,jsonb,text,jsonb) to service_role;
revoke all on function public.fingerprint_fzt73_adoption_manifest(jsonb), public.read_fzt73_adoption_receipt(uuid,text,jsonb),
 public.read_fzt73_unresolved_outbox(uuid) from public, anon, authenticated;
grant execute on function public.fingerprint_fzt73_adoption_manifest(jsonb), public.read_fzt73_adoption_receipt(uuid,text,jsonb),
 public.read_fzt73_unresolved_outbox(uuid) to service_role;
notify pgrst, 'reload schema';
commit;
