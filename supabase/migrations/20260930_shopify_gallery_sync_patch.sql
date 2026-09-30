-- Additive after 20260930_shopify_gallery_sync_inbox.sql. Authenticated server route
-- gates the configured single SKU and live Shopify variant before this RPC.
-- This transaction writes only that bound row's copy and durable outbox.
create or replace function public.patch_shopify_canary_copy(
  p_item_id uuid, p_catalog_key text, p_exact_sku text,
  p_product_gid text, p_variant_gid text, p_expected_version timestamptz, p_copy jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  previous public.carousel_items%rowtype;
  saved public.carousel_items%rowtype;
  previous_content jsonb;
  content jsonb;
  exact_key text;
begin
  if p_item_id is null or p_expected_version is null or p_catalog_key !~ '^[A-Z0-9]+$'
    or p_product_gid !~ '^gid://shopify/Product/[0-9]+$'
    or p_variant_gid !~ '^gid://shopify/ProductVariant/[0-9]+$'
    or jsonb_typeof(p_copy) is distinct from 'object'
    or not (p_copy ?& array['title','description','descriptionHtml','seoTitle','seoDescription'])
    or exists (select 1 from jsonb_object_keys(p_copy) key where key not in ('title','description','descriptionHtml','seoTitle','seoDescription'))
    or jsonb_typeof(p_copy->'title') is distinct from 'string' or length(p_copy->>'title') not between 1 and 120
    or jsonb_typeof(p_copy->'description') is distinct from 'string' or length(p_copy->>'description') > 50000
    or jsonb_typeof(p_copy->'descriptionHtml') not in ('string','null') or length(p_copy->>'descriptionHtml') > 250000
    or jsonb_typeof(p_copy->'seoTitle') not in ('string','null') or length(p_copy->>'seoTitle') > 512
    or jsonb_typeof(p_copy->'seoDescription') not in ('string','null') or length(p_copy->>'seoDescription') > 5000
  then raise exception 'SYNC_COPY_PATCH_INVALID'; end if;
  exact_key := regexp_replace(upper(coalesce(p_exact_sku,'')), '[^A-Z0-9]', '', 'g');
  if exact_key ~ '^P[0-9]{2}.*TU$' then exact_key := left(exact_key,length(exact_key)-2); end if;
  if exact_key is distinct from p_catalog_key then raise exception 'SYNC_BINDING_MISSING_OR_CONFLICTED'; end if;
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  if exists (select 1 from public.shopify_gallery_reconciliation_leases where product_gid=p_product_gid and expires_at>now())
    then raise exception 'SYNC_COPY_BUSY_RETRY'; end if;
  select * into previous from public.carousel_items where id=p_item_id for update;
  if not found or previous.catalog_number is distinct from p_exact_sku
    or (select count(*) from public.shopify_gallery_bindings where product_gid=p_product_gid) <> 1
    or not exists (select 1 from public.shopify_gallery_bindings where catalog_key=p_catalog_key
      and carousel_item_id=p_item_id and product_gid=p_product_gid and variant_gid=p_variant_gid)
  then raise exception 'SYNC_BINDING_MISSING_OR_CONFLICTED'; end if;
  if (select count(*) from public.carousel_items row
    where regexp_replace(regexp_replace(upper(coalesce(row.catalog_number,'')), '[^A-Z0-9]', '', 'g'), '^(P[0-9]{2}.*)TU$', '\1')=p_catalog_key) <> 1
  then raise exception 'SYNC_BINDING_MISSING_OR_CONFLICTED'; end if;
  if previous.copy_updated_at <> p_expected_version then raise exception 'SYNC_COPY_STALE_EDIT_RELOAD'; end if;
  previous_content := jsonb_build_object('title',previous.title,'description',coalesce(previous.description,''),
    'descriptionHtml',previous.description_html,'seoTitle',previous.seo_title,'seoDescription',previous.seo_description);
  if previous_content = p_copy then
    return jsonb_build_object('changed',false,'copyUpdatedAt',previous.copy_updated_at);
  end if;
  update public.carousel_items set title=p_copy->>'title', description=nullif(p_copy->>'description',''),
    description_html=p_copy->>'descriptionHtml', seo_title=p_copy->>'seoTitle', seo_description=p_copy->>'seoDescription',
    copy_updated_at=greatest(clock_timestamp(), previous.copy_updated_at+interval '1 microsecond')
    where id=p_item_id returning * into saved;
  content := jsonb_build_object('title',saved.title,'description',coalesce(saved.description,''),
    'descriptionHtml',saved.description_html,'seoTitle',saved.seo_title,'seoDescription',saved.seo_description);
  insert into public.shopify_gallery_content_outbox(carousel_item_id,catalog_key,content_hash,payload,status,attempts,created_at,last_error)
    values (p_item_id,p_catalog_key,encode(pg_catalog.sha256(pg_catalog.convert_to(content::text,'UTF8')),'hex'),content,'pending',0,now(),null)
    on conflict (carousel_item_id,content_hash) do update set payload=excluded.payload,catalog_key=excluded.catalog_key,
      status='pending',attempts=0,created_at=now(),claimed_at=null,synced_at=null,last_error=null;
  return jsonb_build_object('changed',true,'copyUpdatedAt',saved.copy_updated_at);
end;
$$;
revoke all on function public.patch_shopify_canary_copy(uuid,text,text,text,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.patch_shopify_canary_copy(uuid,text,text,text,text,timestamptz,jsonb) to service_role;
