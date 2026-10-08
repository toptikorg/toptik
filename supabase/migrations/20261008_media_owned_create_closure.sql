-- Reviewed exact closure of an UNCERTAIN owned-file creation (create_owned) whose association never ran.
-- Live case (8.10.2026, P10OXT0529O operation e48b9fc7): the worker sent Shopify fileCreate for the
-- deterministic owned file name; the outcome was never recorded (uncertain, no receipt) and the product
-- was paused before readback. The file exists but is not attached. Whether a later readback would refuse
-- (the store has changed since the attempt's guard) or continue to 'associate' depends on the store state
-- at that moment, so the frozen plan must not be left to decide it. No existing path can close it: retirement covers
-- only phase-0 storage attempts, hold_toptik_media_transport refuses uncertain attempts, and repair
-- covers storage phases only, so the product would stay paused forever. The product is expected to be
-- DISABLED while this runs (the approved switch), so no worker can reach the frozen chain in between.
-- A database operator may close EACH exact such attempt when the journal proves that no later phase
-- (association, detach, reorder) was ever permitted for the step. The operation becomes 'conflict',
-- the product is re-enqueued, and the ordinary planner re-plans from the current state with every
-- gate (including the same-content and visual-duplicate holds). Nothing is created, attached,
-- detached or deleted here, and no request, receipt, guard, artifact, provenance or baseline changes.
-- The operator's platform observation (the owned file id if found, and that it is NOT attached to the
-- product) is recorded as evidence only, never as a receipt.
begin;

