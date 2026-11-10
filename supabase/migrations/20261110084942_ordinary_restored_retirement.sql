-- Service-only retirement of an ordinary journal operation that never reached transport.
-- The current registered media must exactly equal the committed baselines on both sides.
-- Retirement is a conflict with an immutable reason, never a verification or a baseline reset.
begin;
set local lock_timeout='3s';

create function public.read_toptik_media_retirement_context(
 p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;s toptik_media_private.state%rowtype;o toptik_media_private.operations%rowtype;
 q jsonb;e toptik_media_private.events%rowtype;planning jsonb;
begin
 if p_operation_id is null or p_request_id is null then raise exception 'MEDIA_RETIREMENT_INPUT_INVALID';end if;
 begin i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 exception when others then raise exception 'MEDIA_RETIREMENT_ACCESS_DENIED';end;
 -- Lock order: global/copy approval/lease/product (assert_access), state, operation,
 -- queue, gallery item and angles. The global lock excludes gallery angle phantoms.
 select * into s from toptik_media_private.state where product_gid=p_product_gid for update;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if s.product_gid is null or o.id is null then raise exception 'MEDIA_RETIREMENT_OPERATION_MISSING';end if;
 select to_jsonb(w) into q from toptik_media_private.work_queue w where product_gid=p_product_gid for update;
 perform 1 from public.carousel_items where id=(i->>'itemId')::uuid for update;
 perform 1 from public.carousel_item_angles where item_id=(i->>'itemId')::uuid order by id for update;
 perform 1 from public.shopify_gallery_reconciliation_leases where product_gid=p_product_gid and owner=p_lease_owner and expires_at>clock_timestamp() for update;
 if not found then raise exception 'MEDIA_RETIREMENT_LEASE_EXPIRED';end if;
 select * into e from toptik_media_private.events where request_id=p_request_id;
 if found and (e.event_kind<>'restored_before_transport' or e.product_gid<>p_product_gid or e.operation_id is distinct from p_operation_id)
 then raise exception 'MEDIA_RETIREMENT_REQUEST_REUSED';end if;
 planning:=public.read_toptik_media_planning_context(p_product_gid,p_lease_owner);
 return jsonb_build_object('planningContext',planning,'operation',to_jsonb(o),'queueFence',coalesce(q,'null'::jsonb),
  'priorReceipt',case when e.request_id is null then null else to_jsonb(e) end,
  'steps',coalesce((select jsonb_agg(to_jsonb(x) order by step_index) from toptik_media_private.steps x where operation_id=o.id),'[]'::jsonb),
  'chains',coalesce((select jsonb_agg(to_jsonb(x) order by step_index) from toptik_media_private.transport_chains x where operation_id=o.id),'[]'::jsonb),
  'transportAttemptCount',(select count(*) from toptik_media_private.transport_attempts where operation_id=o.id),
  'transportArtifactCount',(select count(*) from toptik_media_private.transport_artifacts where operation_id=o.id),
  'galleryCommitCount',(select count(*) from toptik_media_private.gallery_commits where operation_id=o.id));
end $$;

create function public.retire_restored_toptik_media_operation(
 p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_request_id uuid,p_actor_id uuid,p_auth_method text,p_approval text,
 p_expected_state_version bigint,p_expected_operation_version bigint,p_expected_operation_hash text,p_queue_fence jsonb,
 p_current_pair jsonb,p_gallery_raw jsonb,p_gallery_refs jsonb,p_observed_at timestamptz
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;s toptik_media_private.state%rowtype;o toptik_media_private.operations%rowtype;
 q jsonb;raw jsonb;gallery jsonb;command jsonb;h text;e toptik_media_private.events%rowtype;
 before_steps jsonb;before_chains jsonb;r jsonb;side text;
begin
 if p_operation_id is null or p_request_id is null or p_actor_id is null
 or coalesce(p_auth_method,'') not in ('session_admin','admin_token') or p_approval is distinct from 'RESTORED_BEFORE_TRANSPORT'
 or p_expected_state_version is null or p_expected_state_version<1 or p_expected_operation_version is null or p_expected_operation_version<1
 or coalesce(p_expected_operation_hash,'') !~ '^[a-f0-9]{64}$'
 or p_observed_at is null or not isfinite(p_observed_at)
 or p_observed_at not between clock_timestamp()-interval '2 minutes' and clock_timestamp()+interval '10 seconds'
 or jsonb_typeof(p_gallery_raw) is distinct from 'object' or jsonb_typeof(p_gallery_refs) is distinct from 'array'
 or octet_length(p_gallery_raw::text)>2500000 or octet_length(p_gallery_refs::text)>100000
 then raise exception 'MEDIA_RETIREMENT_INPUT_INVALID';end if;
 begin i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 exception when others then raise exception 'MEDIA_RETIREMENT_ACCESS_DENIED';end;
 select * into s from toptik_media_private.state where product_gid=p_product_gid for update;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if s.product_gid is null or o.id is null then raise exception 'MEDIA_RETIREMENT_OPERATION_MISSING';end if;
 select to_jsonb(w) into q from toptik_media_private.work_queue w where product_gid=p_product_gid for update;
 perform 1 from public.carousel_items where id=(i->>'itemId')::uuid for update;
 perform 1 from public.carousel_item_angles where item_id=(i->>'itemId')::uuid order by id for update;
 -- assert_access ran before any possible waits. This is a live check after all locks.
 perform 1 from public.shopify_gallery_reconciliation_leases where product_gid=p_product_gid and owner=p_lease_owner and expires_at>clock_timestamp() for update;
 if not found then raise exception 'MEDIA_RETIREMENT_LEASE_EXPIRED';end if;
 if s.version is distinct from p_expected_state_version or o.state_version is distinct from s.version
 or o.version is distinct from p_expected_operation_version or o.request_hash is distinct from p_expected_operation_hash
 then raise exception 'MEDIA_RETIREMENT_VERSION_CHANGED';end if;
 if q is null then raise exception 'MEDIA_RETIREMENT_QUEUE_MISSING';end if;
 if coalesce(q,'null'::jsonb) is distinct from coalesce(p_queue_fence,'null'::jsonb) then raise exception 'MEDIA_RETIREMENT_QUEUE_CHANGED';end if;
 if q->>'status'='processing' or q->>'claim_id' is not null or q->>'claimed_generation' is not null or q->>'claimed_at' is not null
 then raise exception 'MEDIA_RETIREMENT_QUEUE_BUSY';end if;
 if exists(select 1 from toptik_media_private.operations where product_gid=p_product_gid and id<>o.id and status in ('reserved','running','uncertain'))
 then raise exception 'MEDIA_RETIREMENT_NEW_OPERATION';end if;
 begin
  perform toptik_media_private.assert_pair(p_current_pair,i);
  perform toptik_media_private.assert_pair(s.baselines,i);
 exception when others then raise exception 'MEDIA_RETIREMENT_PAIR_INVALID';end;
 foreach side in array array['gallery','shopify'] loop
  -- Preserve keys, order, ALT, content, evidence, identity, side and completeness.
  -- A new platform/gallery revision alone is not a media change.
  if (p_current_pair->side)-'revision' is distinct from (s.baselines->side)-'revision'
  then raise exception 'MEDIA_RETIREMENT_BASELINE_MISMATCH';end if;
 end loop;
 begin
  raw:=toptik_media_private.gallery_raw(i);
  if raw is distinct from p_gallery_raw then raise exception 'MEDIA_RETIREMENT_GALLERY_CHANGED';end if;
  gallery:=toptik_media_private.gallery_snapshot(raw,p_gallery_refs);
 exception when others then
  if sqlerrm='MEDIA_RETIREMENT_GALLERY_CHANGED' then raise;end if;
  raise exception 'MEDIA_RETIREMENT_GALLERY_INVALID';
 end;
 if gallery is distinct from p_current_pair->'gallery' then raise exception 'MEDIA_RETIREMENT_GALLERY_CHANGED';end if;
 if p_observed_at not between clock_timestamp()-interval '2 minutes' and clock_timestamp()+interval '10 seconds'
 then raise exception 'MEDIA_RETIREMENT_OBSERVATION_EXPIRED';end if;
 if exists(select 1 from toptik_media_private.transport_attempts where operation_id=o.id)
 or exists(select 1 from toptik_media_private.transport_artifacts where operation_id=o.id)
 or exists(select 1 from toptik_media_private.gallery_commits where operation_id=o.id)
 then raise exception 'MEDIA_RETIREMENT_TRANSPORT_EXISTS';end if;
 if o.next_step<>0 or exists(select 1 from toptik_media_private.steps where operation_id=o.id
  and (status not in ('ready','started') or readback_pair is not null or detach_verified or verified_at is not null or (step_index<>0 and status<>'ready')))
 or not exists(select 1 from toptik_media_private.steps where operation_id=o.id and step_index=0)
 or exists(select 1 from toptik_media_private.transport_chains where operation_id=o.id and (step_index<>0 or status<>'ready' or next_phase<>0))
 then raise exception 'MEDIA_RETIREMENT_LOGICAL_PROGRESS';end if;
 -- Stable intent binds identity and authority. Fresh CAS/capture is audited separately
 -- so identical retries can use new revision-only observations and a renewed lease.
 command:=jsonb_build_object('productId',p_product_gid,'operationId',o.id,'operationHash',o.request_hash,'requestId',p_request_id,
  'actorId',p_actor_id,'authMethod',p_auth_method,'approval',p_approval,'identity',i);
 h:=toptik_media_private.digest(command);
 select * into e from toptik_media_private.events where request_id=p_request_id;
 if found then
  if e.event_kind<>'restored_before_transport' or e.product_gid<>p_product_gid or e.operation_id is distinct from o.id
  or e.request_hash<>h or e.evidence->'command' is distinct from command then raise exception 'MEDIA_RETIREMENT_REQUEST_REUSED';end if;
  if o.status<>'conflict' or o.version::text is distinct from e.result->>'operationVersion'
   or s.version::text is distinct from e.evidence#>>'{before,state,version}'
   or s.baselines is distinct from e.evidence#>'{before,state,baselines}'
  then raise exception 'MEDIA_RETIREMENT_REPLAY_CHANGED';end if;
  return e.result||jsonb_build_object('replayed',true,'queueStatus',q->>'status');
 end if;
 if o.status not in ('reserved','running') then raise exception 'MEDIA_RETIREMENT_OPERATION_STATE';end if;
 if (o.status='reserved' and (exists(select 1 from toptik_media_private.steps where operation_id=o.id and status<>'ready')
   or exists(select 1 from toptik_media_private.transport_chains where operation_id=o.id)))
 or (o.status='running' and (not exists(select 1 from toptik_media_private.steps where operation_id=o.id and step_index=0 and status='started')
   or not exists(select 1 from toptik_media_private.transport_chains where operation_id=o.id and step_index=0 and status='ready' and next_phase=0)))
 then raise exception 'MEDIA_RETIREMENT_LOGICAL_PROGRESS';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by step_index),'[]'::jsonb) into before_steps from toptik_media_private.steps x where operation_id=o.id;
 select coalesce(jsonb_agg(to_jsonb(x) order by step_index),'[]'::jsonb) into before_chains from toptik_media_private.transport_chains x where operation_id=o.id;
 -- Final lease check immediately before the only state transition.
 perform 1 from public.shopify_gallery_reconciliation_leases where product_gid=p_product_gid and owner=p_lease_owner and expires_at>clock_timestamp();
 if not found then raise exception 'MEDIA_RETIREMENT_LEASE_EXPIRED';end if;
 update toptik_media_private.operations set status='conflict',version=version+1,updated_at=clock_timestamp() where id=o.id;
 if not toptik_media_private.enqueue(p_product_gid,jsonb_build_object('restoredBeforeTransport',p_request_id,'retiredOperation',o.id,'reason','MEDIA_RESTORED_BEFORE_TRANSPORT'))
 then raise exception 'MEDIA_RETIREMENT_ENQUEUE_FAILED';end if;
 r:=jsonb_build_object('status','conflict','retiredBeforeTransport',true,'replayed',false,'mayExecute',false,'code','MEDIA_RESTORED_BEFORE_TRANSPORT',
  'operationId',o.id,'requestId',p_request_id,'operationVersion',o.version+1,'stateVersion',s.version,'queueStatus','pending');
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result)
 values(p_request_id,p_product_gid,o.id,'restored_before_transport',h,jsonb_build_object('reason','MEDIA_RESTORED_BEFORE_TRANSPORT','command',command,
  'before',jsonb_build_object('state',to_jsonb(s),'operation',to_jsonb(o),'queueFence',coalesce(q,'null'::jsonb),'steps',before_steps,'chains',before_chains),
  'fences',jsonb_build_object('stateVersion',p_expected_state_version,'operationVersion',p_expected_operation_version,'operationHash',p_expected_operation_hash,'queueFence',coalesce(p_queue_fence,'null'::jsonb)),
  'capture',jsonb_build_object('currentPair',p_current_pair,'galleryRaw',p_gallery_raw,'galleryRefs',p_gallery_refs,'observedAt',p_observed_at)),r);
 return r;
end $$;

revoke all on function public.read_toptik_media_retirement_context(text,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.retire_restored_toptik_media_operation(text,uuid,uuid,uuid,uuid,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,jsonb,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.read_toptik_media_retirement_context(text,uuid,uuid,uuid) to service_role;
grant execute on function public.retire_restored_toptik_media_operation(text,uuid,uuid,uuid,uuid,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,jsonb,timestamptz) to service_role;
commit;
