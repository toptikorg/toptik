-- In-flight media operations keep their queue position between steps (bounded).
-- 1. An enqueue that arrives while the row is being processed (for example the
--    worker's own gallery_cas catalog write firing the durable wakeup trigger)
--    still raises the generation, but no longer moves the row to the back or
--    clears its in-flight marker; finish/defer/keep decide the position.
-- 2. keep_toptik_media_work_in_flight releases a claim that verified a new
--    transport phase WITHOUT moving it, at most 8 consecutive times; after that
--    (or when the claim changed) it returns false and the worker finishes normally.
-- No approval, baseline, operation, evidence or history change.
begin;
alter table toptik_media_private.work_queue add column inflight_keeps integer not null default 0 check(inflight_keeps>=0);

create or replace function toptik_media_private.enqueue(p_product text,p_evidence jsonb) returns boolean
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare e public.shopify_gallery_copy_eligibility%rowtype;
begin
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into e from public.shopify_gallery_copy_eligibility where product_gid=p_product and enabled;
 if not found or exists(select 1 from toptik_media_private.products where product_gid=p_product and not enabled) then return false;end if;
 perform public.assert_shopify_verified_copy_identity(e.carousel_item_id,e.catalog_key,e.exact_gallery_sku,e.product_gid,e.variant_gid,e.exact_shopify_sku);
 insert into toptik_media_private.work_queue(product_gid,evidence) values(p_product,p_evidence)
 on conflict(product_gid) do update set generation=work_queue.generation+1,
  status=case when work_queue.status='processing' then 'processing' else 'pending' end,
  evidence=work_queue.evidence||excluded.evidence,
  last_error=case when work_queue.status='processing' then work_queue.last_error else null end,
  updated_at=case when work_queue.status='processing' then work_queue.updated_at else clock_timestamp() end;
 return true;
end $$;

create function public.keep_toptik_media_work_in_flight(p_product_gid text,p_claim_id uuid,p_generation bigint) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r toptik_media_private.work_queue%rowtype;streak integer;
begin
 if p_claim_id is null or p_generation is null or p_generation<1 or coalesce(p_product_gid,'')!~'^gid://shopify/Product/[1-9][0-9]*$' then raise exception 'MEDIA_QUEUE_FINISH_INVALID';end if;
 select * into r from toptik_media_private.work_queue where product_gid=p_product_gid for update;
 if not found or r.status<>'processing' or r.claim_id is distinct from p_claim_id or r.claimed_generation is distinct from p_generation then raise exception 'MEDIA_QUEUE_CLAIM_CHANGED';end if;
 streak:=case when r.last_error='MEDIA_QUEUE_IN_FLIGHT_CONTINUES' then r.inflight_keeps+1 else 1 end;
 if streak>8 then return false;end if;
 -- updated_at deliberately unchanged: the operation continues first in the next batch.
 update toptik_media_private.work_queue set status='pending',claim_id=null,claimed_generation=null,claimed_at=null,
  inflight_keeps=streak,last_error='MEDIA_QUEUE_IN_FLIGHT_CONTINUES' where product_gid=p_product_gid;
 return true;
end $$;
revoke all on function public.keep_toptik_media_work_in_flight(text,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.keep_toptik_media_work_in_flight(text,uuid,bigint) to service_role;
commit;
