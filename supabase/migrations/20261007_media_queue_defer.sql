-- Release a claimed media queue row WITHOUT moving it to the back of the queue.
-- Used only when the worker claimed a product late in a 40 s batch and had too
-- little budget left to run its prepared phase. Keeping updated_at makes it the
-- first claim of the next batch (full budget). The worker never calls this for
-- the first claim of a batch, so no row can keep the head indefinitely.
-- No approval, baseline, operation, evidence or history change.
begin;
create function public.defer_toptik_media_work(p_product_gid text,p_claim_id uuid,p_generation bigint) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r toptik_media_private.work_queue%rowtype;
begin
 if p_claim_id is null or p_generation is null or p_generation<1 or coalesce(p_product_gid,'')!~'^gid://shopify/Product/[1-9][0-9]*$' then raise exception 'MEDIA_QUEUE_FINISH_INVALID';end if;
 select * into r from toptik_media_private.work_queue where product_gid=p_product_gid for update;
 if not found or r.status<>'processing' or r.claim_id is distinct from p_claim_id or r.claimed_generation is distinct from p_generation then raise exception 'MEDIA_QUEUE_CLAIM_CHANGED';end if;
 -- updated_at deliberately unchanged; a newer generation is simply pending as well.
 update toptik_media_private.work_queue set status='pending',claim_id=null,claimed_generation=null,claimed_at=null,
  last_error='MEDIA_QUEUE_DEFERRED_TIME_BUDGET' where product_gid=p_product_gid;
 return true;
end $$;
revoke all on function public.defer_toptik_media_work(text,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.defer_toptik_media_work(text,uuid,bigint) to service_role;
commit;
