-- Existing product bindings only. No catalog/media deletion, copy or editor writes.
-- INVOKER: service_role already owns this server-side data path; no new RLS bypass.
create or replace function public.refresh_shopify_gallery_publication(
  p_product_gid text, p_owner uuid, p_is_published boolean,
  p_source_updated_at timestamptz, p_handle text, p_visible_variant_gids text[]
) returns integer language plpgsql security invoker set search_path = '' as $$
declare b public.shopify_gallery_bindings%rowtype; visible boolean; changed integer := 0;
begin
  if p_product_gid is null or p_product_gid !~ '^gid://shopify/Product/[0-9]+$'
    or p_owner is null or p_is_published is null or p_visible_variant_gids is null
    or (p_is_published and (p_source_updated_at is null or p_handle is null
      or p_handle !~ '^[A-Za-z0-9א-ת][A-Za-z0-9א-ת-]*$' or length(p_handle)>255))
    or exists(select 1 from unnest(p_visible_variant_gids) v where v is null or v !~ '^gid://shopify/ProductVariant/[0-9]+$')
    or (not p_is_published and cardinality(p_visible_variant_gids)>0)
  then raise exception 'SYNC_PUBLICATION_INPUT_INVALID'; end if;

  -- Lease acquisition uses the same lock. Reuse the existing narrow lease-read
  -- RPC instead of granting the worker direct access to the private lease table.
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  perform public.read_toptik_media_lease(p_product_gid,p_owner);

  for b in select * from public.shopify_gallery_bindings where product_gid=p_product_gid order by catalog_key for update loop
    if p_source_updated_at is not null and b.source_updated_at>p_source_updated_at then
      raise exception 'SYNC_PUBLICATION_STALE_SNAPSHOT';
    end if;
    visible := p_is_published and b.variant_gid=any(p_visible_variant_gids);
    -- Equal updatedAt is allowed: publication changes can leave product.updatedAt unchanged.
    if b.is_published is distinct from visible or (visible and b.product_handle is distinct from p_handle) then
      update public.shopify_gallery_bindings set is_published=visible,
        product_handle=case when visible then p_handle else product_handle end,
        source_updated_at=coalesce(p_source_updated_at,source_updated_at), synced_at=clock_timestamp()
        where catalog_key=b.catalog_key;
      changed := changed+1;
    end if;
    insert into public.shopify_gallery_public_links(catalog_key,product_handle,variant_id,is_published,updated_at)
      values(b.catalog_key,case when visible then p_handle else '' end,
        case when visible then split_part(b.variant_gid,'/',5) else '0' end,visible,clock_timestamp())
      on conflict(catalog_key) do update set product_handle=excluded.product_handle,variant_id=excluded.variant_id,
        is_published=excluded.is_published,updated_at=excluded.updated_at
      where (shopify_gallery_public_links.product_handle,shopify_gallery_public_links.variant_id,shopify_gallery_public_links.is_published)
        is distinct from (excluded.product_handle,excluded.variant_id,excluded.is_published);
  end loop;
  return changed;
end;
$$;
revoke all on function public.refresh_shopify_gallery_publication(text,uuid,boolean,timestamptz,text,text[]) from public,anon,authenticated;
grant execute on function public.refresh_shopify_gallery_publication(text,uuid,boolean,timestamptz,text,text[]) to service_role;
