-- Permit the same reviewed ASCII/Hebrew Shopify handle grammar already used
-- by publication refresh. This repairs exact existing Gallery rows without
-- changing their editorial copy, media, ordering or active state.
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
    or p_product_handle !~ '^[A-Za-z0-9א-ת][A-Za-z0-9א-ת-]*$'
    or length(p_product_handle) > 255
    or p_source_updated_at is null then
    return false;
  end if;

  select * into existing from public.shopify_gallery_bindings
    where catalog_key = p_catalog_key for update;
  if found then
    if existing.carousel_item_id <> p_carousel_item_id
      or existing.product_gid <> p_product_gid
      or existing.variant_gid <> p_variant_gid then return false; end if;
    if existing.source_updated_at is not null and p_source_updated_at <= existing.source_updated_at then return true; end if;
    update public.shopify_gallery_bindings set product_handle=p_product_handle,
      is_published=p_is_published,source_updated_at=p_source_updated_at,synced_at=now()
      where catalog_key=p_catalog_key;
  else
    insert into public.shopify_gallery_bindings(catalog_key,carousel_item_id,product_gid,variant_gid,
      product_handle,is_published,source_updated_at,synced_at)
      values(p_catalog_key,p_carousel_item_id,p_product_gid,p_variant_gid,p_product_handle,
        p_is_published,p_source_updated_at,now()) on conflict do nothing;
    get diagnostics affected = row_count;
    if affected = 0 then return false; end if;
  end if;

  insert into public.shopify_gallery_public_links(catalog_key,product_handle,variant_id,is_published,updated_at)
    values(p_catalog_key,case when p_is_published then p_product_handle else '' end,
      case when p_is_published then regexp_replace(p_variant_gid,'^gid://shopify/ProductVariant/','') else '0' end,
      p_is_published,now())
    on conflict(catalog_key) do update set product_handle=excluded.product_handle,
      variant_id=excluded.variant_id,is_published=excluded.is_published,updated_at=excluded.updated_at;
  return true;
end;
$$;

revoke all on function public.upsert_shopify_gallery_binding(text,uuid,text,text,text,boolean,timestamptz)
  from public,anon,authenticated;
grant execute on function public.upsert_shopify_gallery_binding(text,uuid,text,text,text,boolean,timestamptz)
  to service_role;
