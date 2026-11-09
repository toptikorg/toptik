-- Retire only historical FZT73 webhook reviews after a later exact no-op.
-- No gallery content, media, binding, outbox, or Shopify product is modified.
-- This RPC is service-only and may run only under the current worker lease.
begin;
create or replace function public.close_verified_fzt73_webhook_reviews(
  p_current_event uuid, p_owner uuid, p_source_updated_at timestamptz, p_versions jsonb
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  current_received timestamptz;
  expected record;
  actual record;
  closed_count integer;
begin
  if p_current_event is null or p_owner is null or p_source_updated_at is null or
      jsonb_typeof(p_versions) is distinct from 'object' then
    raise exception 'SYNC_FZT73_RECOVERY_INVALID';
  end if;
  if (select count(*) from jsonb_object_keys(p_versions)) <> 4 then raise exception 'SYNC_FZT73_RECOVERY_INVALID'; end if;
  perform set_config('lock_timeout','3000ms',true);
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  -- Avoid phantoms from an independent outbox writer. Never wait behind an
  -- existing writer; skip housekeeping and leave reviews untouched instead.
  begin
    lock table public.shopify_gallery_content_outbox in share mode nowait;
  exception when lock_not_available then
    return 0;
  end;
  if not exists (select 1 from public.shopify_gallery_reconciliation_leases l
    where l.product_gid='gid://shopify/Product/7524873044218' and l.owner=p_owner and l.expires_at>clock_timestamp())
  then raise exception 'SYNC_RECONCILIATION_LEASE_FAILED'; end if;
  select received_at into current_received from public.shopify_webhook_events e
    where e.id=p_current_event and e.status='processing' and e.topic='products/update'
      and e.shop_domain='toptikcoil.myshopify.com' and e.payload->>'id'='7524873044218'
      and e.payload->>'publication_recovery'='true' for update;
  if current_received is null then raise exception 'SYNC_FZT73_RECOVERY_INVALID'; end if;
  for expected in select * from (values
    ('341df0c7-7a31-4e77-87c0-a683082c3cd7'::uuid,'P10FZT73001','gid://shopify/ProductVariant/42361904398586'),
    ('78e341a9-90f8-4b5a-a215-8bdf5f4f5321'::uuid,'P10FZT7308Q','gid://shopify/ProductVariant/42449044799738'),
    ('7bd35662-0989-4b96-aafd-f6a77ba6d72f'::uuid,'P10FZT7324B','gid://shopify/ProductVariant/42449044832506'),
    ('8890d9f2-d927-42e2-9006-f287a46ef137'::uuid,'P10FZT7327D','gid://shopify/ProductVariant/42449044865274')
  ) v(item_id,sku,variant_gid) order by item_id loop
    if not (p_versions ? expected.item_id::text) or
      coalesce(p_versions->expected.item_id::text->>'editorRevision','') !~ '^[1-9][0-9]*$' or
      coalesce(p_versions->expected.item_id::text->>'copyUpdatedAt','') = '' then
      raise exception 'SYNC_FZT73_RECOVERY_INVALID';
    end if;
    select i.id, i.editor_revision, i.copy_updated_at, i.catalog_number, b.variant_gid,
      b.product_gid, b.is_published, b.source_updated_at
      into actual from public.carousel_items i join public.shopify_gallery_bindings b on b.carousel_item_id=i.id
      where i.id=expected.item_id and b.catalog_key=expected.sku for update of i,b;
    if not found or actual.catalog_number is distinct from expected.sku or actual.variant_gid is distinct from expected.variant_gid or
      actual.product_gid is distinct from 'gid://shopify/Product/7524873044218' or actual.is_published is distinct from true or
      actual.source_updated_at is distinct from p_source_updated_at or
      actual.editor_revision<>(p_versions->expected.item_id::text->>'editorRevision')::bigint or
      actual.copy_updated_at is distinct from (p_versions->expected.item_id::text->>'copyUpdatedAt')::timestamptz then
      raise exception 'SYNC_COPY_CONCURRENT_UPDATE';
    end if;
  end loop;
  -- An outstanding Gallery edit may represent content not yet sent to Shopify.
  -- Never erase or call it synced simply because a later snapshot matches.
  if exists(select 1 from public.shopify_gallery_content_outbox o
    where o.carousel_item_id in (
      '341df0c7-7a31-4e77-87c0-a683082c3cd7'::uuid,'78e341a9-90f8-4b5a-a215-8bdf5f4f5321'::uuid,
      '7bd35662-0989-4b96-aafd-f6a77ba6d72f'::uuid,'8890d9f2-d927-42e2-9006-f287a46ef137'::uuid)
      and o.status in ('pending','processing','review','failed')) then return 0; end if;
  -- Keep each original payload. A marker records that this was superseded by
  -- a later verified equality, not a replay of the original webhook.
  update public.shopify_webhook_events e set status='processed', processed_at=now(),
    last_error='SYNC_FZT73_REVIEW_SUPERSEDED_VERIFIED'
  where e.id<>p_current_event and e.status='review' and e.last_error='SYNC_FZT73_BASELINE_REQUIRED'
    and e.shop_domain='toptikcoil.myshopify.com' and e.payload->>'id'='7524873044218' and e.received_at<=current_received
    and e.topic='products/update'
    and (e.payload->>'publication_recovery'='true' or
      case when coalesce(e.payload->>'updated_at','') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
       and pg_input_is_valid(e.payload->>'updated_at','timestamp with time zone')
      then (e.payload->>'updated_at')::timestamptz<=p_source_updated_at else false end);
  get diagnostics closed_count = row_count;
  return closed_count;
end $$;
revoke all on function public.close_verified_fzt73_webhook_reviews(uuid,uuid,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.close_verified_fzt73_webhook_reviews(uuid,uuid,timestamptz,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
