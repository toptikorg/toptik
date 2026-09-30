-- Additive after the private logical journal. Every external call has a separate
-- one-shot attempt. Intermediate raw platform media may contain old+new images;
-- it MUST NOT be coerced into a unique-logical-key MediaPair.
create table toptik_media_private.transport_chains (
 operation_id uuid not null, step_index int not null, phases jsonb not null,
 initial_guard jsonb not null, current_guard jsonb not null, next_phase int not null default 0,
 status text not null default 'ready' check(status in ('ready','running','uncertain','verified','conflict')),
 primary key(operation_id,step_index), foreign key(operation_id,step_index) references toptik_media_private.steps(operation_id,step_index)
);
create table toptik_media_private.transport_attempts (
 operation_id uuid not null, step_index int not null, phase_index int not null,
 attempt_id uuid not null unique, phase text not null, request_hash text not null, request jsonb not null,
 before_guard jsonb not null, after_guard jsonb,
 status text not null default 'started' check(status in ('started','uncertain','verified','conflict')),
 receipt jsonb, created_at timestamptz not null default clock_timestamp(),
 primary key(operation_id,step_index,phase_index), foreign key(operation_id,step_index) references toptik_media_private.transport_chains(operation_id,step_index)
);
create table toptik_media_private.transport_artifacts (
 operation_id uuid not null, step_index int not null, phase_index int not null,
 artifact jsonb not null, created_at timestamptz not null default clock_timestamp(),
 primary key(operation_id,step_index,phase_index), foreign key(operation_id,step_index,phase_index) references toptik_media_private.transport_attempts(operation_id,step_index,phase_index)
);
create trigger immutable_record before update or delete on toptik_media_private.transport_artifacts for each row execute function toptik_media_private.immutable();

