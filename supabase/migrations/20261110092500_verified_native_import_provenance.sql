-- Import native Shopify references from exact verified create + associate receipts.
-- No media writes, baseline/status changes, RPC additions, or privilege changes.
begin;
create temporary table _native_import_before on commit drop as
select p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig,p.prorettype,p.proargtypes,p.prolang
from pg_proc p where p.oid=to_regprocedure('toptik_media_private.register(text,jsonb)');
do $$ begin
 if (select count(*) from _native_import_before)<>1 then raise exception 'MEDIA_NATIVE_IMPORT_FUNCTION_MISSING';end if;
 if exists(select 1 from _native_import_before e join pg_proc p on p.oid=e.oid
  where md5(replace(p.prosrc,E'\r\n',E'\n')) not in ('88065e782b5d07c3e247e6265a790317','ccacd59022ecfdbe90bc9509aea832b4')
   or p.prosecdef or p.prorettype<>'void'::regtype or p.prokind<>'f'
   or p.prolang<>(select oid from pg_language where lanname='plpgsql')
   or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or has_function_privilege('service_role',p.oid,'EXECUTE')
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee<>p.proowner))
 then raise exception 'MEDIA_NATIVE_IMPORT_DEFINITION_OR_ACL_DRIFT';end if;
end $$;
create or replace function toptik_media_private.register(p_product text,p_proofs jsonb) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare x jsonb;proof jsonb;old toptik_media_private.provenance%rowtype;parent toptik_media_private.provenance%rowtype;op toptik_media_private.operations%rowtype;matches int;
begin
 if jsonb_typeof(p_proofs) is distinct from 'array' or jsonb_array_length(p_proofs)>500 or octet_length(p_proofs::text)>2000000 then raise exception 'MEDIA_PROVENANCE_INVALID';end if;
 for x in select value from jsonb_array_elements(p_proofs) loop
  proof:=x->'proof';
  if jsonb_typeof(x) is distinct from 'object' or not(x ?& array['evidenceId','key','side','contentId','proof']) or (select count(*) from jsonb_object_keys(x))<>5
  or jsonb_typeof(x->'evidenceId') is distinct from 'string' or jsonb_typeof(x->'key') is distinct from 'string' or jsonb_typeof(x->'contentId') is distinct from 'string'
  or coalesce(x->>'evidenceId','') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' or coalesce(x->>'key','') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
  or coalesce(x->>'side','') not in ('gallery','shopify') or coalesce(x->>'contentId','') !~ '^[a-f0-9]{64}$'
  or jsonb_typeof(proof) is distinct from 'object' or not(proof ?& array['platformRef','url','decodedSha256','mime','width','height','byteLength','verifiedAt','ownership'])
  or exists(select 1 from jsonb_object_keys(proof) k where k not in ('platformRef','url','decodedSha256','mime','width','height','byteLength','verifiedAt','ownership','sourceEvidenceId','operationId'))
  or jsonb_typeof(proof->'platformRef') is distinct from 'string' or jsonb_typeof(proof->'url') is distinct from 'string'
  or jsonb_typeof(proof->'decodedSha256') is distinct from 'string' or jsonb_typeof(proof->'verifiedAt') is distinct from 'string'
  or jsonb_typeof(proof->'width') is distinct from 'number' or jsonb_typeof(proof->'height') is distinct from 'number' or jsonb_typeof(proof->'byteLength') is distinct from 'number'
  or coalesce(proof->>'ownership','') not in ('owned_storage','reference_only')
  or coalesce(proof->>'decodedSha256','') !~ '^[a-f0-9]{64}$' or coalesce(proof->>'mime','') not in ('image/jpeg','image/png','image/webp','image/avif','image/gif')
  or coalesce(proof->>'width','') !~ '^[1-9][0-9]{0,4}$' or coalesce(proof->>'height','') !~ '^[1-9][0-9]{0,4}$'
  or (proof->>'width')::numeric*(proof->>'height')::numeric>25000000 or coalesce(proof->>'byteLength','') !~ '^[1-9][0-9]{0,7}$'
  or (proof->>'byteLength')::numeric>8388608 or length(coalesce(proof->>'platformRef','')) not between 1 and 512
  or (proof->>'url')~'[[:space:]\\#]' or length(coalesce(proof->>'url',''))>4096 then raise exception 'MEDIA_PROVENANCE_INVALID';end if;
  if x->>'side'='shopify' and (proof->>'ownership'<>'reference_only' or coalesce(proof->>'platformRef','') !~ '^gid://shopify/MediaImage/[1-9][0-9]*$'
   or coalesce(proof->>'url','') !~ '^https://cdn[.]shopify[.]com/s/files/') then raise exception 'MEDIA_PROVENANCE_INVALID';end if;
  if x->>'side'='gallery' and not(
   (proof->>'ownership'='owned_storage' and coalesce(proof->>'url','') ~ '^https://ekgpaoavsavrtbhlbwdg[.]supabase[.]co/storage/v1/object/public/carousel-media/')
   or (proof->>'ownership'='reference_only' and coalesce(proof->>'url','') ~ '^https://cdn[.]shopify[.]com/s/files/')) then raise exception 'MEDIA_PROVENANCE_INVALID';end if;
  select * into old from toptik_media_private.provenance where evidence_id=x->>'evidenceId';
  if found then
   if old.product_gid<>p_product or old.asset_key<>x->>'key' or old.side<>x->>'side' or old.content_id<>x->>'contentId' or old.proof<>proof then raise exception 'MEDIA_EVIDENCE_REUSED';end if;
   continue;
  end if;
  if not isfinite((proof->>'verifiedAt')::timestamptz) or (proof->>'verifiedAt')::timestamptz not between clock_timestamp()-interval '5 minutes' and clock_timestamp()+interval '10 seconds' then raise exception 'MEDIA_EVIDENCE_EXPIRED';end if;
  if x->>'contentId'<>proof->>'decodedSha256' or proof?'sourceEvidenceId' or proof?'operationId' then
   -- Link fields are a pair even when Shopify preserved the exact source bytes.
   if not(proof ?& array['sourceEvidenceId','operationId'])
    or jsonb_typeof(proof->'sourceEvidenceId') is distinct from 'string'
    or coalesce(proof->>'sourceEvidenceId','') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
    or jsonb_typeof(proof->'operationId') is distinct from 'string'
    or coalesce(proof->>'operationId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    then raise exception 'MEDIA_IMPORT_LINEAGE_REQUIRED';end if;
   select * into parent from toptik_media_private.provenance where evidence_id=x#>>'{proof,sourceEvidenceId}' and product_gid=p_product and asset_key=x->>'key' and content_id=x->>'contentId';
   if not found then raise exception 'MEDIA_IMPORT_LINEAGE_REQUIRED';end if;
   select * into op from toptik_media_private.operations where id=(proof->>'operationId')::uuid and product_gid=p_product and status in ('running','uncertain');
   if not found then raise exception 'MEDIA_IMPORT_LINEAGE_REQUIRED';end if;
   if x->>'side'='shopify' then
    -- A native receipt conveys reference lineage only. It never owns the Shopify file.
    -- Count full matching tuples, and also refuse duplicate phases, rather than picking a receipt.
    select count(*) into matches
    from toptik_media_private.steps st
    join toptik_media_private.transport_chains tc on tc.operation_id=st.operation_id and tc.step_index=st.step_index
    join toptik_media_private.transport_attempts tr on tr.operation_id=st.operation_id and tr.step_index=st.step_index and tr.phase='create_owned'
    join toptik_media_private.transport_artifacts ta on ta.operation_id=tr.operation_id and ta.step_index=tr.step_index and ta.phase_index=tr.phase_index
    join toptik_media_private.transport_attempts ar on ar.operation_id=st.operation_id and ar.step_index=st.step_index and ar.phase='associate'
    where st.operation_id=op.id and st.step_index=op.next_step and st.status in ('started','uncertain')
     and st.body->>'key'=x->>'key' and st.body->>'target'='shopify' and st.body->>'source'='gallery'
     and st.body->>'kind' in ('attach','replace_reference','alt')
     and (select count(*) from jsonb_array_elements(st.expected_pair#>'{shopify,assets}') a where a->>'key'=x->>'key')=1
     and toptik_media_private.asset(st.expected_pair->'shopify',x->>'key')->>'contentId'=x->>'contentId'
     and toptik_media_private.asset(st.expected_pair->'shopify',x->>'key')->>'evidenceId'=parent.evidence_id
     -- ALT cloning retains the old Shopify evidence; it must still be an exact
     -- member of that native observation. Other imports use the gallery source.
     and (parent.side='gallery' or (st.body->>'kind'='alt' and parent.side='shopify'))
     and op.observed_pair->parent.side->'identity'=(select identity from toptik_media_private.products where product_gid=p_product)
     and (select count(*) from jsonb_array_elements(op.observed_pair->parent.side->'assets') a where a->>'key'=x->>'key')=1
     and toptik_media_private.asset(op.observed_pair->parent.side,x->>'key')->>'evidenceId'=parent.evidence_id
     and toptik_media_private.asset(op.observed_pair->parent.side,x->>'key')->>'contentId'=x->>'contentId'
     -- Only same-image ALT preservation can inherit the pinned baseline authority.
     -- A concurrent baseline revision or a different baseline member invalidates it.
     and (st.body->>'kind'<>'alt' or exists(select 1 from toptik_media_private.state bs
      where bs.product_gid=p_product and bs.version=op.state_version
       and bs.baselines->parent.side->>'side'=parent.side
       and bs.baselines->parent.side->'identity'=(select identity from toptik_media_private.products where product_gid=p_product)
       and (select count(*) from jsonb_array_elements(bs.baselines->parent.side->'assets') a where a->>'key'=x->>'key')=1
       and toptik_media_private.asset(bs.baselines->parent.side,x->>'key')->>'evidenceId'=parent.evidence_id
       and toptik_media_private.asset(bs.baselines->parent.side,x->>'key')->>'contentId'=x->>'contentId'))
     and tc.status in ('running','uncertain','verified') and tc.next_phase>ar.phase_index
     and tc.phases->>tr.phase_index='create_owned' and tc.phases->>ar.phase_index='associate' and ar.phase_index=tr.phase_index+1
     and (select count(*) from toptik_media_private.transport_attempts d where d.operation_id=st.operation_id and d.step_index=st.step_index and d.phase='create_owned')=1
     and (select count(*) from toptik_media_private.transport_attempts d where d.operation_id=st.operation_id and d.step_index=st.step_index and d.phase='associate')=1
     and tr.status='verified' and tr.request->>'sourceEvidenceId'=parent.evidence_id
     and tr.receipt->'artifact'=ta.artifact and tr.receipt->>'requestHash'=tr.request_hash
     and ta.artifact->'ready'='true'::jsonb and ta.artifact->>'contentId'=x->>'contentId'
     and ta.artifact->>'mediaGid'=proof->>'platformRef' and ta.artifact->>'decodedSha256'=proof->>'decodedSha256'
     and ta.artifact->>'url'=proof->>'url' and ta.artifact->>'mime'=proof->>'mime'
     and ta.artifact->'width'=proof->'width' and ta.artifact->'height'=proof->'height' and ta.artifact->'byteLength'=proof->'byteLength'
     and ar.status='verified' and ar.request->>'mediaGid'=proof->>'platformRef' and ar.request->>'productGid'=p_product
     and ar.receipt->>'requestHash'=ar.request_hash and ar.receipt->'artifact'='null'::jsonb
     and ar.receipt->>'readbackSha256'=ar.after_guard#>>'{target,revision}'
     and ar.after_guard#>>'{target,identity,productId}'=p_product
     and (select count(*) from jsonb_array_elements(ar.after_guard#>'{target,media}') m where m->>'mediaId'=proof->>'platformRef')=1
     and (select count(*) from jsonb_array_elements(ar.after_guard#>'{target,media}') m
      where m->>'mediaId'=proof->>'platformRef' and m->>'status'='READY' and m->>'fileStatus'='READY'
       and m#>>'{image,url}'=proof->>'url' and m#>'{image,width}'=proof->'width' and m#>'{image,height}'=proof->'height')=1;
    if matches<>1 then raise exception 'MEDIA_IMPORT_LINEAGE_REQUIRED';end if;
   else
    -- Preserve the established transformed gallery_upload contract.
    if x->>'contentId'=proof->>'decodedSha256' then raise exception 'MEDIA_REDUNDANT_LINEAGE_INVALID';end if;
    if not exists(select 1 from toptik_media_private.transport_artifacts ta
     join toptik_media_private.transport_attempts tr on tr.operation_id=ta.operation_id and tr.step_index=ta.step_index and tr.phase_index=ta.phase_index
     join toptik_media_private.steps st on st.operation_id=ta.operation_id and st.step_index=ta.step_index
     where ta.operation_id=op.id and st.body->>'key'=x->>'key' and st.body->>'target'=x->>'side'
      and tr.status='verified' and tr.phase='gallery_upload' and tr.request->>'sourceEvidenceId'=parent.evidence_id
      and ta.artifact->>'contentId'=x->>'contentId' and ta.artifact->>'decodedSha256'=proof->>'decodedSha256'
      and ta.artifact->>'url'=proof->>'url' and ta.artifact->>'mime'=proof->>'mime'
      and ta.artifact->'width'=proof->'width' and ta.artifact->'height'=proof->'height' and ta.artifact->'byteLength'=proof->'byteLength'
      and ta.artifact->>'storagePath'=proof->>'platformRef')
     then raise exception 'MEDIA_IMPORT_LINEAGE_REQUIRED';end if;
   end if;
  end if;
  insert into toptik_media_private.asset_identities(product_gid,asset_key,origin_evidence_id) values(p_product,x->>'key',x->>'evidenceId') on conflict do nothing;
  insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof)
   values(x->>'evidenceId',p_product,x->>'key',x->>'side',x->>'contentId',proof);
 end loop;
end $$;
-- CREATE OR REPLACE must preserve the owner-only private boundary exactly.
do $$ begin
 if exists(select 1 from _native_import_before e left join pg_proc p on p.oid=e.oid
  where p.oid is null or md5(replace(p.prosrc,E'\r\n',E'\n'))<>'ccacd59022ecfdbe90bc9509aea832b4'
   or p.proowner<>e.proowner or p.proacl is distinct from e.proacl or p.prosecdef<>e.prosecdef
   or p.proconfig is distinct from e.proconfig or p.prorettype<>e.prorettype
   or p.proargtypes<>e.proargtypes or p.prolang<>e.prolang)
 then raise exception 'MEDIA_NATIVE_IMPORT_POSTCONDITION_FAILED';end if;
end $$;
commit;
