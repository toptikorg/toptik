-- Additive admin-only observability and exact reviewed-product wakeup.
-- No catalog mutation, baseline reset, removal evidence or permission change.
begin;
create function public.read_toptik_media_status(p_product_gid text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare summary jsonb; detail jsonb;
begin
 if p_product_gid is not null and p_product_gid !~ '^gid://shopify/Product/[1-9][0-9]*$' then
  raise exception 'MEDIA_STATUS_INPUT_INVALID';
 end if;
 select coalesce(jsonb_agg(to_jsonb(t) order by t.status,t.last_error),'[]'::jsonb) into summary
 from (select status,last_error,count(*) as products,min(updated_at) as oldest_updated_at,
  max(updated_at) as newest_updated_at,max(attempts) as maximum_attempts
  from toptik_media_private.work_queue group by status,last_error) t;
 if p_product_gid is not null then
  select jsonb_build_object('identity',m.identity,'catalogKey',e.catalog_key,
   'copyEnabled',e.enabled,'mediaEnabled',m.enabled,'bootstrappedAt',m.created_at,
   'baselineVersion',s.version,'baselineUpdatedAt',s.updated_at,
   'galleryBaselineAssets',jsonb_array_length(s.baselines#>'{gallery,assets}'),
   'shopifyBaselineAssets',jsonb_array_length(s.baselines#>'{shopify,assets}'),
   'queueStatus',q.status,'lastError',q.last_error,'attempts',q.attempts,
   'queueUpdatedAt',q.updated_at,'claimedAt',q.claimed_at,
   'galleryAngles',(select count(*) from public.carousel_item_angles a where a.item_id=e.carousel_item_id),
   'openOperations',(select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'status',o.status,'nextStep',o.next_step,'updatedAt',o.updated_at)),'[]'::jsonb)
      from toptik_media_private.operations o where o.product_gid=e.product_gid and o.status in('reserved','running','uncertain','conflict')))
  into detail from public.shopify_gallery_copy_eligibility e
  left join toptik_media_private.products m using(product_gid)
  left join toptik_media_private.state s using(product_gid)
  left join toptik_media_private.work_queue q using(product_gid)
  where e.product_gid=p_product_gid;
 end if;
 return jsonb_build_object('observedAt',clock_timestamp(),'queue',summary,'product',detail);
end $$;
revoke all on function public.read_toptik_media_status(text) from public,anon,authenticated;
grant execute on function public.read_toptik_media_status(text) to service_role;

create function public.enqueue_toptik_reviewed_media_work(p_product_gid text)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if p_product_gid is null or p_product_gid !~ '^gid://shopify/Product/[1-9][0-9]*$' then
  raise exception 'MEDIA_REVIEW_INPUT_INVALID';
 end if;
 -- The authenticated server caller stores/rechecks a signed exact-image review
 -- first. Empty evidence cannot authorize deletion on either side.
 return toptik_media_private.enqueue(p_product_gid,'{}'::jsonb);
end $$;
revoke all on function public.enqueue_toptik_reviewed_media_work(text) from public,anon,authenticated;
grant execute on function public.enqueue_toptik_reviewed_media_work(text) to service_role;
commit;
