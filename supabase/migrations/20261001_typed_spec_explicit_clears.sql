-- Explicit merchant clears. No DELETE, no inference from absent observations.
-- Depends on 20260930_verified_typed_spec_sync.sql. Existing table/RLS ownership retained.
-- Runtime outbound clears additionally require the deployed value-aware theme contract v2.
create or replace function public.edit_toptik_spec_fields(p_product_gid text,p_lease_owner uuid,p_request_id uuid,p_edits jsonb,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare e jsonb; r toptik_spec_private.field_state%rowtype; v_hash text; previous toptik_spec_private.receipts%rowtype; result jsonb:='[]'::jsonb; audit jsonb:='[]'::jsonb;
begin
 perform toptik_spec_private.assert_access(p_product_gid,p_lease_owner);
 if p_request_id is null or p_edits is null or jsonb_typeof(p_edits)<>'array' or jsonb_array_length(p_edits) not between 1 and 19
 or p_evidence is null or jsonb_typeof(p_evidence) is distinct from 'object' or jsonb_typeof(p_evidence->'evidenceId') is distinct from 'string' or length(btrim(coalesce(p_evidence->>'evidenceId','')))=0 then raise exception 'SPEC_EDIT_INVALID'; end if;
 if (select count(*) from toptik_spec_private.field_state where product_gid=p_product_gid)<>19 then raise exception 'SPEC_BASELINE_REQUIRED'; end if;
 -- observedAt is server-generated observation time. Exclude that alone from retry identity;
 -- all raw values, provenance authority/source, intent IDs and expected versions remain hashed.
 v_hash:=encode(sha256(convert_to(jsonb_build_object('product',p_product_gid,'edits',
  (select jsonb_agg(jsonb_set(value,'{observation,cell,provenance}',(value#>'{observation,cell,provenance}')-'observedAt') order by value->>'key') from jsonb_array_elements(p_edits)),
  'evidence',p_evidence)::text,'UTF8')),'hex');
 select * into previous from toptik_spec_private.receipts where request_id=p_request_id;
 if found then if previous.product_gid<>p_product_gid or previous.request_hash<>v_hash then raise exception 'SPEC_REQUEST_ID_REUSED'; end if;return previous.result;end if;
 if jsonb_array_length(p_edits)<>(select count(distinct value->>'key') from jsonb_array_elements(p_edits)) then raise exception 'SPEC_DUPLICATE_FIELD';end if;
 for e in select value from jsonb_array_elements(p_edits) order by value->>'key' loop
  if not(e ?& array['key','expectedVersion','observation']) or jsonb_typeof(e->'expectedVersion')<>'number' then raise exception 'SPEC_EDIT_INVALID';end if;
  perform toptik_spec_private.assert_observation(e->>'key',e->'observation');
  if e->'observation'->'cell'->>'state' not in ('value','clear') then raise exception 'SPEC_EDIT_INVALID';end if;
  if e->'observation'->'cell'->>'state'='clear' and (e#>>'{observation,cell,provenance,intentId}' is distinct from p_request_id::text||':'||(e->>'key') or e#>>'{observation,cell,provenance,raw,intent}' is distinct from 'clear' or jsonb_typeof(e->'observation'->'revision') is distinct from 'string' or length(btrim(e->'observation'->>'revision'))=0) then raise exception 'SPEC_CLEAR_INTENT_REQUIRED';end if;
  if e#>>'{observation,cell,provenance,authority}' is distinct from 'merchant' or e#>>'{observation,cell,provenance,producer}' is distinct from 'gallery_typed_editor'
   or e#>>'{observation,cell,provenance,evidenceId}' is distinct from p_request_id::text then raise exception 'SPEC_EDITOR_PROVENANCE_INVALID';end if;
  select * into r from toptik_spec_private.field_state where product_gid=p_product_gid and field_key=e->>'key' for update;
  if not found or (e->>'expectedVersion')::numeric<>r.gallery_version then raise exception 'SPEC_EDITOR_STALE';end if;
  update toptik_spec_private.field_state set current_gallery=e->'observation',gallery_version=gallery_version+1,updated_at=clock_timestamp() where product_gid=p_product_gid and field_key=e->>'key';
  result:=result||jsonb_build_array(jsonb_build_object('key',e->>'key','galleryVersion',r.gallery_version+1));
  audit:=audit||jsonb_build_array(jsonb_build_object('key',e->>'key','before',coalesce(r.current_gallery,r.gallery_observation),'after',e->'observation'));
 end loop;
 insert into toptik_spec_private.receipts(request_id,product_gid,request_hash,evidence,changes,result) values(p_request_id,p_product_gid,v_hash,p_evidence,audit,result);
 perform public.enqueue_toptik_spec_work(p_product_gid,'gallery');
 return result;
end $$;

create or replace function public.public_toptik_typed_specs() returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('itemId',q.item_id,'exactSku',q.exact_sku,'fields',q.fields,'cleared',q.cleared)),'[]'::jsonb) from (
  select e.carousel_item_id item_id,e.exact_gallery_sku exact_sku,coalesce(jsonb_object_agg(f.field_key,coalesce(f.current_gallery,f.gallery_observation)->'cell'->'value') filter(where coalesce(f.current_gallery,f.gallery_observation)->'cell'->>'state'='value'),'{}'::jsonb) fields,
   coalesce(jsonb_object_agg(f.field_key,case when f.field_key='additional_specs' then coalesce(coalesce(f.current_gallery,f.gallery_observation)#>'{cell,provenance,raw,previousValue}','null'::jsonb) else 'null'::jsonb end) filter(where coalesce(f.current_gallery,f.gallery_observation)->'cell'->>'state'='clear'),'{}'::jsonb) cleared
  from toptik_spec_private.eligibility e
  join public.shopify_gallery_copy_eligibility c on c.product_gid=e.product_gid and c.enabled
  join public.carousel_items i on i.id=e.carousel_item_id and i.is_active and i.catalog_number=e.exact_gallery_sku
  join public.shopify_gallery_bindings b on b.catalog_key=c.catalog_key and b.carousel_item_id=e.carousel_item_id and b.product_gid=e.product_gid and b.variant_gid=e.variant_gid and b.product_handle=c.approved_product_handle and b.is_published
  join toptik_spec_private.field_state f on f.product_gid=e.product_gid
  where e.enabled and e.carousel_item_id=c.carousel_item_id and e.variant_gid=c.variant_gid and e.exact_gallery_sku=c.exact_gallery_sku and e.exact_shopify_sku=c.exact_shopify_sku
   and coalesce(f.current_gallery,f.gallery_observation)->'cell'->>'state' in ('value','clear')
   and (select count(*) from public.shopify_gallery_bindings where product_gid=e.product_gid)=1
   and (select count(*) from public.carousel_items a where regexp_replace(regexp_replace(upper(coalesce(a.catalog_number,'')),'[^A-Z0-9]','','g'),'^(P[0-9]{2}.*)TU$','\1')=c.catalog_key)=1
  group by e.carousel_item_id,e.exact_gallery_sku
 ) q;
$$;
revoke all on function public.edit_toptik_spec_fields(text,uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.edit_toptik_spec_fields(text,uuid,uuid,jsonb,jsonb) to service_role;
revoke all on function public.public_toptik_typed_specs() from public;
grant execute on function public.public_toptik_typed_specs() to anon,authenticated,service_role;