create table toptik_media_private.owned_create_closures (
 closure_id uuid primary key,
 original_attempt_id uuid not null unique references toptik_media_private.transport_attempts(attempt_id),
 product_gid text not null references toptik_media_private.products(product_gid),
 operation_id uuid not null,
 step_index int not null check(step_index>=0),
 phase_index int not null check(phase_index>=1),
 original_request_hash text not null check(original_request_hash ~ '^[a-f0-9]{64}$'),
 owned_filename text not null check(owned_filename ~ '^toptik-sync-[a-f0-9]{32}-[0-9]+-[a-f0-9]{16}\.(jpg|png|webp|avif)$'),
 observed_file_id text check(observed_file_id ~ '^gid://shopify/MediaImage/[1-9][0-9]*$'),
 observed_attached boolean not null check(observed_attached=false),
 approval_reference text not null check(length(approval_reference) between 1 and 160),
 approval_evidence_sha256 text not null check(approval_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp()
);
alter table toptik_media_private.owned_create_closures enable row level security;
revoke all on table toptik_media_private.owned_create_closures from public,anon,authenticated,service_role;
create trigger immutable_record before update or delete on toptik_media_private.owned_create_closures
 for each row execute function toptik_media_private.immutable();

-- PRIVATE OPERATOR FUNCTION: intentionally NO EXECUTE for service_role or any user role.
-- One call closes one exact attempt; the product may be disabled. p_observed_file_id is the owned file found by its deterministic
-- name (null when none was found); p_observed_attached must be false: an attached file is not this
-- case (the readback path owns it). p_approval_evidence_sha256 is the digest of the operator's live
-- evidence file; it is recorded, never trusted as a permit.
create function toptik_media_private.close_uncertain_owned_create(
 p_product_gid text,p_lease_owner uuid,p_closure_id uuid,p_original_attempt_id uuid,p_request_hash text,
 p_owned_filename text,p_observed_file_id text,p_observed_attached boolean,p_approval_reference text,p_approval_evidence_sha256 text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb; a0 toptik_media_private.transport_attempts%rowtype; a toptik_media_private.transport_attempts%rowtype;
 o toptik_media_private.operations%rowtype; s toptik_media_private.steps%rowtype; c toptik_media_private.transport_chains%rowtype;
 prior toptik_media_private.owned_create_closures%rowtype; r jsonb;
begin
 if p_closure_id is null or p_original_attempt_id is null or coalesce(p_request_hash,'') !~ '^[a-f0-9]{64}$'
 or coalesce(p_owned_filename,'') !~ '^toptik-sync-[a-f0-9]{32}-[0-9]+-[a-f0-9]{16}\.(jpg|png|webp|avif)$'
 or (p_observed_file_id is not null and p_observed_file_id !~ '^gid://shopify/MediaImage/[1-9][0-9]*$')
 or p_observed_attached is null
 or length(coalesce(p_approval_reference,'')) not between 1 and 160 or p_approval_reference ~ '[[:cntrl:]]'
 or coalesce(p_approval_evidence_sha256,'') !~ '^[a-f0-9]{64}$' then raise exception 'MEDIA_OWNED_CREATE_CLOSE_INVALID';end if;
 if p_observed_attached then raise exception 'MEDIA_OWNED_CREATE_CLOSE_ATTACHED_USE_READBACK';end if;
 -- Lease and identity are required; enabled is not (as set_toptik_media_enabled): the paused product is the case.
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner,false);
 -- Idempotent replay of the identical closure only.
 select * into prior from toptik_media_private.owned_create_closures
 where closure_id=p_closure_id or original_attempt_id=p_original_attempt_id;
 if found then
  if prior.closure_id is distinct from p_closure_id or prior.original_attempt_id is distinct from p_original_attempt_id
  or prior.product_gid is distinct from p_product_gid or prior.original_request_hash is distinct from p_request_hash
  or prior.owned_filename is distinct from p_owned_filename or prior.observed_file_id is distinct from p_observed_file_id
  or prior.approval_reference is distinct from p_approval_reference
  or prior.approval_evidence_sha256 is distinct from p_approval_evidence_sha256 then raise exception 'MEDIA_OWNED_CREATE_CLOSE_REUSED';end if;
  return jsonb_build_object('status','conflict','closed',true,'replayed',true,'mayExecute',false,'ownedFileObserved',prior.observed_file_id is not null);
 end if;
 select * into a0 from toptik_media_private.transport_attempts where attempt_id=p_original_attempt_id;
 if not found then raise exception 'MEDIA_OWNED_CREATE_CLOSE_ATTEMPT_MISSING';end if;
 -- Lock order follows assert_access -> operation -> step -> chain -> attempt (as storage_repair_context).
 select * into o from toptik_media_private.operations where id=a0.operation_id and product_gid=p_product_gid for update;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=a0.step_index for update;
 select * into c from toptik_media_private.transport_chains where operation_id=o.id and step_index=a0.step_index for update;
 select * into a from toptik_media_private.transport_attempts where attempt_id=p_original_attempt_id for update;
 -- Exactly the paused shape: this create_owned attempt is the chain's current phase, unanswered,
 -- every earlier phase verified, and nothing after it was ever permitted or produced.
 if o.id is null or s.operation_id is null or c.operation_id is null
 or o.status not in ('running','uncertain') or o.next_step is distinct from a.step_index
 or s.status not in ('started','uncertain') or s.body->>'target' is distinct from 'shopify'
 or c.status not in ('running','uncertain') or c.next_phase is distinct from a.phase_index
 or a.phase is distinct from 'create_owned' or a.phase_index<1 or c.phases->>a.phase_index is distinct from 'create_owned'
 or a.status not in ('started','uncertain') or a.receipt is not null
 or exists(select 1 from generate_series(0,a.phase_index-1) g where not exists(select 1 from toptik_media_private.transport_attempts x
   where x.operation_id=o.id and x.step_index=a.step_index and x.phase_index=g and x.status='verified'))
 or exists(select 1 from toptik_media_private.transport_attempts x where x.operation_id=o.id and x.step_index=a.step_index and x.phase_index>a.phase_index)
 or exists(select 1 from toptik_media_private.transport_artifacts x where x.operation_id=o.id and x.step_index=a.step_index and x.phase_index>=a.phase_index)
 then raise exception 'MEDIA_OWNED_CREATE_CLOSE_OUT_OF_ORDER';end if;
 if a.request_hash is distinct from p_request_hash
 or toptik_media_private.digest(a.request) is distinct from p_request_hash
 or jsonb_typeof(a.request) is distinct from 'object'
 or not(a.request ?& array['duplicateResolutionMode','filename','mutationSha256','sourceEvidenceId','stagedSourceUrl'])
 or (select count(*) from jsonb_object_keys(a.request))<>5
 or a.request->>'filename' is distinct from p_owned_filename
 or position(('toptik-sync-'||replace(o.id::text,'-','')||'-'||a.step_index::text||'-') in p_owned_filename)<>1
 then raise exception 'MEDIA_OWNED_CREATE_CLOSE_REQUEST_CHANGED';end if;
 insert into toptik_media_private.owned_create_closures(closure_id,original_attempt_id,product_gid,operation_id,step_index,phase_index,
  original_request_hash,owned_filename,observed_file_id,observed_attached,approval_reference,approval_evidence_sha256)
 values(p_closure_id,a.attempt_id,p_product_gid,o.id,a.step_index,a.phase_index,p_request_hash,p_owned_filename,p_observed_file_id,
  false,p_approval_reference,p_approval_evidence_sha256);
 -- Same durable conflict states as retirement and hold. Request, (absent) receipt and guards are kept.
 update toptik_media_private.transport_attempts set status='conflict' where attempt_id=a.attempt_id;
 update toptik_media_private.transport_chains set status='conflict' where operation_id=o.id and step_index=a.step_index;
 update toptik_media_private.steps set status='conflict' where operation_id=o.id and step_index=a.step_index;
 update toptik_media_private.operations set status='conflict',version=version+1,updated_at=clock_timestamp() where id=o.id;
 r:=jsonb_build_object('status','conflict','closed',true,'replayed',false,'mayExecute',false,'ownedFileObserved',p_observed_file_id is not null);
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result)
 values(p_closure_id,p_product_gid,o.id,'owned_create_closed',
  toptik_media_private.digest(jsonb_build_object('attempt',a.attempt_id,'requestHash',p_request_hash,'ownedFilename',p_owned_filename,
   'observedFileId',p_observed_file_id,'approvalReference',p_approval_reference,'approvalEvidenceSha256',p_approval_evidence_sha256)),
  jsonb_build_object('attemptId',a.attempt_id,'stepIndex',a.step_index,'phaseIndex',a.phase_index,'ownedFilename',p_owned_filename,
   'observedFileId',p_observed_file_id,'observedAttached',false,'approvalReference',p_approval_reference,
   'approvalEvidenceSha256',p_approval_evidence_sha256),r);
 -- Wake the product (a disabled product is not enqueued; it re-plans once re-enabled).
 perform toptik_media_private.enqueue(p_product_gid,jsonb_build_object('ownedCreateClosed',p_closure_id));
 return r;
end $$;

revoke all on function toptik_media_private.close_uncertain_owned_create(text,uuid,uuid,uuid,text,text,text,boolean,text,text)
 from public,anon,authenticated,service_role;
commit;
