-- Reviewed exact-attempt retirement of a STALE storage attempt that provably wrote nothing.
-- Storage phases (gallery_upload, stage_source) are create-only uploads to one exact
-- immutable path (upsert false). When that object is absent, the original upload did not
-- land. The repair path (20261007_media_storage_repair.sql) may then re-upload only while
-- the fresh observation still equals the attempt's frozen guard. When the store or gallery
-- has since moved on, that repair is refused forever and the operation stays pending.
-- This lets a database operator retire EACH exact such attempt instead: the operation
-- becomes 'conflict', and the ordinary planner re-plans from the current state, with every
-- review gate, on the next run. Nothing is uploaded, approved, deleted or re-timestamped.
-- No original request, receipt, before_guard, artifact, provenance or baseline changes.
begin;

create table toptik_media_private.storage_attempt_retirements (
 retirement_id uuid primary key,
 original_attempt_id uuid not null unique references toptik_media_private.transport_attempts(attempt_id),
 product_gid text not null references toptik_media_private.products(product_gid),
 operation_id uuid not null,
 step_index int not null check(step_index>=0),
 phase text not null check(phase in ('gallery_upload','stage_source')),
 original_request_hash text not null check(original_request_hash ~ '^[a-f0-9]{64}$'),
 storage_path text not null,
 fresh_guard jsonb not null,
 approval_reference text not null check(length(approval_reference) between 1 and 160),
 approval_evidence_sha256 text not null check(approval_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp()
);
alter table toptik_media_private.storage_attempt_retirements enable row level security;
revoke all on table toptik_media_private.storage_attempt_retirements from public,anon,authenticated,service_role;
create trigger immutable_record before update or delete on toptik_media_private.storage_attempt_retirements
 for each row execute function toptik_media_private.immutable();

-- PRIVATE OPERATOR FUNCTION: intentionally NO EXECUTE for service_role or any user role.
-- One call retires one exact attempt. No SELECT-over-failures, seed or bulk form exists.
create function toptik_media_private.retire_stale_storage_attempt(
 p_product_gid text,p_lease_owner uuid,p_retirement_id uuid,p_original_attempt_id uuid,
 p_request_hash text,p_storage_path text,p_approval_reference text,p_approval_evidence_sha256 text,p_fresh_guard jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb; a0 toptik_media_private.transport_attempts%rowtype; a toptik_media_private.transport_attempts%rowtype;
 o toptik_media_private.operations%rowtype; s toptik_media_private.steps%rowtype; c toptik_media_private.transport_chains%rowtype;
 prior toptik_media_private.storage_attempt_retirements%rowtype; r jsonb;
begin
 if p_retirement_id is null or p_original_attempt_id is null or coalesce(p_request_hash,'') !~ '^[a-f0-9]{64}$' or p_storage_path is null
 or length(coalesce(p_approval_reference,'')) not between 1 and 160 or p_approval_reference ~ '[[:cntrl:]]'
 or coalesce(p_approval_evidence_sha256,'') !~ '^[a-f0-9]{64}$' then raise exception 'MEDIA_STORAGE_RETIRE_INVALID';end if;
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 -- Idempotent replay of the identical retirement only.
 select * into prior from toptik_media_private.storage_attempt_retirements
 where retirement_id=p_retirement_id or original_attempt_id=p_original_attempt_id;
 if found then
  if prior.retirement_id is distinct from p_retirement_id or prior.original_attempt_id is distinct from p_original_attempt_id
  or prior.product_gid is distinct from p_product_gid or prior.original_request_hash is distinct from p_request_hash
  or prior.storage_path is distinct from p_storage_path or prior.approval_reference is distinct from p_approval_reference
  or prior.approval_evidence_sha256 is distinct from p_approval_evidence_sha256 then raise exception 'MEDIA_STORAGE_RETIRE_REUSED';end if;
  return jsonb_build_object('status','conflict','retired',true,'replayed',true,'mayExecute',false);
 end if;
 select * into a0 from toptik_media_private.transport_attempts where attempt_id=p_original_attempt_id;
 if not found then raise exception 'MEDIA_STORAGE_RETIRE_ATTEMPT_MISSING';end if;
 -- Lock order follows assert_access -> operation -> step -> chain -> attempt (as storage_repair_context).
 select * into o from toptik_media_private.operations where id=a0.operation_id and product_gid=p_product_gid for update;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=a0.step_index for update;
 select * into c from toptik_media_private.transport_chains where operation_id=o.id and step_index=a0.step_index for update;
 select * into a from toptik_media_private.transport_attempts where attempt_id=p_original_attempt_id for update;
 if o.id is null or s.operation_id is null or c.operation_id is null
 or o.status not in ('running','uncertain') or o.next_step is distinct from a.step_index
 or s.status not in ('started','uncertain') or c.status not in ('running','uncertain')
 or a.status not in ('started','uncertain') or a.phase_index is distinct from 0
 or c.next_phase is distinct from 0 or c.phases->>0 is distinct from a.phase
 or a.phase not in ('gallery_upload','stage_source')
 or (a.phase='gallery_upload' and s.body->>'target' is distinct from 'gallery')
 or (a.phase='stage_source' and s.body->>'target' is distinct from 'shopify')
 or exists(select 1 from toptik_media_private.transport_artifacts x where x.operation_id=o.id and x.step_index=a.step_index)
 or exists(select 1 from toptik_media_private.transport_attempts x where x.operation_id=o.id and x.step_index=a.step_index and x.phase_index>0)
 then raise exception 'MEDIA_STORAGE_RETIRE_OUT_OF_ORDER';end if;
 if a.request_hash is distinct from p_request_hash
 or toptik_media_private.digest(a.request) is distinct from p_request_hash
 or jsonb_typeof(a.request) is distinct from 'object'
 or not(a.request ?& array['mutationSha256','sourceEvidenceId','storagePath','upsert'])
 or (select count(*) from jsonb_object_keys(a.request))<>4
 or a.request->'upsert' is distinct from 'false'::jsonb
 or a.request->>'storagePath' is distinct from p_storage_path
 or p_storage_path !~ ('^sync-media/'||(i->>'itemId')||'/[a-f0-9]{64}\.(jpg|png|webp)$')
 then raise exception 'MEDIA_STORAGE_RETIRE_REQUEST_CHANGED';end if;
 -- A storage repair approval may have authorized a re-upload: inspect it, never retire over it.
 if exists(select 1 from toptik_media_private.storage_repair_approvals x where x.original_attempt_id=a.attempt_id)
 then raise exception 'MEDIA_STORAGE_RETIRE_REPAIR_APPROVAL_EXISTS';end if;
 perform toptik_media_private.assert_transport_guard(p_fresh_guard,i,s.body->>'target');
 -- Only for attempts the exact repair can never admit. An unchanged observation uses repair.
 if (p_fresh_guard-'observedAt') is not distinct from (a.before_guard-'observedAt')
 and (p_fresh_guard-'observedAt') is not distinct from (c.current_guard-'observedAt')
 then raise exception 'MEDIA_STORAGE_RETIRE_GUARD_UNCHANGED_USE_REPAIR';end if;
 -- Authoritative absence check; fails closed if storage.objects is unavailable.
 if exists(select 1 from storage.objects where bucket_id='carousel-media' and name=p_storage_path)
 then raise exception 'MEDIA_STORAGE_RETIRE_OBJECT_EXISTS_USE_READBACK';end if;
 insert into toptik_media_private.storage_attempt_retirements(retirement_id,original_attempt_id,product_gid,operation_id,step_index,phase,
  original_request_hash,storage_path,fresh_guard,approval_reference,approval_evidence_sha256)
 values(p_retirement_id,a.attempt_id,p_product_gid,o.id,a.step_index,a.phase,p_request_hash,p_storage_path,p_fresh_guard,
  p_approval_reference,p_approval_evidence_sha256);
 -- Same durable conflict shape as hold_toptik_media_transport. The original receipt is kept.
 update toptik_media_private.transport_attempts set status='conflict',after_guard=coalesce(after_guard,p_fresh_guard)
  where attempt_id=a.attempt_id;
 update toptik_media_private.transport_chains set status='conflict',current_guard=p_fresh_guard where operation_id=o.id and step_index=a.step_index;
 update toptik_media_private.steps set status='conflict' where operation_id=o.id and step_index=a.step_index;
 update toptik_media_private.operations set status='conflict',version=version+1,updated_at=clock_timestamp() where id=o.id;
 r:=jsonb_build_object('status','conflict','retired',true,'replayed',false,'mayExecute',false);
 insert into toptik_media_private.events values(p_retirement_id,p_product_gid,o.id,'storage_attempt_retired',
  toptik_media_private.digest(jsonb_build_object('attempt',a.attempt_id,'requestHash',p_request_hash,'storagePath',p_storage_path,
   'approvalReference',p_approval_reference,'approvalEvidenceSha256',p_approval_evidence_sha256)),
  jsonb_build_object('attemptId',a.attempt_id,'phase',a.phase,'stepIndex',a.step_index,'storagePath',p_storage_path,
   'previousUpdatedAt',a.before_guard#>>'{target,updatedAt}','freshUpdatedAt',p_fresh_guard#>>'{target,updatedAt}',
   'approvalReference',p_approval_reference),r,clock_timestamp());
 return r;
end $$;

revoke all on function toptik_media_private.retire_stale_storage_attempt(text,uuid,uuid,uuid,text,text,text,text,jsonb)
 from public,anon,authenticated,service_role;
commit;
