-- One explicit legacy alias. DDL only: no execution, backfill, or catalog write.
-- Requires verified_catalog_copy_activation + rich-copy/lease foundation.
create table if not exists public.shopify_existing_osv04_admission (
 product_gid text primary key check(product_gid='gid://shopify/Product/15401872654586'),
 approval_id text not null unique references public.shopify_gallery_copy_activations(approval_id),
 evidence jsonb not null, evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now()
);
alter table public.shopify_existing_osv04_admission enable row level security;
revoke all on public.shopify_existing_osv04_admission from public,anon,authenticated,service_role;
grant select on public.shopify_existing_osv04_admission to service_role;
drop trigger if exists immutable_osv04_admission on public.shopify_existing_osv04_admission;
create trigger immutable_osv04_admission before update or delete on public.shopify_existing_osv04_admission
 for each row execute function public.reject_shopify_copy_approval_mutation();

create or replace function public.read_existing_osv04_admission(p_lease_owner uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_item constant uuid:='70bce0cd-f69f-4d27-8e98-7632b458bf1f';
 v_product constant text:='gid://shopify/Product/15401872654586';
 v_key constant text:='P10OSV0405J';
 v_revision text; v_enabled boolean;
begin
 perform set_config('lock_timeout','3000ms',true);
 perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 lock table public.carousel_items,public.carousel_item_angles in share row exclusive mode;
 if p_lease_owner is null or not exists(select 1 from public.shopify_gallery_reconciliation_leases
   where product_gid=v_product and owner=p_lease_owner and expires_at>clock_timestamp() for update)
 then raise exception 'SYNC_OSV04_LEASE_LOST'; end if;
 if not exists(select 1 from public.carousel_items where id=v_item and catalog_number='P10OSV04-05J-TU')
 or (select count(*) from public.carousel_items where regexp_replace(regexp_replace(upper(coalesce(catalog_number,'')),'[^A-Z0-9]','','g'),'^(P[0-9]{2}.*)TU$','\1')=v_key)<>1
 then raise exception 'SYNC_OSV04_GALLERY_IDENTITY_CHANGED'; end if;
 if exists(select 1 from public.shopify_existing_osv04_admission where product_gid=v_product) then
  select e.enabled into v_enabled from public.shopify_gallery_copy_eligibility e
   join public.shopify_existing_osv04_admission r on r.product_gid=e.product_gid and r.approval_id=e.approval_id
   join public.shopify_gallery_bindings b on b.catalog_key=e.catalog_key
   join public.shopify_gallery_public_links l on l.catalog_key=e.catalog_key
   join public.shopify_gallery_sync_state s on s.catalog_key=e.catalog_key
  where e.product_gid=v_product and e.carousel_item_id=v_item and e.catalog_key=v_key
   and e.variant_gid='gid://shopify/ProductVariant/67612818669818'
   and e.exact_gallery_sku='P10OSV04-05J-TU' and e.exact_shopify_sku=v_key
   and e.approved_product_handle='p10osv0405j'
   and b.product_gid=e.product_gid and b.variant_gid=e.variant_gid and b.carousel_item_id=e.carousel_item_id
   and b.product_handle=e.approved_product_handle and b.is_published
   and l.product_handle=e.approved_product_handle and l.variant_id='67612818669818' and l.is_published
   and s.gallery_baseline_payload is not null and s.shopify_baseline_payload is not null
   and (select count(*) from public.shopify_gallery_bindings where product_gid=v_product)=1;
  if not found then raise exception 'SYNC_OSV04_EXISTING_ASSOCIATION_CHANGED'; end if;
  return jsonb_build_object('admitted',true,'replayed',true,'enabled',v_enabled,'itemId',v_item);
 end if;
 if exists(select 1 from public.shopify_gallery_bindings where catalog_key=v_key or carousel_item_id=v_item or product_gid=v_product or variant_gid='gid://shopify/ProductVariant/67612818669818')
 or exists(select 1 from public.shopify_gallery_copy_eligibility where catalog_key=v_key or carousel_item_id=v_item or product_gid=v_product or variant_gid='gid://shopify/ProductVariant/67612818669818')
 or exists(select 1 from public.shopify_gallery_sync_state where catalog_key=v_key)
 or exists(select 1 from public.shopify_gallery_public_links where catalog_key=v_key or variant_id='67612818669818')
 then raise exception 'SYNC_OSV04_EXISTING_ASSOCIATION_CONFLICT'; end if;
 select encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_object('item',to_jsonb(i),'angles',
   (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from public.carousel_item_angles a where a.item_id=i.id))::text,'UTF8')),'hex')
 into v_revision from public.carousel_items i where i.id=v_item;
 return jsonb_build_object('admitted',false,'galleryRevision',v_revision);
