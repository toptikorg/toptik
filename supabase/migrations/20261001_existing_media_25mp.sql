-- Existing media: accept original, verified images through 25MP inclusive.
-- No data updates; existing signatures, owners, ACLs, security and search paths stay intact.
-- Creation/admission keep the separate 16MP policy. Do not re-run prior schema bundles.
begin;
-- Preflight accepts only the exact reviewed old/new bodies and established ACLs.
create temporary table _media25_before on commit drop as
select p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig,p.prorettype,p.proargtypes,p.prolang,
 e.old_hash,e.new_hash,e.expected_definer,e.expected_return
from (values
('toptik_media_private.assert_transport_guard(jsonb,jsonb,text)','579d4beb42d7d03c4d1c5de04deec200','d60cfd04ae1d610da589b6d115daaa99',false,'void'),
('public.accept_toptik_media_transport(text,uuid,uuid,integer,integer,uuid,jsonb,jsonb)','016c85e0527c1bdf5055b34f25afcf25','6b4fa79824819955fa9d8cb5e75bc7d5',true,'jsonb'),
('toptik_media_private.register(text,jsonb)','cf5212f16920d02fc760df0ac6365e77','88065e782b5d07c3e247e6265a790317',false,'void')
) e(signature,old_hash,new_hash,expected_definer,expected_return)
join pg_proc p on p.oid=to_regprocedure(e.signature);
do $$ begin
 if (select count(*) from _media25_before)<>3 then raise exception 'MEDIA25_FUNCTION_SET_MISMATCH';end if;
 if exists(select 1 from _media25_before e join pg_proc p on p.oid=e.oid
   where md5(replace(p.prosrc,E'\r\n',E'\n')) not in(e.old_hash,e.new_hash)
   or p.prosecdef is distinct from e.expected_definer or p.prorettype<>to_regtype(e.expected_return)
   or p.prokind<>'f' or p.prolang<>(select oid from pg_language where lanname='plpgsql')
   or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
   or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
   or has_function_privilege('service_role',p.oid,'EXECUTE') is distinct from e.expected_definer
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     where a.grantee<>p.proowner and (not e.expected_definer or a.grantee<>'service_role'::regrole::oid or a.privilege_type<>'EXECUTE' or a.is_grantable)))
 then raise exception 'MEDIA25_FUNCTION_DEFINITION_OR_ACL_DRIFT';end if;
