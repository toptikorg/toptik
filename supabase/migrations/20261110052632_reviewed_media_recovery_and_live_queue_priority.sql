-- Preserve rejected attempts, and resolve only a proved full product-graph restoration.
-- This migration performs no adoption, resolution, queue replay or Shopify write.
begin;

-- Match the native single-image-per-variant contract in SQL as well as TypeScript.
create or replace function toptik_owned_media_private.assert_request(op toptik_owned_media_private.operations,idx integer,request jsonb)returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare spec jsonb:=op.phases->idx;i jsonb:=request->'input';expected jsonb;owned jsonb;current_ids jsonb;native jsonb;begin
 if request->>'apiVersion'is distinct from'2026-07' or request->>'operationId' is distinct from op.id::text or request->>'phaseIndex' is distinct from idx::text
  or request->'binding'is distinct from op.cursor_graph->'binding' or request->>'beforeFingerprint'is distinct from op.cursor_graph->>'fingerprint'
  or request->>'requestHash'is distinct from toptik_owned_media_private.digest(request-'requestHash')then raise exception'OWNED_MEDIA_REQUEST_INVALID';end if;
 case spec->>'kind'
 when 'create_owned' then expected:=jsonb_build_object('kind','create_owned','source',spec->'source','alt',spec->'alt');
 when 'product_attach' then
  select artifact->'owned' into owned from toptik_owned_media_private.phase_attempts where operation_id=op.id and status='verified'and artifact->>'uploadKey'=spec->>'uploadKey';
  if owned is null then raise exception'OWNED_MEDIA_UPLOAD_RECEIPT_REQUIRED';end if;expected:=jsonb_build_object('kind','product_attach','owned',owned);
 when 'variant_append','variant_detach' then
  expected:=jsonb_build_object('kind',spec->>'kind','variantId',spec->>'variantId','mediaIds',toptik_owned_media_private.resolve_refs(op.id,spec->'mediaRefs'));
  if spec->>'kind'='variant_detach'then expected:=expected||jsonb_build_object('removalIntentId',spec->>'removalIntentId');end if;
 when 'variant_cover' then expected:=jsonb_build_object('kind','variant_cover','variantId',spec->>'variantId','mediaId',toptik_owned_media_private.resolve_ref(op.id,spec->>'mediaRef'));
 when 'product_detach' then expected:=jsonb_build_object('kind','product_detach','mediaId',toptik_owned_media_private.resolve_ref(op.id,spec->>'mediaRef'),
  'protectedMediaIds',toptik_owned_media_private.resolve_refs(op.id,spec->'protectedRefs'),'removalIntentId',spec->>'removalIntentId');
 when 'reorder' then expected:=jsonb_build_object('kind','reorder','mediaIds',toptik_owned_media_private.resolve_refs(op.id,spec->'mediaRefs'),'protectedMediaIds',toptik_owned_media_private.resolve_refs(op.id,spec->'protectedRefs'));
 else raise exception'OWNED_MEDIA_PHASE_INVALID';end case;
 if i is distinct from expected then raise exception'OWNED_MEDIA_REQUEST_SPEC_CONFLICT';end if;
 if i->>'kind' in('variant_append','variant_cover') then
  select v into native from jsonb_array_elements(op.cursor_graph->'variants')v where v->>'variantGid'=i->>'variantId';
  if native is null then raise exception 'OWNED_MEDIA_VARIANT_NOT_BOUND';end if;
  if i->>'kind'='variant_append' and (jsonb_array_length(i->'mediaIds')<>1 or jsonb_array_length(native->'mediaIds')<>0)
   then raise exception 'OWNED_MEDIA_VARIANT_SINGLE_IMAGE_REQUIRED';end if;
  if i->>'kind'='variant_cover' and request->'readOnlyNoop' is distinct from 'true'::jsonb and jsonb_array_length(native->'mediaIds')>1
   then raise exception 'OWNED_MEDIA_VARIANT_MEMBERSHIP_REVIEW';end if;
 end if;
 if i->>'kind'like'variant_%'and not exists(select 1 from jsonb_array_elements(op.before_graph->'binding'->'variants')v where v->>'variantGid'=i->>'variantId')then raise exception'OWNED_MEDIA_VARIANT_NOT_BOUND';end if;
 if i->>'kind'in('variant_detach','product_detach')then
  if i->>'removalIntentId'is distinct from op.id::text then raise exception'OWNED_MEDIA_REMOVAL_INTENT_REQUIRED';end if;
  if i->>'kind'='product_detach'and not exists(select 1 from toptik_owned_media_private.removal_intents where operation_id=op.id and media_gid=i->>'mediaId')then raise exception'OWNED_MEDIA_REMOVAL_INTENT_REQUIRED';end if;
  if i->>'kind'='variant_detach'and exists(select 1 from jsonb_array_elements_text(i->'mediaIds')refs(media_gid_text) where not exists(select 1 from toptik_owned_media_private.removal_intents where operation_id=op.id and variant_gid=i->>'variantId'and media_gid=refs.media_gid_text))then raise exception'OWNED_MEDIA_REMOVAL_INTENT_REQUIRED';end if;
 end if;
 if request->'readOnlyNoop'='true'::jsonb then
  if i->>'kind'='reorder'then select jsonb_agg(m->>'mediaId'order by n)into current_ids from jsonb_array_elements(op.cursor_graph->'media')with ordinality a(m,n);
   if current_ids is distinct from i->'mediaIds'then raise exception'OWNED_MEDIA_NOOP_INVALID';end if;
  elsif i->>'kind'='variant_cover'then select v into native from jsonb_array_elements(op.cursor_graph->'variants')v where v->>'variantGid'=i->>'variantId';
   if not exists(select 1 from jsonb_array_elements(op.cursor_graph->'media')m where m->>'mediaId'=i->>'mediaId'and m->'image'->>'url'=native->'image'->>'url')then raise exception'OWNED_MEDIA_NOOP_INVALID';end if;
  else raise exception'OWNED_MEDIA_NOOP_INVALID';end if;
 end if;
