-- Queue priority: real work and recovery before the daily safety sweep.
-- The daily cron (recover_toptik_media_work, 04:00 UTC) re-enqueued every enabled product
-- through enqueue(): each row went to pending with a fresh updated_at and a cleared
-- last_error, so real changes and recovery waited behind ~300 routine checks for hours,
-- and rows waiting for a storage repair lost their backoff every day.
-- Now:
--  * work_queue.routine marks rows that only the sweep woke;
--  * every real enqueue (webhook, editor, review, recovery) clears it, exactly as before;
--  * the sweep wakes only finished rows (done/review) and never touches a pending, failed
--    or processing row (all claimable already), so it cannot demote real work or reset a backoff;
--  * a claim clears routine (the row has had its turn; later work competes normally);
--  * both claim functions share one order: repair backoff last (unchanged), then an effective
--    time = updated_at, plus a fixed 6-hour handicap for routine rows (real work enqueued within
--    6 hours of a sweep goes first; no cliff and no permanent starvation either way), product_gid.
-- No row is deleted; leases, generations, CAS, in-flight keeps and exclusions are unchanged.
begin;
set local lock_timeout='3s';

alter table toptik_media_private.work_queue add column if not exists routine boolean not null default false;

-- Real work: identical to 20261007_media_queue_inflight.sql, plus routine=false.
create or replace function toptik_media_private.enqueue(p_product text,p_evidence jsonb) returns boolean
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare e public.shopify_gallery_copy_eligibility%rowtype;
begin
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into e from public.shopify_gallery_copy_eligibility where product_gid=p_product and enabled;
 if not found or exists(select 1 from toptik_media_private.products where product_gid=p_product and not enabled) then return false;end if;
 perform public.assert_shopify_verified_copy_identity(e.carousel_item_id,e.catalog_key,e.exact_gallery_sku,e.product_gid,e.variant_gid,e.exact_shopify_sku);
 insert into toptik_media_private.work_queue(product_gid,evidence,routine) values(p_product,p_evidence,false)
 on conflict(product_gid) do update set generation=work_queue.generation+1,
  status=case when work_queue.status='processing' then 'processing' else 'pending' end,
  evidence=work_queue.evidence||excluded.evidence,
  last_error=case when work_queue.status='processing' then work_queue.last_error else null end,
  updated_at=case when work_queue.status='processing' then work_queue.updated_at else clock_timestamp() end,
  routine=false;
 return true;
end $$;

-- Safety sweep only: wakes finished rows as routine; pending/failed/processing rows are left exactly as they are.
create function toptik_media_private.enqueue_routine(p_product text) returns boolean
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare e public.shopify_gallery_copy_eligibility%rowtype;
begin
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into e from public.shopify_gallery_copy_eligibility where product_gid=p_product and enabled;
 if not found or exists(select 1 from toptik_media_private.products where product_gid=p_product and not enabled) then return false;end if;
 perform public.assert_shopify_verified_copy_identity(e.carousel_item_id,e.catalog_key,e.exact_gallery_sku,e.product_gid,e.variant_gid,e.exact_shopify_sku);
 insert into toptik_media_private.work_queue(product_gid,evidence,routine) values(p_product,'{}'::jsonb,true)
 on conflict(product_gid) do update set generation=work_queue.generation+1,status='pending',last_error=null,
  updated_at=clock_timestamp(),routine=true
 where work_queue.status in ('done','review');
 return true;
end $$;
revoke all on function toptik_media_private.enqueue_routine(text) from public,anon,authenticated,service_role;

create or replace function public.recover_toptik_media_work() returns integer
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p record;n integer:=0;
begin
 for p in select e.product_gid from public.shopify_gallery_copy_eligibility e left join toptik_media_private.products m using(product_gid)
  where e.enabled and (m.product_gid is null or m.enabled) order by e.product_gid limit 5000 loop
  begin if toptik_media_private.enqueue_routine(p.product_gid) then n:=n+1;end if;
  exception when others then if sqlerrm not in('SYNC_COPY_APPROVAL_MISSING_OR_CHANGED','MEDIA_APPROVAL_MISSING_OR_CHANGED') then raise;end if;end;
 end loop;return n;
end $$;

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
 -- 1. A row waiting for an operator storage-repair approval stays last for 6 hours (unchanged).
 -- 2. Routine sweep rows carry a fixed 6-hour handicap on their queue time (no cliff, no starvation).
 order by coalesce(q.status='pending' and q.last_error='MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED' and q.updated_at>clock_timestamp()-interval '6 hours',false),
  case when q.routine then q.updated_at+interval '6 hours' else q.updated_at end,q.product_gid limit 1 for update of q skip locked;
 if not found then return null;end if;
 -- Once claimed, a sweep row has had its turn: if it turns out to need real work, every later
 -- return to pending (in-flight keep, defer, finish) competes as normal work.
 update toptik_media_private.work_queue set status='processing',claim_id=p_claim_id,claimed_generation=generation,claimed_at=clock_timestamp(),attempts=attempts+1,routine=false
 where product_gid=r.product_gid;
 return jsonb_build_object('productId',r.product_gid,'claimId',p_claim_id,'generation',r.generation,'evidence',r.evidence,
  'initialized',exists(select 1 from toptik_media_private.products where product_gid=r.product_gid));
end $$;

-- Kept for older callers: the original FIFO order ignored backoff and priority; now one shared order.
create or replace function public.claim_toptik_media_work(p_claim_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 return public.claim_toptik_media_work_excluding(p_claim_id,'{}'::text[]);
end $$;
commit;
