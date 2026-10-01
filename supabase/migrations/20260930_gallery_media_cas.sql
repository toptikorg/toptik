-- Apply after media_transport_runtime. No bootstrap/enable/catalog rewrite.
alter table public.carousel_items add column cover_image_alt text null check(length(cover_image_alt)<=512);
alter table public.carousel_item_angles add column image_alt text null check(length(image_alt)<=512);
create table toptik_media_private.gallery_versions(item_id uuid primary key references public.carousel_items(id) on delete cascade,version bigint not null check(version>0));
create table toptik_media_private.gallery_observations(
 product_gid text not null references toptik_media_private.products(product_gid),revision text not null,
 raw jsonb not null,refs jsonb not null,snapshot jsonb not null,created_at timestamptz not null default clock_timestamp(),primary key(product_gid,revision));
create table toptik_media_private.gallery_commits(
 operation_id uuid not null,step_index int not null,phase_index int not null,attempt_id uuid not null,request_id uuid not null unique,
 product_gid text not null,request_hash text not null,before_revision text not null,after_raw jsonb not null,refs jsonb not null,snapshot jsonb not null,
 created_at timestamptz not null default clock_timestamp(),primary key(operation_id,step_index,phase_index),
 foreign key(operation_id,step_index,phase_index) references toptik_media_private.transport_attempts(operation_id,step_index,phase_index));
create trigger immutable_record before update or delete on toptik_media_private.gallery_observations for each row execute function toptik_media_private.immutable();
create trigger immutable_record before update or delete on toptik_media_private.gallery_commits for each row execute function toptik_media_private.immutable();

-- Covers every ordinary editor/SQL media write, not just this adapter. The same
-- advisory lock also excludes angle phantoms while the item's CAS is in progress.
create function toptik_media_private.gallery_media_changed() returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare item uuid;changed bool;
begin
 if tg_table_name='carousel_items' then
  changed:=old.cover_image_path is distinct from new.cover_image_path or old.cover_image_alt is distinct from new.cover_image_alt or old.title is distinct from new.title;
  item:=new.id;
 else
  if tg_op='UPDATE' and old.item_id<>new.item_id then raise exception 'MEDIA_GALLERY_ANGLE_REPARENT_FORBIDDEN';end if;
  changed:=tg_op<>'UPDATE' or to_jsonb(old) is distinct from to_jsonb(new);item:=case when tg_op='DELETE' then old.item_id else new.item_id end;
 end if;
 if changed then
  perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  perform 1 from public.carousel_items where id=item for update;
  if found then insert into toptik_media_private.gallery_versions values(item,2) on conflict(item_id) do update set version=gallery_versions.version+1;end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger gallery_media_version before update on public.carousel_items for each row execute function toptik_media_private.gallery_media_changed();
create trigger gallery_media_version before insert or update or delete on public.carousel_item_angles for each row execute function toptik_media_private.gallery_media_changed();

create function toptik_media_private.gallery_raw(i jsonb) returns jsonb language plpgsql set search_path=pg_catalog,pg_temp as $$
declare r jsonb;v bigint;
begin
 select jsonb_build_object('identity',i,'item',to_jsonb(c),'angles',(select coalesce(jsonb_agg(to_jsonb(a) order by angle_order,id),'[]'::jsonb) from public.carousel_item_angles a where a.item_id=c.id))
 into r from public.carousel_items c where c.id=(i->>'itemId')::uuid and c.catalog_number=i->>'exactGallerySku';
 if r is null or r#>'{item,is_active}' is distinct from 'true'::jsonb then raise exception 'MEDIA_GALLERY_IDENTITY_CHANGED';end if;
 if jsonb_array_length(r->'angles')>30 then raise exception 'MEDIA_GALLERY_ANGLE_LIMIT';end if;
 select version into v from toptik_media_private.gallery_versions where item_id=(i->>'itemId')::uuid;
 r:=r||jsonb_build_object('version',coalesce(v,1));return r||jsonb_build_object('revision',toptik_media_private.digest(r));
