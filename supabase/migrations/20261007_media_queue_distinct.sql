-- Migration first: new RPC names preserve the original queue API for old
-- deployments. Only selection changes; no rows, guards or approvals are reset.
-- Supabase CLI unavailable in the authoring environment; filename follows this
-- repository's existing date/name convention. Validate before production use.
create function toptik_media_private.validate_queue_exclusions(p_exclude_product_gids text[])
returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
 if p_exclude_product_gids is null or cardinality(p_exclude_product_gids)>10
  or coalesce(array_ndims(p_exclude_product_gids),1)<>1
  or (cardinality(p_exclude_product_gids)>0 and array_lower(p_exclude_product_gids,1)<>1)
  or exists(select 1 from unnest(p_exclude_product_gids) x where x is null or x!~'^gid://shopify/Product/[1-9][0-9]*$')
  or (select count(*)<>count(distinct x) from unnest(p_exclude_product_gids) x)
 then raise exception 'MEDIA_QUEUE_EXCLUSIONS_INVALID';end if;
end $$;
revoke all on function toptik_media_private.validate_queue_exclusions(text[]) from public,anon,authenticated,service_role;

create function public.claim_toptik_media_work_excluding(p_claim_id uuid,p_exclude_product_gids text[] default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r toptik_media_private.work_queue%rowtype;
begin
 if p_claim_id is null then raise exception 'MEDIA_QUEUE_CLAIM_INVALID';end if;
 perform toptik_media_private.validate_queue_exclusions(p_exclude_product_gids);
 select q.* into r from toptik_media_private.work_queue q join public.shopify_gallery_copy_eligibility e on e.product_gid=q.product_gid and e.enabled
 left join toptik_media_private.products p on p.product_gid=q.product_gid
 where (p.product_gid is null or p.enabled) and q.product_gid<>all(p_exclude_product_gids)
  and (q.status in('pending','failed') or (q.status='processing' and q.claimed_at<clock_timestamp()-interval '5 minutes'))
 order by q.updated_at,q.product_gid limit 1 for update of q skip locked;
 if not found then return null;end if;
 update toptik_media_private.work_queue set status='processing',claim_id=p_claim_id,claimed_generation=generation,claimed_at=clock_timestamp(),attempts=attempts+1
 where product_gid=r.product_gid;
 return jsonb_build_object('productId',r.product_gid,'claimId',p_claim_id,'generation',r.generation,'evidence',r.evidence,
  'initialized',exists(select 1 from toptik_media_private.products where product_gid=r.product_gid));
end $$;
revoke all on function public.claim_toptik_media_work_excluding(uuid,text[]) from public,anon,authenticated;
grant execute on function public.claim_toptik_media_work_excluding(uuid,text[]) to service_role;

create function public.toptik_media_work_pending_excluding(p_exclude_product_gids text[] default '{}') returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform toptik_media_private.validate_queue_exclusions(p_exclude_product_gids);
 return exists(select 1 from toptik_media_private.work_queue q join public.shopify_gallery_copy_eligibility e using(product_gid)
  left join toptik_media_private.products p using(product_gid)
  where e.enabled and (p.product_gid is null or p.enabled) and q.status='pending' and q.product_gid<>all(p_exclude_product_gids));
end $$;
revoke all on function public.toptik_media_work_pending_excluding(text[]) from public,anon,authenticated;
grant execute on function public.toptik_media_work_pending_excluding(text[]) to service_role;