end$$;
create or replace function toptik_owned_media_private.assert_delta(request jsonb,b jsonb,o jsonb,artifact jsonb)returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare i jsonb:=request->'input';expected_media jsonb:=b->'media';expected_variants jsonb:=b->'variants';native jsonb;actual jsonb;photo jsonb;owned jsonb;begin
 perform toptik_owned_media_private.assert_source(b->'binding'->>'productGid',o);
 if ((b->'product')-'updatedAt')is distinct from((o->'product')-'updatedAt')or b->'binding'is distinct from o->'binding'then raise exception'OWNED_MEDIA_READBACK_MISMATCH';end if;
 if request->'readOnlyNoop'='true'::jsonb then
  if artifact->'verifiedNoop'is distinct from'true'::jsonb or o->>'fingerprint'is distinct from b->>'fingerprint'then raise exception'OWNED_MEDIA_NOOP_INVALID';end if;return;
 end if;
 case i->>'kind'
 when 'create_owned'then
  owned:=artifact->'owned';photo:=owned->'media';
  if artifact->>'uploadKey'is null or artifact->>'mediaId'is distinct from photo->>'mediaId' or owned->>'operationId'is distinct from request->>'operationId'
   or owned->>'productGid'is distinct from b->'binding'->>'productGid' or owned->>'itemId'is distinct from i->'source'->>'itemId'
   or owned->>'createPhaseIndex'is distinct from request->>'phaseIndex' or owned->>'receiptId'is distinct from i->'source'->>'receiptId'
   or owned->>'sourceSha256'is distinct from i->'source'->>'sha256' or owned->>'mime'is distinct from i->'source'->>'mime'
   or coalesce(owned->>'decodedSha256','')!~'^[a-f0-9]{64}$' or coalesce(owned->>'decodedByteLength','')!~'^[1-9][0-9]*$'
   or photo->>'status'is distinct from'READY' or photo->>'fileStatus'is distinct from'READY' or photo->>'alt'is distinct from i->>'alt'
   or coalesce(photo->'image'->>'url','')not like 'https://cdn.shopify.com/s/files/%'
   or right(split_part(split_part(photo->'image'->>'url','?',1),'#',1),length(owned->>'filename')+1)is distinct from '/'||(owned->>'filename')
   or owned->>'filename'is distinct from ('toptik-group-'||replace(request->>'operationId','-','')||'-'||(request->>'phaseIndex')||'-'||left(i->'source'->>'sha256',16)||case i->'source'->>'mime'when'image/jpeg'then'.jpg'when'image/png'then'.png'when'image/webp'then'.webp'else'INVALID'end)
  then raise exception'OWNED_MEDIA_UPLOAD_RECEIPT_REQUIRED';end if;
 when 'product_attach'then
  select m into photo from jsonb_array_elements(o->'media')m where m->>'mediaId'=i->'owned'->'media'->>'mediaId';
  if photo is null or(photo-'updatedAt')is distinct from((i->'owned'->'media')-'updatedAt')then raise exception'OWNED_MEDIA_READBACK_MISMATCH';end if;
  expected_media:=expected_media||jsonb_build_array(photo);
 when 'product_detach'then
  if exists(select 1 from jsonb_array_elements(b->'variants')v where(v->'mediaIds')?(i->>'mediaId')or exists(select 1 from jsonb_array_elements(b->'media')m where m->>'mediaId'=i->>'mediaId'and m->'image'->>'url'=v->'image'->>'url'))or(i->'protectedMediaIds')?(i->>'mediaId')then raise exception'OWNED_MEDIA_REFERENCE_PROTECTED';end if;
  select coalesce(jsonb_agg(m order by n),'[]'::jsonb)into expected_media from jsonb_array_elements(b->'media')with ordinality a(m,n)where m->>'mediaId'<>i->>'mediaId';
 when 'reorder'then
  select jsonb_agg(m order by n)into expected_media from jsonb_array_elements_text(i->'mediaIds')with ordinality a(id,n)join lateral(select value m from jsonb_array_elements(b->'media')where value->>'mediaId'=id)x on true;
 when 'variant_append','variant_detach','variant_cover'then
  select v into native from jsonb_array_elements(b->'variants')v where v->>'variantGid'=i->>'variantId';
  if native is null then raise exception'OWNED_MEDIA_VARIANT_NOT_BOUND';end if;
  if i->>'kind'='variant_append'then
   if jsonb_array_length(i->'mediaIds')<>1 or jsonb_array_length(native->'mediaIds')<>0 then raise exception 'OWNED_MEDIA_VARIANT_SINGLE_IMAGE_REQUIRED';end if;
   native:=jsonb_set(native,'{mediaIds}',(native->'mediaIds')||(i->'mediaIds'));
  elsif i->>'kind'='variant_detach'then
   if exists(select 1 from jsonb_array_elements_text(i->'mediaIds')id join jsonb_array_elements(b->'media')m on m->>'mediaId'=id where m->'image'->>'url'=native->'image'->>'url')then raise exception'OWNED_MEDIA_REFERENCE_PROTECTED';end if;
   select coalesce(jsonb_agg(id order by n),'[]'::jsonb)into actual from jsonb_array_elements_text(native->'mediaIds')with ordinality a(id,n)where not(i->'mediaIds')?id;native:=jsonb_set(native,'{mediaIds}',actual);
  else
   select v->'image'into actual from jsonb_array_elements(o->'variants')v where v->>'variantGid'=i->>'variantId';
   if jsonb_array_length(native->'mediaIds')>1 or not exists(select 1 from jsonb_array_elements(b->'media')m where m->>'mediaId'=i->>'mediaId'and m->'image'->>'url'=actual->>'url')then raise exception'OWNED_MEDIA_READBACK_MISMATCH';end if;
   native:=jsonb_set(jsonb_set(native,'{image}',actual),'{mediaIds}',jsonb_build_array(i->>'mediaId'));
  end if;
  select jsonb_agg(case when v->>'variantGid'=i->>'variantId'then native else v end order by n)into expected_variants from jsonb_array_elements(b->'variants')with ordinality a(v,n);
 else raise exception'OWNED_MEDIA_PHASE_INVALID';end case;
 if expected_media is distinct from o->'media'or expected_variants is distinct from o->'variants'then raise exception'OWNED_MEDIA_READBACK_MISMATCH';end if;
