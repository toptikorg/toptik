-- Default-off typed manufacturer/merchant facts; no commerce or catalog identity writes.
-- Depends on existing copy eligibility and reconciliation lease tables.
create schema if not exists toptik_spec_private;
revoke all on schema toptik_spec_private from public,anon,authenticated,service_role;
grant usage on schema toptik_spec_private to service_role;

create function toptik_spec_private.keys() returns text[] language sql immutable
set search_path=pg_catalog as $$ select array['manufacturer_sku','manufacturer_model','material','height','width','depth',
 'expanded_height','expanded_width','expanded_depth','volume','expanded_volume','net_weight','wheel_count','wheel_type',
 'lock_type','expandable','color_name','warranty_text','additional_specs']::text[] $$;

create table toptik_spec_private.eligibility (
 product_gid text primary key references public.shopify_gallery_copy_eligibility(product_gid),
 carousel_item_id uuid not null unique, variant_gid text not null unique,
 exact_gallery_sku text not null, exact_shopify_sku text not null,
 approval_id text not null, enabled boolean not null default false, approval_evidence jsonb not null default '{}'::jsonb,
 approved_fields text[] not null default toptik_spec_private.keys() check(approved_fields=toptik_spec_private.keys()),
 created_at timestamptz not null default clock_timestamp()
);
create table toptik_spec_private.field_state (
 product_gid text not null references toptik_spec_private.eligibility(product_gid),
 field_key text not null check(field_key=any(toptik_spec_private.keys())),
 state_version bigint not null default 1 check(state_version>0),
 gallery_observation jsonb not null, shopify_observation jsonb not null,
 updated_at timestamptz not null default clock_timestamp(), primary key(product_gid,field_key)
);
create table toptik_spec_private.receipts (
 request_id uuid primary key, product_gid text not null references toptik_spec_private.eligibility(product_gid),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 evidence jsonb not null, changes jsonb not null, result jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create function toptik_spec_private.immutable_record() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_table_name='eligibility' and tg_op='UPDATE' and to_jsonb(new)-'enabled'=to_jsonb(old)-'enabled' then return new; end if;
 raise exception 'SPEC_PRIVATE_RECORD_IMMUTABLE';
end $$;
create trigger immutable_approval before update or delete on toptik_spec_private.eligibility for each row execute function toptik_spec_private.immutable_record();
create trigger immutable_receipt before update or delete on toptik_spec_private.receipts for each row execute function toptik_spec_private.immutable_record();

create function toptik_spec_private.assert_access(p_product_gid text,p_lease_owner uuid) returns void
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_copy public.shopify_gallery_copy_eligibility%rowtype;
begin
 if p_product_gid is null or p_product_gid !~ '^gid://shopify/Product/[0-9]+$' or p_lease_owner is null then raise exception 'SPEC_IDENTITY_INVALID'; end if;
 perform set_config('lock_timeout','3000ms',true);
 perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select c.* into v_copy from toptik_spec_private.eligibility s join public.shopify_gallery_copy_eligibility c on c.product_gid=s.product_gid
 where s.product_gid=p_product_gid and s.enabled and c.enabled
 and s.carousel_item_id=c.carousel_item_id and s.variant_gid=c.variant_gid
 and s.exact_gallery_sku=c.exact_gallery_sku and s.exact_shopify_sku=c.exact_shopify_sku
 and s.approved_fields=toptik_spec_private.keys() for update of s,c;
 if not found then raise exception 'SPEC_APPROVAL_MISSING_OR_CHANGED'; end if;
 perform public.assert_shopify_verified_copy_identity(v_copy.carousel_item_id,v_copy.catalog_key,v_copy.exact_gallery_sku,
  v_copy.product_gid,v_copy.variant_gid,v_copy.exact_shopify_sku);
 perform 1 from public.shopify_gallery_reconciliation_leases l
 where l.product_gid=p_product_gid and l.owner=p_lease_owner and l.expires_at>clock_timestamp() for update;
 if not found then raise exception 'SPEC_LEASE_LOST'; end if;
end $$;

create function toptik_spec_private.assert_observation(p_field text,p_observation jsonb) returns void
language plpgsql immutable set search_path=pg_catalog as $$
declare v_cell jsonb; v_state text; v_provenance jsonb;
begin
 if p_field is null or not(p_field=any(toptik_spec_private.keys())) or p_observation is null
 or jsonb_typeof(p_observation)<>'object' or not(p_observation ?& array['cell','revision'])
 or (select count(*) from jsonb_object_keys(p_observation))<>2 then raise exception 'SPEC_OBSERVATION_INVALID'; end if;
 v_cell:=p_observation->'cell'; v_state:=v_cell->>'state';
 if jsonb_typeof(v_cell)<>'object' or v_state is null or v_state not in ('absent','value','clear') then raise exception 'SPEC_OBSERVATION_INVALID'; end if;
 if v_state='absent' then
  if p_observation->'revision'<>'null'::jsonb or v_cell<>'{"state":"absent"}'::jsonb then raise exception 'SPEC_OBSERVATION_INVALID'; end if;
 else
  if v_state='value' and (jsonb_typeof(p_observation->'revision')<>'string' or length(btrim(p_observation->>'revision'))=0 or not(v_cell?'value')) then raise exception 'SPEC_REVISION_REQUIRED'; end if;
  if p_observation->'revision'<>'null'::jsonb and (jsonb_typeof(p_observation->'revision')<>'string' or length(btrim(p_observation->>'revision'))=0) then raise exception 'SPEC_REVISION_REQUIRED'; end if;
  v_provenance:=v_cell->'provenance';
  if v_provenance is null or jsonb_typeof(v_provenance)<>'object' or not(v_provenance ?& array['authority','producer','observedAt','evidenceId','raw'])
    or coalesce(v_provenance->>'authority','') not in ('manufacturer','merchant') or length(coalesce(v_provenance->>'evidenceId',''))=0 then raise exception 'SPEC_PROVENANCE_REQUIRED'; end if;
  if v_state='clear' and (v_provenance->>'authority'<>'merchant' or length(coalesce(v_provenance->>'intentId',''))=0) then raise exception 'SPEC_CLEAR_INTENT_REQUIRED'; end if;
 end if;
 if octet_length(p_observation::text)>350000 then raise exception 'SPEC_OBSERVATION_TOO_LARGE'; end if;
end $$;

-- expectedVersion:null creates an initial baseline only as a complete19-field batch.
-- Later writes require current per-field stateVersion, and cannot change any other field.
-- Call only after TypeScript validation and independently verified source/target readback.
create function public.persist_toptik_spec_state(p_product_gid text,p_lease_owner uuid,p_request_id uuid,p_changes jsonb,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_change jsonb; v_key text; v_count int; v_initial bool; v_row toptik_spec_private.field_state%rowtype;
 v_hash text; v_existing toptik_spec_private.receipts%rowtype; v_result jsonb:='[]'::jsonb; v_audit jsonb:='[]'::jsonb;
begin
 perform toptik_spec_private.assert_access(p_product_gid,p_lease_owner);
 if p_request_id is null or p_changes is null or jsonb_typeof(p_changes)<>'array' or jsonb_array_length(p_changes) not between 1 and 19
 or p_evidence is null or jsonb_typeof(p_evidence)<>'object' or not(p_evidence?'evidenceId') or length(coalesce(p_evidence->>'evidenceId',''))=0
 or octet_length(p_evidence::text)>1000000 then raise exception 'SPEC_STATE_REQUEST_INVALID'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('product',p_product_gid,'changes',p_changes,'evidence',p_evidence)::text,'UTF8')),'hex');
 select * into v_existing from toptik_spec_private.receipts where request_id=p_request_id;
 if found then
  if v_existing.product_gid<>p_product_gid or v_existing.request_hash<>v_hash then raise exception 'SPEC_REQUEST_ID_REUSED'; end if;
  return v_existing.result;
 end if;
 select count(*) into v_count from jsonb_array_elements(p_changes);
 if v_count<>(select count(distinct value->>'key') from jsonb_array_elements(p_changes)) then raise exception 'SPEC_DUPLICATE_FIELD'; end if;
 select not exists(select 1 from toptik_spec_private.field_state where product_gid=p_product_gid) into v_initial;
 if v_initial and jsonb_array_length(p_changes)<>19 then raise exception 'SPEC_COMPLETE_BASELINE_REQUIRED'; end if;
 for v_change in select value from jsonb_array_elements(p_changes) order by value->>'key' loop
  if jsonb_typeof(v_change)<>'object' or not(v_change ?& array['key','expectedVersion','gallery','shopify']) or (select count(*) from jsonb_object_keys(v_change))<>4 then raise exception 'SPEC_STATE_REQUEST_INVALID'; end if;
  v_key:=v_change->>'key';
  perform toptik_spec_private.assert_observation(v_key,v_change->'gallery'); perform toptik_spec_private.assert_observation(v_key,v_change->'shopify');
  select * into v_row from toptik_spec_private.field_state where product_gid=p_product_gid and field_key=v_key for update;
  if v_initial then
   if found or v_change->'expectedVersion'<>'null'::jsonb then raise exception 'SPEC_STATE_CAS_CONFLICT'; end if;
   insert into toptik_spec_private.field_state(product_gid,field_key,gallery_observation,shopify_observation)
   values(p_product_gid,v_key,v_change->'gallery',v_change->'shopify');
   v_audit:=v_audit||jsonb_build_array(jsonb_build_object('key',v_key,'before',null,'after',v_change));
   v_result:=v_result||jsonb_build_array(jsonb_build_object('key',v_key,'stateVersion',1));
  else
   if not found or jsonb_typeof(v_change->'expectedVersion')<>'number' or v_change->>'expectedVersion' !~ '^[1-9][0-9]*$'
    or (v_change->>'expectedVersion')::numeric<>v_row.state_version then raise exception 'SPEC_STATE_CAS_CONFLICT'; end if;
   update toptik_spec_private.field_state set gallery_observation=v_change->'gallery',shopify_observation=v_change->'shopify',state_version=state_version+1,updated_at=clock_timestamp()
    where product_gid=p_product_gid and field_key=v_key;
   v_audit:=v_audit||jsonb_build_array(jsonb_build_object('key',v_key,'before',to_jsonb(v_row),'after',v_change));
   v_result:=v_result||jsonb_build_array(jsonb_build_object('key',v_key,'stateVersion',v_row.state_version+1));
  end if;
 end loop;
 insert into toptik_spec_private.receipts(request_id,product_gid,request_hash,evidence,changes,result)
 values(p_request_id,p_product_gid,v_hash,p_evidence,v_audit,v_result);
 return v_result;
