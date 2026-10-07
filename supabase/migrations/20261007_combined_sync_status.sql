-- Read-only combined status for the authenticated admin server. No payloads,
-- approval changes, queue retries, or resets. A clear copy inbox cannot conceal
-- pending media, absent baselines, specification work or commercial commands.
begin;
create function public.read_toptik_combined_sync_status(p_product_gid text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare queues jsonb; coverage jsonb;
begin
 if p_product_gid is not null and p_product_gid !~ '^gid://shopify/Product/[1-9][0-9]*$' then
  raise exception 'SYNC_STATUS_INPUT_INVALID';
 end if;
 with queue_rows as (
  select 'copy_inbox'::text lane,status,count(*) as count from public.shopify_webhook_events
   where p_product_gid is null or payload->>'id' in (p_product_gid,split_part(p_product_gid,'/',5)) group by status
  union all
  select 'copy_outbox',o.status,count(*) from public.shopify_gallery_content_outbox o
   where p_product_gid is null or exists(select 1 from public.shopify_gallery_copy_eligibility e
    where e.product_gid=p_product_gid and e.carousel_item_id=o.carousel_item_id) group by o.status
  union all
  select 'media',status,count(*) from toptik_media_private.work_queue
   where p_product_gid is null or product_gid=p_product_gid group by status
  union all
  select 'specifications',status,count(*) from toptik_spec_private.work_queue
   where p_product_gid is null or product_gid=p_product_gid group by status
  union all
  select 'commerce',state,count(*) from public.shopify_gallery_commerce_commands
   where p_product_gid is null or product_gid=p_product_gid group by state
  union all
  select 'media_operations',o.status,count(*) from toptik_media_private.operations o
   join toptik_media_private.state s using(product_gid)
   where (p_product_gid is null or o.product_gid=p_product_gid) and o.state_version=s.version
   group by o.status
 ) select coalesce(jsonb_agg(to_jsonb(q) order by lane,status),'[]'::jsonb) into queues from queue_rows q;
 select jsonb_build_object('approvedProducts',count(distinct e.product_gid),
  'missingCopyBaseline',count(*) filter(where c.catalog_key is null or c.gallery_baseline_payload is null or c.shopify_baseline_payload is null),
  'missingMediaBaseline',count(*) filter(where m.product_gid is null or not m.enabled or s.product_gid is null),
  'missingMediaQueue',count(*) filter(where q.product_gid is null))
 into coverage from public.shopify_gallery_copy_eligibility e
 left join public.shopify_gallery_sync_state c using(catalog_key)
 left join toptik_media_private.products m using(product_gid)
 left join toptik_media_private.state s using(product_gid)
 left join toptik_media_private.work_queue q using(product_gid)
 where e.enabled and (p_product_gid is null or e.product_gid=p_product_gid);
 return jsonb_build_object('observedAt',statement_timestamp(),'queues',queues,'coverage',coverage);
end $$;
revoke all on function public.read_toptik_combined_sync_status(text) from public,anon,authenticated;
grant execute on function public.read_toptik_combined_sync_status(text) to service_role;
commit;