end $$;
create function public.read_toptik_gallery_media(p_product_gid text,p_lease_owner uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;begin i:=toptik_media_private.assert_copy_identity(p_product_gid,p_lease_owner);return toptik_media_private.gallery_raw(i);end $$;

-- Explicit role/angle UUID references come only from the private service's
-- decoded provenance. A URL, filename or array position never creates a key.
create function toptik_media_private.gallery_snapshot(raw jsonb,refs jsonb) returns jsonb language plpgsql set search_path=pg_catalog,pg_temp as $$
declare i jsonb:=raw->'identity';r jsonb;a jsonb;p toptik_media_private.provenance%rowtype;assets jsonb:='[]';entry jsonb;cover_key text;cover_entry jsonb;path text;alt text;n int;
begin
 if jsonb_typeof(refs) is distinct from 'array' or jsonb_array_length(refs)<>jsonb_array_length(raw->'angles')+1 then raise exception 'MEDIA_GALLERY_REFERENCES_INCOMPLETE';end if;
 for r,n in select value,ordinality::int from jsonb_array_elements(refs) with ordinality loop
  if jsonb_typeof(r) is distinct from 'object' or not(r ?& array['role','angleId','key','evidenceId']) or (select count(*) from jsonb_object_keys(r))<>4 then raise exception 'MEDIA_GALLERY_REFERENCE_INVALID';end if;
  if n=1 then
   if r->>'role' is distinct from 'cover' or r->'angleId' is distinct from 'null'::jsonb then raise exception 'MEDIA_GALLERY_REFERENCE_INVALID';end if;
   path:=raw#>>'{item,cover_image_path}';alt:=coalesce(raw#>>'{item,cover_image_alt}',raw#>>'{item,title}');cover_key:=r->>'key';
  else
   a:=raw->'angles'->(n-2);
   if r->>'role' is distinct from 'angle' or r->>'angleId' is distinct from a->>'id' then raise exception 'MEDIA_GALLERY_REFERENCE_INVALID';end if;
   path:=a->>'image_path';alt:=coalesce(a->>'image_alt',raw#>>'{item,title}');
  end if;
  select * into p from toptik_media_private.provenance where evidence_id=r->>'evidenceId' and product_gid=i->>'productId' and side='gallery' and asset_key=r->>'key';
  if not found or p.proof->>'url' is distinct from path then raise exception 'MEDIA_GALLERY_PROVENANCE_MISMATCH';end if;
  entry:=jsonb_build_object('key',p.asset_key,'contentId',p.content_id,'alt',alt,'evidenceId',p.evidence_id);
  if n=1 then cover_entry:=entry;
  else
   if exists(select 1 from jsonb_array_elements(assets) x where x->>'key'=p.asset_key) then raise exception 'MEDIA_GALLERY_DUPLICATE_ANGLE_KEY';end if;
   if p.asset_key=cover_key and entry is distinct from cover_entry then raise exception 'MEDIA_GALLERY_COVER_ALIAS_CONFLICT';end if;
   assets:=assets||jsonb_build_array(entry);
  end if;
 end loop;
 if not exists(select 1 from jsonb_array_elements(assets) x where x->>'key'=cover_key) then assets:=jsonb_build_array(cover_entry)||assets;end if;
 entry:=jsonb_build_object('identity',i,'side','gallery','revision',raw->>'revision','complete',true,'assets',assets);
 perform toptik_media_private.assert_snapshot(entry,'gallery',i);return entry;
end $$;
create function public.observe_toptik_gallery_media(p_product_gid text,p_lease_owner uuid,p_expected_revision text,p_refs jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;raw jsonb;s jsonb;old toptik_media_private.gallery_observations%rowtype;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner,false);raw:=toptik_media_private.gallery_raw(i);
 if raw->>'revision' is distinct from p_expected_revision then raise exception 'MEDIA_GALLERY_CAS_CHANGED';end if;
 s:=toptik_media_private.gallery_snapshot(raw,p_refs);
 select * into old from toptik_media_private.gallery_observations where product_gid=p_product_gid and revision=p_expected_revision;
 if found then if old.raw<>raw or old.refs<>p_refs or old.snapshot<>s then raise exception 'MEDIA_GALLERY_OBSERVATION_REUSED';end if;
 else insert into toptik_media_private.gallery_observations(product_gid,revision,raw,refs,snapshot) values(p_product_gid,p_expected_revision,raw,p_refs,s);end if;
 return jsonb_build_object('raw',raw,'refs',p_refs,'snapshot',s);
end $$;

-- Read-only source port for an already bootstrapped product. Reuses explicit
-- immutable row roles; unknown/new URLs require fresh decoded provenance.
create function public.read_toptik_gallery_media_snapshot(p_product_gid text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare e public.shopify_gallery_copy_eligibility%rowtype;i jsonb;raw jsonb;refs jsonb;old_refs jsonb;
begin
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into e from public.shopify_gallery_copy_eligibility where product_gid=p_product_gid and enabled;
 if not found then raise exception 'MEDIA_APPROVAL_MISSING_OR_CHANGED';end if;
 perform public.assert_shopify_verified_copy_identity(e.carousel_item_id,e.catalog_key,e.exact_gallery_sku,e.product_gid,e.variant_gid,e.exact_shopify_sku);
 i:=jsonb_build_object('productId',e.product_gid,'variantId',e.variant_gid,'itemId',e.carousel_item_id,'exactGallerySku',e.exact_gallery_sku,'exactShopifySku',e.exact_shopify_sku,'productHandle',e.approved_product_handle);
 if not exists(select 1 from toptik_media_private.products where product_gid=p_product_gid and enabled and identity=i) then raise exception 'MEDIA_APPROVAL_MISSING_OR_CHANGED';end if;
 select x.refs into old_refs from toptik_media_private.gallery_observations x where product_gid=p_product_gid order by created_at desc,revision limit 1;
 if old_refs is null then raise exception 'MEDIA_GALLERY_BOOTSTRAP_REQUIRED';end if;
 raw:=toptik_media_private.gallery_raw(i);
 select jsonb_build_array(old_refs->0)||coalesce(jsonb_agg(b.r order by a.n) filter(where b.r is not null),'[]'::jsonb) into refs
 from jsonb_array_elements(raw->'angles') with ordinality a(x,n) left join lateral(select y from jsonb_array_elements(old_refs) y where y->>'role'='angle' and y->>'angleId'=a.x->>'id') b(r) on true;
 return toptik_media_private.gallery_snapshot(raw,refs);
end $$;

create function public.apply_toptik_gallery_media_cas(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_phase_index int,
 p_attempt_id uuid,p_request_id uuid,p_request_hash text,p_fresh_guard jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;t toptik_media_private.transport_attempts%rowtype;c toptik_media_private.transport_chains%rowtype;
 obs toptik_media_private.gallery_observations%rowtype;prior toptik_media_private.gallery_commits%rowtype;raw jsonb;refs jsonb;after_raw jsonb;after_snapshot jsonb;
 kind text;k text;value jsonb;artifact jsonb;source_proof jsonb;proof jsonb;evidence text;r jsonb;new_angle uuid;cover_key text;n int;angle_id uuid;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if p_request_id is null or p_attempt_id is null or coalesce(p_request_hash,'')!~'^[a-f0-9]{64}$' then raise exception 'MEDIA_GALLERY_REQUEST_INVALID';end if;
 select * into prior from toptik_media_private.gallery_commits where operation_id=p_operation_id and step_index=p_step_index and phase_index=p_phase_index;
 if found then
  if prior.product_gid<>p_product_gid or prior.attempt_id<>p_attempt_id or prior.request_id<>p_request_id or prior.request_hash<>p_request_hash then raise exception 'MEDIA_GALLERY_REQUEST_REUSED';end if;
  return jsonb_build_object('applied',true,'replayed',true,'raw',prior.after_raw,'refs',prior.refs,'snapshot',prior.snapshot);
 end if;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 select * into c from toptik_media_private.transport_chains where operation_id=o.id and step_index=p_step_index for update;
 select * into t from toptik_media_private.transport_attempts where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index for update;
 if o.id is null or s.body->>'target' is distinct from 'gallery' or o.status not in ('running','uncertain') or s.status not in ('started','uncertain')
  or c.next_phase is distinct from p_phase_index or c.status not in ('ready','running','uncertain') or t.phase is distinct from 'gallery_cas'
  or t.status is distinct from 'started' or t.attempt_id is distinct from p_attempt_id or t.request_hash is distinct from p_request_hash then raise exception 'MEDIA_GALLERY_PERMIT_REQUIRED';end if;
 perform toptik_media_private.assert_transport_guard(p_fresh_guard,i,'gallery');
 if p_fresh_guard-'observedAt' is distinct from t.before_guard-'observedAt' then raise exception 'MEDIA_GALLERY_SOURCE_CHANGED';end if;
 raw:=toptik_media_private.gallery_raw(i);
 select * into obs from toptik_media_private.gallery_observations where product_gid=p_product_gid and revision=t.request->>'expectedRevision';
 if not found or obs.raw is distinct from raw or obs.snapshot is distinct from t.before_guard->'target'
  or raw->>'revision' is distinct from t.request->>'expectedRevision' then raise exception 'MEDIA_GALLERY_CAS_CHANGED';end if;
 refs:=obs.refs;kind:=s.body->>'kind';k:=s.body->>'key';value:=toptik_media_private.asset(s.expected_pair->'gallery',k);cover_key:=refs->0->>'key';
 if kind in ('attach','replace_reference') then
  select ta.artifact,tr.request into artifact,source_proof from toptik_media_private.transport_artifacts ta join toptik_media_private.transport_attempts tr using(operation_id,step_index,phase_index)
  where ta.operation_id=o.id and ta.step_index=p_step_index and ta.phase_index<p_phase_index and tr.phase='gallery_upload' and tr.status='verified' order by ta.phase_index desc limit 1;
  if artifact is null or artifact->>'contentId' is distinct from value->>'contentId' or artifact->'ready' is distinct from 'true'::jsonb then raise exception 'MEDIA_GALLERY_UPLOAD_REQUIRED';end if;
  evidence:='gallery:'||o.id::text||':'||p_step_index;
  proof:=jsonb_build_object('platformRef',artifact->>'storagePath','url',artifact->>'url','decodedSha256',artifact->>'decodedSha256','mime',artifact->>'mime',
   'width',artifact->'width','height',artifact->'height','byteLength',artifact->'byteLength','verifiedAt',clock_timestamp(),'ownership','owned_storage');
  if artifact->>'contentId'<>artifact->>'decodedSha256' then proof:=proof||jsonb_build_object('sourceEvidenceId',source_proof->>'sourceEvidenceId','operationId',o.id);end if;
  perform toptik_media_private.register(p_product_gid,jsonb_build_array(jsonb_build_object('evidenceId',evidence,'key',k,'side','gallery','contentId',value->>'contentId','proof',proof)));
 end if;
 if kind='attach' then
  if jsonb_array_length(raw->'angles')>=30 or exists(select 1 from jsonb_array_elements(refs) x where x->>'key'=k) then raise exception 'MEDIA_GALLERY_ATTACH_INVALID';end if;
  new_angle:=gen_random_uuid();insert into public.carousel_item_angles(id,item_id,angle_key,image_path,angle_order,image_alt)
   values(new_angle,(i->>'itemId')::uuid,'sync-'||left(replace(new_angle::text,'-',''),27),artifact->>'url',31,value->>'alt');
  refs:=refs||jsonb_build_array(jsonb_build_object('role','angle','angleId',new_angle,'key',k,'evidenceId',evidence));
 elsif kind='replace_reference' then
  if not exists(select 1 from jsonb_array_elements(refs) x where x->>'key'=k) then raise exception 'MEDIA_GALLERY_ASSET_MISSING';end if;
  if cover_key=k then update public.carousel_items set cover_image_path=artifact->>'url' where id=(i->>'itemId')::uuid;end if;
  update public.carousel_item_angles set image_path=artifact->>'url' where item_id=(i->>'itemId')::uuid and id in(select (x->>'angleId')::uuid from jsonb_array_elements(refs) x where x->>'key'=k and x->>'role'='angle');
  select jsonb_agg(case when x->>'key'=k then x||jsonb_build_object('evidenceId',evidence) else x end order by a.n) into refs from jsonb_array_elements(refs) with ordinality a(x,n);
 elsif kind='alt' then
  if not exists(select 1 from jsonb_array_elements(refs) x where x->>'key'=k) then raise exception 'MEDIA_GALLERY_ASSET_MISSING';end if;
  if cover_key=k then update public.carousel_items set cover_image_alt=value->>'alt' where id=(i->>'itemId')::uuid;end if;
  update public.carousel_item_angles set image_alt=value->>'alt' where item_id=(i->>'itemId')::uuid and id in(select (x->>'angleId')::uuid from jsonb_array_elements(refs) x where x->>'key'=k and x->>'role'='angle');
 elsif kind='detach_reference' then
  if cover_key=k then raise exception 'MEDIA_GALLERY_COVER_REMOVAL_REQUIRES_SELECTION';end if;
  delete from public.carousel_item_angles where item_id=(i->>'itemId')::uuid and id in(select (x->>'angleId')::uuid from jsonb_array_elements(refs) x where x->>'key'=k and x->>'role'='angle');
  select jsonb_agg(x order by a.n) into refs from jsonb_array_elements(refs) with ordinality a(x,n) where x->>'key'<>k;
 elsif kind<>'reorder' then raise exception 'MEDIA_GALLERY_PATCH_UNSUPPORTED';end if;
 if kind in ('attach','reorder') then
  if not exists(select 1 from jsonb_array_elements(refs) x where x->>'role'='angle' and x->>'key'=cover_key)
   and s.expected_pair#>>'{gallery,assets,0,key}' is distinct from cover_key then raise exception 'MEDIA_GALLERY_COVER_ORDER_PROTECTED';end if;
  n:=0;for r in select x from jsonb_array_elements(s.expected_pair#>'{gallery,assets}') x loop
   select (x->>'angleId')::uuid into angle_id from jsonb_array_elements(refs) x where x->>'role'='angle' and x->>'key'=r->>'key';
   if found then n:=n+1;update public.carousel_item_angles set angle_order=n where id=angle_id and item_id=(i->>'itemId')::uuid and angle_order<>n;end if;
  end loop;
 end if;
 after_raw:=toptik_media_private.gallery_raw(i);
 select jsonb_build_array(refs->0)||coalesce(jsonb_agg(b.r order by a.n) filter(where b.r is not null),'[]'::jsonb) into refs
 from jsonb_array_elements(after_raw->'angles') with ordinality a(x,n) left join lateral(select y from jsonb_array_elements(refs) y where y->>'role'='angle' and y->>'angleId'=a.x->>'id') b(r) on true;
 after_snapshot:=toptik_media_private.gallery_snapshot(after_raw,refs);
 if toptik_media_private.semantic(after_snapshot) is distinct from toptik_media_private.semantic(s.expected_pair->'gallery') then raise exception 'MEDIA_GALLERY_PLANNED_RESULT_MISMATCH';end if;
 insert into toptik_media_private.gallery_observations(product_gid,revision,raw,refs,snapshot) values(p_product_gid,after_raw->>'revision',after_raw,refs,after_snapshot) on conflict do nothing;
 select * into obs from toptik_media_private.gallery_observations x where x.product_gid=p_product_gid and x.revision=after_raw->>'revision';
 if not found or obs.raw<>after_raw or obs.refs<>refs or obs.snapshot<>after_snapshot then raise exception 'MEDIA_GALLERY_OBSERVATION_REUSED';end if;
 insert into toptik_media_private.gallery_commits(operation_id,step_index,phase_index,attempt_id,request_id,product_gid,request_hash,before_revision,after_raw,refs,snapshot)
 values(o.id,p_step_index,p_phase_index,p_attempt_id,p_request_id,p_product_gid,p_request_hash,raw->>'revision',after_raw,refs,after_snapshot);
 update toptik_media_private.transport_attempts set status='uncertain',receipt=jsonb_build_object('outcome','accepted') where operation_id=o.id and step_index=p_step_index and phase_index=p_phase_index;
 update toptik_media_private.transport_chains set status='uncertain' where operation_id=o.id and step_index=p_step_index;
 update toptik_media_private.operations set status='uncertain' where id=o.id;
 return jsonb_build_object('applied',true,'replayed',false,'raw',after_raw,'refs',refs,'snapshot',after_snapshot);
end $$;
create function public.read_toptik_gallery_media_commit(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_phase_index int) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;c toptik_media_private.gallery_commits%rowtype;r jsonb;begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);select * into c from toptik_media_private.gallery_commits where product_gid=p_product_gid and operation_id=p_operation_id and step_index=p_step_index and phase_index=p_phase_index;
 if not found then return null;end if;r:=toptik_media_private.gallery_raw(i);
 return jsonb_build_object('applied',true,'requestId',c.request_id,'attemptId',c.attempt_id,'requestHash',c.request_hash,'raw',c.after_raw,'refs',c.refs,'snapshot',c.snapshot,'currentRaw',r,'readbackMatches',r=c.after_raw);
end $$;
do $$ declare t text;fn record;begin
 foreach t in array array['gallery_versions','gallery_observations','gallery_commits'] loop
  execute format('alter table toptik_media_private.%I enable row level security',t);execute format('revoke all on toptik_media_private.%I from public,anon,authenticated,service_role',t);
 end loop;
 for fn in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('read_toptik_gallery_media','observe_toptik_gallery_media','read_toptik_gallery_media_snapshot','apply_toptik_gallery_media_cas','read_toptik_gallery_media_commit') loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.sig);execute format('grant execute on function %s to service_role',fn.sig);
 end loop;
end $$;
revoke all on all functions in schema toptik_media_private from public,anon,authenticated,service_role;

