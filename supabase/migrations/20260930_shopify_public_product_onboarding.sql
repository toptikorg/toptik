-- Additive NEWONLY published-Shopify ingestion. Runtime activation is separate
-- and defaults off. Applying this schema performs no ingestion or Shopify write.
-- Apply after 20260930_verified_catalog_copy_activation.sql.
create table if not exists public.shopify_gallery_product_onboarding_receipts (
  product_gid text primary key check (product_gid ~ '^gid://shopify/Product/[1-9][0-9]*$'),
  variant_gid text not null unique check (variant_gid ~ '^gid://shopify/ProductVariant/[1-9][0-9]*$'),
  catalog_key text not null unique check (catalog_key ~ '^[A-Z0-9]+$'),
  carousel_item_id uuid not null unique references public.carousel_items(id) on delete restrict,
  exact_sku text not null,
  approval_id text not null unique references public.shopify_gallery_copy_activations(approval_id),
  source_event_id uuid not null,
  source_updated_at timestamptz not null,
  evidence jsonb not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.shopify_gallery_product_onboarding_receipts enable row level security;
revoke all on public.shopify_gallery_product_onboarding_receipts from public,anon,authenticated,service_role;
grant select on public.shopify_gallery_product_onboarding_receipts to service_role;
drop trigger if exists immutable_product_onboarding_receipt on public.shopify_gallery_product_onboarding_receipts;
create trigger immutable_product_onboarding_receipt before update or delete
  on public.shopify_gallery_product_onboarding_receipts for each row
  execute function public.reject_shopify_copy_approval_mutation();

create or replace function public.onboard_public_shopify_product(p_evidence jsonb,p_lease_owner uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_policy constant text := 'published-shopify-v1';
  v_product text; v_variant text; v_sku text; v_key text; v_handle text;
  v_event_id uuid; v_source timestamptz; v_verified timestamptz; v_event_source timestamptz;
  v_event public.shopify_webhook_events%rowtype;
  v_receipt public.shopify_gallery_product_onboarding_receipts%rowtype;
  v_item_id uuid; v_approval text; v_hash text; v_manifest jsonb; v_copy jsonb;
  v_media jsonb; v_ordinal integer := 0; v_order integer; v_now timestamptz;
  v_outbox_count bigint; v_brand text; v_category text;
begin
  if jsonb_typeof(p_evidence) is distinct from 'object' or octet_length(p_evidence::text)>1000000
    or not (p_evidence ?& array['policyVersion','eventId','productGid','variantGid','exactSku','catalogKey','handle',
      'sourceUpdatedAt','brandLabel','category','copy','media','verifiedAt','shopifyCollisionCount',
      'status','publishedOnPublication','variantCount','shopDomain'])
    or exists (select 1 from jsonb_object_keys(p_evidence) key where key not in
      ('policyVersion','eventId','productGid','variantGid','exactSku','catalogKey','handle','sourceUpdatedAt',
       'brandLabel','category','copy','media','verifiedAt','shopifyCollisionCount','status',
       'publishedOnPublication','variantCount','shopDomain'))
    or p_evidence->>'policyVersion' is distinct from v_policy
    or p_evidence->>'shopDomain' is distinct from 'toptikcoil.myshopify.com'
    or p_evidence->>'status' is distinct from 'ACTIVE'
    or p_evidence->'publishedOnPublication' is distinct from 'true'::jsonb
    or p_evidence->'variantCount' is distinct from '1'::jsonb
    or p_evidence->'shopifyCollisionCount' is distinct from '1'::jsonb
  then raise exception 'SYNC_ONBOARDING_EVIDENCE_INVALID'; end if;
  if exists (select 1 from unnest(array['policyVersion','eventId','productGid','variantGid','exactSku','catalogKey',
      'handle','sourceUpdatedAt','brandLabel','verifiedAt','status','shopDomain']) key
    where jsonb_typeof(p_evidence->key) is distinct from 'string')
    or (jsonb_typeof(p_evidence->'category') is distinct from 'null'
        and p_evidence->>'category' not in ('suitcase','carryon'))
  then raise exception 'SYNC_ONBOARDING_EVIDENCE_INVALID'; end if;
  v_product:=p_evidence->>'productGid'; v_variant:=p_evidence->>'variantGid';
  v_sku:=p_evidence->>'exactSku'; v_key:=p_evidence->>'catalogKey'; v_handle:=p_evidence->>'handle';
  v_brand:=p_evidence->>'brandLabel'; v_category:=p_evidence->>'category';
  if v_product !~ '^gid://shopify/Product/[1-9][0-9]*$'
    or v_variant !~ '^gid://shopify/ProductVariant/[1-9][0-9]*$'
    or length(v_sku) not between 2 and 64 or v_sku<>btrim(v_sku)
    or v_sku !~ '^[A-Za-z0-9][A-Za-z0-9._ /-]*$'
    or v_key !~ '^[A-Z0-9]+$'
    or v_key is distinct from regexp_replace(regexp_replace(upper(v_sku),'[^A-Z0-9]','','g'),'^(P[0-9]{2}.*)TU$','\1')
    or not public.shopify_safe_product_handle(v_handle)
    or v_brand not in ('Mandarina Duck','Bric''s','Samsonite')
  then raise exception 'SYNC_ONBOARDING_IDENTITY_INVALID'; end if;
  -- Explicit unresolved Gallery rows, hidden Porsche rows and the payment test
  -- remain excluded even if an upstream classification is later changed.
  if v_key in ('P10OSV0405J','P10ZJT0624U','ORI05500909','ORI05500024')
    or v_product='gid://shopify/Product/9399665819898'
  then raise exception 'SYNC_ONBOARDING_HELD_PRODUCT'; end if;
  begin
    if p_evidence->>'eventId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or p_evidence->>'sourceUpdatedAt' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$'
      or p_evidence->>'verifiedAt' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$'
    then raise exception 'SYNC_ONBOARDING_TIMESTAMP_INVALID'; end if;
    v_event_id:=(p_evidence->>'eventId')::uuid;
    v_source:=(p_evidence->>'sourceUpdatedAt')::timestamptz;
    v_verified:=(p_evidence->>'verifiedAt')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format
    then raise exception 'SYNC_ONBOARDING_TIMESTAMP_INVALID';
  end;
  if not isfinite(v_source) or not isfinite(v_verified)
    or v_verified<clock_timestamp()-interval '5 minutes'
    or v_verified>clock_timestamp()+interval '30 seconds' or v_source>v_verified+interval '30 seconds'
  then raise exception 'SYNC_ONBOARDING_EVIDENCE_EXPIRED'; end if;

  v_copy:=p_evidence->'copy';
  if jsonb_typeof(v_copy) is distinct from 'object'
    or not (v_copy ?& array['title','description','descriptionHtml','seoTitle','seoDescription'])
    or exists (select 1 from jsonb_object_keys(v_copy) key where key not in ('title','description','descriptionHtml','seoTitle','seoDescription'))
    or jsonb_typeof(v_copy->'title') is distinct from 'string' or length(btrim(v_copy->>'title')) not between 1 and 120
    or length(v_copy->>'title')>120
    or jsonb_typeof(v_copy->'description') is distinct from 'string' or length(v_copy->>'description')>50000
    or jsonb_typeof(v_copy->'descriptionHtml') is distinct from 'string' or length(v_copy->>'descriptionHtml')>250000
    or jsonb_typeof(v_copy->'seoTitle') not in ('string','null') or length(v_copy->>'seoTitle')>512
    or jsonb_typeof(v_copy->'seoDescription') not in ('string','null') or length(v_copy->>'seoDescription')>5000
  then raise exception 'SYNC_ONBOARDING_COPY_INVALID'; end if;
  if jsonb_typeof(p_evidence->'media') is distinct from 'array'
    or jsonb_array_length(p_evidence->'media') not between 1 and 20
  then raise exception 'SYNC_ONBOARDING_MEDIA_INVALID'; end if;
  for v_media in select value from jsonb_array_elements(p_evidence->'media') loop
    if jsonb_typeof(v_media) is distinct from 'object'
      or not (v_media ?& array['mediaGid','url','width','height','mime','sha256','byteLength'])
      or exists (select 1 from jsonb_object_keys(v_media) key where key not in ('mediaGid','url','width','height','mime','sha256','byteLength'))
      or exists (select 1 from unnest(array['mediaGid','url','mime','sha256']) key where jsonb_typeof(v_media->key) is distinct from 'string')
      or v_media->>'mediaGid' !~ '^gid://shopify/MediaImage/[1-9][0-9]*$'
      or length(v_media->>'url')>2048 or v_media->>'url' !~ '^https://cdn[.]shopify[.]com/s/files/[^[:space:]#\\]+$'
      or v_media->>'mime' not in ('image/jpeg','image/png','image/webp','image/avif','image/gif')
      or v_media->>'sha256' !~ '^[a-f0-9]{64}$'
      or exists (select 1 from unnest(array['width','height','byteLength']) key
        where jsonb_typeof(v_media->key) is distinct from 'number' or v_media->>key !~ '^[1-9][0-9]{0,7}$')
    then raise exception 'SYNC_ONBOARDING_MEDIA_INVALID'; end if;
    if (v_media->>'width')::integer>16000 or (v_media->>'height')::integer>16000
      or (v_media->>'width')::bigint*(v_media->>'height')::bigint>16000000
      or (v_media->>'byteLength')::integer>8388608
    then raise exception 'SYNC_ONBOARDING_MEDIA_INVALID'; end if;
  end loop;
  if (select count(*)<>count(distinct value->>'mediaGid') or count(*)<>count(distinct value->>'url')
    from jsonb_array_elements(p_evidence->'media'))
  then raise exception 'SYNC_ONBOARDING_MEDIA_INVALID'; end if;

  perform set_config('lock_timeout','3000ms',true);
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  -- Excludes concurrent inserts even from legacy save paths without this lock.
  lock table public.carousel_items,public.carousel_item_angles,public.shopify_gallery_bindings,
    public.shopify_gallery_public_links,public.shopify_gallery_sync_state,
    public.shopify_gallery_copy_activations,public.shopify_gallery_copy_eligibility,
    public.shopify_gallery_copy_activation_receipts,public.shopify_gallery_copy_activation_events,
    public.shopify_gallery_product_onboarding_receipts,public.shopify_gallery_content_outbox
    in share row exclusive mode;
  if p_lease_owner is null or not exists (select 1 from public.shopify_gallery_reconciliation_leases
    where product_gid=v_product and owner=p_lease_owner and expires_at>clock_timestamp()
      and v_verified>=expires_at-interval '5 minutes 30 seconds' for update)
  then raise exception 'SYNC_ONBOARDING_LEASE_LOST'; end if;
  select * into v_event from public.shopify_webhook_events where id=v_event_id for update;
  if not found or v_event.status<>'processing' or v_event.claimed_at is null
    or v_event.claimed_at<clock_timestamp()-interval '15 minutes'
    or v_event.shop_domain<>'toptikcoil.myshopify.com' or v_event.topic not in ('products/create','products/update')
    or coalesce(case when v_event.payload->>'id' ~ '^[1-9][0-9]*$'
         then 'gid://shopify/Product/'||(v_event.payload->>'id') else v_event.payload->>'id' end,'')<>v_product
    or (v_event.payload ? 'admin_graphql_api_id' and v_event.payload->>'admin_graphql_api_id' is distinct from v_product)
  then raise exception 'SYNC_ONBOARDING_EVENT_INVALID'; end if;
  if v_event.payload->>'updated_at' is not null then
    begin v_event_source:=(v_event.payload->>'updated_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation
      then raise exception 'SYNC_ONBOARDING_EVENT_INVALID'; end;
    if not isfinite(v_event_source) or v_source<v_event_source
    then raise exception 'SYNC_ONBOARDING_SOURCE_STALE'; end if;
  end if;

  select * into v_receipt from public.shopify_gallery_product_onboarding_receipts where product_gid=v_product;
  if found then
    if v_receipt.variant_gid<>v_variant or v_receipt.catalog_key<>v_key or v_receipt.exact_sku<>v_sku
      or not exists (select 1 from public.carousel_items i
        join public.shopify_gallery_bindings b on b.carousel_item_id=i.id
        join public.shopify_gallery_copy_eligibility e on e.product_gid=b.product_gid
        where i.id=v_receipt.carousel_item_id and i.catalog_number=v_sku and b.catalog_key=v_key
          and b.product_gid=v_product and b.variant_gid=v_variant and b.product_handle=v_handle
          and e.approval_id=v_receipt.approval_id and e.catalog_key=v_key and e.carousel_item_id=i.id
          and e.variant_gid=v_variant and e.exact_gallery_sku=v_sku and e.exact_shopify_sku=v_sku
          and e.approved_product_handle=v_handle)
    then raise exception 'SYNC_ONBOARDING_IDEMPOTENCY_CONFLICT'; end if;
    -- Never refresh copy/media, re-enable a disabled approval, or unhide a row.
    return jsonb_build_object('changed',false,'itemId',v_receipt.carousel_item_id,'catalogKey',v_key,'approvalId',v_receipt.approval_id);
  end if;
  if exists (select 1 from public.carousel_items where catalog_number=v_sku
       or regexp_replace(regexp_replace(upper(coalesce(catalog_number,'')),'[^A-Z0-9]','','g'),'^(P[0-9]{2}.*)TU$','\1')=v_key)
    or exists(select 1 from public.shopify_gallery_bindings where catalog_key=v_key or product_gid=v_product or variant_gid=v_variant)
    or exists(select 1 from public.shopify_gallery_copy_eligibility where catalog_key=v_key or product_gid=v_product or variant_gid=v_variant)
    or exists(select 1 from public.shopify_gallery_public_links where catalog_key=v_key or variant_id=replace(v_variant,'gid://shopify/ProductVariant/',''))
    or exists(select 1 from public.shopify_gallery_sync_state where catalog_key=v_key)
    or exists(select 1 from public.shopify_gallery_product_onboarding_receipts where catalog_key=v_key or variant_gid=v_variant)
  then raise exception 'SYNC_ONBOARDING_GALLERY_SKU_COLLISION'; end if;

  v_now:=clock_timestamp(); v_item_id:=gen_random_uuid();
  v_approval:=v_policy||':'||replace(v_product,'gid://shopify/Product/','');
  v_hash:=encode(pg_catalog.sha256(pg_catalog.convert_to(p_evidence::text,'UTF8')),'hex');
  v_manifest:=jsonb_build_object('policyVersion',v_policy,'kind','new_public_product',
    'sourceEncoding','postgres-jsonb-utf8','evidenceSha256',v_hash,'evidence',p_evidence);
  select count(*) into v_outbox_count from public.shopify_gallery_content_outbox;
  select coalesce(max(display_order),0)+1 into v_order from public.carousel_items;
  -- Match the existing editor's 5,000-row/9,999-order limits: ingestion must
  -- not create a catalog the authorized editor can no longer save.
  if v_order>9999 or (select count(*) from public.carousel_items)>=5000
  then raise exception 'SYNC_ONBOARDING_CATALOG_CAPACITY'; end if;
  insert into public.carousel_items(id,catalog_number,title,description,description_html,seo_title,seo_description,
    copy_updated_at,cover_image_path,display_order,is_active,source_url,tech_specs)
    values(v_item_id,v_sku,v_copy->>'title',nullif(v_copy->>'description',''),v_copy->>'descriptionHtml',
      v_copy->>'seoTitle',v_copy->>'seoDescription',v_now,p_evidence->'media'->0->>'url',v_order,true,null,
      jsonb_build_object('specs',jsonb_build_array(jsonb_build_object('heading','פרטי מוצר',
        'items',jsonb_build_array(jsonb_build_object('label','מותג','value',v_brand)))),'colors','[]'::jsonb,'category',v_category));
  for v_media in select value from jsonb_array_elements(p_evidence->'media') loop
    v_ordinal:=v_ordinal+1;
    insert into public.carousel_item_angles(item_id,angle_key,image_path,angle_order)
      values(v_item_id,case when v_ordinal=1 then 'front' else 'view-'||v_ordinal end,v_media->>'url',v_ordinal);
  end loop;
  insert into public.shopify_gallery_bindings(catalog_key,carousel_item_id,product_gid,variant_gid,product_handle,is_published,source_updated_at)
    values(v_key,v_item_id,v_product,v_variant,v_handle,true,v_source);
  insert into public.shopify_gallery_public_links(catalog_key,product_handle,variant_id,is_published)
    values(v_key,v_handle,replace(v_variant,'gid://shopify/ProductVariant/',''),true);
  insert into public.shopify_gallery_sync_state(catalog_key,last_synced_payload,last_synced_hash,
    gallery_baseline_payload,shopify_baseline_payload,gallery_updated_at,shopify_updated_at)
    values(v_key,v_copy,encode(pg_catalog.sha256(pg_catalog.convert_to(v_copy::text,'UTF8')),'hex'),v_copy,v_copy,v_now,v_source);
  -- Append a NEW approval identity. The frozen existing78 manifest and receipts
  -- are neither updated nor reused to authorize this new product.
  insert into public.shopify_gallery_copy_activations(approval_id,manifest_sha256,source_file_sha256,manifest)
    values(v_approval,encode(pg_catalog.sha256(pg_catalog.convert_to(v_manifest::text,'UTF8')),'hex'),v_hash,v_manifest);
  insert into public.shopify_gallery_copy_eligibility(product_gid,catalog_key,carousel_item_id,variant_gid,
    exact_gallery_sku,exact_shopify_sku,approved_product_handle,enabled,approval_id,approved_source_updated_at,alias_evidence)
    values(v_product,v_key,v_item_id,v_variant,v_sku,v_sku,v_handle,true,v_approval,v_source,
      jsonb_build_object('policyVersion',v_policy,'exactSku',v_sku,'eventId',v_event_id,'evidenceSha256',v_hash));
  insert into public.shopify_gallery_copy_activation_receipts(catalog_key,approval_id,snapshot)
    values(v_key,v_approval,public.verified_copy_current_receipt(v_item_id,v_key));
  insert into public.shopify_gallery_copy_activation_events(approval_id,event_kind)
    values(v_approval,'created'),(v_approval,'enabled');
  insert into public.shopify_gallery_product_onboarding_receipts(product_gid,variant_gid,catalog_key,carousel_item_id,
    exact_sku,approval_id,source_event_id,source_updated_at,evidence,evidence_sha256)
    values(v_product,v_variant,v_key,v_item_id,v_sku,v_approval,v_event_id,v_source,p_evidence,v_hash);
  if (select count(*) from public.shopify_gallery_content_outbox)<>v_outbox_count
  then raise exception 'SYNC_ONBOARDING_UNEXPECTED_OUTBOX'; end if;
  return jsonb_build_object('changed',true,'itemId',v_item_id,'catalogKey',v_key,'approvalId',v_approval);
end;
$$;
revoke all on function public.onboard_public_shopify_product(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.onboard_public_shopify_product(jsonb,uuid) to service_role;
