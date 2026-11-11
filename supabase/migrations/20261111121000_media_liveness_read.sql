-- Read-only, bounded per-product liveness view of OPEN media queue rows for the
-- admin monitor. Service role only (called by the authenticated admin server
-- route). It adds the durable evidence the existing monitor read lacks so a
-- "stuck" verdict can rest on verified progress of the CURRENT episode instead
-- of work_queue.updated_at (a FIFO timestamp that claim/keep/defer can preserve).
--
-- Per row:
--   episode            the one open operation (reserved/running/uncertain), or null
--   episode_progress   ONLY that operation's verified evidence: transport_readback /
--                      transport_final_readback events whose result.status is
--                      'verified' (their created_at is the verification time) and
--                      steps.verified_at. transport_attempts.created_at is an attempt
--                      start, not a verification, and is reported as activity only.
--                      Observation and guard refreshes are bookkeeping, not progress.
--   last_completed     latest verified operation (historical evidence, display only)
--   last_observed_at   heartbeat: latest journal event, operation touch or queue touch
--   retry_due_at       failed rows: updated_at + least(attempts,36) * 10 minutes, the
--                      same formula claim_toptik_media_work_excluding applies today
--   claim_stale_after  processing rows: claimed_at + 5 minutes, the stale-claim bound
--                      the claim function uses for recovery
-- Returns no payloads, evidence bodies, guards, URLs, tokens or provider messages:
-- last_error is passed through only when it is an allowlisted MEDIA_ code.
-- No queue, approval, baseline, history or catalog change. Scope is open
-- work_queue rows only; products without a queue row are outside this read.
begin;
create function public.read_toptik_media_liveness(p_limit int default 50)
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
   case when q.status='failed' then q.updated_at+least(q.attempts,36)*interval '10 minutes' end as retry_due_at,
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
revoke all on function public.read_toptik_media_liveness(int) from public,anon,authenticated,service_role;
grant execute on function public.read_toptik_media_liveness(int) to service_role;
commit;
