-- Preserve the service-only discovery boundary, returning the immutable parent
-- chain needed by the existing exact-image review guard. No reviews are granted.
begin;
create temporary table _media_discovery_contract_before on commit drop as
 select oid,proowner,proacl,prosecdef,proconfig,proargtypes,prorettype
 from pg_proc where oid='public.read_toptik_media_operation(uuid,integer,integer)'::regprocedure;

do $patch$
declare body text;old_block text:=$old$ select coalesce(jsonb_agg(to_jsonb(v) order by v.evidence_id),'[]'::jsonb) into proofs from toptik_media_private.provenance v
 where v.product_gid=o.product_gid and v.evidence_id in (
  select asset->>'evidenceId' from jsonb_each(o.observed_pair) side cross join lateral jsonb_array_elements(side.value->'assets') asset
  union select asset->>'evidenceId' from jsonb_each(coalesce(s.expected_pair,'{}'::jsonb)) side cross join lateral jsonb_array_elements(side.value->'assets') asset
  union select a.request->>'sourceEvidenceId' from toptik_media_private.transport_attempts a where a.operation_id=o.id and a.step_index=p_step_index);$old$;
new_block text:=$new$ -- MEDIA_DISCOVERY_REVIEW_LINEAGE_V1: at most eight nodes, including each directly referenced root.
 with recursive direct_ids(evidence_id) as (
  select asset->>'evidenceId' from jsonb_each(o.observed_pair) side cross join lateral jsonb_array_elements(side.value->'assets') asset
  union select asset->>'evidenceId' from jsonb_each(coalesce(s.expected_pair,'{}'::jsonb)) side cross join lateral jsonb_array_elements(side.value->'assets') asset
  union select a.request->>'sourceEvidenceId' from toptik_media_private.transport_attempts a where a.operation_id=o.id and a.step_index=p_step_index
 ), lineage(evidence_id,asset_key,content_id,proof,depth,visited) as (
  select v.evidence_id,v.asset_key,v.content_id,v.proof,0,array[v.evidence_id]::text[]
  from toptik_media_private.provenance v join direct_ids d on d.evidence_id=v.evidence_id
  where v.product_gid=o.product_gid
  union all
  select parent.evidence_id,parent.asset_key,parent.content_id,parent.proof,child.depth+1,child.visited||parent.evidence_id
  from lineage child join toptik_media_private.provenance parent
   on parent.evidence_id=child.proof->>'sourceEvidenceId' and parent.product_gid=o.product_gid
    and parent.asset_key=child.asset_key and parent.content_id=child.content_id
  where child.depth<7 and jsonb_typeof(child.proof->'operationId')='string'
   and jsonb_typeof(child.proof->'sourceEvidenceId')='string'
   and not(parent.evidence_id=any(child.visited))
 )
 select coalesce(jsonb_agg(to_jsonb(v) order by v.evidence_id),'[]'::jsonb) into proofs
 from toptik_media_private.provenance v where v.product_gid=o.product_gid
  and v.evidence_id in(select evidence_id from lineage);$new$;
begin
 body:=replace(pg_get_functiondef('public.read_toptik_media_operation(uuid,integer,integer)'::regprocedure),E'\r','');
 -- Fresh read-only production definition: raw MD5 87387298fe41b86d044eb216f775f57c.
 -- Normalize only CR here so a clean LF checkout has the same exact predecessor contract.
 if md5(body)='3a3540b19374affdb5d68bbd29aa44b0' then return;end if;
 if md5(body)<>'117b992c3fb04f6d62494ee695cb2af2'
  or (length(body)-length(replace(body,old_block,'')))/length(old_block)<>1
  or strpos(body,'MEDIA_DISCOVERY_REVIEW_LINEAGE_V1')>0 then
  raise exception 'MEDIA_DISCOVERY_PREDECESSOR_CHANGED';
 end if;
 execute replace(body,old_block,new_block);
 if md5(replace(pg_get_functiondef('public.read_toptik_media_operation(uuid,integer,integer)'::regprocedure),E'\r',''))<>'3a3540b19374affdb5d68bbd29aa44b0' then
  raise exception 'MEDIA_DISCOVERY_PATCH_READBACK_CHANGED';
 end if;
end$patch$;

do $contract$
begin
 if exists(select 1 from _media_discovery_contract_before b join pg_proc p on p.oid=b.oid
  where p.proowner is distinct from b.proowner or p.proacl is distinct from b.proacl
   or p.prosecdef is distinct from b.prosecdef or p.proconfig is distinct from b.proconfig
   or p.proargtypes is distinct from b.proargtypes or p.prorettype is distinct from b.prorettype) then
  raise exception 'MEDIA_DISCOVERY_CONTRACT_CHANGED';
 end if;
end$contract$;
commit;
