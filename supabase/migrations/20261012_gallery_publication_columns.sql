-- The existing service worker can read these tables, but writes previously went
-- through dedicated RPCs. Keep the publication function SECURITY INVOKER and
-- grant only its publication columns, never product identity, catalog or DELETE.
grant update (is_published,product_handle,source_updated_at,synced_at)
  on public.shopify_gallery_bindings to service_role;
grant insert (catalog_key,product_handle,variant_id,is_published,updated_at),
  update (product_handle,variant_id,is_published,updated_at)
  on public.shopify_gallery_public_links to service_role;
