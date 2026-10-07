-- Durable, exact record of a DEFINITIVE database rejection of one Gallery CAS.
-- apply_toptik_gallery_media_cas is a single atomic transaction that writes its
-- gallery_commits receipt together with every catalog change. When the database
-- itself answered with a rejection, that transaction rolled back. Before this
-- migration the worker swallowed the error, so the consumed one-shot attempt
-- stayed 'started' without a receipt and recovery returned pending forever.
--
-- This port is service-only and gallery_cas-only. It never authorizes, retries
-- or replays a write. It refuses when a commit receipt exists or the attempt is
-- no longer the exact started permit, so an in-flight or committed apply always
-- wins (both functions lock the same operation/attempt rows before writing).
-- The resulting conflict uses the existing review contract: no baseline,
-- approval, queue, catalog or provenance change; replanning needs a new event.
begin;
create function public.reject_toptik_gallery_media_cas(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_phase_index int,
 p_attempt_id uuid,p_request_id uuid,p_rejection text,p_guard jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;c toptik_media_private.transport_chains%rowtype;
 a toptik_media_private.transport_attempts%rowtype;e toptik_media_private.events%rowtype;h text;r jsonb;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if p_operation_id is null or p_attempt_id is null or p_request_id is null or p_step_index is null or p_step_index not between 0 and 1000
  or p_phase_index is null or p_phase_index not between 0 and 10 or coalesce(p_rejection,'') !~ '^(MEDIA|SYNC_COPY)_[A-Z0-9_]{1,90}$' then raise exception 'MEDIA_GALLERY_REJECTION_INVALID';end if;
 h:=toptik_media_private.digest(jsonb_build_object('operation',p_operation_id,'step',p_step_index,'phase',p_phase_index,'attempt',p_attempt_id,'rejection',p_rejection,'guard',p_guard));
 select * into e from toptik_media_private.events where request_id=p_request_id;
 if found then if e.event_kind<>'transport_rejected' or e.request_hash<>h or e.product_gid<>p_product_gid then raise exception 'MEDIA_REQUEST_REUSED';end if;return e.result;end if;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 select * into c from toptik_media_private.transport_chains where operation_id=o.id and step_index=p_step_index for update;
 select * into a from toptik_media_private.transport_attempts where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index for update;
 if o.id is null or o.status not in ('running','uncertain') or s.status not in ('started','uncertain') or s.body->>'target' is distinct from 'gallery'
  or c.status not in ('ready','running','uncertain') or c.next_phase is distinct from p_phase_index or c.phases->>p_phase_index is distinct from 'gallery_cas'
  or a.phase is distinct from 'gallery_cas' or a.attempt_id is distinct from p_attempt_id or a.status is distinct from 'started'
  or a.after_guard is not null or a.receipt is not null then raise exception 'MEDIA_GALLERY_REJECTION_NOT_ALLOWED';end if;
 -- The receipt is written in the same transaction as the catalog change.
 if exists(select 1 from toptik_media_private.gallery_commits g where g.operation_id=o.id and g.step_index=p_step_index and g.phase_index=p_phase_index)
  then raise exception 'MEDIA_GALLERY_REJECTION_AFTER_COMMIT';end if;
 perform toptik_media_private.assert_transport_guard(p_guard,i,'gallery');
 update toptik_media_private.transport_attempts set status='conflict',after_guard=p_guard,
  receipt=jsonb_build_object('notApplied',true,'code','MEDIA_GALLERY_CAS_REJECTED','rejection',p_rejection)
  where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index;
 update toptik_media_private.transport_chains set status='conflict',current_guard=p_guard where operation_id=o.id and step_index=p_step_index;
 update toptik_media_private.steps set status='conflict' where operation_id=o.id and step_index=p_step_index;
 update toptik_media_private.operations set status='conflict',version=version+1,updated_at=clock_timestamp() where id=o.id;
 r:=jsonb_build_object('status','conflict','mayExecute',false,'notApplied',true,'rejection',p_rejection);
 insert into toptik_media_private.events values(p_request_id,p_product_gid,o.id,'transport_rejected',h,
  jsonb_build_object('stepIndex',p_step_index,'phaseIndex',p_phase_index,'attemptId',p_attempt_id,'rejection',p_rejection,'guard',p_guard),r,clock_timestamp());
 return r;
end $$;
revoke all on function public.reject_toptik_gallery_media_cas(text,uuid,uuid,int,int,uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.reject_toptik_gallery_media_cas(text,uuid,uuid,int,int,uuid,uuid,text,jsonb) to service_role;
commit;
