-- Service-only discovery and pre-send hold. No public catalog writes or activation.
-- Apply after media_sync_journal and media_transport_substeps.
create function public.read_toptik_media_operation(p_operation_id uuid,p_step_index int,p_phase_index int)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;
 p toptik_media_private.products%rowtype;e public.shopify_gallery_copy_eligibility%rowtype;r jsonb;proofs jsonb;
begin
 if p_operation_id is null or p_step_index is null or p_step_index not between 0 and 1000 or p_phase_index is null or p_phase_index not between 0 and 10 then raise exception 'MEDIA_TRANSPORT_REFERENCE_INVALID';end if;
 select * into o from toptik_media_private.operations where id=p_operation_id;
 if not found then raise exception 'MEDIA_OPERATION_MISSING';end if;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index;
 if not found then raise exception 'MEDIA_TRANSPORT_MISSING';end if;
 select * into p from toptik_media_private.products where product_gid=o.product_gid;
 select * into e from public.shopify_gallery_copy_eligibility where product_gid=o.product_gid;
 if e.product_gid is null or p.identity is distinct from jsonb_build_object('productId',e.product_gid,'variantId',e.variant_gid,'itemId',e.carousel_item_id,
  'exactGallerySku',e.exact_gallery_sku,'exactShopifySku',e.exact_shopify_sku,'productHandle',e.approved_product_handle) then raise exception 'MEDIA_APPROVAL_MISSING_OR_CHANGED';end if;
 if e.enabled and p.enabled then perform public.assert_shopify_verified_copy_identity(e.carousel_item_id,e.catalog_key,e.exact_gallery_sku,e.product_gid,e.variant_gid,e.exact_shopify_sku);end if;
 select coalesce(jsonb_agg(to_jsonb(v) order by v.evidence_id),'[]'::jsonb) into proofs from toptik_media_private.provenance v
 where v.product_gid=o.product_gid and v.evidence_id in (
  select asset->>'evidenceId' from jsonb_each(o.observed_pair) side cross join lateral jsonb_array_elements(side.value->'assets') asset
  union select asset->>'evidenceId' from jsonb_each(coalesce(s.expected_pair,'{}'::jsonb)) side cross join lateral jsonb_array_elements(side.value->'assets') asset
  union select a.request->>'sourceEvidenceId' from toptik_media_private.transport_attempts a where a.operation_id=o.id and a.step_index=p_step_index);
 r:=jsonb_build_object('identity',p.identity,'enabled',p.enabled and e.enabled,'operation',to_jsonb(o),'step',to_jsonb(s),'provenance',proofs,
  'desiredSemanticSha256',case when s.expected_pair is null then null else toptik_media_private.digest(toptik_media_private.semantic(s.expected_pair->'gallery')) end,
  'transport',jsonb_build_object('chain',(select to_jsonb(c) from toptik_media_private.transport_chains c where c.operation_id=o.id and c.step_index=p_step_index),
   'attempts',coalesce((select jsonb_agg(to_jsonb(a) order by a.phase_index) from toptik_media_private.transport_attempts a where a.operation_id=o.id and a.step_index=p_step_index),'[]'::jsonb),
   'artifacts',coalesce((select jsonb_agg(to_jsonb(a) order by a.phase_index) from toptik_media_private.transport_artifacts a where a.operation_id=o.id and a.step_index=p_step_index),'[]'::jsonb)));
 if octet_length(r::text)>5000000 or jsonb_array_length(proofs)>1000 then raise exception 'MEDIA_TRANSPORT_DISCOVERY_TOO_LARGE';end if;
 return r;
end $$;

create function public.read_toptik_media_lease(p_product_gid text,p_owner uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r jsonb;begin
 if p_product_gid is null or p_product_gid !~ '^gid://shopify/Product/[1-9][0-9]*$' or p_owner is null then raise exception 'MEDIA_IDENTITY_INVALID';end if;
 select jsonb_build_object('owner',l.owner,'expiresAt',floor(extract(epoch from l.expires_at)*1000)) into r
 from public.shopify_gallery_reconciliation_leases l where l.product_gid=p_product_gid and l.owner=p_owner and l.expires_at>clock_timestamp();
 if r is null then raise exception 'MEDIA_LEASE_LOST';end if;return r;
end $$;

create function public.hold_toptik_media_transport(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_phase_index int,
 p_attempt_id uuid,p_request_id uuid,p_code text,p_guard jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;a toptik_media_private.transport_attempts%rowtype;
 e toptik_media_private.events%rowtype;h text;r jsonb;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if p_attempt_id is null or p_request_id is null or p_code is null or p_code not in ('MEDIA_TRANSPORT_CHANGED_BEFORE_CALL','MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET') then raise exception 'MEDIA_TRANSPORT_HOLD_INVALID';end if;
 h:=toptik_media_private.digest(jsonb_build_object('operation',p_operation_id,'step',p_step_index,'phase',p_phase_index,'attempt',p_attempt_id,'code',p_code,'guard',p_guard));
 select * into e from toptik_media_private.events where request_id=p_request_id;
 if found then if e.event_kind<>'transport_not_sent' or e.request_hash<>h or e.product_gid<>p_product_gid then raise exception 'MEDIA_REQUEST_REUSED';end if;return e.result;end if;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 select * into a from toptik_media_private.transport_attempts where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index for update;
 if o.id is null or o.status not in ('running','uncertain') or s.status not in ('started','uncertain') or a.attempt_id is distinct from p_attempt_id
  or a.status is distinct from 'started' or a.after_guard is not null or a.receipt is not null then raise exception 'MEDIA_TRANSPORT_HOLD_NOT_ALLOWED';end if;
 perform toptik_media_private.assert_transport_guard(p_guard,i,s.body->>'target');
 if p_code='MEDIA_TRANSPORT_CHANGED_BEFORE_CALL' and p_guard-'observedAt'=a.before_guard-'observedAt' then raise exception 'MEDIA_TRANSPORT_HOLD_NO_CHANGE';end if;
 -- Caller must be the server worker that consumed this permit and has not sent
 -- the HTTP mutation. A prior uncertain/accepted attempt cannot become not-sent.
 update toptik_media_private.transport_attempts set status='conflict',after_guard=p_guard,receipt=jsonb_build_object('notSent',true,'code',p_code)
  where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index;
 update toptik_media_private.transport_chains set status='conflict',current_guard=p_guard where operation_id=o.id and step_index=p_step_index;
 update toptik_media_private.steps set status='conflict' where operation_id=o.id and step_index=p_step_index;
 update toptik_media_private.operations set status='conflict',version=version+1,updated_at=clock_timestamp() where id=o.id;
 r:=jsonb_build_object('status','conflict','mayExecute',false,'notSent',true);
 insert into toptik_media_private.events values(p_request_id,p_product_gid,o.id,'transport_not_sent',h,jsonb_build_object('attemptId',p_attempt_id,'code',p_code,'guard',p_guard),r,clock_timestamp());
 return r;
end $$;

revoke all on function public.read_toptik_media_operation(uuid,int,int),public.read_toptik_media_lease(text,uuid),
 public.hold_toptik_media_transport(text,uuid,uuid,int,int,uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.read_toptik_media_operation(uuid,int,int),public.read_toptik_media_lease(text,uuid),
 public.hold_toptik_media_transport(text,uuid,uuid,int,int,uuid,uuid,text,jsonb) to service_role;