end $$;

do $$ declare t text; begin
 foreach t in array array['eligibility','field_state','receipts'] loop
  execute format('alter table toptik_spec_private.%I enable row level security',t);
  execute format('revoke all on toptik_spec_private.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on toptik_spec_private.%I to service_role',t);
  execute format('create policy service_read on toptik_spec_private.%I for select to service_role using(true)',t);
 end loop;
end $$;
revoke all on all functions in schema toptik_spec_private from public,anon,authenticated,service_role;
revoke all on function public.persist_toptik_spec_state(text,uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.persist_toptik_spec_state(text,uuid,uuid,jsonb,jsonb) to service_role;

-- Runtime state is separate from immutable per-side sync baselines.
alter table toptik_spec_private.field_state add column current_gallery jsonb;
alter table toptik_spec_private.field_state add column gallery_version bigint not null default 1 check(gallery_version>0);
create table toptik_spec_private.work_queue (
 product_gid text primary key references toptik_spec_private.eligibility(product_gid),
 requested_generation bigint not null default 1, completed_generation bigint not null default 0,
 claimed_generation bigint, claim_owner uuid, claim_until timestamptz,
 status text not null default 'pending' check(status in ('pending','processing','complete','failed','review')),
 attempts int not null default 0 check(attempts>=0), last_error text, updated_at timestamptz not null default clock_timestamp()
);
alter table toptik_spec_private.work_queue enable row level security;
revoke all on toptik_spec_private.work_queue from public,anon,authenticated,service_role;
grant select on toptik_spec_private.work_queue to service_role;
create policy service_read on toptik_spec_private.work_queue for select to service_role using(true);

create function public.list_toptik_spec_products() returns jsonb language sql security definer set search_path=pg_catalog,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('productGid',s.product_gid,'itemId',s.carousel_item_id,'gallerySku',s.exact_gallery_sku,'shopifySku',s.exact_shopify_sku) order by s.exact_gallery_sku),'[]'::jsonb)
 from toptik_spec_private.eligibility s join public.shopify_gallery_copy_eligibility c on c.product_gid=s.product_gid where s.enabled and c.enabled;
