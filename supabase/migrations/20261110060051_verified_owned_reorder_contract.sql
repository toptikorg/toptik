-- Reorder changes media.updatedAt for repositioned objects. Other fields stay strict.
-- No production operation is resolved by this migration.
begin;
create function toptik_owned_media_private.reorder_expected_media(b jsonb,ids jsonb,observed jsonb)returns jsonb
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare target text;n bigint;old_n bigint;photo jsonb;actual jsonb;result jsonb:='[]';begin
 if jsonb_typeof(ids)is distinct from'array'or jsonb_typeof(observed)is distinct from'array'
  or jsonb_array_length(ids)<>jsonb_array_length(b->'media')or jsonb_array_length(observed)<>jsonb_array_length(ids)
  or(select count(distinct value)from jsonb_array_elements_text(ids))<>jsonb_array_length(ids)
  then raise exception'OWNED_MEDIA_READBACK_MISMATCH';end if;
 for target,n in select value,ordinality from jsonb_array_elements_text(ids)with ordinality loop
  select value,ordinality into photo,old_n from jsonb_array_elements(b->'media')with ordinality where value->>'mediaId'=target;
  actual:=observed->(n::int-1);
  if photo is null or actual->>'mediaId'is distinct from target then raise exception'OWNED_MEDIA_READBACK_MISMATCH';end if;
  if old_n<>n then
   if(photo-'updatedAt')is distinct from(actual-'updatedAt')or coalesce(actual->>'updatedAt','')=''or coalesce(photo->>'updatedAt','')=''
    or not isfinite((actual->>'updatedAt')::timestamptz)or not isfinite((photo->>'updatedAt')::timestamptz)
    or(actual->>'updatedAt')::timestamptz<(photo->>'updatedAt')::timestamptz then raise exception'OWNED_MEDIA_READBACK_MISMATCH';end if;
   photo:=jsonb_set(photo,'{updatedAt}',actual->'updatedAt');
  end if;
  result:=result||jsonb_build_array(photo);
 end loop;return result;
end$$;
revoke all on function toptik_owned_media_private.reorder_expected_media(jsonb,jsonb,jsonb)from public,anon,authenticated,service_role;

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
  expected_media:=toptik_owned_media_private.reorder_expected_media(b,i->'mediaIds',o->'media');
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

