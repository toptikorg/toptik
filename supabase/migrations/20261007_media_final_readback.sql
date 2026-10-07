-- Complete an already verified transport with a freshly pinned full readback.
-- Shopify product.updatedAt includes unrelated copy/SEO changes. It is the only
-- raw field allowed to drift when all exact media and variant facts still match.
-- Real media drift becomes a durable conflict, not a permanently running retry.
begin;
create function public.accept_toptik_media_final_readback(
 p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,
 p_request_id uuid,p_observed jsonb,p_guard jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;
 c toptik_media_private.transport_chains%rowtype;e toptik_media_private.events%rowtype;
 h text;result jsonb;target text;source text;expected_refs jsonb;unchanged_media boolean;detached boolean;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 perform toptik_media_private.assert_pair(p_observed,i);
 if p_request_id is null then raise exception 'MEDIA_READBACK_INVALID';end if;
 h:=toptik_media_private.digest(jsonb_build_object('product',p_product_gid,'operation',p_operation_id,
  'step',p_step_index,'observed',p_observed,'guard',p_guard));
 select * into e from toptik_media_private.events where request_id=p_request_id;
 if found then
  if e.event_kind<>'transport_final_readback' or e.request_hash<>h then raise exception 'MEDIA_REQUEST_REUSED';end if;
  return e.result;
 end if;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if not found or o.status not in ('running','uncertain') or o.next_step<>p_step_index then raise exception 'MEDIA_OPERATION_STATE_CHANGED';end if;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 if not found or s.status not in ('started','uncertain') then raise exception 'MEDIA_STEP_NOT_STARTED';end if;
 select * into c from toptik_media_private.transport_chains where operation_id=o.id and step_index=p_step_index for update;
 if not found or c.status<>'verified' then raise exception 'MEDIA_TRANSPORT_NOT_VERIFIED';end if;
 target:=s.body->>'target';source:=s.body->>'source';
 -- Frozen reorder steps contain target/keys, with the opposite side serving
 -- as their source observation. Other steps must retain their explicit source.
 if s.body->>'kind'='reorder' and source is null then
  source:=case target when 'shopify' then 'gallery' when 'gallery' then 'shopify' end;
 end if;
 if target is null or source is null or target not in ('gallery','shopify') or source not in ('gallery','shopify') or source=target then raise exception 'MEDIA_STEP_INVALID';end if;
 perform toptik_media_private.assert_transport_guard(p_guard,i,target);
 if p_guard->>'sourceFingerprint' is distinct from toptik_media_private.fingerprint(p_observed->source) then
  raise exception 'MEDIA_FINAL_SOURCE_CHANGED_DURING_READ';
 end if;
 if target='shopify' then
  if exists(select 1 from jsonb_array_elements(p_guard#>'{target,media}') m
    where m->>'status' is distinct from 'READY' or m->>'fileStatus' is distinct from 'READY') then
   raise exception 'MEDIA_FINAL_TARGET_NOT_READY';
  end if;
  if p_observed#>>'{shopify,revision}' is distinct from toptik_media_private.ready_transport_fingerprint(p_guard->'target') then
   raise exception 'MEDIA_FINAL_TARGET_CHANGED_DURING_READ';
  end if;
  -- A READY snapshot must map every current asset to the exact current media ID
  -- in the same order. No historical filename/alt or sibling variant is proof.
  select jsonb_agg(p.proof->>'platformRef' order by n) into expected_refs
   from jsonb_array_elements(p_observed#>'{shopify,assets}') with ordinality x(a,n)
   join toptik_media_private.provenance p on p.evidence_id=a->>'evidenceId' and p.product_gid=p_product_gid and p.side='shopify';
  if expected_refs is distinct from (select jsonb_agg(m->>'mediaId' order by n)
    from jsonb_array_elements(p_guard#>'{target,media}') with ordinality x(m,n)) then
   raise exception 'MEDIA_FINAL_REFERENCE_MISMATCH';
  end if;
  unchanged_media:=((c.current_guard->'target')-'updatedAt'-'revision')=((p_guard->'target')-'updatedAt'-'revision');
 else
  if p_observed->'gallery' is distinct from p_guard->'target' then raise exception 'MEDIA_FINAL_TARGET_CHANGED_DURING_READ';end if;
  unchanged_media:=c.current_guard->'target'=p_guard->'target';
 end if;
 if unchanged_media then
  -- Existing internal logical acceptance still checks both complete semantic
  -- collections and the exact unchanged source. No baseline or media writes.
  result:=toptik_media_private.accept_toptik_media_readback(p_product_gid,p_lease_owner,p_operation_id,p_step_index,gen_random_uuid(),p_observed);
 else
  -- The transport already finished. Preserve its history and record current
  -- concurrent changes so the next authorized event can safely replan them.
  -- A detach receipt acknowledges ONLY this previously verified removal, and
  -- only when its exact key is still absent on BOTH current sides.
  detached:=s.body->>'kind'='detach_reference'
   and toptik_media_private.asset(p_observed->'gallery',s.body->>'key') is null
   and toptik_media_private.asset(p_observed->'shopify',s.body->>'key') is null;
  update toptik_media_private.steps set status='conflict',readback_pair=p_observed,detach_verified=detached,
   verified_at=null where operation_id=o.id and step_index=p_step_index;
  update toptik_media_private.operations set status='conflict',observed_pair=p_observed,version=version+1,
   updated_at=clock_timestamp() where id=o.id;
  result:=jsonb_build_object('status','conflict','mayExecute',false,'code','MEDIA_FINAL_READBACK_CONCURRENT_CHANGE',
   'nextStep',p_step_index,'detachAcknowledged',detached);
 end if;
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result)
 values(p_request_id,p_product_gid,o.id,'transport_final_readback',h,jsonb_build_object('stepIndex',p_step_index,
  'historicGuard',c.current_guard,'freshGuard',p_guard,'observed',p_observed,
  'unchangedMedia',unchanged_media,'productTimestampChanged',(target='shopify' and
    (c.current_guard#>>'{target,updatedAt}' is distinct from p_guard#>>'{target,updatedAt}'))),result);
 return result;
end $$;
revoke all on function public.accept_toptik_media_final_readback(text,uuid,uuid,int,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.accept_toptik_media_final_readback(text,uuid,uuid,int,uuid,jsonb,jsonb) to service_role;
commit;