-- Initial READY-only raw read must be exactly the same ready-reader revision
-- already pinned by the logical MediaPair. Opaque image ID namespaces stay distinct.
create function toptik_media_private.ready_transport_fingerprint(r jsonb) returns text language plpgsql immutable set search_path=pg_catalog as $$
declare ids text;images text;variants text;s text;
begin
 select '['||string_agg(to_json(r#>>array['identity',k])::text,',' order by n)||']' into ids
 from unnest(array['productId','variantId','itemId','exactGallerySku','exactShopifySku','productHandle']) with ordinality x(k,n);
 select '['||coalesce(string_agg('['||to_json(m->>'mediaId')::text||','||to_json(m#>>'{image,id}')::text||','||to_json(m#>>'{image,url}')::text||','||
 (m#>'{image,width}')::text||','||(m#>'{image,height}')::text||','||(m->'alt')::text||','||to_json(m->>'updatedAt')::text||','||((r->'variantMediaIds') ? (m->>'mediaId'))::text||']',',' order by n),'')||']'
 into images from jsonb_array_elements(r->'media') with ordinality x(m,n);
 select '['||coalesce(string_agg(to_json(v)::text,',' order by n),'')||']' into variants from jsonb_array_elements_text(r->'variantMediaIds') with ordinality x(v,n);
 s:='{"identity":'||ids||',"updatedAt":'||to_json(r->>'updatedAt')::text||',"images":'||images||',"variantMediaIds":'||variants||
 ',"variantImageId":'||coalesce(to_json(r#>>'{variantImage,id}')::text,'null')||',"variantImageUrl":'||coalesce(to_json(r#>>'{variantImage,url}')::text,'null')||'}';
 return encode(sha256(convert_to(s,'UTF8')),'hex');
end $$;

create function toptik_media_private.raw_transport_fingerprint(r jsonb) returns text language plpgsql immutable set search_path=pg_catalog as $$
declare ids text;images text;variants text;s text;
begin
 select '['||string_agg(to_json(r#>>array['identity',k])::text,',' order by n)||']' into ids
 from unnest(array['productId','variantId','itemId','exactGallerySku','exactShopifySku','productHandle']) with ordinality x(k,n);
 select '['||coalesce(string_agg('['||to_json(m->>'mediaId')::text||','||to_json(m->>'mediaContentType')::text||','||to_json(m->>'status')::text||','||to_json(m->>'fileStatus')::text||','||
 to_json(m->>'updatedAt')::text||','||(m->'alt')::text||','||case when m->'image'='null'::jsonb then 'null' else '['||to_json(m#>>'{image,id}')::text||','||to_json(m#>>'{image,url}')::text||','||
 (m#>'{image,width}')::text||','||(m#>'{image,height}')::text||']' end||']',',' order by n),'')||']'
 into images from jsonb_array_elements(r->'media') with ordinality x(m,n);
 select '['||coalesce(string_agg(to_json(v)::text,',' order by n),'')||']' into variants from jsonb_array_elements_text(r->'variantMediaIds') with ordinality x(v,n);
 s:='{"side":"shopify","identity":'||ids||',"complete":true,"updatedAt":'||to_json(r->>'updatedAt')::text||',"media":'||images||',"variantMediaIds":'||variants||
 ',"variantImage":'||case when r->'variantImage'='null'::jsonb then 'null' else '['||to_json(r#>>'{variantImage,id}')::text||','||to_json(r#>>'{variantImage,url}')::text||']' end||'}';
 return encode(sha256(convert_to(s,'UTF8')),'hex');
end $$;

create function toptik_media_private.assert_transport_guard(g jsonb,i jsonb,target text) returns void
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
   or (im->>'width')::numeric>16000 or (im->>'height')::numeric>16000 or (im->>'width')::numeric*(im->>'height')::numeric>16000000 then raise exception 'MEDIA_TRANSPORT_RAW_INVALID';end if;
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

create function public.prepare_toptik_media_transport(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_request_id uuid,p_phases jsonb,p_guard jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;c toptik_media_private.transport_chains%rowtype;
 h text;e toptik_media_private.events%rowtype;target text;source text;kind text;result jsonb;effective jsonb;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 if p_request_id is null or o.id is null or o.status not in ('running','uncertain') or s.status not in ('started','uncertain') then raise exception 'MEDIA_TRANSPORT_LOGICAL_NOT_STARTED';end if;
 target:=s.body->>'target';source:=case target when 'shopify' then 'gallery' else 'shopify' end;kind:=s.body->>'kind';
 perform toptik_media_private.assert_transport_guard(p_guard,i,target);
 h:=toptik_media_private.digest(jsonb_build_object('operation',o.id,'step',p_step_index,'phases',p_phases,'guard',p_guard));
 select * into e from toptik_media_private.events where request_id=p_request_id;
 if found then if e.event_kind<>'transport_prepared' or e.request_hash<>h then raise exception 'MEDIA_REQUEST_REUSED';end if;return e.result;end if;
 select * into c from toptik_media_private.transport_chains where operation_id=o.id and step_index=p_step_index;
 if found then
  if c.phases<>p_phases or c.initial_guard<>p_guard then raise exception 'MEDIA_TRANSPORT_CHAIN_IMMUTABLE';end if;
  return jsonb_build_object('status',c.status,'mayExecute',false,'replayed',true);
 end if;
 if p_guard->>'sourceFingerprint'<>toptik_media_private.fingerprint(o.observed_pair->source)
 or (target='gallery' and p_guard->'target'<>o.observed_pair->'gallery') then raise exception 'MEDIA_TRANSPORT_SOURCE_CHANGED';end if;
 if target='shopify' and (exists(select 1 from jsonb_array_elements(p_guard#>'{target,media}') m where m->>'status'<>'READY' or m->>'fileStatus'<>'READY' or m->'image'='null'::jsonb)
  or toptik_media_private.ready_transport_fingerprint(p_guard->'target') is distinct from o.observed_pair#>>'{shopify,revision}') then raise exception 'MEDIA_TRANSPORT_INITIAL_READ_CHANGED';end if;
 effective:=p_phases;
 if target='shopify' and p_phases->>0='stage_source' then select jsonb_agg(v order by n) into effective from jsonb_array_elements(p_phases) with ordinality x(v,n) where n>1;end if;
 if (target='shopify' and not(
  (kind='attach' and effective='["create_owned","associate","reorder"]'::jsonb)
  or (kind in ('replace_reference','alt') and effective in ('["create_owned","associate","detach_old","reorder"]'::jsonb,'["create_owned","associate","variant_reassign","detach_old","reorder"]'::jsonb))
  or (kind='detach_reference' and p_phases='["detach_old"]'::jsonb)
  or (kind='reorder' and p_phases='["reorder"]'::jsonb)))
 or (target='gallery' and not(
  (kind in ('attach','replace_reference') and p_phases='["gallery_upload","gallery_cas"]'::jsonb)
  or (kind in ('alt','detach_reference','reorder') and p_phases='["gallery_cas"]'::jsonb))) then raise exception 'MEDIA_TRANSPORT_CHAIN_INVALID';end if;
 insert into toptik_media_private.transport_chains(operation_id,step_index,phases,initial_guard,current_guard) values(o.id,p_step_index,p_phases,p_guard,p_guard);
 result:=jsonb_build_object('status','ready','mayExecute',false,'nextPhase',0);
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result)
 values(p_request_id,p_product_gid,o.id,'transport_prepared',h,jsonb_build_object('stepIndex',p_step_index,'phases',p_phases,'guard',p_guard),result);
 return result;
end $$;

create function public.begin_toptik_media_transport(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_phase_index int,p_attempt_id uuid,p_request jsonb,p_fresh_guard jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;c toptik_media_private.transport_chains%rowtype;a toptik_media_private.transport_attempts%rowtype;
 phase text;expected_asset jsonb;source_proof toptik_media_private.provenance%rowtype;artifact jsonb;stage_artifact jsonb;old_media text;h text;result jsonb;expected_keys jsonb;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 select * into c from toptik_media_private.transport_chains where operation_id=o.id and step_index=p_step_index for update;
 if o.id is null or c.operation_id is null or p_attempt_id is null or p_phase_index<0 then raise exception 'MEDIA_TRANSPORT_MISSING';end if;
 perform toptik_media_private.assert_transport_guard(p_fresh_guard,i,s.body->>'target');
 h:=toptik_media_private.digest(p_request);
 select * into a from toptik_media_private.transport_attempts where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index;
 if found then
  if a.request_hash<>h then raise exception 'MEDIA_TRANSPORT_REQUEST_CHANGED';end if;
  return jsonb_build_object('mayExecute',false,'status',a.status,'attemptId',a.attempt_id,'requestHash',a.request_hash,'replayed',true);
 end if;
 if o.status not in ('running','uncertain') or c.status not in ('ready','running') or c.next_phase<>p_phase_index
 or p_phase_index>=jsonb_array_length(c.phases) or s.status not in ('started','uncertain') then raise exception 'MEDIA_TRANSPORT_OUT_OF_ORDER';end if;
 if p_fresh_guard-'observedAt'<>c.current_guard-'observedAt' then
  update toptik_media_private.transport_chains set status='conflict' where operation_id=o.id and step_index=p_step_index;
  update toptik_media_private.operations set status='conflict',version=version+1 where id=o.id;
  insert into toptik_media_private.events values(p_attempt_id,p_product_gid,o.id,'transport_conflict',h,jsonb_build_object('expected',c.current_guard,'fresh',p_fresh_guard),jsonb_build_object('status','conflict','mayExecute',false),clock_timestamp());
  return jsonb_build_object('status','conflict','mayExecute',false);
 end if;
 phase:=c.phases->>p_phase_index;
 if jsonb_typeof(p_request) is distinct from 'object' or coalesce(p_request->>'mutationSha256','') !~ '^[a-f0-9]{64}$'
 or octet_length(p_request::text)>100000 then raise exception 'MEDIA_TRANSPORT_REQUEST_INVALID';end if;
 expected_asset:=toptik_media_private.asset(s.expected_pair->(s.body->>'target'),s.body->>'key');
 select ta.artifact into artifact from toptik_media_private.transport_artifacts ta where ta.operation_id=o.id and ta.step_index=p_step_index and ta.phase_index<p_phase_index and ta.artifact?'mediaGid' order by ta.phase_index limit 1;
 select ta.artifact into stage_artifact from toptik_media_private.transport_artifacts ta where ta.operation_id=o.id and ta.step_index=p_step_index and ta.phase_index<p_phase_index and ta.artifact?'storagePath' order by ta.phase_index limit 1;
 select p.proof->>'platformRef' into old_media from toptik_media_private.provenance p where p.evidence_id=toptik_media_private.asset(o.observed_pair->(s.body->>'target'),s.body->>'key')->>'evidenceId';
 if phase in ('create_owned','gallery_upload','stage_source') then
  select * into source_proof from toptik_media_private.provenance where evidence_id=p_request->>'sourceEvidenceId' and product_gid=p_product_gid and asset_key=s.body->>'key' and content_id=expected_asset->>'contentId';
  if not found then raise exception 'MEDIA_TRANSPORT_SOURCE_PROOF_REQUIRED';end if;
  if phase='create_owned' then
   if (select count(*) from jsonb_object_keys(p_request))<>5 or not(p_request ?& array['mutationSha256','sourceEvidenceId','filename','duplicateResolutionMode','stagedSourceUrl'])
   or p_request->>'duplicateResolutionMode' is distinct from 'RAISE_ERROR'
   or coalesce(p_request->>'filename','') !~ ('^toptik-sync-'||replace(o.id::text,'-','')||'-'||p_step_index||'-'||left(source_proof.proof->>'decodedSha256',16)||'[.](jpg|png|webp|avif)$') then raise exception 'MEDIA_TRANSPORT_CREATE_NOT_IDEMPOTENT';end if;
   if coalesce(p_request->>'stagedSourceUrl','') !~ ('^https://ekgpaoavsavrtbhlbwdg[.]supabase[.]co/storage/v1/object/public/carousel-media/sync-media/'||(i->>'itemId')||'/'||(source_proof.proof->>'decodedSha256')||'[.](jpg|png|webp|avif)$')
    or not((stage_artifact is not null and stage_artifact->>'url'=p_request->>'stagedSourceUrl' and stage_artifact->>'decodedSha256'=source_proof.proof->>'decodedSha256')
     or (source_proof.proof->>'ownership'='owned_storage' and source_proof.proof->>'url'=p_request->>'stagedSourceUrl')) then raise exception 'MEDIA_TRANSPORT_IMMUTABLE_SOURCE_REQUIRED';end if;
  else
   if (select count(*) from jsonb_object_keys(p_request))<>4 or not(p_request ?& array['mutationSha256','sourceEvidenceId','storagePath','upsert'])
    or p_request->'upsert' is distinct from 'false'::jsonb
    or coalesce(p_request->>'storagePath','') !~ ('^sync-media/'||(i->>'itemId')||'/'||(source_proof.proof->>'decodedSha256')||'[.](jpg|png|webp|avif)$') then raise exception 'MEDIA_TRANSPORT_UPLOAD_NOT_IDEMPOTENT';end if;
  end if;
 elsif phase='associate' then
  if p_request->>'productGid' is distinct from p_product_gid or p_request->>'mediaGid' is distinct from artifact->>'mediaGid' or artifact is null
   or (select count(*) from jsonb_object_keys(p_request))<>3 then raise exception 'MEDIA_TRANSPORT_ARTIFACT_REQUIRED';end if;
 elsif phase='variant_reassign' then
  if p_request->>'variantGid' is distinct from i->>'variantId' or p_request->>'mediaGid' is distinct from artifact->>'mediaGid' or artifact is null
   or (select count(*) from jsonb_object_keys(p_request))<>3 then raise exception 'MEDIA_TRANSPORT_ARTIFACT_REQUIRED';end if;
  if p_fresh_guard#>'{target,variantMediaIds}' is distinct from jsonb_build_array(old_media) then raise exception 'MEDIA_TRANSPORT_VARIANT_REFERENCE_PROTECTED';end if;
 elsif phase='detach_old' then
  if p_request->>'productGid' is distinct from p_product_gid or p_request->>'mediaGid' is distinct from old_media or old_media is null
   or (select count(*) from jsonb_object_keys(p_request))<>3 or (p_fresh_guard#>'{target,variantMediaIds}') ? old_media then raise exception 'MEDIA_TRANSPORT_VARIANT_REFERENCE_PROTECTED';end if;
 elsif phase='gallery_cas' then
  if p_request->>'expectedRevision' is distinct from o.observed_pair#>>'{gallery,revision}'
   or p_request->>'desiredSemanticSha256' is distinct from toptik_media_private.digest(toptik_media_private.semantic(s.expected_pair->'gallery'))
   or (select count(*) from jsonb_object_keys(p_request))<>3 then raise exception 'MEDIA_TRANSPORT_GALLERY_CAS_INVALID';end if;
 elsif phase='reorder' then
  select jsonb_agg(asset_row->>'key' order by n) into expected_keys from jsonb_array_elements(s.expected_pair#>'{shopify,assets}') with ordinality x(asset_row,n);
  if jsonb_typeof(p_request->'mediaGids') is distinct from 'array' or (select count(*) from jsonb_object_keys(p_request))<>2
   or p_request->'mediaGids' is distinct from (select jsonb_agg(case when artifact is not null and x.k=s.body->>'key' then artifact->>'mediaGid' else p.proof->>'platformRef' end order by x.n)
    from jsonb_array_elements_text(expected_keys) with ordinality x(k,n) left join toptik_media_private.provenance p on p.evidence_id=toptik_media_private.asset(o.observed_pair->'shopify',x.k)->>'evidenceId') then raise exception 'MEDIA_TRANSPORT_REORDER_INVALID';end if;
 end if;
 insert into toptik_media_private.transport_attempts(operation_id,step_index,phase_index,attempt_id,phase,request_hash,request,before_guard)
 values(o.id,p_step_index,p_phase_index,p_attempt_id,phase,h,p_request,p_fresh_guard);
 -- A verified complete fresh order already equal to the frozen desired order
 -- needs no Shopify call. Persist completion instead of forcing a no-op mutation.
 if phase='reorder' and p_request->'mediaGids'=(select jsonb_agg(m->>'mediaId' order by n) from jsonb_array_elements(p_fresh_guard#>'{target,media}') with ordinality x(m,n)) then
  update toptik_media_private.transport_attempts set status='verified',after_guard=p_fresh_guard,receipt=jsonb_build_object('verifiedNoop',true,'reason','order_already_matches')
   where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index;
  update toptik_media_private.transport_chains set current_guard=p_fresh_guard,next_phase=next_phase+1,
   status=case when next_phase+1=jsonb_array_length(phases) then 'verified' else 'running' end where operation_id=o.id and step_index=p_step_index;
  result:=jsonb_build_object('mayExecute',false,'status','verified','verifiedNoop',true,'phase',phase,'attemptId',p_attempt_id,'requestHash',h,'request',p_request,'replayed',false,'nextPhase',p_phase_index+1);
  insert into toptik_media_private.events values(p_attempt_id,p_product_gid,o.id,'transport_noop',h,jsonb_build_object('stepIndex',p_step_index,'phaseIndex',p_phase_index,'request',p_request,'guard',p_fresh_guard),result,clock_timestamp());
  return result;
 end if;
 update toptik_media_private.transport_chains set status='running' where operation_id=o.id and step_index=p_step_index;
 result:=jsonb_build_object('mayExecute',true,'phase',phase,'attemptId',p_attempt_id,'requestHash',h,'request',p_request,'replayed',false);
 insert into toptik_media_private.events values(p_attempt_id,p_product_gid,o.id,'transport_started',h,jsonb_build_object('stepIndex',p_step_index,'phaseIndex',p_phase_index,'request',p_request,'guard',p_fresh_guard),result,clock_timestamp());
 return result;
end $$;

create function public.mark_toptik_media_transport_uncertain(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_phase_index int,p_request_id uuid,p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a toptik_media_private.transport_attempts%rowtype;h text;e toptik_media_private.events%rowtype;r jsonb;
begin
 perform toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if p_request_id is null or jsonb_typeof(p_receipt) is distinct from 'object' or octet_length(p_receipt::text)>2000
 or exists(select 1 from jsonb_object_keys(p_receipt) k where k not in ('outcome','mediaGid','jobId'))
 or coalesce(p_receipt->>'outcome','') not in ('unknown','accepted','processing')
 or (p_receipt?'mediaGid' and coalesce(p_receipt->>'mediaGid','') !~ '^gid://shopify/MediaImage/[1-9][0-9]*$')
 or (p_receipt?'jobId' and coalesce(p_receipt->>'jobId','') !~ '^gid://shopify/Job/[A-Za-z0-9-]{1,100}$') then raise exception 'MEDIA_TRANSPORT_RECEIPT_INVALID';end if;
 h:=toptik_media_private.digest(jsonb_build_object('operation',p_operation_id,'step',p_step_index,'phase',p_phase_index,'receipt',p_receipt));
 select * into e from toptik_media_private.events where request_id=p_request_id;
 if found then if e.event_kind<>'transport_uncertain' or e.request_hash<>h then raise exception 'MEDIA_REQUEST_REUSED';end if;return e.result;end if;
 select a0.* into a from toptik_media_private.transport_attempts a0 join toptik_media_private.operations o on o.id=a0.operation_id
 where o.product_gid=p_product_gid and a0.operation_id=p_operation_id and a0.step_index=p_step_index and a0.phase_index=p_phase_index for update of a0;
 if not found or a.status not in ('started','uncertain') then raise exception 'MEDIA_TRANSPORT_NOT_STARTED';end if;
 update toptik_media_private.transport_attempts set status='uncertain' where operation_id=p_operation_id and step_index=p_step_index and phase_index=p_phase_index;
 update toptik_media_private.transport_chains set status='uncertain' where operation_id=p_operation_id and step_index=p_step_index;
 r:=jsonb_build_object('status','uncertain','mayExecute',false,'readbackRequired',true);
 insert into toptik_media_private.events values(p_request_id,p_product_gid,p_operation_id,'transport_uncertain',h,p_receipt,r,clock_timestamp());
 return r;
end $$;

create function public.accept_toptik_media_transport(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_phase_index int,p_request_id uuid,p_guard jsonb,p_receipt jsonb)
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
   or (artifact->>'width')::numeric*(artifact->>'height')::numeric>16000000 or coalesce(artifact->>'byteLength','') !~ '^[1-9][0-9]{0,7}$' or (artifact->>'byteLength')::numeric>8388608 then raise exception 'MEDIA_TRANSPORT_ARTIFACT_INVALID';end if;
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

-- The old logical permit is internal only. It reserves the logical step but does
-- not authorize any external call after this additive migration.
alter function public.begin_toptik_media_step(text,uuid,uuid,int,uuid,jsonb) set schema toptik_media_private;
alter function public.accept_toptik_media_readback(text,uuid,uuid,int,uuid,jsonb) set schema toptik_media_private;
create function public.begin_toptik_media_step(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_attempt_id uuid,p_fresh jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r jsonb;expected jsonb;begin
 r:=toptik_media_private.begin_toptik_media_step(p_product_gid,p_lease_owner,p_operation_id,p_step_index,p_attempt_id,p_fresh);
 select expected_pair into expected from toptik_media_private.steps where operation_id=p_operation_id and step_index=p_step_index;
 return r||jsonb_build_object('logicalStepReady',r->>'status' in ('started','uncertain'),'mayExecute',false,'transportRequired',true,
  'desiredSemanticSha256',case when expected is null then null else toptik_media_private.digest(toptik_media_private.semantic(expected->'gallery')) end);
end $$;
create function public.accept_toptik_media_readback(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_request_id uuid,p_observed jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare c toptik_media_private.transport_chains%rowtype;s toptik_media_private.steps%rowtype;expected_refs jsonb;
begin
 perform toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if not exists(select 1 from toptik_media_private.transport_chains chain_row join toptik_media_private.operations o on o.id=chain_row.operation_id
  where o.product_gid=p_product_gid and chain_row.operation_id=p_operation_id and chain_row.step_index=p_step_index and chain_row.status='verified') then raise exception 'MEDIA_TRANSPORT_NOT_VERIFIED';end if;
 select * into c from toptik_media_private.transport_chains where operation_id=p_operation_id and step_index=p_step_index;
 select * into s from toptik_media_private.steps where operation_id=p_operation_id and step_index=p_step_index;
 if s.body->>'target'='shopify' then
  if p_observed#>>'{shopify,revision}' is distinct from toptik_media_private.ready_transport_fingerprint(c.current_guard->'target') then raise exception 'MEDIA_TRANSPORT_FINAL_SNAPSHOT_MISMATCH';end if;
  select jsonb_agg(p.proof->>'platformRef' order by n) into expected_refs from jsonb_array_elements(p_observed#>'{shopify,assets}') with ordinality x(a,n)
   join toptik_media_private.provenance p on p.evidence_id=a->>'evidenceId' and p.product_gid=p_product_gid and p.side='shopify';
  if expected_refs is distinct from (select jsonb_agg(m->>'mediaId' order by n) from jsonb_array_elements(c.current_guard#>'{target,media}') with ordinality x(m,n)) then raise exception 'MEDIA_TRANSPORT_FINAL_SNAPSHOT_MISMATCH';end if;
 else
  if p_observed->'gallery' is distinct from c.current_guard->'target' then raise exception 'MEDIA_TRANSPORT_FINAL_SNAPSHOT_MISMATCH';end if;
 end if;
 return toptik_media_private.accept_toptik_media_readback(p_product_gid,p_lease_owner,p_operation_id,p_step_index,p_request_id,p_observed);
end $$;
create function public.read_toptik_media_transport(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 perform toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if not exists(select 1 from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid) then raise exception 'MEDIA_OPERATION_MISSING';end if;
 return jsonb_build_object('desiredSemanticSha256',(select toptik_media_private.digest(toptik_media_private.semantic(expected_pair->'gallery')) from toptik_media_private.steps where operation_id=p_operation_id and step_index=p_step_index),
 'chain',(select to_jsonb(c) from toptik_media_private.transport_chains c where operation_id=p_operation_id and step_index=p_step_index),
  'attempts',coalesce((select jsonb_agg(to_jsonb(a) order by phase_index) from toptik_media_private.transport_attempts a where operation_id=p_operation_id and step_index=p_step_index),'[]'::jsonb),
  'artifacts',coalesce((select jsonb_agg(to_jsonb(a) order by phase_index) from toptik_media_private.transport_artifacts a where operation_id=p_operation_id and step_index=p_step_index),'[]'::jsonb));
end $$;
do $$ declare t text;r record;begin
 foreach t in array array['transport_chains','transport_attempts','transport_artifacts'] loop
  execute format('alter table toptik_media_private.%I enable row level security',t);
  execute format('revoke all on toptik_media_private.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on toptik_media_private.%I to service_role',t);
  execute format('create policy service_read on toptik_media_private.%I for select to service_role using(true)',t);
 end loop;
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and p.proname in ('prepare_toptik_media_transport','begin_toptik_media_transport','mark_toptik_media_transport_uncertain','accept_toptik_media_transport','read_toptik_media_transport','begin_toptik_media_step','accept_toptik_media_readback') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
  execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
-- Verified transport artifacts also support same-side owned cloning for alt.
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
  or (proof->>'width')::numeric*(proof->>'height')::numeric>16000000 or coalesce(proof->>'byteLength','') !~ '^[1-9][0-9]{0,7}$'
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
revoke all on all functions in schema toptik_media_private from public,anon,authenticated,service_role;