-- The old rejected-write resolver remains unchanged and refuses every reorder.
-- This separate path only handles a restored add-canary whose sole reorder move
-- targeted a newly-created file, which is now absent from the product.
create function public.resolve_restored_toptik_owned_reorder_review(
 p_product_gid text,p_owner uuid,p_operation_id uuid,p_resolution_id uuid,
 p_expected_map_version bigint,p_source jsonb,p_entries jsonb,p_approval jsonb
)returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare expires timestamptz;op toptik_owned_media_private.operations;r toptik_owned_media_private.registry;
 previous toptik_owned_media_private.events;a toptik_owned_media_private.phase_attempts;created_ids text[];
 request_hash text;proof_hash text;e jsonb;c jsonb;photo jsonb;actual jsonb;original_n bigint;old_n bigint;new_n bigint;
 before_state jsonb;result jsonb;begin
 expires:=toptik_owned_media_private.lease(p_product_gid,p_owner);
 select * into op from toptik_owned_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if not found then raise exception'OWNED_MEDIA_OPERATION_UNKNOWN';end if;
 request_hash:=toptik_owned_media_private.digest(jsonb_build_array(p_product_gid,p_operation_id,p_expected_map_version,p_source,p_entries,p_approval));
 select * into previous from toptik_owned_media_private.events where request_id=p_resolution_id;
 if found then
  if previous.kind<>'restored_reorder_review'or previous.request_hash<>request_hash then raise exception'OWNED_MEDIA_REQUEST_CONFLICT';end if;
  return public.read_toptik_owned_media_registry(p_product_gid);
 end if;
 if p_resolution_id is null or jsonb_typeof(p_approval)is distinct from'object'or p_approval->>'approvedBy'is distinct from'Tal'
  or coalesce(p_approval->>'approvedAt','')=''or coalesce(p_approval->>'reviewReference','')=''then raise exception'OWNED_MEDIA_APPROVAL_REQUIRED';end if;
 if op.status<>'review'then raise exception'OWNED_MEDIA_RESTORED_REVIEW_REQUIRED';end if;
 select * into r from toptik_owned_media_private.registry where product_gid=p_product_gid for update;
 if not found or r.map_version is distinct from p_expected_map_version or r.map_version<>op.map_version
  or r.source_fingerprint<>op.source_fingerprint or r.manifest is distinct from op.plan->'beforeManifest'
  then raise exception'OWNED_MEDIA_RESTORE_PREIMAGE_REQUIRED';end if;
 perform toptik_owned_media_private.assert_source(p_product_gid,p_source);
 select * into a from toptik_owned_media_private.phase_attempts where operation_id=op.id and phase_index=op.next_phase;
 if not found or a.status<>'review'or a.request->'input'->>'kind'is distinct from'reorder'
  or coalesce((a.request->>'phaseIndex')::int,-1)<>op.next_phase
  or a.request->>'operationId'is distinct from op.id::text
  or not exists(select 1 from toptik_owned_media_private.phase_evidence where operation_id=op.id and phase_index=op.next_phase
    and action='review'and artifact->>'reason'='GROUP_MEDIA_READBACK_MISMATCH')
  or exists(select 1 from toptik_owned_media_private.phase_attempts x where x.operation_id=op.id and x.phase_index<>op.next_phase
    and(x.status<>'verified'or coalesce(x.request->'input'->>'kind','')not in('create_owned','product_attach')))
  or jsonb_typeof(a.request->'variables'->'moves')is distinct from'array'
  or jsonb_array_length(a.request->'variables'->'moves')<>1
  then raise exception'OWNED_MEDIA_RESTORE_DISPATCH_UNSAFE';end if;
 select array_agg(distinct artifact->>'mediaId')into created_ids from toptik_owned_media_private.phase_attempts
  where operation_id=op.id and status='verified'and request->'input'->>'kind'='create_owned'
   and artifact->'owned'->>'operationId'=op.id::text and artifact->>'mediaId'=artifact->'owned'->'media'->>'mediaId';
 if coalesce(array_length(created_ids,1),0)<>1
  or(a.request->'variables'->'moves'->0->>'id')is distinct from created_ids[1]
  or exists(select 1 from jsonb_array_elements(op.before_graph->'media')m where(m->>'mediaId')=any(created_ids))
  or exists(select 1 from jsonb_array_elements(p_source->'media')m where(m->>'mediaId')=any(created_ids))
  then raise exception'OWNED_MEDIA_RESTORE_DISPATCH_UNSAFE';end if;
 -- Every semantic field and original order must be restored. Only timestamps of
 -- media whose position changed in that precise reorder may advance.
 if(op.before_graph-'fingerprint'-'media'-'product')is distinct from(p_source-'fingerprint'-'media'-'product')
  or((op.before_graph->'product')-'updatedAt')is distinct from((p_source->'product')-'updatedAt')
  or jsonb_array_length(op.before_graph->'media')<>jsonb_array_length(p_source->'media')
  then raise exception'OWNED_MEDIA_RESTORE_PREIMAGE_REQUIRED';end if;
 for photo,original_n in select value,ordinality from jsonb_array_elements(op.before_graph->'media')with ordinality loop
  actual:=p_source->'media'->(original_n::int-1);
  if photo is not distinct from actual then continue;end if;
  select ordinality into old_n from jsonb_array_elements(a.before_graph->'media')with ordinality where value->>'mediaId'=photo->>'mediaId';
  select ordinality into new_n from jsonb_array_elements_text(a.request->'input'->'mediaIds')with ordinality where value=photo->>'mediaId';
  if old_n is null or new_n is null or old_n=new_n or(photo-'updatedAt')is distinct from(actual-'updatedAt')
   or coalesce(actual->>'updatedAt','')=''or coalesce(photo->>'updatedAt','')=''
   or not isfinite((actual->>'updatedAt')::timestamptz)or not isfinite((photo->>'updatedAt')::timestamptz)
   or(actual->>'updatedAt')::timestamptz<(photo->>'updatedAt')::timestamptz then raise exception'OWNED_MEDIA_RESTORE_PREIMAGE_REQUIRED';end if;
 end loop;
 perform toptik_owned_media_private.verify_entries(p_product_gid,p_source,r.manifest,p_entries);
 for e in select value from jsonb_array_elements(p_entries)loop
  select value into c from jsonb_array_elements(toptik_owned_media_private.cards(p_product_gid))x where x->>'itemId'=e->>'itemId';
  if c is null or c->'isActive'is distinct from'true'::jsonb or c->'projection'is distinct from e->'projection'
   or(c->>'expectedRevision')::bigint is distinct from(e->>'expectedRevision')::bigint
   or(c->>'expectedVersion')::timestamptz is distinct from(e->>'expectedVersion')::timestamptz
   or not exists(select 1 from jsonb_array_elements(op.expected_cards)x where x->>'itemId'=e->>'itemId'
     and x->'projection'=e->'projection'and(x->>'expectedRevision')::bigint=(e->>'expectedRevision')::bigint
     and(x->>'expectedVersion')::timestamptz=(e->>'expectedVersion')::timestamptz)
   then raise exception'SYNC_COPY_CONCURRENT_UPDATE';end if;
 end loop;
 proof_hash:=toptik_owned_media_private.digest(jsonb_build_array(op.id,op.request_hash,r.map_version,p_source,p_entries));
 if p_approval->>'packageHash'is distinct from proof_hash then raise exception'OWNED_MEDIA_RESTORE_APPROVAL_CHANGED';end if;
 before_state:=public.read_toptik_owned_media_registry(p_product_gid);
 update toptik_owned_media_private.operations set status='cancelled',work_owner=null,work_claim=null,work_expires=null,
  work_error='OWNED_MEDIA_RESTORED_AFTER_REORDER_REVIEW',updated_at=clock_timestamp()where id=op.id;
 perform toptik_owned_media_private.commit_projection(p_product_gid,p_owner,r.map_version,p_source,r.manifest,p_entries);
 if expires<=clock_timestamp()then raise exception'OWNED_MEDIA_LEASE_REQUIRED';end if;
 result:=public.read_toptik_owned_media_registry(p_product_gid);
 insert into toptik_owned_media_private.events values(p_resolution_id,p_product_gid,'restored_reorder_review',request_hash,before_state,result,p_approval,clock_timestamp());
 return result;
end$$;
revoke all on function public.resolve_restored_toptik_owned_reorder_review(text,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb)from public,anon,authenticated;
grant execute on function public.resolve_restored_toptik_owned_reorder_review(text,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb)to service_role;
commit;
