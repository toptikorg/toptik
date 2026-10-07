-- Reviewed exact-attempt recovery policy. No automatic bulk admission.
-- Requires the existing media journal/transport migrations and storage.objects.
-- A database operator must separately approve EACH exact old attempt. Neither
-- missing Storage metadata nor the worker service_role can create approvals.
-- No original attempt, permit, operation, chain, phase, artifact, product or
-- Storage row is updated here. Completion uses the existing verified GET path.
begin;

create table toptik_media_private.storage_repair_approvals (
 approval_id uuid primary key,
 original_attempt_id uuid not null unique references toptik_media_private.transport_attempts(attempt_id),
 product_gid text not null references toptik_media_private.products(product_gid),
 operation_id uuid not null,
 step_index int not null check(step_index>=0),
 phase_index int not null check(phase_index=0),
 original_request_hash text not null check(original_request_hash ~ '^[a-f0-9]{64}$'),
 storage_path text not null,
 source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
 source_evidence_id text not null,
 identity jsonb not null,
 scope_hash text not null check(scope_hash ~ '^[a-f0-9]{64}$'),
 approval_reference text not null check(length(approval_reference) between 1 and 160),
 approval_evidence_sha256 text not null check(approval_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp(),
 check(expires_at>created_at and expires_at<=created_at+interval '24 hours'),
 foreign key(operation_id,step_index,phase_index)
   references toptik_media_private.transport_attempts(operation_id,step_index,phase_index)
);
create table toptik_media_private.storage_repair_claims (
 repair_id uuid primary key,
 approval_id uuid not null unique references toptik_media_private.storage_repair_approvals(approval_id),
 original_attempt_id uuid not null unique references toptik_media_private.transport_attempts(attempt_id),
 lease_owner uuid not null,
 fresh_guard jsonb not null,
 may_execute_until timestamptz not null,
 absence_checked_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp(),
 check(may_execute_until>created_at)
);
create table toptik_media_private.storage_repair_outcomes (
 repair_id uuid primary key references toptik_media_private.storage_repair_claims(repair_id),
 request_id uuid not null unique,
 -- accepted means the upload response only, NEVER phase verification.
 outcome text not null check(outcome in ('accepted','unknown')),
 stage text not null check(stage in ('preflight','decode','dns','upload','readback')),
 http_status int check(http_status between 100 and 599),
 created_at timestamptz not null default clock_timestamp()
);

do $$ declare t text; begin
 foreach t in array array['storage_repair_approvals','storage_repair_claims','storage_repair_outcomes'] loop
  execute format('alter table toptik_media_private.%I enable row level security',t);
  execute format('revoke all on table toptik_media_private.%I from public,anon,authenticated,service_role',t);
  execute format('create trigger immutable_record before update or delete on toptik_media_private.%I for each row execute function toptik_media_private.immutable()',t);
 end loop;
end $$;

-- Lock order follows assert_access -> operation -> step -> chain -> attempt.
-- This checks DB evidence; caller must ALSO re-run source review/deny gates,
-- byte decode/hash and live source/target observation before claim and POST.
create function toptik_media_private.storage_repair_context(
 p_product_gid text,p_lease_owner uuid,p_original_attempt_id uuid,
 p_request_hash text,p_storage_path text,p_source_sha256 text,p_fresh_guard jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb; a0 toptik_media_private.transport_attempts%rowtype;
 a toptik_media_private.transport_attempts%rowtype; o toptik_media_private.operations%rowtype;
 s toptik_media_private.steps%rowtype; c toptik_media_private.transport_chains%rowtype;
 p toptik_media_private.provenance%rowtype; asset jsonb; ext text; lease_end timestamptz;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if p_original_attempt_id is null or coalesce(p_request_hash,'') !~ '^[a-f0-9]{64}$'
 or coalesce(p_source_sha256,'') !~ '^[a-f0-9]{64}$' or p_storage_path is null then
  raise exception 'MEDIA_STORAGE_REPAIR_SCOPE_INVALID';end if;
 select * into a0 from toptik_media_private.transport_attempts where attempt_id=p_original_attempt_id;
 if not found then raise exception 'MEDIA_STORAGE_REPAIR_ATTEMPT_MISSING';end if;
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
 then raise exception 'MEDIA_STORAGE_REPAIR_OUT_OF_ORDER';end if;
 if a.request_hash is distinct from p_request_hash
 or toptik_media_private.digest(a.request) is distinct from p_request_hash
 or jsonb_typeof(a.request) is distinct from 'object'
 or not(a.request ?& array['mutationSha256','sourceEvidenceId','storagePath','upsert'])
 or (select count(*) from jsonb_object_keys(a.request))<>4
 or coalesce(a.request->>'mutationSha256','') !~ '^[a-f0-9]{64}$'
 or a.request->'upsert' is distinct from 'false'::jsonb
 or a.request->>'storagePath' is distinct from p_storage_path
 then raise exception 'MEDIA_STORAGE_REPAIR_REQUEST_CHANGED';end if;
 perform toptik_media_private.assert_transport_guard(p_fresh_guard,i,s.body->>'target');
 if (p_fresh_guard-'observedAt') is distinct from (c.current_guard-'observedAt')
 or (p_fresh_guard-'observedAt') is distinct from (a.before_guard-'observedAt')
 then raise exception 'MEDIA_STORAGE_REPAIR_GUARD_CHANGED';end if;
 asset:=toptik_media_private.asset(s.expected_pair->(s.body->>'target'),s.body->>'key');
 select * into p from toptik_media_private.provenance
 where evidence_id=a.request->>'sourceEvidenceId' and product_gid=p_product_gid
 and asset_key=s.body->>'key' and content_id=asset->>'contentId';
 -- Do not force provenance.side = body.source: an ALT clone may intentionally
 -- stage the target's existing owned rendition. The original exact request,
 -- immutable evidence, product/key/content and SHA remain mandatory, matching
 -- begin_toptik_media_transport's established proof selection.
 if not found or p.proof->>'decodedSha256' is distinct from p_source_sha256
 then raise exception 'MEDIA_STORAGE_REPAIR_SOURCE_CHANGED';end if;
 ext:=case p.proof->>'mime' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' end;
 if ext is null or p_storage_path is distinct from 'sync-media/'||(i->>'itemId')||'/'||p_source_sha256||'.'||ext
 then raise exception 'MEDIA_STORAGE_REPAIR_PATH_INVALID';end if;
 select expires_at into lease_end from public.shopify_gallery_reconciliation_leases
 where product_gid=p_product_gid and owner=p_lease_owner;
 if lease_end is null or lease_end<=clock_timestamp()+interval '15 seconds'
 then raise exception 'MEDIA_STORAGE_REPAIR_LEASE_TOO_SHORT';end if;
 return jsonb_build_object('identity',i,'productGid',p_product_gid,'operationId',o.id,
  'stepIndex',a.step_index,'phaseIndex',0,'originalAttemptId',a.attempt_id,
  'originalRequestHash',a.request_hash,'storagePath',p_storage_path,'sourceSha256',p_source_sha256,
  'sourceEvidenceId',p.evidence_id,'phase',a.phase,'request',a.request,'leaseExpiresAt',lease_end);
end $$;

-- PRIVATE OPERATOR FUNCTION: intentionally NO EXECUTE for service_role.
-- Each invocation must be traceable to separately authorized exact scope.
-- No migration seed, SELECT-over-failures, worker call or bulk auto-approval.
create function toptik_media_private.authorize_storage_repair(
 p_product_gid text,p_lease_owner uuid,p_approval_id uuid,p_original_attempt_id uuid,
 p_request_hash text,p_storage_path text,p_source_sha256 text,
 p_approval_reference text,p_approval_evidence_sha256 text,p_expires_at timestamptz,p_fresh_guard jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare x jsonb; h text; prior toptik_media_private.storage_repair_approvals%rowtype;
begin
 if p_approval_id is null or p_expires_at is null or not isfinite(p_expires_at)
 or p_expires_at<=clock_timestamp()+interval '30 seconds' or p_expires_at>clock_timestamp()+interval '24 hours'
 or length(coalesce(p_approval_reference,'')) not between 1 and 160
 or p_approval_reference ~ '[[:cntrl:]]' or coalesce(p_approval_evidence_sha256,'') !~ '^[a-f0-9]{64}$'
 then raise exception 'MEDIA_STORAGE_REPAIR_APPROVAL_INVALID';end if;
 x:=toptik_media_private.storage_repair_context(p_product_gid,p_lease_owner,p_original_attempt_id,
  p_request_hash,p_storage_path,p_source_sha256,p_fresh_guard);
 h:=toptik_media_private.digest((x-'leaseExpiresAt')||jsonb_build_object('approvalId',p_approval_id,
  'approvalReference',p_approval_reference,'approvalEvidenceSha256',p_approval_evidence_sha256,'expiresAt',p_expires_at));
 select * into prior from toptik_media_private.storage_repair_approvals where approval_id=p_approval_id or original_attempt_id=p_original_attempt_id;
 if found then
  if prior.approval_id is distinct from p_approval_id or prior.scope_hash is distinct from h
  then raise exception 'MEDIA_STORAGE_REPAIR_APPROVAL_REUSED';end if;
  return jsonb_build_object('approvalId',prior.approval_id,'replayed',true,'mayExecute',false);
 end if;
 -- This authoritative check must fail closed if storage.objects is unavailable.
 -- Absence is a prerequisite, NEVER the authority to insert an approval.
 if exists(select 1 from storage.objects where bucket_id='carousel-media' and name=p_storage_path)
 then raise exception 'MEDIA_STORAGE_REPAIR_OBJECT_EXISTS_USE_READBACK';end if;
 insert into toptik_media_private.storage_repair_approvals(approval_id,original_attempt_id,product_gid,
 operation_id,step_index,phase_index,original_request_hash,storage_path,source_sha256,source_evidence_id,
 identity,scope_hash,approval_reference,approval_evidence_sha256,expires_at)
 values(p_approval_id,p_original_attempt_id,p_product_gid,(x->>'operationId')::uuid,(x->>'stepIndex')::int,0,
 p_request_hash,p_storage_path,p_source_sha256,x->>'sourceEvidenceId',x->'identity',h,
 p_approval_reference,p_approval_evidence_sha256,p_expires_at);
 return jsonb_build_object('approvalId',p_approval_id,'replayed',false,'mayExecute',false);
end $$;

create function public.read_toptik_storage_repair(p_product_gid text,p_lease_owner uuid,p_original_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb; a toptik_media_private.storage_repair_approvals%rowtype;
 c toptik_media_private.storage_repair_claims%rowtype; r toptik_media_private.storage_repair_outcomes%rowtype;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 select * into a from toptik_media_private.storage_repair_approvals
 where original_attempt_id=p_original_attempt_id and product_gid=p_product_gid;
 if not found then return jsonb_build_object('approved',false,'mayExecute',false);end if;
 if a.identity is distinct from i then raise exception 'MEDIA_STORAGE_REPAIR_IDENTITY_CHANGED';end if;
 select * into c from toptik_media_private.storage_repair_claims where approval_id=a.approval_id;
 select * into r from toptik_media_private.storage_repair_outcomes where repair_id=c.repair_id;
 return jsonb_build_object('approved',true,'mayExecute',false,'approval',to_jsonb(a),
  'expired',a.expires_at<=clock_timestamp(),
  'claim',case when c.repair_id is null then null else to_jsonb(c) end,
  'outcome',case when r.repair_id is null then null else to_jsonb(r) end,
  'objectPresent',exists(select 1 from storage.objects where bucket_id='carousel-media' and name=a.storage_path));
end $$;

create function public.claim_toptik_storage_repair(
 p_product_gid text,p_lease_owner uuid,p_approval_id uuid,p_repair_id uuid,p_original_attempt_id uuid,
 p_request_hash text,p_storage_path text,p_source_sha256 text,p_fresh_guard jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb; x jsonb; a toptik_media_private.storage_repair_approvals%rowtype;
 prior toptik_media_private.storage_repair_claims%rowtype; until_time timestamptz;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if p_approval_id is null or p_repair_id is null or p_original_attempt_id is null
 then raise exception 'MEDIA_STORAGE_REPAIR_SCOPE_INVALID';end if;
 select * into a from toptik_media_private.storage_repair_approvals where approval_id=p_approval_id;
 if not found or a.product_gid is distinct from p_product_gid or a.identity is distinct from i
 or a.original_attempt_id is distinct from p_original_attempt_id or a.original_request_hash is distinct from p_request_hash
 or a.storage_path is distinct from p_storage_path or a.source_sha256 is distinct from p_source_sha256
 then raise exception 'MEDIA_STORAGE_REPAIR_APPROVAL_REQUIRED';end if;
 select * into prior from toptik_media_private.storage_repair_claims where approval_id=p_approval_id;
 if found then
  -- A timeout/lost response consumes the permit. Even SAME repairId is GET-only.
  return jsonb_build_object('mayExecute',false,'replayed',true,'repairId',prior.repair_id,'status','consumed');
 end if;
 if exists(select 1 from toptik_media_private.storage_repair_claims where repair_id=p_repair_id)
 then raise exception 'MEDIA_STORAGE_REPAIR_ID_REUSED';end if;
 if a.expires_at<=clock_timestamp()+interval '15 seconds' then raise exception 'MEDIA_STORAGE_REPAIR_APPROVAL_EXPIRED';end if;
 x:=toptik_media_private.storage_repair_context(p_product_gid,p_lease_owner,p_original_attempt_id,
  p_request_hash,p_storage_path,p_source_sha256,p_fresh_guard);
 if a.operation_id is distinct from (x->>'operationId')::uuid or a.step_index is distinct from (x->>'stepIndex')::int
 or a.source_evidence_id is distinct from x->>'sourceEvidenceId'
 then raise exception 'MEDIA_STORAGE_REPAIR_SCOPE_CHANGED';end if;
 if exists(select 1 from storage.objects where bucket_id='carousel-media' and name=p_storage_path)
 then return jsonb_build_object('mayExecute',false,'replayed',false,'status','object_present_use_readback');end if;
 until_time:=least(a.expires_at,(x->>'leaseExpiresAt')::timestamptz-interval '5 seconds',clock_timestamp()+interval '30 seconds');
 insert into toptik_media_private.storage_repair_claims(repair_id,approval_id,original_attempt_id,lease_owner,
 fresh_guard,may_execute_until,absence_checked_at)
 values(p_repair_id,p_approval_id,p_original_attempt_id,p_lease_owner,p_fresh_guard,until_time,clock_timestamp());
 return jsonb_build_object('mayExecute',true,'replayed',false,'repairId',p_repair_id,'approvalId',p_approval_id,
  'originalAttemptId',p_original_attempt_id,'originalRequestHash',p_request_hash,'storagePath',p_storage_path,
  'sourceSha256',p_source_sha256,'sourceEvidenceId',a.source_evidence_id,'phase',x->>'phase',
  'mayExecuteUntil',until_time,'upsert',false,'request',x->'request');
end $$;

create function public.record_toptik_storage_repair_outcome(
 p_product_gid text,p_lease_owner uuid,p_repair_id uuid,p_request_id uuid,
 p_outcome text,p_stage text,p_http_status int default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb; a toptik_media_private.storage_repair_approvals%rowtype;
 c toptik_media_private.storage_repair_claims%rowtype; prior toptik_media_private.storage_repair_outcomes%rowtype;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if p_request_id is null or p_repair_id is null or p_outcome is null or p_stage is null
 or p_outcome not in ('accepted','unknown') or p_stage not in ('preflight','decode','dns','upload','readback')
 or (p_http_status is not null and p_http_status not between 100 and 599)
 then raise exception 'MEDIA_STORAGE_REPAIR_OUTCOME_INVALID';end if;
 select * into c from toptik_media_private.storage_repair_claims where repair_id=p_repair_id;
 select * into a from toptik_media_private.storage_repair_approvals where approval_id=c.approval_id;
 if c.repair_id is null or a.product_gid is distinct from p_product_gid or a.identity is distinct from i
 or c.lease_owner is distinct from p_lease_owner then raise exception 'MEDIA_STORAGE_REPAIR_CLAIM_REQUIRED';end if;
 select * into prior from toptik_media_private.storage_repair_outcomes where repair_id=p_repair_id or request_id=p_request_id;
 if found then
  if prior.repair_id is distinct from p_repair_id or prior.request_id is distinct from p_request_id
  or prior.outcome is distinct from p_outcome or prior.stage is distinct from p_stage or prior.http_status is distinct from p_http_status
  then raise exception 'MEDIA_STORAGE_REPAIR_OUTCOME_REUSED';end if;
  return jsonb_build_object('recorded',true,'replayed',true,'mayExecute',false);
 end if;
 insert into toptik_media_private.storage_repair_outcomes(repair_id,request_id,outcome,stage,http_status)
 values(p_repair_id,p_request_id,p_outcome,p_stage,p_http_status);
 return jsonb_build_object('recorded',true,'replayed',false,'mayExecute',false);
end $$;

-- Functions default to PUBLIC execute, therefore revoke explicitly, including
-- service_role for private helpers/authorization. No grants to user roles.
revoke all on function toptik_media_private.storage_repair_context(text,uuid,uuid,text,text,text,jsonb),
 toptik_media_private.authorize_storage_repair(text,uuid,uuid,uuid,text,text,text,text,text,timestamptz,jsonb)
 from public,anon,authenticated,service_role;
revoke all on function public.read_toptik_storage_repair(text,uuid,uuid),
 public.claim_toptik_storage_repair(text,uuid,uuid,uuid,uuid,text,text,text,jsonb),
 public.record_toptik_storage_repair_outcome(text,uuid,uuid,uuid,text,text,int)
 from public,anon,authenticated,service_role;
grant execute on function public.read_toptik_storage_repair(text,uuid,uuid),
 public.claim_toptik_storage_repair(text,uuid,uuid,uuid,uuid,text,text,text,jsonb),
 public.record_toptik_storage_repair_outcome(text,uuid,uuid,uuid,text,text,int) to service_role;
commit;
