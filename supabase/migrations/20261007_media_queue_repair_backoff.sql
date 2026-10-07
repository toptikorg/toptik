-- Throughput: rows waiting for an operator storage-repair approval no longer consume
-- every batch. Only the claim ORDER changes; eligibility, locking, grants and the
-- legacy claim RPC are unchanged. No row, approval, baseline or history change.
begin;
create or replace function public.claim_toptik_media_work_excluding(p_claim_id uuid,p_exclude_product_gids text[] default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r toptik_media_private.work_queue%rowtype;
begin
 if p_claim_id is null then raise exception 'MEDIA_QUEUE_CLAIM_INVALID';end if;
 perform toptik_media_private.validate_queue_exclusions(p_exclude_product_gids);
 select q.* into r from toptik_media_private.work_queue q join public.shopify_gallery_copy_eligibility e on e.product_gid=q.product_gid and e.enabled
 left join toptik_media_private.products p on p.product_gid=q.product_gid
 where (p.product_gid is null or p.enabled) and q.product_gid<>all(p_exclude_product_gids)
  and (q.status in('pending','failed') or (q.status='processing' and q.claimed_at<clock_timestamp()-interval '5 minutes'))
 -- A row that needs an operator storage-repair approval cannot progress on its own: after a failed
 -- attempt it waits behind every other claimable row for 6 hours (still retried when nothing else
 -- is claimable). A new enqueue (for example after an approval) clears last_error and restores it.
 order by coalesce(q.status='pending' and q.last_error='MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED' and q.updated_at>clock_timestamp()-interval '6 hours',false),
  q.updated_at,q.product_gid limit 1 for update of q skip locked;
 if not found then return null;end if;
 update toptik_media_private.work_queue set status='processing',claim_id=p_claim_id,claimed_generation=generation,claimed_at=clock_timestamp(),attempts=attempts+1
 where product_gid=r.product_gid;
 return jsonb_build_object('productId',r.product_gid,'claimId',p_claim_id,'generation',r.generation,'evidence',r.evidence,
  'initialized',exists(select 1 from toptik_media_private.products where product_gid=r.product_gid));
end $$;
commit;