end $$;
create or replace function toptik_media_private.assert_transport_guard(g jsonb,i jsonb,target text) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare raw jsonb;m jsonb;im jsonb;v jsonb;
begin
 if jsonb_typeof(g) is distinct from 'object' or not(g ?& array['sourceFingerprint','target','observedAt']) or (select count(*) from jsonb_object_keys(g))<>3
 or coalesce(g->>'sourceFingerprint','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(g->'observedAt') is distinct from 'string'
 or not isfinite((g->>'observedAt')::timestamptz) or (g->>'observedAt')::timestamptz not between clock_timestamp()-interval '5 minutes' and clock_timestamp()+interval '10 seconds'
 or octet_length(g::text)>2500000 then raise exception 'MEDIA_TRANSPORT_GUARD_INVALID';end if;
 raw:=g->'target';
 if target='gallery' then perform toptik_media_private.assert_snapshot(raw,'gallery',i,false);return;end if;
 if target<>'shopify' or raw->>'side' is distinct from 'shopify' or raw->'identity' is distinct from i or raw->'complete' is distinct from 'true'::jsonb
 or coalesce(raw->>'revision','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(raw->'updatedAt') is distinct from 'string'
 or coalesce(raw->>'updatedAt','') !~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' or not isfinite((raw->>'updatedAt')::timestamptz)
 or jsonb_typeof(raw->'media') is distinct from 'array' or jsonb_array_length(raw->'media')>250
 or jsonb_typeof(raw->'variantMediaIds') is distinct from 'array' or not(raw?'variantImage')
 or jsonb_array_length(raw->'media')<>(select count(distinct a->>'mediaId') from jsonb_array_elements(raw->'media') a)
 or jsonb_array_length(raw->'variantMediaIds')<>(select count(distinct a) from jsonb_array_elements(raw->'variantMediaIds') a)
 then raise exception 'MEDIA_TRANSPORT_RAW_INCOMPLETE';end if;
 for m in select value from jsonb_array_elements(raw->'media') loop
  if coalesce(m->>'mediaId','') !~ '^gid://shopify/MediaImage/[1-9][0-9]*$' or m->>'mediaContentType' is distinct from 'IMAGE'
   or coalesce(m->>'status','') not in ('UPLOADED','PROCESSING','READY','FAILED') or coalesce(m->>'fileStatus','') not in ('UPLOADED','PROCESSING','READY','FAILED')
   or not(m ?& array['image','alt','updatedAt']) or jsonb_typeof(m->'image') not in ('null','object') or jsonb_typeof(m->'alt') not in ('null','string') or length(m->>'alt')>512
   or coalesce(m->>'updatedAt','') !~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' or not isfinite((m->>'updatedAt')::timestamptz) then raise exception 'MEDIA_TRANSPORT_RAW_INVALID';end if;
  im:=m->'image';
  if im='null'::jsonb then
   if m->>'status'='READY' and m->>'fileStatus'='READY' then raise exception 'MEDIA_TRANSPORT_RAW_INVALID';end if;
  elsif not(im ?& array['id','url','width','height']) or coalesce(im->>'id','') !~ '^gid://shopify/(ImageSource|ProductImage)/[1-9][0-9]*$'
   or coalesce(im->>'url','') !~ '^https://cdn[.]shopify[.]com/s/files/' or im->>'url'~'[[:space:]\\#]' or im->>'url'~* '%(2f|5c|2e)'
   or jsonb_typeof(im->'width') is distinct from 'number' or jsonb_typeof(im->'height') is distinct from 'number'
   or coalesce(im->>'width','') !~ '^[1-9][0-9]{0,4}$' or coalesce(im->>'height','') !~ '^[1-9][0-9]{0,4}$'
   or (im->>'width')::numeric>16000 or (im->>'height')::numeric>16000 or (im->>'width')::numeric*(im->>'height')::numeric>25000000 then raise exception 'MEDIA_TRANSPORT_RAW_INVALID';end if;
 end loop;
 for v in select value from jsonb_array_elements(raw->'variantMediaIds') loop
  if jsonb_typeof(v) is distinct from 'string' or v#>>'{}' !~ '^gid://shopify/MediaImage/[1-9][0-9]*$' then raise exception 'MEDIA_TRANSPORT_VARIANT_MISSING';end if;
 end loop;
 if exists(select 1 from jsonb_array_elements_text(raw->'variantMediaIds') variant_id where not exists(select 1 from jsonb_array_elements(raw->'media') entry where entry->>'mediaId'=variant_id)) then raise exception 'MEDIA_TRANSPORT_VARIANT_MISSING';end if;
 im:=raw->'variantImage';
 if im is distinct from 'null'::jsonb and (jsonb_typeof(im) is distinct from 'object' or not(im ?& array['id','url'])
  or coalesce(im->>'id','') !~ '^gid://shopify/(ImageSource|ProductImage)/[1-9][0-9]*$'
  or coalesce(im->>'url','') !~ '^https://cdn[.]shopify[.]com/s/files/' or im->>'url'~'[[:space:]\\#]' or im->>'url'~* '%(2f|5c|2e)'
  or not exists(select 1 from jsonb_array_elements(raw->'media') x where (raw->'variantMediaIds')?(x->>'mediaId') and x#>>'{image,url}'=im->>'url')) then raise exception 'MEDIA_TRANSPORT_VARIANT_MISSING';end if;
 if raw->>'revision' is distinct from toptik_media_private.raw_transport_fingerprint(raw) then raise exception 'MEDIA_TRANSPORT_RAW_REVISION_INVALID';end if;
 -- The strict TS reader verifies actual GraphQL connection completeness before
 -- service submission. SQL independently validates its stored shape and digest.
end $$;

create or replace function public.accept_toptik_media_transport(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_phase_index int,p_request_id uuid,p_guard jsonb,p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;c toptik_media_private.transport_chains%rowtype;a toptik_media_private.transport_attempts%rowtype;
 e toptik_media_private.events%rowtype;h text;r jsonb;artifact jsonb;prior_artifact jsonb;before_raw jsonb;after_raw jsonb;expected_asset jsonb;source_proof jsonb;
 valid bool:=true;expected_media jsonb;new_media jsonb;old_media text;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 select * into c from toptik_media_private.transport_chains where operation_id=o.id and step_index=p_step_index for update;
 if o.id is null or c.operation_id is null or p_request_id is null then raise exception 'MEDIA_TRANSPORT_MISSING';end if;
 perform toptik_media_private.assert_transport_guard(p_guard,i,s.body->>'target');
 h:=toptik_media_private.digest(jsonb_build_object('operation',o.id,'step',p_step_index,'phase',p_phase_index,'guard',p_guard,'receipt',p_receipt));
 select * into e from toptik_media_private.events where request_id=p_request_id;
 if found then if e.event_kind<>'transport_readback' or e.request_hash<>h then raise exception 'MEDIA_REQUEST_REUSED';end if;return e.result;end if;
 select * into a from toptik_media_private.transport_attempts where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index for update;
 if not found or a.status not in ('started','uncertain') or o.status not in ('running','uncertain') or c.next_phase<>p_phase_index then raise exception 'MEDIA_TRANSPORT_NOT_STARTED';end if;
 if jsonb_typeof(p_receipt) is distinct from 'object' or not(p_receipt ?& array['requestHash','readbackSha256','artifact']) or (select count(*) from jsonb_object_keys(p_receipt))<>3
  or p_receipt->>'requestHash' is distinct from a.request_hash
  or p_receipt->>'readbackSha256' is distinct from (case s.body->>'target' when 'shopify' then p_guard#>>'{target,revision}' else toptik_media_private.fingerprint(p_guard->'target') end) then raise exception 'MEDIA_TRANSPORT_READBACK_INVALID';end if;
 artifact:=p_receipt->'artifact';before_raw:=a.before_guard->'target';after_raw:=p_guard->'target';
 expected_asset:=toptik_media_private.asset(s.expected_pair->(s.body->>'target'),s.body->>'key');
 select ta.artifact into prior_artifact from toptik_media_private.transport_artifacts ta where ta.operation_id=o.id and ta.step_index=p_step_index and ta.phase_index<p_phase_index and ta.artifact?'mediaGid' order by ta.phase_index limit 1;
 select p.proof into source_proof from toptik_media_private.provenance p where p.evidence_id=a.request->>'sourceEvidenceId';
 select p.proof->>'platformRef' into old_media from toptik_media_private.provenance p where p.evidence_id=toptik_media_private.asset(o.observed_pair->(s.body->>'target'),s.body->>'key')->>'evidenceId';
 if p_guard->>'sourceFingerprint' is distinct from a.before_guard->>'sourceFingerprint' then valid:=false;end if;
 if a.phase in ('create_owned','gallery_upload','stage_source') then
  if jsonb_typeof(artifact) is distinct from 'object' or not(artifact ?& array['contentId','decodedSha256','ready','url','width','height','byteLength','mime'])
   or artifact->>'contentId' is distinct from expected_asset->>'contentId' or coalesce(artifact->>'decodedSha256','') !~ '^[a-f0-9]{64}$'
   or artifact->'ready' is distinct from 'true'::jsonb or coalesce(artifact->>'mime','') not in ('image/png','image/jpeg','image/webp','image/avif')
   or coalesce(artifact->>'width','') !~ '^[1-9][0-9]{0,4}$' or coalesce(artifact->>'height','') !~ '^[1-9][0-9]{0,4}$'
   or (artifact->>'width')::numeric*(artifact->>'height')::numeric>25000000 or coalesce(artifact->>'byteLength','') !~ '^[1-9][0-9]{0,7}$' or (artifact->>'byteLength')::numeric>8388608 then raise exception 'MEDIA_TRANSPORT_ARTIFACT_INVALID';end if;
  if a.phase='create_owned' then
   if coalesce(artifact->>'mediaGid','') !~ '^gid://shopify/MediaImage/[1-9][0-9]*$' or artifact->>'filename' is distinct from a.request->>'filename'
    or coalesce(artifact->>'url','') !~ '^https://cdn[.]shopify[.]com/s/files/' or artifact->>'url'~'[[:space:]\\#]'
    or exists(select 1 from jsonb_object_keys(artifact) k where k not in ('contentId','decodedSha256','ready','url','width','height','byteLength','mime','mediaGid','filename')) then raise exception 'MEDIA_TRANSPORT_ARTIFACT_INVALID';end if;
  else
   if artifact->>'storagePath' is distinct from a.request->>'storagePath' or artifact->>'decodedSha256' is distinct from source_proof->>'decodedSha256'
    or artifact->>'url' is distinct from 'https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/'||(artifact->>'storagePath')
    or exists(select 1 from jsonb_object_keys(artifact) k where k not in ('contentId','decodedSha256','ready','url','width','height','byteLength','mime','storagePath')) then raise exception 'MEDIA_TRANSPORT_ARTIFACT_INVALID';end if;
  end if;
  if after_raw<>before_raw then valid:=false;end if;
 elsif artifact is distinct from 'null'::jsonb then raise exception 'MEDIA_TRANSPORT_UNEXPECTED_ARTIFACT';
 elsif a.phase='gallery_cas' then
  if toptik_media_private.semantic(after_raw)<>toptik_media_private.semantic(s.expected_pair->'gallery') then valid:=false;end if;
 elsif a.phase='associate' then
  select m into new_media from jsonb_array_elements(after_raw->'media') m where m->>'mediaId'=a.request->>'mediaGid';
  if new_media is null or new_media->>'status' is distinct from 'READY' or new_media->>'fileStatus' is distinct from 'READY'
   or new_media->>'alt' is distinct from expected_asset->>'alt' or new_media#>>'{image,url}' is distinct from prior_artifact->>'url'
   or new_media#>'{image,width}' is distinct from prior_artifact->'width' or new_media#>'{image,height}' is distinct from prior_artifact->'height' then valid:=false;end if;
  expected_media:=(before_raw->'media')||jsonb_build_array(new_media);
  if after_raw->'media' is distinct from expected_media or after_raw->'variantMediaIds'<>before_raw->'variantMediaIds' or after_raw->'variantImage'<>before_raw->'variantImage' then valid:=false;end if;
 elsif a.phase='variant_reassign' then
  if after_raw->'media'<>before_raw->'media' or after_raw->'variantMediaIds' is distinct from jsonb_build_array(a.request->>'mediaGid')
   or after_raw#>>'{variantImage,url}' is distinct from prior_artifact->>'url' then valid:=false;end if;
 elsif a.phase='detach_old' then
  select coalesce(jsonb_agg(m order by n),'[]'::jsonb) into expected_media from jsonb_array_elements(before_raw->'media') with ordinality x(m,n) where m->>'mediaId'<>a.request->>'mediaGid';
  if jsonb_array_length(expected_media)<1 or jsonb_array_length(expected_media)<>jsonb_array_length(before_raw->'media')-1
   or after_raw->'media'<>expected_media or after_raw->'variantMediaIds'<>before_raw->'variantMediaIds' or after_raw->'variantImage'<>before_raw->'variantImage' then valid:=false;end if;
 elsif a.phase='reorder' then
  select coalesce(jsonb_agg(m order by x.n),'[]'::jsonb) into expected_media from jsonb_array_elements_text(a.request->'mediaGids') with ordinality x(id,n)
  join lateral (select value from jsonb_array_elements(before_raw->'media') where value->>'mediaId'=x.id) y(m) on true;
  if after_raw->'media'<>expected_media or after_raw->'variantMediaIds'<>before_raw->'variantMediaIds' or after_raw->'variantImage'<>before_raw->'variantImage' then valid:=false;end if;
 end if;
 if a.phase in ('create_owned','gallery_upload','stage_source') then
  insert into toptik_media_private.transport_artifacts(operation_id,step_index,phase_index,artifact) values(o.id,p_step_index,p_phase_index,artifact);
 end if;
 update toptik_media_private.transport_attempts set status=case when valid then 'verified' else 'conflict' end,after_guard=p_guard,receipt=p_receipt
 where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index;
 update toptik_media_private.transport_chains set current_guard=p_guard,next_phase=case when valid then next_phase+1 else next_phase end,
 status=case when not valid then 'conflict' when next_phase+1=jsonb_array_length(phases) then 'verified' else 'running' end
 where operation_id=o.id and step_index=p_step_index;
 if not valid then update toptik_media_private.operations set status='conflict',version=version+1 where id=o.id;end if;
 r:=jsonb_build_object('status',case when valid then 'verified' else 'conflict' end,'mayExecute',false,'nextPhase',case when valid then p_phase_index+1 else p_phase_index end);
 insert into toptik_media_private.events values(p_request_id,p_product_gid,o.id,'transport_readback',h,jsonb_build_object('stepIndex',p_step_index,'phaseIndex',p_phase_index,'guard',p_guard,'receipt',p_receipt),r,clock_timestamp());
 return r;
end $$;

create or replace function toptik_media_private.register(p_product text,p_proofs jsonb) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare x jsonb;proof jsonb;old toptik_media_private.provenance%rowtype;parent toptik_media_private.provenance%rowtype;op toptik_media_private.operations%rowtype;
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
  if x->>'contentId'<>proof->>'decodedSha256' then
   select * into parent from toptik_media_private.provenance where evidence_id=x#>>'{proof,sourceEvidenceId}' and product_gid=p_product and asset_key=x->>'key' and content_id=x->>'contentId';
   if not found then raise exception 'MEDIA_IMPORT_LINEAGE_REQUIRED';end if;
   select * into op from toptik_media_private.operations where id=(proof->>'operationId')::uuid and product_gid=p_product and status in ('running','uncertain');
   if not found or not exists(select 1 from toptik_media_private.transport_artifacts ta
    join toptik_media_private.transport_attempts tr on tr.operation_id=ta.operation_id and tr.step_index=ta.step_index and tr.phase_index=ta.phase_index
    join toptik_media_private.steps st on st.operation_id=ta.operation_id and st.step_index=ta.step_index
    where ta.operation_id=op.id and st.body->>'key'=x->>'key' and st.body->>'target'=x->>'side'
     and tr.status='verified' and tr.phase in ('create_owned','gallery_upload') and tr.request->>'sourceEvidenceId'=parent.evidence_id
     and ta.artifact->>'contentId'=x->>'contentId' and ta.artifact->>'decodedSha256'=x#>>'{proof,decodedSha256}'
     and ta.artifact->>'url'=x#>>'{proof,url}' and ta.artifact->>'mime'=x#>>'{proof,mime}'
     and ta.artifact->'width'=x#>'{proof,width}' and ta.artifact->'height'=x#>'{proof,height}' and ta.artifact->'byteLength'=x#>'{proof,byteLength}'
     and case x->>'side' when 'shopify' then ta.artifact->>'mediaGid' else ta.artifact->>'storagePath' end=x#>>'{proof,platformRef}')
    then raise exception 'MEDIA_IMPORT_LINEAGE_REQUIRED';end if;
  elsif proof?'sourceEvidenceId' or proof?'operationId' then raise exception 'MEDIA_REDUNDANT_LINEAGE_INVALID';end if;
  insert into toptik_media_private.asset_identities(product_gid,asset_key,origin_evidence_id) values(p_product,x->>'key',x->>'evidenceId') on conflict do nothing;
  insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof)
   values(x->>'evidenceId',p_product,x->>'key',x->>'side',x->>'contentId',proof);
 end loop;
end $$;
-- Fail the entire transaction if a signature, privilege, owner, or guard body drifted.
do $$ begin
 if exists(select 1 from _media25_before e left join pg_proc p on p.oid=e.oid
   where p.oid is null or md5(replace(p.prosrc,E'\r\n',E'\n'))<>e.new_hash
   or p.proowner<>e.proowner or p.proacl is distinct from e.proacl
   or p.prosecdef<>e.prosecdef or p.proconfig is distinct from e.proconfig
   or p.prorettype<>e.prorettype or p.proargtypes<>e.proargtypes or p.prolang<>e.prolang)
 then raise exception 'MEDIA25_POSTCONDITION_FAILED';end if;
end $$;
select 'EXISTING_MEDIA_25MP_CONTRACT_VERIFIED' as status,count(*)::integer as verified_function_count from _media25_before;
commit;
