-- Additive: one more exact not-sent reason for the existing pre-send hold.
-- A worker that consumed a one-shot permit may now record that a deterministic
-- precondition (fresh observation, decoded bytes, storage DNS/configuration)
-- failed BEFORE any request was sent. Every other rule is unchanged: only the
-- exact started attempt without receipt/after_guard, same lease, same guard
-- validation, idempotent request id, durable conflict for review.
-- Never used for an HTTP/storage timeout or response: those stay unknown.
begin;
create or replace function public.hold_toptik_media_transport(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_phase_index int,
 p_attempt_id uuid,p_request_id uuid,p_code text,p_guard jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;a toptik_media_private.transport_attempts%rowtype;
 e toptik_media_private.events%rowtype;h text;r jsonb;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if p_attempt_id is null or p_request_id is null or p_code is null or p_code not in ('MEDIA_TRANSPORT_CHANGED_BEFORE_CALL','MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET','MEDIA_TRANSPORT_NOT_SENT_PRECONDITION') then raise exception 'MEDIA_TRANSPORT_HOLD_INVALID';end if;
 h:=toptik_media_private.digest(jsonb_build_object('operation',p_operation_id,'step',p_step_index,'phase',p_phase_index,'attempt',p_attempt_id,'code',p_code,'guard',p_guard));
 select * into e from toptik_media_private.events where request_id=p_request_id;
 if found then if e.event_kind<>'transport_not_sent' or e.request_hash<>h or e.product_gid<>p_product_gid then raise exception 'MEDIA_REQUEST_REUSED';end if;return e.result;end if;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 select * into a from toptik_media_private.transport_attempts where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index for update;
 if o.id is null or o.status not in ('running','uncertain') or s.status not in ('started','uncertain') or a.attempt_id is distinct from p_attempt_id
  or a.status is distinct from 'started' or a.after_guard is not null or a.receipt is not null then raise exception 'MEDIA_TRANSPORT_HOLD_NOT_ALLOWED';end if;
 perform toptik_media_private.assert_transport_guard(p_guard,i,s.body->>'target');
 if p_code='MEDIA_TRANSPORT_CHANGED_BEFORE_CALL' and p_guard-'observedAt'=a.before_guard-'observedAt' then raise exception 'MEDIA_TRANSPORT_HOLD_NO_CHANGE';end if;
 -- Caller must be the server worker that consumed this permit and has not sent
 -- the HTTP mutation. A prior uncertain/accepted attempt cannot become not-sent.
 update toptik_media_private.transport_attempts set status='conflict',after_guard=p_guard,receipt=jsonb_build_object('notSent',true,'code',p_code)
  where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index;
 update toptik_media_private.transport_chains set status='conflict',current_guard=p_guard where operation_id=o.id and step_index=p_step_index;
 update toptik_media_private.steps set status='conflict' where operation_id=o.id and step_index=p_step_index;
 update toptik_media_private.operations set status='conflict',version=version+1,updated_at=clock_timestamp() where id=o.id;
 r:=jsonb_build_object('status','conflict','mayExecute',false,'notSent',true);
 insert into toptik_media_private.events values(p_request_id,p_product_gid,o.id,'transport_not_sent',h,jsonb_build_object('attemptId',p_attempt_id,'code',p_code,'guard',p_guard),r,clock_timestamp());
 return r;
end $$;
revoke all on function public.hold_toptik_media_transport(text,uuid,uuid,int,int,uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.hold_toptik_media_transport(text,uuid,uuid,int,int,uuid,uuid,text,jsonb) to service_role;
commit;
