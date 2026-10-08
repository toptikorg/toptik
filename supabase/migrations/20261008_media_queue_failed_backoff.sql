-- Throughput: a row that keeps FAILING no longer burns a claim (and a full image observation)
-- every single batch. Live case (8.10.2026): one product whose gallery sources exceed the byte
-- limit accumulated 282 attempts in two days, each one downloading megabytes before failing the
-- same way, while healthy work waited behind the wasted batch slots.
-- A failed row now waits least(attempts, 36) * 10 minutes since its last attempt (finish stamps
-- updated_at) before it is claimable again: a first transient failure retries within 10 minutes,
-- a chronic one settles at the same 6-hour horizon the storage-repair rule already uses.
-- Any REAL enqueue (webhook, editor, review, recovery) resets the row to pending with a fresh
-- updated_at and a cleared error, exactly as before, so an actual fix is picked up immediately.
-- Only the claim WHERE changes; ordering (repair-backoff last, routine handicap), eligibility of
-- pending/stale-processing rows, locking, grants, leases and the legacy claim RPC are unchanged.
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
  and (q.status='pending'
   -- A chronically failing row backs off: least(attempts, 36) * 10 minutes since its last
   -- attempt (finish stamps updated_at; a real enqueue resets the row to pending immediately).
   or (q.status='failed' and q.updated_at<=clock_timestamp()-least(q.attempts,36)*interval '10 minutes')
   or (q.status='processing' and q.claimed_at<clock_timestamp()-interval '5 minutes'))
 -- 1. A row waiting for an operator storage-repair approval stays last for 6 hours (unchanged).
 -- 2. Routine sweep rows carry a fixed 6-hour handicap on their queue time (unchanged).
 order by coalesce(q.status='pending' and q.last_error='MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED' and q.updated_at>clock_timestamp()-interval '6 hours',false),
  case when q.routine then q.updated_at+interval '6 hours' else q.updated_at end,q.product_gid limit 1 for update of q skip locked;
 if not found then return null;end if;
 update toptik_media_private.work_queue set status='processing',claim_id=p_claim_id,claimed_generation=generation,claimed_at=clock_timestamp(),attempts=attempts+1,routine=false
 where product_gid=r.product_gid;
 return jsonb_build_object('productId',r.product_gid,'claimId',p_claim_id,'generation',r.generation,'evidence',r.evidence,
  'initialized',exists(select 1 from toptik_media_private.products where product_gid=r.product_gid));
end $$;
commit;
