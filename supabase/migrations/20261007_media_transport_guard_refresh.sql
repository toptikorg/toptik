-- Additive: pre-attempt refresh of a Shopify transport chain guard when ONLY
-- the product-level updatedAt (and the raw revision digest derived from it)
-- drifted. Shopify bumps product.updatedAt asynchronously a few seconds after a
-- media association, and also for unrelated copy/SEO edits. Before this
-- migration the next phase's begin compared the whole guard and recorded a
-- durable transport_conflict mid-chain (e.g. after associate, before
-- detach_old), leaving a duplicate image. The final readback already allows
-- exactly this drift (20261007_media_final_readback.sql).
--
-- Every other rule is unchanged:
--  * same lease (assert_access), same strict guard validation, same row locks
--    and order checks as begin_toptik_media_transport;
--  * Shopify targets only; Gallery snapshots have no product timestamp;
--  * source fingerprint and EVERY other target fact (identity, side, complete,
--    each media id/status/fileStatus/updatedAt/alt/image, order,
--    variantMediaIds, variantImage) must be exactly equal, else it refuses
--    with an exception and writes nothing; begin still records real drift as
--    a conflict exactly as before;
--  * never runs once an attempt exists for the phase: recovery keeps using the
--    immutable attempt before_guard. That case returns a non-mutating
--    'attempt_exists' refusal (not an exception) so recovery still proceeds;
--  * no attempt, permit, artifact, step, operation, provenance or baseline
--    change; only transport_chains.current_guard plus an idempotent event.
begin;
create or replace function public.refresh_toptik_media_transport_guard(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_phase_index int,
 p_request_id uuid,p_fresh_guard jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;c toptik_media_private.transport_chains%rowtype;
 e toptik_media_private.events%rowtype;h text;r jsonb;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if p_operation_id is null or p_request_id is null or p_step_index is null or p_step_index not between 0 and 1000
  or p_phase_index is null or p_phase_index not between 0 and 10 then raise exception 'MEDIA_TRANSPORT_GUARD_REFRESH_INVALID';end if;
 h:=toptik_media_private.digest(jsonb_build_object('operation',p_operation_id,'step',p_step_index,'phase',p_phase_index,'guard',p_fresh_guard));
 select * into e from toptik_media_private.events where request_id=p_request_id;
 if found then
  if e.event_kind<>'transport_guard_refreshed' or e.request_hash<>h or e.product_gid<>p_product_gid then raise exception 'MEDIA_REQUEST_REUSED';end if;
  return e.result;
 end if;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 select * into c from toptik_media_private.transport_chains where operation_id=o.id and step_index=p_step_index for update;
 if o.id is null or s.operation_id is null or c.operation_id is null then raise exception 'MEDIA_TRANSPORT_MISSING';end if;
 if s.body->>'target' is distinct from 'shopify' then raise exception 'MEDIA_TRANSPORT_GUARD_REFRESH_UNSUPPORTED';end if;
 perform toptik_media_private.assert_transport_guard(p_fresh_guard,i,'shopify');
 -- A consumed one-shot attempt freezes its before_guard forever. Never touch it.
 if exists(select 1 from toptik_media_private.transport_attempts a where a.operation_id=o.id and a.step_index=p_step_index and a.phase_index=p_phase_index) then
  return jsonb_build_object('status','attempt_exists','refreshed',false,'mayExecute',false);
 end if;
 if o.status not in ('running','uncertain') or c.status not in ('ready','running') or c.next_phase<>p_phase_index
 or p_phase_index>=jsonb_array_length(c.phases) or s.status not in ('started','uncertain') then raise exception 'MEDIA_TRANSPORT_OUT_OF_ORDER';end if;
 if p_fresh_guard-'observedAt'=c.current_guard-'observedAt' then
  return jsonb_build_object('status','unchanged','refreshed',false,'mayExecute',false);
 end if;
 if p_fresh_guard->>'sourceFingerprint' is distinct from c.current_guard->>'sourceFingerprint'
 or ((p_fresh_guard->'target')-'updatedAt'-'revision') is distinct from ((c.current_guard->'target')-'updatedAt'-'revision') then
  raise exception 'MEDIA_TRANSPORT_GUARD_REFRESH_MISMATCH';
 end if;
 update toptik_media_private.transport_chains set current_guard=p_fresh_guard where operation_id=o.id and step_index=p_step_index;
 r:=jsonb_build_object('status','refreshed','refreshed',true,'mayExecute',false,'nextPhase',p_phase_index);
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result)
 values(p_request_id,p_product_gid,o.id,'transport_guard_refreshed',h,jsonb_build_object('stepIndex',p_step_index,'phaseIndex',p_phase_index,
  'previousGuard',c.current_guard,'freshGuard',p_fresh_guard,
  'previousUpdatedAt',c.current_guard#>>'{target,updatedAt}','freshUpdatedAt',p_fresh_guard#>>'{target,updatedAt}'),r);
 return r;
end $$;
revoke all on function public.refresh_toptik_media_transport_guard(text,uuid,uuid,int,int,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.refresh_toptik_media_transport_guard(text,uuid,uuid,int,int,uuid,jsonb) to service_role;
commit;