end$$;

create function public.resolve_restored_toptik_owned_media_review(
 p_product_gid text,p_owner uuid,p_operation_id uuid,p_resolution_id uuid,
 p_expected_map_version bigint,p_source jsonb,p_entries jsonb,p_approval jsonb
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare expires timestamptz;op toptik_owned_media_private.operations;
 r toptik_owned_media_private.registry;previous toptik_owned_media_private.events;
 request_hash text;proof_hash text;e jsonb;c jsonb;before_state jsonb;begin
 expires:=toptik_owned_media_private.lease(p_product_gid,p_owner);
 select * into op from toptik_owned_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if not found then raise exception 'OWNED_MEDIA_OPERATION_UNKNOWN';end if;
 request_hash:=toptik_owned_media_private.digest(jsonb_build_array(p_product_gid,p_operation_id,p_expected_map_version,p_source,p_entries,p_approval));
 select * into previous from toptik_owned_media_private.events where request_id=p_resolution_id;
 if found then
  if previous.kind<>'restored_rejected_review' or previous.request_hash<>request_hash then raise exception 'OWNED_MEDIA_REQUEST_CONFLICT';end if;
  return toptik_owned_media_private.operation_json(op);
 end if;
 if p_resolution_id is null or jsonb_typeof(p_approval) is distinct from 'object'
  or p_approval->>'approvedBy' is distinct from 'Tal'
  or coalesce(p_approval->>'approvedAt','')=''
  or coalesce(p_approval->>'reviewReference','')='' then raise exception 'OWNED_MEDIA_APPROVAL_REQUIRED';end if;
 if op.status<>'review' then raise exception 'OWNED_MEDIA_RESTORED_REVIEW_REQUIRED';end if;
 select * into r from toptik_owned_media_private.registry where product_gid=p_product_gid for update;
 if not found or r.map_version is distinct from p_expected_map_version or r.map_version<>op.map_version
  or r.source_fingerprint<>op.source_fingerprint or r.manifest is distinct from op.plan->'beforeManifest'
  then raise exception 'OWNED_MEDIA_RESTORE_PREIMAGE_REQUIRED';end if;
 perform toptik_owned_media_private.assert_source(p_product_gid,p_source);
 if p_source->>'fingerprint' is distinct from op.source_fingerprint
  then raise exception 'OWNED_MEDIA_RESTORE_PREIMAGE_REQUIRED';end if;
 -- Do not resolve an uncertain dispatch or async reorder. This narrow recovery
 -- covers the actual rejected image-append incident after exact product restore.
 if exists(select 1 from toptik_owned_media_private.phase_attempts a where a.operation_id=op.id
    and (a.status in('started','uncertain') or coalesce(a.request->'input'->>'kind','') not in('create_owned','product_attach','variant_append')))
  or not exists(select 1 from toptik_owned_media_private.phase_evidence a where a.operation_id=op.id
    and a.action='review' and a.artifact->>'reason'='GROUP_MEDIA_WRITE_REJECTED')
  then raise exception 'OWNED_MEDIA_RESTORE_DISPATCH_UNSAFE';end if;
 perform toptik_owned_media_private.verify_entries(p_product_gid,p_source,r.manifest,p_entries);
 for e in select value from jsonb_array_elements(p_entries)loop
  select value into c from jsonb_array_elements(toptik_owned_media_private.cards(p_product_gid))x where x->>'itemId'=e->>'itemId';
  if c is null or c->'isActive' is distinct from 'true'::jsonb
   or c->'projection' is distinct from e->'projection'
   or (c->>'expectedRevision')::bigint is distinct from (e->>'expectedRevision')::bigint
   or (c->>'expectedVersion')::timestamptz is distinct from (e->>'expectedVersion')::timestamptz
   then raise exception 'SYNC_COPY_CONCURRENT_UPDATE';end if;
 end loop;
 proof_hash:=toptik_owned_media_private.digest(jsonb_build_array(op.id,op.request_hash,r.map_version,p_source,p_entries));
 if p_approval->>'packageHash' is distinct from proof_hash then raise exception 'OWNED_MEDIA_RESTORE_APPROVAL_CHANGED';end if;
 before_state:=toptik_owned_media_private.operation_json(op);
 update toptik_owned_media_private.operations set status='cancelled',work_owner=null,work_claim=null,work_expires=null,
  work_error='OWNED_MEDIA_RESTORED_AFTER_REJECTED_WRITE',updated_at=clock_timestamp() where id=op.id returning * into op;
 insert into toptik_owned_media_private.events values(p_resolution_id,p_product_gid,'restored_rejected_review',request_hash,
  before_state,jsonb_build_object('operation',toptik_owned_media_private.operation_json(op),'restoredSource',p_source),p_approval,clock_timestamp());
 if expires<=clock_timestamp()then raise exception 'OWNED_MEDIA_LEASE_REQUIRED';end if;
 return toptik_owned_media_private.operation_json(op);
end$$;
revoke all on function public.resolve_restored_toptik_owned_media_review(text,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.resolve_restored_toptik_owned_media_review(text,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb) to service_role;

-- A daily publication sweep must not put a real signed update behind hundreds
-- of recovery rows. Eligibility, retries, leases and the bounded limit stay intact.
create or replace function public.claim_shopify_webhook_events(p_limit integer default 20)
returns setof public.shopify_webhook_events language sql security definer set search_path=pg_catalog,pg_temp as $$
 with candidates as (
  select id from public.shopify_webhook_events
  where attempts<5 and (status in('pending','failed') or (status='processing' and claimed_at<now()-interval'15 minutes'))
  order by case when delivery_id like 'publication-recovery:%' and payload->>'publication_recovery'='true' then 1 else 0 end,
   received_at,id
  for update skip locked limit greatest(1,least(coalesce(p_limit,20),50))
 )
 update public.shopify_webhook_events as event set status='processing',attempts=event.attempts+1,claimed_at=now()
 from candidates where event.id=candidates.id returning event.*;
$$;
revoke all on function public.claim_shopify_webhook_events(integer) from public,anon,authenticated;
grant execute on function public.claim_shopify_webhook_events(integer) to service_role;
commit;