$$;
create function public.read_toptik_spec_state(p_product_gid text,p_lease_owner uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_identity jsonb; v_fields jsonb;
begin
 perform toptik_spec_private.assert_access(p_product_gid,p_lease_owner);
 select jsonb_build_object('productGid',s.product_gid,'variantGid',s.variant_gid,'exactSku',s.exact_shopify_sku,'itemId',s.carousel_item_id,'gallerySku',s.exact_gallery_sku,'productHandle',c.approved_product_handle)
 into v_identity from toptik_spec_private.eligibility s join public.shopify_gallery_copy_eligibility c on c.product_gid=s.product_gid where s.product_gid=p_product_gid;
 select coalesce(jsonb_agg(jsonb_build_object('key',field_key,'stateVersion',state_version,'galleryVersion',gallery_version,'galleryBaseline',gallery_observation,
 'shopifyBaseline',shopify_observation,'currentGallery',coalesce(current_gallery,gallery_observation)) order by field_key),'[]'::jsonb)
 into v_fields from toptik_spec_private.field_state where product_gid=p_product_gid;
 return jsonb_build_object('identity',v_identity,'fields',v_fields);
end $$;
create function public.enqueue_toptik_spec_work(p_product_gid text,p_reason text) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare e public.shopify_gallery_copy_eligibility%rowtype;
begin
 if p_reason not in ('gallery','shopify','recovery') then raise exception 'SPEC_QUEUE_REASON_INVALID'; end if;
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select c.* into e from public.shopify_gallery_copy_eligibility c join toptik_spec_private.eligibility s on s.product_gid=c.product_gid where c.product_gid=p_product_gid and c.enabled and s.enabled;
 if not found then return false; end if;
 perform public.assert_shopify_verified_copy_identity(e.carousel_item_id,e.catalog_key,e.exact_gallery_sku,e.product_gid,e.variant_gid,e.exact_shopify_sku);
 if (select count(*) from toptik_spec_private.field_state where product_gid=p_product_gid)<>19 then return false; end if;
 insert into toptik_spec_private.work_queue(product_gid) values(p_product_gid)
 on conflict(product_gid) do update set requested_generation=work_queue.requested_generation+1,attempts=0,last_error=null,
 status=case when work_queue.claim_until>clock_timestamp() then 'processing' else 'pending' end,updated_at=clock_timestamp();
 return true;
end $$;

create function public.edit_toptik_spec_fields(p_product_gid text,p_lease_owner uuid,p_request_id uuid,p_edits jsonb,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare e jsonb; r toptik_spec_private.field_state%rowtype; v_hash text; previous toptik_spec_private.receipts%rowtype; result jsonb:='[]'::jsonb; audit jsonb:='[]'::jsonb;
begin
 perform toptik_spec_private.assert_access(p_product_gid,p_lease_owner);
 if p_request_id is null or p_edits is null or jsonb_typeof(p_edits)<>'array' or jsonb_array_length(p_edits) not between 1 and 19
 or jsonb_typeof(p_evidence)<>'object' or not(p_evidence?'evidenceId') then raise exception 'SPEC_EDIT_INVALID'; end if;
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
  if e->'observation'->'cell'->>'state'<>'value' then raise exception 'SPEC_CLEAR_DISABLED_V1';end if;
  if e#>>'{observation,cell,provenance,authority}'<>'merchant' or e#>>'{observation,cell,provenance,producer}'<>'gallery_typed_editor'
   or e#>>'{observation,cell,provenance,evidenceId}'<>p_request_id::text then raise exception 'SPEC_EDITOR_PROVENANCE_INVALID';end if;
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

-- Commit only verified per-field baselines and observed current Gallery versions.
create function public.commit_toptik_spec_readback(p_product_gid text,p_lease_owner uuid,p_request_id uuid,p_changes jsonb,p_gallery_versions jsonb,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare change jsonb; r toptik_spec_private.field_state%rowtype; result jsonb;
begin
 perform toptik_spec_private.assert_access(p_product_gid,p_lease_owner);
 if p_gallery_versions is null or jsonb_typeof(p_gallery_versions)<>'object' then raise exception 'SPEC_EDITOR_STALE';end if;
 for change in select value from jsonb_array_elements(p_changes) loop
  select * into r from toptik_spec_private.field_state where product_gid=p_product_gid and field_key=change->>'key' for update;
  if found and (not(p_gallery_versions ? (change->>'key')) or jsonb_typeof(p_gallery_versions->(change->>'key'))<>'number' or (p_gallery_versions->>(change->>'key'))::numeric<>r.gallery_version) then raise exception 'SPEC_EDITOR_STALE';end if;
 end loop;
 result:=public.persist_toptik_spec_state(p_product_gid,p_lease_owner,p_request_id,p_changes,p_evidence);
 for change in select value from jsonb_array_elements(p_changes) loop
  update toptik_spec_private.field_state set
   gallery_version=case when coalesce(current_gallery,gallery_observation)=change->'gallery' then gallery_version else gallery_version+1 end,
   current_gallery=change->'gallery'
  where product_gid=p_product_gid and field_key=change->>'key';
 end loop;
 return result;
end $$;

create function public.claim_toptik_spec_work(p_owner uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r toptik_spec_private.work_queue%rowtype;
begin
 if p_owner is null then raise exception 'SPEC_QUEUE_OWNER_REQUIRED';end if;
 select * into r from toptik_spec_private.work_queue where status in ('pending','failed','processing') and attempts<5
 and requested_generation>completed_generation and (claim_until is null or claim_until<clock_timestamp()) order by updated_at for update skip locked limit 1;
 if not found then return null;end if;
 update toptik_spec_private.work_queue set claim_owner=p_owner,claim_until=clock_timestamp()+interval '5 minutes',claimed_generation=requested_generation,status='processing',attempts=attempts+1 where product_gid=r.product_gid;
 return jsonb_build_object('productGid',r.product_gid,'generation',r.requested_generation);
end $$;
create function public.finish_toptik_spec_work(p_product_gid text,p_owner uuid,p_generation bigint,p_status text,p_error text) returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if p_status not in ('complete','pending','failed','review') or (p_error is not null and p_error!~'^[A-Z0-9_]{1,100}$') then raise exception 'SPEC_QUEUE_RESULT_INVALID';end if;
 if p_status='pending' and coalesce(p_error,'') not in ('SPEC_PRODUCT_BUSY','SPEC_TIME_BUDGET') then raise exception 'SPEC_QUEUE_RESULT_INVALID';end if;
 update toptik_spec_private.work_queue set completed_generation=case when p_status='complete' then greatest(completed_generation,p_generation) else completed_generation end,
 status=case when p_status='complete' and requested_generation>p_generation then 'pending' else p_status end,
 attempts=case when p_status='pending' then greatest(attempts-1,0) else attempts end,
 claim_owner=null,claim_until=null,claimed_generation=null,last_error=p_error,updated_at=clock_timestamp()
 where product_gid=p_product_gid and claim_owner=p_owner and claimed_generation=p_generation and claim_until>clock_timestamp();
 if not found then raise exception 'SPEC_QUEUE_CLAIM_LOST';end if;
end $$;

revoke all on function public.list_toptik_spec_products(),public.read_toptik_spec_state(text,uuid),public.enqueue_toptik_spec_work(text,text),
 public.edit_toptik_spec_fields(text,uuid,uuid,jsonb,jsonb),public.commit_toptik_spec_readback(text,uuid,uuid,jsonb,jsonb,jsonb),
 public.claim_toptik_spec_work(uuid),public.finish_toptik_spec_work(text,uuid,bigint,text,text) from public,anon,authenticated,service_role;
grant execute on function public.list_toptik_spec_products(),public.read_toptik_spec_state(text,uuid),public.enqueue_toptik_spec_work(text,text),
 public.edit_toptik_spec_fields(text,uuid,uuid,jsonb,jsonb),public.commit_toptik_spec_readback(text,uuid,uuid,jsonb,jsonb,jsonb),
 public.claim_toptik_spec_work(uuid),public.finish_toptik_spec_work(text,uuid,bigint,text,text) to service_role;

-- Narrow public projection deliberately excludes all provenance, revisions and private commerce.
create function public.public_toptik_typed_specs() returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('itemId',q.item_id,'exactSku',q.exact_sku,'fields',q.fields)),'[]'::jsonb) from (
  select e.carousel_item_id item_id,e.exact_gallery_sku exact_sku,jsonb_object_agg(f.field_key,coalesce(f.current_gallery,f.gallery_observation)->'cell'->'value') fields
  from toptik_spec_private.eligibility e
  join public.shopify_gallery_copy_eligibility c on c.product_gid=e.product_gid and c.enabled
  join public.carousel_items i on i.id=e.carousel_item_id and i.is_active and i.catalog_number=e.exact_gallery_sku
  join public.shopify_gallery_bindings b on b.catalog_key=c.catalog_key and b.carousel_item_id=e.carousel_item_id and b.product_gid=e.product_gid and b.variant_gid=e.variant_gid and b.product_handle=c.approved_product_handle and b.is_published
  join toptik_spec_private.field_state f on f.product_gid=e.product_gid
  where e.enabled and e.carousel_item_id=c.carousel_item_id and e.variant_gid=c.variant_gid and e.exact_gallery_sku=c.exact_gallery_sku and e.exact_shopify_sku=c.exact_shopify_sku
   and coalesce(f.current_gallery,f.gallery_observation)->'cell'->>'state'='value'
   and (select count(*) from public.shopify_gallery_bindings where product_gid=e.product_gid)=1
   and (select count(*) from public.carousel_items a where regexp_replace(regexp_replace(upper(coalesce(a.catalog_number,'')),'[^A-Z0-9]','','g'),'^(P[0-9]{2}.*)TU$','\1')=c.catalog_key)=1
  group by e.carousel_item_id,e.exact_gallery_sku
 ) q;
$$;
revoke all on function public.public_toptik_typed_specs() from public;
grant execute on function public.public_toptik_typed_specs() to anon,authenticated,service_role;

-- Explicit typed approval adds no products and never modifies the frozen copy approval.
create function public.activate_toptik_spec_product(p_product_gid text,p_lease_owner uuid,p_expected jsonb,p_approval_id text,p_evidence jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare c public.shopify_gallery_copy_eligibility%rowtype; previous toptik_spec_private.eligibility%rowtype;
begin
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 if p_expected is null or jsonb_typeof(p_expected)<>'object' or not(p_expected ?& array['itemId','variantId','exactGallerySku','exactShopifySku','productHandle'])
  or (select count(*) from jsonb_object_keys(p_expected))<>5
  or exists(select 1 from jsonb_each(p_expected) where jsonb_typeof(value)<>'string' or length(btrim(value#>>'{}'))=0)
  or length(coalesce(p_approval_id,'')) not between 1 and 128
  or p_evidence is null or jsonb_typeof(p_evidence)<>'object' or length(coalesce(p_evidence->>'evidenceId','')) not between 1 and 256
  or octet_length(p_evidence::text)>10000 then raise exception 'SPEC_ACTIVATION_INVALID';end if;
 select * into c from public.shopify_gallery_copy_eligibility where product_gid=p_product_gid and enabled for update;
 if not found or c.carousel_item_id::text<>p_expected->>'itemId' or c.variant_gid<>p_expected->>'variantId'
  or c.exact_gallery_sku<>p_expected->>'exactGallerySku' or c.exact_shopify_sku<>p_expected->>'exactShopifySku'
  or c.approved_product_handle<>p_expected->>'productHandle' then raise exception 'SPEC_APPROVAL_MISSING_OR_CHANGED';end if;
 perform public.assert_shopify_verified_copy_identity(c.carousel_item_id,c.catalog_key,c.exact_gallery_sku,c.product_gid,c.variant_gid,c.exact_shopify_sku);
 perform 1 from public.shopify_gallery_reconciliation_leases where product_gid=p_product_gid and owner=p_lease_owner and expires_at>clock_timestamp() for update;
 if not found then raise exception 'SPEC_LEASE_LOST';end if;
 select * into previous from toptik_spec_private.eligibility where product_gid=p_product_gid for update;
 if found then
  if previous.carousel_item_id<>c.carousel_item_id or previous.variant_gid<>c.variant_gid or previous.exact_gallery_sku<>c.exact_gallery_sku
   or previous.exact_shopify_sku<>c.exact_shopify_sku or previous.approval_id<>p_approval_id or previous.approval_evidence<>p_evidence or not previous.enabled
   then raise exception 'SPEC_APPROVAL_MISSING_OR_CHANGED';end if;
  return false;
 end if;
 insert into toptik_spec_private.eligibility(product_gid,carousel_item_id,variant_gid,exact_gallery_sku,exact_shopify_sku,approval_id,approval_evidence,enabled)
 values(c.product_gid,c.carousel_item_id,c.variant_gid,c.exact_gallery_sku,c.exact_shopify_sku,p_approval_id,p_evidence,true);
 return true;
end $$;
create function public.toptik_spec_queue_status() returns jsonb language sql security definer set search_path=pg_catalog,pg_temp as $$
 select jsonb_build_object('pending',count(*) filter(where status in ('pending','failed','processing') and attempts<5 and requested_generation>completed_generation and (claim_until is null or claim_until<clock_timestamp())),
 'failed',count(*) filter(where status='failed'),'review',count(*) filter(where status='review'),'processing',count(*) filter(where status='processing' and claim_until>clock_timestamp()))
 from toptik_spec_private.work_queue;
$$;
create function public.recover_toptik_spec_work() returns integer language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare c record; n integer:=0;
begin
 for c in select e.product_gid from toptik_spec_private.eligibility e join public.shopify_gallery_copy_eligibility p using(product_gid)
 where e.enabled and p.enabled and (select count(*) from toptik_spec_private.field_state f where f.product_gid=e.product_gid)=19
 and not exists(select 1 from toptik_spec_private.work_queue q where q.product_gid=e.product_gid and
  (q.requested_generation>q.completed_generation or q.claim_until>clock_timestamp()))
 order by coalesce((select q.updated_at from toptik_spec_private.work_queue q where q.product_gid=e.product_gid),'-infinity'::timestamptz) limit 100 loop
  begin
   if public.enqueue_toptik_spec_work(c.product_gid,'recovery') then n:=n+1;end if;
  exception when raise_exception then
   if sqlerrm not in ('SYNC_COPY_APPROVAL_MISSING_OR_CHANGED','SPEC_APPROVAL_MISSING_OR_CHANGED') then raise;end if;
  end;
 end loop;
 return n;
end $$;
revoke all on function public.activate_toptik_spec_product(text,uuid,jsonb,text,jsonb),public.toptik_spec_queue_status(),public.recover_toptik_spec_work() from public,anon,authenticated,service_role;
grant execute on function public.activate_toptik_spec_product(text,uuid,jsonb,text,jsonb),public.toptik_spec_queue_status(),public.recover_toptik_spec_work() to service_role;
