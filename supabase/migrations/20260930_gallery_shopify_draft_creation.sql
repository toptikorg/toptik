-- NEW-only private draft creation. Never publishes, binds, enables sync, or writes inventory.
-- Requires the existing carousel, copy eligibility, binding, inbox/outbox and lease migrations.
create table if not exists public.shopify_gallery_creation_drafts (
  id uuid primary key references public.carousel_items(id) on delete restrict,
  catalog_key text not null unique,
  source jsonb not null,
  source_row_hash text not null check(source_row_hash ~ '^[a-f0-9]{64}$'),
  ready_proof jsonb,
  receipt jsonb,
  stage text not null default 'reserved' check(stage in ('reserved','create_started','draft_found','variant_started','draft_ready','uncertain','review')),
  version bigint not null default 1 check(version>0),
  product_gid text unique,
  variant_gid text unique,
  lease_owner uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.shopify_gallery_creation_drafts add column if not exists last_error text;
create table if not exists public.shopify_gallery_creation_events (
  draft_id uuid not null references public.shopify_gallery_creation_drafts(id) on delete restrict,
  from_version bigint not null,
  expected_stage text,
  patch jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(draft_id,from_version)
);
alter table public.shopify_gallery_creation_drafts enable row level security;
alter table public.shopify_gallery_creation_events enable row level security;
revoke all on public.shopify_gallery_creation_drafts,public.shopify_gallery_creation_events from public,anon,authenticated,service_role;
grant select on public.shopify_gallery_creation_drafts,public.shopify_gallery_creation_events to service_role;
drop policy if exists creation_service_read on public.shopify_gallery_creation_drafts;
create policy creation_service_read on public.shopify_gallery_creation_drafts for select to service_role using(true);
drop policy if exists creation_service_read on public.shopify_gallery_creation_events;
create policy creation_service_read on public.shopify_gallery_creation_events for select to service_role using(true);

create or replace function public.creation_immutable_record() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if tg_table_name='shopify_gallery_creation_events' or tg_op='DELETE' then raise exception 'SYNC_CREATION_IMMUTABLE'; end if;
  if new.id<>old.id or new.catalog_key<>old.catalog_key or new.source<>old.source or new.source_row_hash<>old.source_row_hash
    or new.created_at<>old.created_at or (old.ready_proof is not null and new.ready_proof is distinct from old.ready_proof)
    or (old.product_gid is not null and new.product_gid is distinct from old.product_gid)
    or (old.variant_gid is not null and new.variant_gid is distinct from old.variant_gid)
  then raise exception 'SYNC_CREATION_IMMUTABLE'; end if;
  return new;
end $$;

create or replace function public.creation_assert_commercial(p_value jsonb) returns void
language plpgsql immutable set search_path=pg_catalog as $$
begin
  if not public.creation_has_keys(p_value,array['price','compareAtPrice','barcode','taxable','requiresShipping'])
    or jsonb_typeof(p_value->'price')<>'string' or p_value->>'price' !~ '^[0-9]{1,12}([.][0-9]{1,2})?$'
    or (p_value->'compareAtPrice'<>'null'::jsonb and (jsonb_typeof(p_value->'compareAtPrice')<>'string'
      or p_value->>'compareAtPrice' !~ '^[0-9]{1,12}([.][0-9]{1,2})?$'))
    or jsonb_typeof(p_value->'barcode') not in ('string','null') or length(p_value->>'barcode')>64
    or jsonb_typeof(p_value->'taxable')<>'boolean' or jsonb_typeof(p_value->'requiresShipping')<>'boolean'
  then raise exception 'SYNC_CREATION_COMMERCIAL_SNAPSHOT_INVALID'; end if;
end $$;
create or replace function public.creation_commercial_hash(p_value jsonb) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare v_json text;
begin
  perform public.creation_assert_commercial(p_value);
  -- Match the fixed property order and money normalization of the pure TS policy.
  v_json:='{"price":'||to_json(to_char((p_value->>'price')::numeric,'FM999999999999990.00'))::text
    ||',"compareAtPrice":'||case when p_value->'compareAtPrice'='null'::jsonb then 'null'
      else to_json(to_char((p_value->>'compareAtPrice')::numeric,'FM999999999999990.00'))::text end
    ||',"barcode":'||(p_value->'barcode')::text||',"taxable":'||(p_value->'taxable')::text
    ||',"requiresShipping":'||(p_value->'requiresShipping')::text||'}';
  return encode(sha256(convert_to(v_json,'UTF8')),'hex');
end $$;

create or replace function public.creation_assert_ready(p_source jsonb,p_key text,p_ready jsonb) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare v_image jsonb; v_i int:=0; v_at timestamptz; v_expected jsonb;
begin
  if not public.creation_has_keys(p_ready,array['policyVersion','draft','catalogKey','sourceFingerprint','customId','imageEvidence','readyForPublication','outstanding'])
    or p_ready->>'policyVersion' is distinct from 'gallery-shopify-draft-v1' or p_ready->'draft' is distinct from p_source
    or p_ready->>'catalogKey' is distinct from p_key or jsonb_typeof(p_ready->'sourceFingerprint') is distinct from 'string'
    or p_ready->>'sourceFingerprint' !~ '^[a-f0-9]{64}$'
    or p_ready->'readyForPublication' is distinct from 'false'::jsonb
    or not public.creation_has_keys(p_ready->'customId',array['namespace','key','value'])
    or jsonb_typeof(p_ready->'customId'->'namespace') is distinct from 'string'
    or p_ready->'customId'->>'namespace' !~ '^app--[1-9][0-9]*--toptik_gallery$'
    or p_ready->'customId'->>'key' is distinct from 'source_item_id'
    or p_ready->'customId'->>'value' is distinct from 'toptikcoil.myshopify.com:gallery:'||(p_source->>'galleryItemId')
    or jsonb_typeof(p_ready->'imageEvidence')<>'array'
    or jsonb_array_length(p_ready->'imageEvidence')<>jsonb_array_length(p_source->'media')
  then raise exception 'SYNC_CREATION_READY_PROOF_INVALID'; end if;
  v_expected:=case when p_source->'commerce'->'sellingPrice'='null'::jsonb then '["selling_price"]'::jsonb else '[]'::jsonb end
    ||case when p_source->'commerce'->'taxable'='null'::jsonb then '["tax_policy"]'::jsonb else '[]'::jsonb end
    ||'["inventory","publication_not_supported_v1"]'::jsonb;
  if p_ready->'outstanding' is distinct from v_expected then raise exception 'SYNC_CREATION_READY_PROOF_INVALID'; end if;
  for v_image in select value from jsonb_array_elements(p_ready->'imageEvidence') loop
    if not public.creation_has_keys(v_image,array['url','galleryItemId','exactSku','sha256','mime','width','height','byteLength','verifiedAt'])
      or v_image->>'url' is distinct from p_source->'media'->v_i->>'url'
      or v_image->>'galleryItemId' is distinct from p_source->>'galleryItemId'
      or v_image->>'exactSku' is distinct from p_source->>'shopifySku'
      or jsonb_typeof(v_image->'sha256') is distinct from 'string' or v_image->>'sha256' !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(v_image->'mime') is distinct from 'string' or v_image->>'mime' not in ('image/jpeg','image/png','image/webp','image/avif','image/gif')
      or jsonb_typeof(v_image->'width')<>'number' or v_image->>'width' !~ '^[1-9][0-9]*$'
      or jsonb_typeof(v_image->'height')<>'number' or v_image->>'height' !~ '^[1-9][0-9]*$'
      or jsonb_typeof(v_image->'byteLength')<>'number' or v_image->>'byteLength' !~ '^[1-9][0-9]*$'
      or (v_image->>'width')::numeric>16000 or (v_image->>'height')::numeric>16000
      or (v_image->>'width')::numeric*(v_image->>'height')::numeric>16000000 or (v_image->>'byteLength')::numeric>8388608
    then raise exception 'SYNC_CREATION_READY_MEDIA_INVALID'; end if;
    v_at:=(v_image->>'verifiedAt')::timestamptz;
    if v_at is null or not isfinite(v_at) or v_at<clock_timestamp()-interval '5 minutes' or v_at>clock_timestamp()+interval '30 seconds'
    then raise exception 'SYNC_CREATION_READY_MEDIA_STALE'; end if;
    v_i:=v_i+1;
  end loop;
end $$;

create or replace function public.creation_assert_readback(p_ready jsonb,p_receipt jsonb,p_proof jsonb) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare s jsonb; c jsonb; initial jsonb; source jsonb; image jsonb; expected jsonb; v_i int:=0; v_at timestamptz;
begin
  if not public.creation_has_keys(p_proof,array['snapshot','media','verifiedAt']) or octet_length(p_proof::text)>1000000
  then raise exception 'SYNC_CREATION_READBACK_REQUIRED'; end if;
  v_at:=(p_proof->>'verifiedAt')::timestamptz;
  if v_at is null or not isfinite(v_at) or v_at<clock_timestamp()-interval '5 minutes' or v_at>clock_timestamp()+interval '30 seconds'
  then raise exception 'SYNC_CREATION_READBACK_STALE'; end if;
  s:=p_proof->'snapshot'; c:=s->'commercial'; initial:=p_receipt->'initialCommercial'; source:=p_ready->'draft';
  if jsonb_typeof(s)<>'object' or s->>'productGid' is distinct from p_receipt->>'productGid'
    or s->>'variantGid' is distinct from p_receipt->>'variantGid' or s->'variantCount' is distinct from '1'::jsonb
    or s->>'sku' is distinct from source->>'shopifySku' or s->>'status' is distinct from 'DRAFT'
    or s->'publishedAnywhere' is distinct from 'false'::jsonb or s->'customId' is distinct from p_ready->'customId'
    or s->>'sourceFingerprint' is distinct from p_ready->>'sourceFingerprint'
    or s->>'updatedAt' is distinct from p_receipt->>'shopifyUpdatedAt' or s->>'brand' is distinct from source->>'brand'
    or s->'copy'->>'title' is distinct from source->'copy'->>'title'
    or s->'copy'->'seoTitle' is distinct from source->'copy'->'seoTitle'
    or s->'copy'->'seoDescription' is distinct from source->'copy'->'seoDescription'
    or jsonb_typeof(s->'copy'->'descriptionHtml') is distinct from 'string' or length(s->'copy'->>'descriptionHtml')>250000
  then raise exception 'SYNC_CREATION_READBACK_IDENTITY_OR_COPY'; end if;
  -- HTML semantic equivalence and decoded bytes are independently checked by the
  -- trusted TypeScript adapter. SQL freezes that evidence and checks identities.
  perform public.creation_assert_commercial(c); perform public.creation_assert_commercial(initial);
  expected:=initial||jsonb_build_object('requiresShipping',true);
  if source->'commerce'->'sellingPrice'<>'null'::jsonb then expected:=expected||jsonb_build_object('price',source->'commerce'->>'sellingPrice'); end if;
  if source->'commerce'->'compareAtPrice'<>'null'::jsonb then expected:=expected||jsonb_build_object('compareAtPrice',source->'commerce'->>'compareAtPrice'); end if;
  if source->'commerce'->'barcode'<>'null'::jsonb then expected:=expected||jsonb_build_object('barcode',source->'commerce'->>'barcode'); end if;
  if source->'commerce'->'taxable'<>'null'::jsonb then expected:=expected||jsonb_build_object('taxable',source->'commerce'->'taxable'); end if;
  if public.creation_commercial_hash(c)<>public.creation_commercial_hash(expected) then raise exception 'SYNC_CREATION_READBACK_COMMERCE'; end if;
  if jsonb_typeof(p_proof->'media')<>'array' or jsonb_array_length(p_proof->'media')<>jsonb_array_length(p_ready->'imageEvidence')
    or (select count(distinct value->>'mediaGid') from jsonb_array_elements(p_proof->'media'))<>jsonb_array_length(p_proof->'media')
  then raise exception 'SYNC_CREATION_READBACK_MEDIA'; end if;
  for image in select value from jsonb_array_elements(p_proof->'media') loop
    expected:=p_ready->'imageEvidence'->v_i;
    if not public.creation_has_keys(image,array['productGid','mediaGid','status','url','alt','sha256','mime','width','height','byteLength','verifiedAt'])
      or image->>'productGid' is distinct from s->>'productGid' or image->>'mediaGid' !~ '^gid://shopify/MediaImage/[1-9][0-9]*$'
      or image->>'status' is distinct from 'READY' or not public.creation_media_url(image->>'url')
      or image->>'url' !~ '^https://cdn[.]shopify[.]com/s/files/' or image->>'alt' is distinct from source->'media'->v_i->>'alt'
      or image->'sha256' is distinct from expected->'sha256' or image->'mime' is distinct from expected->'mime'
      or image->'width' is distinct from expected->'width' or image->'height' is distinct from expected->'height'
      or image->'byteLength' is distinct from expected->'byteLength'
    then raise exception 'SYNC_CREATION_READBACK_MEDIA'; end if;
    v_at:=(image->>'verifiedAt')::timestamptz;
    if v_at is null or not isfinite(v_at) or v_at<clock_timestamp()-interval '5 minutes' or v_at>clock_timestamp()+interval '30 seconds'
    then raise exception 'SYNC_CREATION_READBACK_STALE'; end if;
    v_i:=v_i+1;
  end loop;
end $$;

create or replace function public.advance_gallery_shopify_draft(p_id uuid,p_owner uuid,p_expected_version bigint,p_expected_stage text,p_patch jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r public.shopify_gallery_creation_drafts%rowtype; e public.shopify_gallery_creation_events%rowtype;
  v_ready jsonb; v_receipt jsonb; v_to text; v_product text; v_variant text; v_at timestamptz; v_result jsonb; v_prepare boolean;
  v_original_content jsonb; v_fresh_content jsonb; v_outbox bigint;
begin
  if p_owner is null or p_expected_version is null or p_expected_version<1 or p_expected_stage is null
    or p_patch is null or jsonb_typeof(p_patch)<>'object' or not(p_patch?'receipt') or octet_length(p_patch::text)>2500000
    or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('readyProof','receipt','readbackProof','freshReadyProof'))
  then raise exception 'SYNC_CREATION_ADVANCE_INVALID'; end if;
  perform set_config('lock_timeout','3000ms',true); perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  select * into r from public.shopify_gallery_creation_drafts where id=p_id for update;
  if not found then raise exception 'SYNC_CREATION_NOT_FOUND'; end if;
  if r.lease_owner is distinct from p_owner or r.lease_expires_at is null or r.lease_expires_at<=clock_timestamp()
  then raise exception 'SYNC_CREATION_LEASE_LOST'; end if;
  perform public.creation_assert_source(p_id);
  if r.product_gid is not null then
    perform 1 from public.shopify_gallery_reconciliation_leases where product_gid=r.product_gid and owner=p_owner and expires_at>clock_timestamp() for update;
    if not found then raise exception 'SYNC_CREATION_LEASE_LOST'; end if;
  end if;
  select * into e from public.shopify_gallery_creation_events where draft_id=p_id and from_version=p_expected_version;
  if found then
    if e.expected_stage is distinct from p_expected_stage or e.patch<>p_patch then raise exception 'SYNC_CREATION_REQUEST_REUSED'; end if;
    -- Historical acknowledgement, never permission to repeat an external write.
    return e.result||'{"replayed":true}'::jsonb;
  end if;
  if r.version<>p_expected_version or r.stage<>p_expected_stage then raise exception 'SYNC_CREATION_STATE_CAS'; end if;
  v_ready:=coalesce(p_patch->'readyProof',r.ready_proof); v_receipt:=p_patch->'receipt'; v_to:=v_receipt->>'stage';
  v_prepare:=r.stage='reserved' and v_to='reserved' and r.ready_proof is null and r.receipt is null;
  if v_ready is null or v_ready='null'::jsonb or (r.ready_proof is not null and v_ready<>r.ready_proof)
  then raise exception 'SYNC_CREATION_READY_PROOF_CHANGED'; end if;
  if v_prepare then perform public.creation_assert_ready(r.source,r.catalog_key,v_ready); end if;
  if not v_prepare and not (
    (r.stage='reserved' and v_to in ('create_started','review')) or
    (r.stage='create_started' and v_to in ('draft_found','uncertain','review')) or
    (r.stage='draft_found' and v_to in ('variant_started','review')) or
    (r.stage='variant_started' and v_to in ('draft_ready','uncertain','review')) or
    (r.stage='uncertain' and v_to in ('draft_ready','review')) or
    (r.stage='draft_ready' and v_to='review'))
  then raise exception 'SYNC_CREATION_STAGE_TRANSITION_INVALID'; end if;
  if v_to in ('create_started','variant_started') then
    perform public.creation_assert_ready(r.source,r.catalog_key,p_patch->'freshReadyProof');
    v_original_content:=(v_ready-'imageEvidence')||jsonb_build_object('imageEvidence',
      (select jsonb_agg(value-'verifiedAt' order by ord) from jsonb_array_elements(v_ready->'imageEvidence') with ordinality as image(value,ord)));
    v_fresh_content:=((p_patch->'freshReadyProof')-'imageEvidence')||jsonb_build_object('imageEvidence',
      (select jsonb_agg(value-'verifiedAt' order by ord) from jsonb_array_elements(p_patch->'freshReadyProof'->'imageEvidence') with ordinality as image(value,ord)));
    if v_original_content is distinct from v_fresh_content then raise exception 'SYNC_CREATION_READY_PROOF_CHANGED'; end if;
  elsif p_patch?'freshReadyProof' then raise exception 'SYNC_CREATION_READY_PROOF_STAGE'; end if;
  if not public.creation_has_keys(v_receipt,array['policyVersion','galleryItemId','sourceFingerprint','customId','stage',
      'productGid','variantGid','shopifyUpdatedAt','commercialFingerprint','initialCommercial'])
    or v_receipt->>'policyVersion' is distinct from 'gallery-shopify-draft-v1'
    or v_receipt->>'galleryItemId' is distinct from p_id::text
    or v_receipt->>'sourceFingerprint' is distinct from v_ready->>'sourceFingerprint'
    or v_receipt->'customId' is distinct from v_ready->'customId'
    or v_to is null or v_to not in ('reserved','create_started','draft_found','variant_started','draft_ready','uncertain','review')
  then raise exception 'SYNC_CREATION_RECEIPT_INVALID'; end if;
  v_product:=v_receipt->>'productGid'; v_variant:=v_receipt->>'variantGid';
  if (v_product is null)<>(v_variant is null) or (v_product is not null and (v_product !~ '^gid://shopify/Product/[1-9][0-9]*$'
      or v_variant !~ '^gid://shopify/ProductVariant/[1-9][0-9]*$'))
    or (r.product_gid is not null and v_product is distinct from r.product_gid)
    or (r.variant_gid is not null and v_variant is distinct from r.variant_gid)
    or (v_to in ('reserved','create_started') and (v_product is not null or v_receipt->'shopifyUpdatedAt'<>'null'::jsonb
      or v_receipt->'initialCommercial'<>'null'::jsonb or v_receipt->'commercialFingerprint'<>'null'::jsonb))
    or (v_to in ('draft_found','variant_started','draft_ready') and (v_product is null or v_receipt->'initialCommercial'='null'::jsonb))
  then raise exception 'SYNC_CREATION_RECEIPT_IDENTITY_INVALID'; end if;
  if v_receipt->'initialCommercial'<>'null'::jsonb then
    if v_receipt->>'commercialFingerprint' is distinct from public.creation_commercial_hash(v_receipt->'initialCommercial')
      or (r.receipt is not null and r.receipt->'initialCommercial'<>'null'::jsonb and
        (v_receipt->'initialCommercial' is distinct from r.receipt->'initialCommercial' or v_receipt->'commercialFingerprint' is distinct from r.receipt->'commercialFingerprint'))
      or ((r.receipt is null or r.receipt->'initialCommercial'='null'::jsonb) and not(r.stage='create_started' and v_to='draft_found'))
    then raise exception 'SYNC_CREATION_INITIAL_COMMERCE_PROOF_REQUIRED'; end if;
  elsif v_receipt->'commercialFingerprint'<>'null'::jsonb or (r.receipt is not null and r.receipt->'initialCommercial'<>'null'::jsonb)
  then raise exception 'SYNC_CREATION_INITIAL_COMMERCE_CHANGED'; end if;
  if v_product is not null then
    v_at:=(v_receipt->>'shopifyUpdatedAt')::timestamptz;
    if v_at is null or not isfinite(v_at) or v_at>clock_timestamp()+interval '30 seconds'
      or (r.receipt->>'shopifyUpdatedAt' is not null and v_at<(r.receipt->>'shopifyUpdatedAt')::timestamptz)
    then raise exception 'SYNC_CREATION_SHOPIFY_VERSION_INVALID'; end if;
    if exists(select 1 from public.shopify_gallery_bindings where product_gid=v_product or variant_gid=v_variant)
      or exists(select 1 from public.shopify_gallery_copy_eligibility where product_gid=v_product or variant_gid=v_variant)
      or exists(select 1 from public.shopify_gallery_public_links where variant_id=replace(v_variant,'gid://shopify/ProductVariant/',''))
    then raise exception 'SYNC_CREATION_PRODUCT_COLLISION'; end if;
    if r.product_gid is null then
      insert into public.shopify_gallery_reconciliation_leases(product_gid,owner,expires_at) values(v_product,p_owner,r.lease_expires_at)
        on conflict(product_gid) do update set owner=excluded.owner,expires_at=excluded.expires_at
        where public.shopify_gallery_reconciliation_leases.expires_at<=clock_timestamp() or public.shopify_gallery_reconciliation_leases.owner=p_owner;
      if not found then raise exception 'SYNC_CREATION_PRODUCT_BUSY'; end if;
    end if;
  elsif v_receipt->'shopifyUpdatedAt'<>'null'::jsonb then raise exception 'SYNC_CREATION_SHOPIFY_VERSION_INVALID'; end if;
  if v_to='draft_ready' then perform public.creation_assert_readback(v_ready,v_receipt,p_patch->'readbackProof');
  elsif p_patch?'readbackProof' then raise exception 'SYNC_CREATION_READBACK_STAGE_INVALID'; end if;
  select count(*) into v_outbox from public.shopify_gallery_content_outbox;
  update public.shopify_gallery_creation_drafts set ready_proof=v_ready,receipt=v_receipt,stage=v_to,version=version+1,last_error=null,
    product_gid=v_product,variant_gid=v_variant,updated_at=clock_timestamp() where id=p_id;
  v_result:=public.creation_record(p_id);
  insert into public.shopify_gallery_creation_events(draft_id,from_version,expected_stage,patch,result)
    values(p_id,p_expected_version,p_expected_stage,p_patch,v_result);
  if (select count(*) from public.shopify_gallery_content_outbox)<>v_outbox then raise exception 'SYNC_CREATION_UNEXPECTED_OUTBOX'; end if;
  return v_result;
end $$;

drop trigger if exists creation_draft_immutable on public.shopify_gallery_creation_drafts;
create trigger creation_draft_immutable before update or delete on public.shopify_gallery_creation_drafts
  for each row execute function public.creation_immutable_record();
drop trigger if exists creation_event_immutable on public.shopify_gallery_creation_events;
create trigger creation_event_immutable before update or delete on public.shopify_gallery_creation_events
  for each row execute function public.creation_immutable_record();

create or replace function public.creation_has_keys(p_value jsonb,p_keys text[]) returns boolean
language sql immutable set search_path=pg_catalog as $$
  select coalesce(jsonb_typeof(p_value)='object' and p_value ?& p_keys
    and (select count(*) from jsonb_object_keys(p_value))=cardinality(p_keys),false)
$$;
create or replace function public.creation_catalog_key(p_sku text) returns text
language sql immutable set search_path=pg_catalog as $$
  select regexp_replace(regexp_replace(upper(coalesce(p_sku,'')),'[^A-Z0-9]','','g'),'^(P[0-9]{2}.*)TU$','\1')
$$;
create or replace function public.creation_media_url(p_url text) returns boolean
language sql immutable set search_path=pg_catalog as $$
  select coalesce(length(p_url)<=2048 and p_url !~ '[[:space:]\\#]' and p_url !~* '%(2e|2f|5c)'
    and (p_url ~ '^https://cdn[.]shopify[.]com/s/files/[^?]+'
      or p_url ~ '^https://ekgpaoavsavrtbhlbwdg[.]supabase[.]co/storage/v1/object/public/carousel-media/[^?]+'),false)
$$;
create or replace function public.creation_source_hash(p_id uuid) returns text
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select encode(sha256(convert_to(jsonb_build_object('item',to_jsonb(i)-'created_at'-'updated_at',
    'angles',coalesce((select jsonb_agg(to_jsonb(a)-'created_at'-'updated_at' order by a.angle_order,a.id)
      from public.carousel_item_angles a where a.item_id=i.id),'[]'::jsonb))::text,'UTF8')),'hex')
  from public.carousel_items i where i.id=p_id
$$;
create or replace function public.creation_record(p_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('id',id,'source',source,'catalogKey',catalog_key,'stage',stage,'version',version,
    'readyProof',ready_proof,'receipt',receipt,'leaseExpiresAt',lease_expires_at,'lastError',last_error,'replayed',false)
  from public.shopify_gallery_creation_drafts where id=p_id
$$;
create or replace function public.creation_assert_source(p_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r public.shopify_gallery_creation_drafts%rowtype;
begin
  select * into r from public.shopify_gallery_creation_drafts where id=p_id for update;
  if not found then raise exception 'SYNC_CREATION_NOT_FOUND'; end if;
  perform 1 from public.carousel_items where id=p_id for update;
  perform 1 from public.carousel_item_angles where item_id=p_id order by angle_order,id for update;
  if public.creation_source_hash(p_id) is distinct from r.source_row_hash
    or not exists(select 1 from public.carousel_items where id=p_id and not is_active and catalog_number=r.source->>'shopifySku')
    or (select count(*) from public.carousel_items where public.creation_catalog_key(catalog_number)=r.catalog_key)<>1
    or exists(select 1 from public.shopify_gallery_bindings where catalog_key=r.catalog_key or carousel_item_id=p_id
      or product_gid=r.product_gid or variant_gid=r.variant_gid)
    or exists(select 1 from public.shopify_gallery_copy_eligibility where catalog_key=r.catalog_key or carousel_item_id=p_id
      or product_gid=r.product_gid or variant_gid=r.variant_gid)
    or exists(select 1 from public.shopify_gallery_public_links where catalog_key=r.catalog_key)
    or exists(select 1 from public.shopify_gallery_sync_state where catalog_key=r.catalog_key)
  then raise exception 'SYNC_CREATION_SOURCE_CHANGED'; end if;
end $$;

create or replace function public.reserve_gallery_shopify_draft(p_draft jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_id uuid; v_key text; v_sku text; v_copy jsonb; v_commerce jsonb; v_media jsonb; v_mapping jsonb;
  v_version timestamptz; v_order int; v_index int:=0; v_outbox bigint; v_result jsonb; r public.shopify_gallery_creation_drafts%rowtype;
begin
  if p_draft is null or octet_length(p_draft::text)>1000000 or not public.creation_has_keys(p_draft,
    array['galleryItemId','copyUpdatedAt','shopifySku','manufacturerSku','identityMapping','brand','category','copy','media','commerce'])
  then raise exception 'SYNC_CREATION_DRAFT_INVALID'; end if;
  v_id:=(p_draft->>'galleryItemId')::uuid; v_version:=(p_draft->>'copyUpdatedAt')::timestamptz;
  v_sku:=p_draft->>'shopifySku'; v_key:=public.creation_catalog_key(v_sku);
  v_copy:=p_draft->'copy'; v_commerce:=p_draft->'commerce'; v_mapping:=p_draft->'identityMapping';
  if v_id is null or not isfinite(v_version) or v_version>clock_timestamp()+interval '30 seconds'
    or v_sku is null or length(v_sku) not between 2 and 64 or v_sku<>btrim(v_sku) or v_sku !~ '^[A-Za-z0-9][A-Za-z0-9._ /-]*$'
    or v_key='' or v_key in ('P10OSV0405J','P10ZJT0624U','ORI05500909','ORI05500024')
    or public.creation_catalog_key(p_draft->>'manufacturerSku') in ('P10OSV0405J','P10ZJT0624U','ORI05500909','ORI05500024')
    or jsonb_typeof(p_draft->'brand') is distinct from 'string' or p_draft->>'brand' not in ('Mandarina Duck','Bric''s','Samsonite')
    or jsonb_typeof(p_draft->'category') not in ('string','null')
    or (p_draft->'category'<>'null'::jsonb and p_draft->>'category' not in ('carryon','suitcase'))
    or (p_draft->'manufacturerSku'<>'null'::jsonb and (jsonb_typeof(p_draft->'manufacturerSku')<>'string'
      or length(p_draft->>'manufacturerSku') not between 2 and 64 or p_draft->>'manufacturerSku' !~ '^[A-Za-z0-9][A-Za-z0-9._ /-]*$'))
  then raise exception 'SYNC_CREATION_IDENTITY_INVALID'; end if;
  if p_draft->'manufacturerSku'<>'null'::jsonb and p_draft->>'manufacturerSku'<>v_sku then
    if not public.creation_has_keys(v_mapping,array['shopifySku','manufacturerSku','sourceUrl','evidenceSha256','verifiedAt'])
      or v_mapping->>'shopifySku' is distinct from v_sku or v_mapping->>'manufacturerSku' is distinct from p_draft->>'manufacturerSku'
      or v_mapping->>'sourceUrl' !~ '^https://' or length(v_mapping->>'sourceUrl')>2000
      or v_mapping->>'evidenceSha256' !~ '^[a-f0-9]{64}$' or not isfinite((v_mapping->>'verifiedAt')::timestamptz)
    then raise exception 'SYNC_CREATION_MAPPING_REQUIRED'; end if;
  elsif v_mapping<>'null'::jsonb then
    if v_mapping->>'shopifySku' is distinct from v_sku or v_mapping->>'manufacturerSku' is distinct from p_draft->>'manufacturerSku'
    then raise exception 'SYNC_CREATION_MAPPING_INVALID'; end if;
  end if;
  if not public.creation_has_keys(v_copy,array['title','description','descriptionHtml','seoTitle','seoDescription'])
    or jsonb_typeof(v_copy->'title')<>'string' or length(btrim(v_copy->>'title')) not between 1 and 120 or btrim(v_copy->>'title')='מוצר חדש'
    or jsonb_typeof(v_copy->'description')<>'string' or length(v_copy->>'description')>50000
    or jsonb_typeof(v_copy->'descriptionHtml') not in ('string','null') or length(v_copy->>'descriptionHtml')>200000
    or jsonb_typeof(v_copy->'seoTitle') not in ('string','null') or length(v_copy->>'seoTitle')>512
    or jsonb_typeof(v_copy->'seoDescription') not in ('string','null') or length(v_copy->>'seoDescription')>5000
  then raise exception 'SYNC_CREATION_COPY_INVALID'; end if;
  if not public.creation_has_keys(v_commerce,array['sellingPrice','currency','compareAtPrice','barcode','taxable','requiresShipping','inventory','storeIntent'])
    or jsonb_typeof(v_commerce->'currency')<>'string' or v_commerce->>'currency' !~ '^[A-Z]{3}$'
    or v_commerce->'requiresShipping' is distinct from 'true'::jsonb or v_commerce->>'storeIntent' is distinct from 'draft'
    or v_commerce->'inventory' is distinct from '{"status":"unknown"}'::jsonb
    or jsonb_typeof(v_commerce->'taxable') not in ('boolean','null')
    or jsonb_typeof(v_commerce->'barcode') not in ('string','null') or length(v_commerce->>'barcode') not between 1 and 64
  then raise exception 'SYNC_CREATION_COMMERCE_INVALID'; end if;
  for v_media in select value from jsonb_each(v_commerce) where key in ('sellingPrice','compareAtPrice') loop
    if v_media<>'null'::jsonb and (jsonb_typeof(v_media)<>'string' or (v_media#>>'{}') !~ '^(0|[1-9][0-9]{0,6})([.][0-9]{1,2})?$'
      or (v_media#>>'{}')::numeric<=0) then raise exception 'SYNC_CREATION_COMMERCE_INVALID'; end if;
  end loop;
  if v_commerce->'compareAtPrice'<>'null'::jsonb and (v_commerce->'sellingPrice'='null'::jsonb
    or (v_commerce->>'compareAtPrice')::numeric<=(v_commerce->>'sellingPrice')::numeric) then raise exception 'SYNC_CREATION_COMMERCE_INVALID'; end if;
  if jsonb_typeof(p_draft->'media')<>'array' or jsonb_array_length(p_draft->'media') not between 1 and 10
    or (select count(distinct value->>'url') from jsonb_array_elements(p_draft->'media'))<>jsonb_array_length(p_draft->'media')
  then raise exception 'SYNC_CREATION_MEDIA_INVALID'; end if;
  for v_media in select value from jsonb_array_elements(p_draft->'media') loop
    if not public.creation_has_keys(v_media,array['url','alt']) or not public.creation_media_url(v_media->>'url')
      or jsonb_typeof(v_media->'alt')<>'string' or length(btrim(v_media->>'alt')) not between 1 and 200
    then raise exception 'SYNC_CREATION_MEDIA_INVALID'; end if;
  end loop;
  perform set_config('lock_timeout','3000ms',true);
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  lock table public.carousel_items,public.carousel_item_angles in share row exclusive mode;
  select * into r from public.shopify_gallery_creation_drafts where id=v_id for update;
  if found then
    if r.source<>p_draft then raise exception 'SYNC_CREATION_RESERVATION_CONFLICT'; end if;
    perform public.creation_assert_source(v_id);
    return public.creation_record(v_id)||'{"replayed":true}'::jsonb;
  end if;
  if exists(select 1 from public.carousel_items where id=v_id or public.creation_catalog_key(catalog_number)=v_key)
    or exists(select 1 from public.shopify_gallery_creation_drafts where catalog_key=v_key)
    or exists(select 1 from public.shopify_gallery_bindings where catalog_key=v_key or carousel_item_id=v_id)
    or exists(select 1 from public.shopify_gallery_copy_eligibility where catalog_key=v_key or carousel_item_id=v_id)
    or exists(select 1 from public.shopify_gallery_public_links where catalog_key=v_key)
    or exists(select 1 from public.shopify_gallery_sync_state where catalog_key=v_key)
  then raise exception 'SYNC_CREATION_GALLERY_SKU_COLLISION'; end if;
  select coalesce(max(display_order),0)+1 into v_order from public.carousel_items;
  if v_order>9999 or (select count(*) from public.carousel_items)>=5000 then raise exception 'SYNC_CREATION_CATALOG_CAPACITY'; end if;
  select count(*) into v_outbox from public.shopify_gallery_content_outbox;
  insert into public.carousel_items(id,catalog_number,title,description,description_html,seo_title,seo_description,copy_updated_at,
    cover_image_path,display_order,is_active,source_url,tech_specs)
    values(v_id,v_sku,v_copy->>'title',nullif(v_copy->>'description',''),v_copy->>'descriptionHtml',v_copy->>'seoTitle',v_copy->>'seoDescription',v_version,
      p_draft->'media'->0->>'url',v_order,false,null,jsonb_build_object('specs',jsonb_build_array(jsonb_build_object('heading','פרטי מוצר',
        'items',jsonb_build_array(jsonb_build_object('label','מותג','value',p_draft->>'brand')))),'colors','[]'::jsonb,'category',p_draft->'category'));
  for v_media in select value from jsonb_array_elements(p_draft->'media') loop
    v_index:=v_index+1;
    insert into public.carousel_item_angles(item_id,angle_key,image_path,angle_order)
      values(v_id,case when v_index=1 then 'front' else 'view-'||v_index end,v_media->>'url',v_index);
  end loop;
  insert into public.shopify_gallery_creation_drafts(id,catalog_key,source,source_row_hash)
    values(v_id,v_key,p_draft,public.creation_source_hash(v_id));
  v_result:=public.creation_record(v_id);
  insert into public.shopify_gallery_creation_events(draft_id,from_version,patch,result) values(v_id,0,p_draft,v_result);
  if (select count(*) from public.shopify_gallery_content_outbox)<>v_outbox then raise exception 'SYNC_CREATION_UNEXPECTED_OUTBOX'; end if;
  return v_result;
end $$;

create or replace function public.claim_gallery_shopify_draft(p_id uuid,p_owner uuid,p_seconds integer default 60) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r public.shopify_gallery_creation_drafts%rowtype; v_expiry timestamptz;
begin
  if p_owner is null or p_id is null or p_seconds is null or p_seconds not between 30 and 300 then raise exception 'SYNC_CREATION_LEASE_INVALID'; end if;
  perform set_config('lock_timeout','3000ms',true); perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  select * into r from public.shopify_gallery_creation_drafts where id=p_id for update;
  if not found then raise exception 'SYNC_CREATION_NOT_FOUND'; end if;
  if r.lease_expires_at>clock_timestamp() then
    if r.lease_owner=p_owner then perform public.creation_assert_source(p_id); return public.creation_record(p_id); end if;
    return null;
  end if;
  perform public.creation_assert_source(p_id);
  v_expiry:=clock_timestamp()+make_interval(secs=>p_seconds);
  if r.product_gid is not null then
    insert into public.shopify_gallery_reconciliation_leases(product_gid,owner,expires_at) values(r.product_gid,p_owner,v_expiry)
      on conflict(product_gid) do update set owner=excluded.owner,expires_at=excluded.expires_at
      where public.shopify_gallery_reconciliation_leases.expires_at<=clock_timestamp() or public.shopify_gallery_reconciliation_leases.owner=p_owner;
    if not found then return null; end if;
  end if;
  update public.shopify_gallery_creation_drafts set lease_owner=p_owner,lease_expires_at=v_expiry where id=p_id;
  return public.creation_record(p_id);
end $$;

create or replace function public.release_gallery_shopify_draft(p_id uuid,p_owner uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r public.shopify_gallery_creation_drafts%rowtype;
begin
  perform set_config('lock_timeout','3000ms',true); perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  select * into r from public.shopify_gallery_creation_drafts where id=p_id and lease_owner=p_owner for update;
  if not found then return false; end if;
  delete from public.shopify_gallery_reconciliation_leases where product_gid=r.product_gid and owner=p_owner;
  update public.shopify_gallery_creation_drafts set lease_owner=null,lease_expires_at=null where id=p_id;
  return true;
end $$;

-- A filtered diagnostic may be recorded even when source CAS failed. This never
-- changes the frozen source, stage, version, readiness proof, or external state.
create or replace function public.record_gallery_shopify_draft_error(p_id uuid,p_owner uuid,p_error text) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if p_error is null or length(p_error)>100 or p_error !~ '^(SYNC|SHOPIFY)_[A-Z0-9_]+$' then raise exception 'SYNC_CREATION_ERROR_CODE_INVALID'; end if;
  perform set_config('lock_timeout','3000ms',true); perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  update public.shopify_gallery_creation_drafts set last_error=p_error
    where id=p_id and lease_owner=p_owner and lease_expires_at>clock_timestamp();
  return found;
end $$;

revoke all on function public.creation_immutable_record(),public.creation_has_keys(jsonb,text[]),public.creation_catalog_key(text),
  public.creation_media_url(text),public.creation_source_hash(uuid),public.creation_record(uuid),public.creation_assert_source(uuid),
  public.creation_assert_commercial(jsonb),public.creation_commercial_hash(jsonb),public.creation_assert_ready(jsonb,text,jsonb),
  public.creation_assert_readback(jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.reserve_gallery_shopify_draft(jsonb),public.claim_gallery_shopify_draft(uuid,uuid,integer),
  public.advance_gallery_shopify_draft(uuid,uuid,bigint,text,jsonb),public.release_gallery_shopify_draft(uuid,uuid),public.record_gallery_shopify_draft_error(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.reserve_gallery_shopify_draft(jsonb),public.claim_gallery_shopify_draft(uuid,uuid,integer),
  public.advance_gallery_shopify_draft(uuid,uuid,bigint,text,jsonb),public.release_gallery_shopify_draft(uuid,uuid),public.record_gallery_shopify_draft_error(uuid,uuid,text) to service_role;
