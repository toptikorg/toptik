-- Count failed outcomes, not successful phase claims, for future failure backoff.
-- Existing unfinished rows keep a conservative capped lifetime count: migration
-- must not accelerate any existing pending/processing/review/failed episode.
-- Only a matching-generation done resets the new count. Enqueue, recover,
-- defer, keep, stale-claim recovery and superseded finishes never reset it.
-- Lifetime attempts, statuses, queue timestamps, claims, generation, evidence,
-- ordering, exclusions, leases, guards, function ACLs and return shapes stay intact.
-- No queue replay, worker invocation, media registration or catalog update.
-- PREPARED FOR REVIEW ONLY. Applying this migration requires separate approval
-- and confirmation that it cannot resume the safety-stopped workflow.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
alter table toptik_media_private.work_queue add column failure_streak integer not null default 0
 constraint media_queue_failure_streak_range check(failure_streak between 0 and 36);
update toptik_media_private.work_queue set failure_streak=
 case when status='done' then 0
      when status='failed' then least(greatest(attempts,1),36)
      else least(greatest(attempts,0),36) end;

create or replace function public.finish_toptik_media_work(p_product_gid text,p_claim_id uuid,p_generation bigint,p_status text,p_error text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r toptik_media_private.work_queue%rowtype;
begin
 if p_claim_id is null or p_generation is null or p_generation<1 or p_status is null or p_status not in('pending','done','failed','review')
  or (p_error is not null and p_error!~'^MEDIA_[A-Z0-9_]{1,90}$') then raise exception 'MEDIA_QUEUE_FINISH_INVALID';end if;
 select * into r from toptik_media_private.work_queue where product_gid=p_product_gid for update;
 if not found or r.status<>'processing' or r.claim_id is distinct from p_claim_id or r.claimed_generation is distinct from p_generation then raise exception 'MEDIA_QUEUE_CLAIM_CHANGED';end if;
 update toptik_media_private.work_queue set status=case when generation>p_generation then 'pending' else p_status end,
  evidence=case when generation=p_generation and p_status='done' then '{}'::jsonb else evidence end,
  claim_id=null,claimed_generation=null,claimed_at=null,last_error=p_error,updated_at=clock_timestamp(),
  failure_streak=case when generation>p_generation then failure_streak
   when p_status='failed' then least(failure_streak,35)+1
   when p_status='done' then 0 else failure_streak end where product_gid=p_product_gid;
 return true;
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
  and (q.status='pending'
   -- A chronically failing row backs off: least(failure_streak, 36) * 10 minutes since its last
   -- attempt (finish stamps updated_at; a real enqueue resets the row to pending immediately).
   or (q.status='failed' and q.updated_at<=clock_timestamp()-least(q.failure_streak,36)*interval '10 minutes')
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

create or replace function public.read_toptik_media_liveness(p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare items jsonb;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'MEDIA_MONITOR_INPUT_INVALID';end if;
 select coalesce(jsonb_agg(jsonb_build_object(
   'product_gid',t.product_gid,'sku',t.sku,'status',t.status,'last_error',t.last_error,
   'updated_at',t.updated_at,'attempts',t.attempts,'generation',t.generation,
   'claim_id',t.claim_id,'claimed_at',t.claimed_at,'claim_stale_after',t.claim_stale_after,
   'inflight_keeps',t.inflight_keeps,'routine',t.routine,'retry_due_at',t.retry_due_at,
   'episode',t.episode,'episode_progress',t.episode_progress,'last_completed',t.last_completed,
   'last_observed_at',t.last_observed_at) order by t.updated_at,t.product_gid),'[]'::jsonb) into items
 from (select q.product_gid,e.exact_gallery_sku as sku,q.status,q.updated_at,q.attempts,q.generation,q.claim_id,q.claimed_at,q.inflight_keeps,q.routine,
   case when q.last_error is null then null when q.last_error ~ '^MEDIA_[A-Z0-9_]{1,90}$' then q.last_error else 'MEDIA_ERROR_UNRECOGNIZED' end as last_error,
   case when q.status='failed' then q.updated_at+least(q.failure_streak,36)*interval '10 minutes' end as retry_due_at,
   case when q.status='processing' and q.claimed_at is not null then q.claimed_at+interval '5 minutes' end as claim_stale_after,
   op.episode,
   case when op.id is null then null else jsonb_build_object(
     'last_verified_at',pr.last_verified_at,'last_verified_source',pr.last_verified_source,
     'verified_phases',pr.verified_phases,'verified_steps',pr.verified_steps,
     'last_activity_at',pr.last_activity_at,'latest_attempt',pr.latest_attempt) end as episode_progress,
   (select jsonb_build_object('id',o.id,'updated_at',o.updated_at) from toptik_media_private.operations o
      where o.product_gid=q.product_gid and o.status='verified' order by o.updated_at desc limit 1) as last_completed,
   greatest(q.updated_at,
     (select max(ev.created_at) from toptik_media_private.events ev where ev.product_gid=q.product_gid),
     (select max(o.updated_at) from toptik_media_private.operations o where o.product_gid=q.product_gid)) as last_observed_at
  from toptik_media_private.work_queue q
  left join public.shopify_gallery_copy_eligibility e using(product_gid)
  left join lateral (select o.id,jsonb_build_object('id',o.id,'status',o.status,'next_step',o.next_step,'state_version',o.state_version,
      'created_at',o.created_at,'updated_at',o.updated_at) as episode
    from toptik_media_private.operations o where o.product_gid=q.product_gid and o.status in('reserved','running','uncertain')
    order by o.created_at desc limit 1) op on true
  left join lateral (select
      greatest(v.at,s.at) as last_verified_at,
      case when v.at is not null and (s.at is null or v.at>=s.at) then v.source else s.source end as last_verified_source,
      coalesce(v.n,0) as verified_phases,coalesce(s.n,0) as verified_steps,
      (select max(ev.created_at) from toptik_media_private.events ev where ev.operation_id=op.id) as last_activity_at,
      (select jsonb_build_object('phase',a.phase,'status',a.status,'created_at',a.created_at) from toptik_media_private.transport_attempts a
         where a.operation_id=op.id order by a.created_at desc limit 1) as latest_attempt
    from (select max(ev.created_at) as at,count(*) as n,
            (select jsonb_build_object('kind',ev2.event_kind,'request_id',ev2.request_id,'step_index',ev2.evidence->'stepIndex','phase_index',ev2.evidence->'phaseIndex','at',ev2.created_at)
               from toptik_media_private.events ev2 where ev2.operation_id=op.id and ev2.event_kind in('transport_readback','transport_final_readback') and ev2.result->>'status'='verified'
               order by ev2.created_at desc limit 1) as source
          from toptik_media_private.events ev where ev.operation_id=op.id and ev.event_kind in('transport_readback','transport_final_readback') and ev.result->>'status'='verified') v,
         (select max(st.verified_at) as at,count(*) filter (where st.status='verified') as n,
            (select jsonb_build_object('kind','step','step_index',st2.step_index,'at',st2.verified_at) from toptik_media_private.steps st2
               where st2.operation_id=op.id and st2.status='verified' and st2.verified_at is not null order by st2.verified_at desc limit 1) as source
          from toptik_media_private.steps st where st.operation_id=op.id and st.status='verified') s) pr on op.id is not null
  where q.status in ('pending','processing','review','failed')
  order by q.updated_at,q.product_gid limit p_limit) t;
 return jsonb_build_object('observedAt',statement_timestamp(),'limit',p_limit,'items',items,
  'openTotal',(select count(*) from toptik_media_private.work_queue where status in ('pending','processing','review','failed')),
  'scope','open_work_queue_rows_only');
end $$;
commit;