end;
$$;

create or replace function public.admit_existing_osv04(p_lease_owner uuid,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_context jsonb; v_copy jsonb; v_gallery jsonb; v_media jsonb; v_source timestamptz; v_verified timestamptz;
 v_hash text; v_manifest jsonb; v_before jsonb; v_item public.carousel_items%rowtype;
 v_approval constant text:='existing-osv04-v1:15401872654586';
 v_product constant text:='gid://shopify/Product/15401872654586';
 v_variant constant text:='gid://shopify/ProductVariant/67612818669818';
 v_key constant text:='P10OSV0405J';
begin
 if jsonb_typeof(p_evidence) is distinct from 'object' or octet_length(p_evidence::text)>1000000
 or p_evidence->>'policyVersion' is distinct from 'existing-osv04-v1'
 or p_evidence->>'productId' is distinct from v_product or p_evidence->>'variantId' is distinct from v_variant
 or p_evidence->>'itemId' is distinct from '70bce0cd-f69f-4d27-8e98-7632b458bf1f'
 or p_evidence->>'gallerySku' is distinct from 'P10OSV04-05J-TU'
 or p_evidence->>'shopifySku' is distinct from v_key or p_evidence->>'catalogKey' is distinct from v_key
 or p_evidence->>'handle' is distinct from 'p10osv0405j'
 or p_evidence->>'manufacturerUrl' is distinct from 'https://mandarinaduck.com/products/eco-coated-trolley-large-expandable-duck-yellow-osv0405j'
 or p_evidence->>'price' is distinct from '1545.00' or p_evidence->>'currency' is distinct from 'ILS'
 or coalesce(p_evidence->>'vendor','') not in ('mandarinaduck','Mandarina Duck')
 or p_evidence->>'status' is distinct from 'ACTIVE' or p_evidence->'publishedOnPublication' is distinct from 'true'::jsonb
 or p_evidence->'variantCount' is distinct from '1'::jsonb or p_evidence->'shopifyCollisionCount' is distinct from '1'::jsonb
 or p_evidence->'inventoryTracked' is distinct from 'false'::jsonb
 or coalesce(p_evidence->>'galleryRevision','') !~ '^[a-f0-9]{64}$'
 then raise exception 'SYNC_OSV04_EVIDENCE_INVALID'; end if;
 begin
  if coalesce(p_evidence->>'sourceUpdatedAt','') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$'
   or coalesce(p_evidence->>'verifiedAt','') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$'
  then raise exception 'SYNC_OSV04_TIMESTAMP_INVALID'; end if;
  v_source:=(p_evidence->>'sourceUpdatedAt')::timestamptz;v_verified:=(p_evidence->>'verifiedAt')::timestamptz;
 exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then raise exception 'SYNC_OSV04_TIMESTAMP_INVALID'; end;
 if not isfinite(v_source) or not isfinite(v_verified) or v_verified<clock_timestamp()-interval '5 minutes'
  or v_verified>clock_timestamp()+interval '30 seconds' or v_source>v_verified+interval '30 seconds'
 then raise exception 'SYNC_OSV04_EVIDENCE_EXPIRED'; end if;
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
  then raise exception 'SYNC_OSV04_COPY_INVALID'; end if;
  if jsonb_typeof(p_evidence->'media') is distinct from 'array'
    or jsonb_array_length(p_evidence->'media') not between 1 and 20
  then raise exception 'SYNC_OSV04_MEDIA_INVALID'; end if;
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
    then raise exception 'SYNC_OSV04_MEDIA_INVALID'; end if;
    if (v_media->>'width')::integer>16000 or (v_media->>'height')::integer>16000
      or (v_media->>'width')::bigint*(v_media->>'height')::bigint>16000000
      or (v_media->>'byteLength')::integer>8388608
    then raise exception 'SYNC_OSV04_MEDIA_INVALID'; end if;
  end loop;
  if (select count(*)<>count(distinct value->>'mediaGid') or count(*)<>count(distinct value->>'url')
    from jsonb_array_elements(p_evidence->'media'))
  then raise exception 'SYNC_OSV04_MEDIA_INVALID'; end if;


 perform set_config('lock_timeout','3000ms',true);
 perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 lock table public.carousel_items,public.carousel_item_angles,public.shopify_gallery_bindings,
 public.shopify_gallery_public_links,public.shopify_gallery_sync_state,public.shopify_gallery_copy_activations,
 public.shopify_gallery_copy_eligibility,public.shopify_gallery_copy_activation_receipts,
 public.shopify_gallery_copy_activation_events,public.shopify_existing_osv04_admission in share row exclusive mode;
 v_context:=public.read_existing_osv04_admission(p_lease_owner);
 if v_context->'admitted'='true'::jsonb then return v_context; end if;
 if v_context->>'galleryRevision' is distinct from p_evidence->>'galleryRevision'
 then raise exception 'SYNC_OSV04_GALLERY_CHANGED'; end if;
 v_before:=public.verified_copy_protected_tables();
 select * into strict v_item from public.carousel_items where id='70bce0cd-f69f-4d27-8e98-7632b458bf1f' for update;
 v_gallery:=jsonb_build_object('title',v_item.title,'description',v_item.description,'descriptionHtml',v_item.description_html,'seoTitle',v_item.seo_title,'seoDescription',v_item.seo_description);
 v_hash:=encode(pg_catalog.sha256(pg_catalog.convert_to(p_evidence::text,'UTF8')),'hex');
 v_manifest:=jsonb_build_object('policyVersion','existing-osv04-v1','kind','exact_existing_alias','evidenceSha256',v_hash,'evidence',p_evidence);
 insert into public.shopify_gallery_bindings(catalog_key,carousel_item_id,product_gid,variant_gid,product_handle,is_published,source_updated_at)
 values(v_key,v_item.id,v_product,v_variant,'p10osv0405j',true,v_source);
 insert into public.shopify_gallery_public_links(catalog_key,product_handle,variant_id,is_published)
 values(v_key,'p10osv0405j','67612818669818',true);
 insert into public.shopify_gallery_sync_state(catalog_key,last_synced_payload,last_synced_hash,gallery_baseline_payload,shopify_baseline_payload,gallery_updated_at,shopify_updated_at)
 values(v_key,v_copy,encode(pg_catalog.sha256(pg_catalog.convert_to(v_copy::text,'UTF8')),'hex'),v_gallery,v_copy,v_item.copy_updated_at,v_source);
 insert into public.shopify_gallery_copy_activations(approval_id,manifest_sha256,source_file_sha256,manifest)
 values(v_approval,encode(pg_catalog.sha256(pg_catalog.convert_to(v_manifest::text,'UTF8')),'hex'),v_hash,v_manifest);
 insert into public.shopify_gallery_copy_eligibility(product_gid,catalog_key,carousel_item_id,variant_gid,exact_gallery_sku,exact_shopify_sku,approved_product_handle,enabled,approval_id,approved_source_updated_at,alias_evidence)
 values(v_product,v_key,v_item.id,v_variant,'P10OSV04-05J-TU',v_key,'p10osv0405j',true,v_approval,v_source,
 jsonb_build_object('policyVersion','existing-osv04-v1','gallerySku','P10OSV04-05J-TU','shopifySku',v_key,'manufacturerUrl',p_evidence->>'manufacturerUrl','evidenceSha256',v_hash));
 insert into public.shopify_gallery_copy_activation_receipts(catalog_key,approval_id,snapshot)
 values(v_key,v_approval,public.verified_copy_current_receipt(v_item.id,v_key));
 insert into public.shopify_gallery_copy_activation_events(approval_id,event_kind) values(v_approval,'created'),(v_approval,'enabled');
 insert into public.shopify_existing_osv04_admission(product_gid,approval_id,evidence,evidence_sha256) values(v_product,v_approval,p_evidence,v_hash);
 if public.verified_copy_protected_tables() is distinct from v_before then raise exception 'SYNC_OSV04_UNEXPECTED_CATALOG_WRITE'; end if;
 return jsonb_build_object('admitted',true,'replayed',false,'enabled',true,'itemId',v_item.id);
end;
$$;
revoke all on function public.read_existing_osv04_admission(uuid),public.admit_existing_osv04(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_existing_osv04_admission(uuid),public.admit_existing_osv04(uuid,jsonb) to service_role;
