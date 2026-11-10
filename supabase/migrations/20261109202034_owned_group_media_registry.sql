-- Group-scoped media registry for the two reviewed multi-color products. No live data seed or native mutation.
begin;
create schema if not exists toptik_owned_media_private;
revoke all on schema toptik_owned_media_private from public,anon,authenticated,service_role;
alter default privileges in schema toptik_owned_media_private revoke execute on functions from public;
create table toptik_owned_media_private.registry(
 product_gid text primary key,binding jsonb not null,map_version bigint not null check(map_version>0),
 source_fingerprint text not null,source_snapshot jsonb not null,manifest jsonb not null,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
create table toptik_owned_media_private.operations(
 id uuid primary key,product_gid text not null references toptik_owned_media_private.registry(product_gid),
 request_hash text not null,map_version bigint not null,source_fingerprint text not null,
 command jsonb not null,actor jsonb not null,plan jsonb not null,phases jsonb not null,expected_cards jsonb not null,
 work_owner uuid,work_claim uuid,work_expires timestamptz,next_work_at timestamptz not null default clock_timestamp(),work_error text,
 before_graph jsonb not null,cursor_graph jsonb not null,next_phase integer not null default 0,
 status text not null check(status in('prepared','running','uncertain','review','verified','cancelled')),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
create unique index owned_media_active_operation on toptik_owned_media_private.operations(product_gid)
 where status in('prepared','running','uncertain','review');
create table toptik_owned_media_private.phase_attempts(
 operation_id uuid not null references toptik_owned_media_private.operations(id),phase_index integer not null,
 attempt_id uuid unique not null,request_hash text not null,request jsonb not null,before_graph jsonb not null,
 status text not null check(status in('started','uncertain','verified','review')),artifact jsonb,
 observed_graph jsonb,created_at timestamptz not null default clock_timestamp(),verified_at timestamptz,
 primary key(operation_id,phase_index)
);
create table toptik_owned_media_private.phase_evidence(
 operation_id uuid not null references toptik_owned_media_private.operations(id),phase_index integer not null,evidence_hash text not null,
 action text not null check(action in('review','uncertain')),observed_graph jsonb,artifact jsonb,created_at timestamptz not null default clock_timestamp(),
 primary key(operation_id,phase_index,evidence_hash)
);
create table toptik_owned_media_private.removal_intents(
 id uuid primary key default gen_random_uuid(),operation_id uuid not null references toptik_owned_media_private.operations(id),
 item_id uuid not null,variant_gid text not null,media_gid text not null,before_fingerprint text not null,
 created_at timestamptz not null default clock_timestamp(),unique(operation_id,item_id,media_gid)
);
create table toptik_owned_media_private.events(
 request_id uuid primary key,product_gid text not null,kind text not null,request_hash text not null,
 before_state jsonb not null,after_state jsonb not null,evidence jsonb not null,created_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin foreach t in array array['registry','operations','phase_attempts','phase_evidence','removal_intents','events'] loop
 execute format('alter table toptik_owned_media_private.%I enable row level security',t);
 execute format('revoke all on toptik_owned_media_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
create function toptik_owned_media_private.canonical(j jsonb) returns text language plpgsql immutable set search_path=pg_catalog,pg_temp as $$
declare r text;begin
 if jsonb_typeof(j)='object' then select '{'||coalesce(string_agg(to_jsonb(k)::text||':'||toptik_owned_media_private.canonical(v),',' order by k collate "C"),'')||'}' into r from jsonb_each(j)x(k,v);
 elsif jsonb_typeof(j)='array' then select '['||coalesce(string_agg(toptik_owned_media_private.canonical(v),',' order by n),'')||']' into r from jsonb_array_elements(j)with ordinality x(v,n);
 else r:=j::text;end if;return r;end$$;
create function toptik_owned_media_private.digest(j jsonb) returns text language sql immutable set search_path=pg_catalog,pg_temp as $$
 select encode(sha256(convert_to(toptik_owned_media_private.canonical(j),'UTF8')),'hex')$$;
create function toptik_owned_media_private.binding(p text) returns jsonb language sql immutable set search_path=pg_catalog,pg_temp as $$
 select case p when 'gid://shopify/Product/7524873044218' then '{"productGid":"gid://shopify/Product/7524873044218","handle":"תיק-פאוץ-מעור-קלאסי-מבית-מנדרינה-דאק","variants":[{"itemId":"341df0c7-7a31-4e77-87c0-a683082c3cd7","variantGid":"gid://shopify/ProductVariant/42361904398586","sku":"P10FZT73001"},{"itemId":"78e341a9-90f8-4b5a-a215-8bdf5f4f5321","variantGid":"gid://shopify/ProductVariant/42449044799738","sku":"P10FZT7308Q"},{"itemId":"7bd35662-0989-4b96-aafd-f6a77ba6d72f","variantGid":"gid://shopify/ProductVariant/42449044832506","sku":"P10FZT7324B"},{"itemId":"8890d9f2-d927-42e2-9006-f287a46ef137","variantGid":"gid://shopify/ProductVariant/42449044865274","sku":"P10FZT7327D"}]}'::jsonb
when 'gid://shopify/Product/7512404951290' then '{"productGid":"gid://shopify/Product/7512404951290","handle":"md-20-תיק-פאוץ-מבית-מנדרינה-דאק","variants":[{"itemId":"e78b4341-95ae-56e2-ba11-58c2d1e15f8e","variantGid":"gid://shopify/ProductVariant/42307603103994","sku":"P10QMMM1651"},{"itemId":"973d074a-ace0-5225-90e6-8f348d9b3e1c","variantGid":"gid://shopify/ProductVariant/42307603136762","sku":"P10QMMM1465"},{"itemId":"63110328-f35d-5247-8793-48abc8450124","variantGid":"gid://shopify/ProductVariant/42307603169530","sku":"P10QMMM109K"}]}'::jsonb else null end$$;
create function toptik_owned_media_private.lease(p text,o uuid) returns timestamptz language plpgsql set search_path=pg_catalog,pg_temp as $$
declare e timestamptz;begin
 if toptik_owned_media_private.binding(p) is null or o is null then raise exception 'OWNED_MEDIA_IDENTITY_INVALID';end if;
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select expires_at into e from public.shopify_gallery_reconciliation_leases where product_gid=p and owner=o for update;
 if e is null or e<=clock_timestamp() then raise exception 'OWNED_MEDIA_LEASE_REQUIRED';end if;return e;end$$;
-- Review observations may record withdrawal/processing; they can never authorize a mutation or projection.
create function toptik_owned_media_private.assert_observation(p text,s jsonb)returns void language plpgsql set search_path=pg_catalog,pg_temp as $$begin
 if jsonb_typeof(s)is distinct from'object'or s->>'schemaVersion'is distinct from'1'or s->'binding'is distinct from toptik_owned_media_private.binding(p)
  or s->'product'->>'productGid'is distinct from p or s->'product'->>'handle'is distinct from s->'binding'->>'handle'
  or coalesce(s->'product'->>'status','')not in('ACTIVE','DRAFT','ARCHIVED','UNLISTED')or jsonb_typeof(s->'product'->'publishedOnPublication')is distinct from'boolean'
  or jsonb_typeof(s->'media')is distinct from'array'or jsonb_array_length(s->'media')>250 or jsonb_typeof(s->'variants')is distinct from'array'or jsonb_array_length(s->'variants')>250
  or s->>'fingerprint'is distinct from toptik_owned_media_private.digest((s-'fingerprint')#-'{product,updatedAt}')
 then raise exception'OWNED_MEDIA_OBSERVATION_INVALID';end if;end$$;
create function toptik_owned_media_private.assert_source(p text,s jsonb) returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
declare v jsonb;m jsonb;ids jsonb;fp text;begin
 if jsonb_typeof(s) is distinct from 'object' or s->>'schemaVersion'is distinct from'1' or s->'binding' is distinct from toptik_owned_media_private.binding(p)
  or s->'product'->>'productGid' is distinct from p or s->'product'->>'handle' is distinct from s->'binding'->>'handle'
  or s->'product'->>'status' is distinct from 'ACTIVE' or s->'product'->'publishedOnPublication' is distinct from 'true'::jsonb
  or jsonb_typeof(s->'media') is distinct from 'array' or jsonb_array_length(s->'media') not between 1 and 250
  or jsonb_typeof(s->'variants') is distinct from 'array' or jsonb_array_length(s->'variants') not between 1 and 250
  or coalesce(s->>'fingerprint','')!~'^[a-f0-9]{64}$'
 then raise exception 'OWNED_MEDIA_SOURCE_INVALID';end if;
 fp:=toptik_owned_media_private.digest((s-'fingerprint') #- '{product,updatedAt}');
 if fp is distinct from s->>'fingerprint' then raise exception 'OWNED_MEDIA_SOURCE_FINGERPRINT_INVALID';end if;
 if (select count(distinct x->>'mediaId') from jsonb_array_elements(s->'media')x)<>jsonb_array_length(s->'media')
  or (select count(distinct x->'image'->>'url') from jsonb_array_elements(s->'media')x)<>jsonb_array_length(s->'media')
  or (select count(distinct x->>'variantGid') from jsonb_array_elements(s->'variants')x)<>jsonb_array_length(s->'variants')
 then raise exception 'OWNED_MEDIA_SOURCE_INVALID';end if;
 for m in select value from jsonb_array_elements(s->'media')loop
  if coalesce(m->>'mediaId','')!~'^gid://shopify/MediaImage/[1-9][0-9]*$' or m->>'status' is distinct from 'READY' or m->>'fileStatus' is distinct from 'READY'
   or jsonb_typeof(m->'image') is distinct from 'object' or coalesce(m->'image'->>'url','') not like 'https://cdn.shopify.com/s/files/%'
   or coalesce(m->'image'->>'width','')!~'^[1-9][0-9]*$' or coalesce(m->'image'->>'height','')!~'^[1-9][0-9]*$'
  then raise exception 'OWNED_MEDIA_SOURCE_NOT_READY';end if;
 end loop;
 for v in select value from jsonb_array_elements(s->'binding'->'variants')loop
  if (select count(*) from jsonb_array_elements(s->'variants')x where x->>'variantGid'=v->>'variantGid' and x->>'sku'=v->>'sku')<>1 then raise exception 'OWNED_MEDIA_IDENTITY_INVALID';end if;
 end loop;
 for v in select value from jsonb_array_elements(s->'variants')loop
  if jsonb_typeof(v->'mediaIds') is distinct from 'array' or (select count(distinct x) from jsonb_array_elements_text(v->'mediaIds')x)<>jsonb_array_length(v->'mediaIds')
   or exists(select 1 from jsonb_array_elements_text(v->'mediaIds')x where not exists(select 1 from jsonb_array_elements(s->'media')photo where photo->>'mediaId'=x))
  then raise exception 'OWNED_MEDIA_SOURCE_INVALID';end if;
 end loop;
end$$;
create function toptik_owned_media_private.assert_manifest(p text,s jsonb,m jsonb) returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
declare b jsonb;v jsonb;all_ids jsonb;id text;begin
 perform toptik_owned_media_private.assert_source(p,s);b:=toptik_owned_media_private.binding(p);
 select jsonb_agg(x->>'mediaId' order by n) into all_ids from jsonb_array_elements(s->'media')with ordinality a(x,n);
 if jsonb_typeof(m) is distinct from 'object' or m->>'schemaVersion'is distinct from'1' or m->>'productGid' is distinct from p or m->>'handle' is distinct from b->>'handle'
  or m->'globalOrder' is distinct from all_ids or jsonb_typeof(m->'variants') is distinct from 'array'
  or jsonb_array_length(m->'variants')<>jsonb_array_length(b->'variants') or jsonb_typeof(m->'ignoredMediaIds') is distinct from 'array'
  or (select count(distinct x) from jsonb_array_elements_text(m->'ignoredMediaIds')x)<>jsonb_array_length(m->'ignoredMediaIds')
  or (select count(distinct x->>'itemId') from jsonb_array_elements(m->'variants')x)<>jsonb_array_length(m->'variants')
 then raise exception 'OWNED_MEDIA_MANIFEST_INVALID';end if;
 for v in select value from jsonb_array_elements(m->'variants')loop
  if not exists(select 1 from jsonb_array_elements(b->'variants')x where (x->>'itemId',x->>'variantGid',x->>'sku')=(v->>'itemId',v->>'variantGid',v->>'sku'))
   or jsonb_typeof(v->'orderedMediaIds') is distinct from 'array' or jsonb_array_length(v->'orderedMediaIds') not between 1 and 20
   or (select count(distinct x) from jsonb_array_elements_text(v->'orderedMediaIds')x)<>jsonb_array_length(v->'orderedMediaIds')
   or not (v->'orderedMediaIds') ? (v->>'coverMediaId')
   or exists(select 1 from jsonb_array_elements_text(v->'orderedMediaIds')x where not all_ids ? x)
  then raise exception 'OWNED_MEDIA_MANIFEST_INVALID';end if;
 end loop;
 for id in select value from jsonb_array_elements_text(m->'globalOrder')loop
  if not exists(select 1 from jsonb_array_elements(m->'variants')mapped where (mapped->'orderedMediaIds') ? id) and not (m->'ignoredMediaIds') ? id then raise exception 'OWNED_MEDIA_UNASSIGNED_REVIEW_REQUIRED';end if;
 end loop;
 if exists(select 1 from jsonb_array_elements_text(m->'ignoredMediaIds')x where not all_ids ? x or exists(select 1 from jsonb_array_elements(m->'variants')mapped where (mapped->'orderedMediaIds') ? x))then raise exception 'OWNED_MEDIA_MANIFEST_INVALID';end if;
end$$;
create function toptik_owned_media_private.cards(p text) returns jsonb language plpgsql set search_path=pg_catalog,pg_temp as $$
declare rows jsonb;begin
 select coalesce(jsonb_agg(jsonb_build_object('itemId',c.id,'catalogKey',c.catalog_number,'expectedVersion',c.copy_updated_at,'expectedRevision',c.editor_revision,
 'isActive',c.is_active,'projection',jsonb_build_object('title',c.title,'description',c.description,'description_html',c.description_html,'seo_title',c.seo_title,'seo_description',c.seo_description,
 'cover_image_path',c.cover_image_path,'cover_image_alt',c.cover_image_alt,'angles',coalesce((select jsonb_agg(jsonb_build_object('angle_key',a.angle_key,'angle_order',a.angle_order,'image_path',a.image_path,'image_alt',a.image_alt)
 order by a.angle_order,a.angle_key,a.image_path)from public.carousel_item_angles a where a.item_id=c.id),'[]'::jsonb)))order by c.id),'[]'::jsonb)into rows
 from jsonb_array_elements(toptik_owned_media_private.binding(p)->'variants')v join public.carousel_items c on c.id=(v->>'itemId')::uuid;
 return rows;end$$;
create function toptik_owned_media_private.expected_images(p text,k text) returns text[] language sql stable set search_path=pg_catalog,pg_temp as $$
 select array_agg(a->'image'->>'url' order by n) from toptik_owned_media_private.registry r,
 jsonb_array_elements(r.manifest->'variants')v,jsonb_array_elements_text(v->'orderedMediaIds')with ordinality z(id,n),
 jsonb_array_elements(r.source_snapshot->'media')a where r.product_gid=p and v->>'sku'=k and a->>'mediaId'=id$$;
create function toptik_owned_media_private.expected_cover(p text,k text) returns text language sql stable set search_path=pg_catalog,pg_temp as $$
 select a->'image'->>'url' from toptik_owned_media_private.registry r,jsonb_array_elements(r.manifest->'variants')v,jsonb_array_elements(r.source_snapshot->'media')a
 where r.product_gid=p and v->>'sku'=k and a->>'mediaId'=v->>'coverMediaId'$$;
-- Preserve the original functions, all CAS/lease/hidden/outbox guards and legacy exact arrays.
-- Only a registered group's approved media manifest replaces the frozen expected_images/cover lookup.
do $$declare name text;definition text;block text;new_definition text;begin
 foreach name in array array['apply_fzt73_owned_projection','apply_md20_owned_projection']loop
  select pg_get_functiondef(p.oid)into definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=name;
  block:=substring(definition from '(?s)expected_images := case p_catalog_key.*?end;');
  if block is null or position('p_projection->>''cover_image_path'' is distinct from desired_angles->0->>''image_path''' in definition)=0 then raise exception 'OWNED_MEDIA_LEGACY_GUARD_SHAPE_CHANGED';end if;
  new_definition:=replace(definition,block,'expected_images := toptik_owned_media_private.expected_images(p_product_gid,p_catalog_key); if expected_images is null then '||block||' end if;');
  new_definition:=replace(new_definition,'p_projection->>''cover_image_path'' is distinct from desired_angles->0->>''image_path''',
   'p_projection->>''cover_image_path'' is distinct from coalesce(toptik_owned_media_private.expected_cover(p_product_gid,p_catalog_key),desired_angles->0->>''image_path'')');
  execute new_definition;
 end loop;
end$$;
create function toptik_owned_media_private.operation_json(op toptik_owned_media_private.operations) returns jsonb language sql stable set search_path=pg_catalog,pg_temp as $$
 select jsonb_build_object('id',op.id,'productGid',op.product_gid,'status',op.status,'mapVersion',op.map_version,'sourceFingerprint',op.source_fingerprint,'command',op.command,'actor',op.actor,'plan',op.plan,'phases',op.phases,'nextPhase',op.next_phase,'cursor',op.cursor_graph,'expectedCards',op.expected_cards,
 'evidence',coalesce((select jsonb_agg(to_jsonb(e)order by e.created_at)from toptik_owned_media_private.phase_evidence e where e.operation_id=op.id),'[]'::jsonb),
 'attempts',coalesce((select jsonb_agg(to_jsonb(a)order by a.phase_index)from toptik_owned_media_private.phase_attempts a where a.operation_id=op.id),'[]'::jsonb),
 'artifacts',coalesce((select jsonb_agg(a.artifact order by a.phase_index)from toptik_owned_media_private.phase_attempts a where a.operation_id=op.id and a.status='verified' and a.artifact is not null),'[]'::jsonb),
 'removalIntents',coalesce((select jsonb_agg(to_jsonb(i))from toptik_owned_media_private.removal_intents i where i.operation_id=op.id),'[]'::jsonb))$$;
create function public.read_toptik_owned_media_registry(p_product_gid text) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r toptik_owned_media_private.registry;op toptik_owned_media_private.operations;begin
 if toptik_owned_media_private.binding(p_product_gid)is null then raise exception 'OWNED_MEDIA_ITEM_UNKNOWN';end if;
 select * into r from toptik_owned_media_private.registry where product_gid=p_product_gid;
 select * into op from toptik_owned_media_private.operations where product_gid=p_product_gid and status in('prepared','running','uncertain','review');
 return jsonb_build_object('registered',r.product_gid is not null,'schemaAvailable',true,'binding',toptik_owned_media_private.binding(p_product_gid),'mapVersion',coalesce(r.map_version,0),'sourceFingerprint',r.source_fingerprint,
 'manifest',r.manifest,'snapshot',r.source_snapshot,'cards',toptik_owned_media_private.cards(p_product_gid),'operation',case when op.id is null then null else toptik_owned_media_private.operation_json(op)end);end$$;
create function toptik_owned_media_private.verify_entries(p text,s jsonb,m jsonb,entries jsonb) returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
declare e jsonb;v jsonb;a jsonb;image jsonb;cover jsonb;active_count int;begin
 perform toptik_owned_media_private.assert_manifest(p,s,m);
 select count(*) into active_count from jsonb_array_elements(toptik_owned_media_private.binding(p)->'variants')b join public.carousel_items c on c.id=(b->>'itemId')::uuid where c.is_active;
 if jsonb_typeof(entries)is distinct from'array' or jsonb_array_length(entries)<>active_count or active_count=0 or (select count(distinct x->>'itemId')from jsonb_array_elements(entries)x)<>active_count then raise exception 'OWNED_MEDIA_ENTRIES_INVALID';end if;
 for e in select value from jsonb_array_elements(entries)loop
  select value into v from jsonb_array_elements(m->'variants')x where x->>'itemId'=e->>'itemId';
  if v is null or e->>'catalogKey' is distinct from v->>'sku' or e->>'variantGid' is distinct from v->>'variantGid' then raise exception 'OWNED_MEDIA_ENTRIES_INVALID';end if;
  select value into cover from jsonb_array_elements(s->'media')x where x->>'mediaId'=v->>'coverMediaId';
  if e->'projection'->>'cover_image_path' is distinct from cover->'image'->>'url' or e->'projection'->>'cover_image_alt' is distinct from nullif(btrim(cover->>'alt'),'')
    or jsonb_typeof(e->'projection'->'angles')is distinct from'array' or jsonb_array_length(e->'projection'->'angles')<>jsonb_array_length(v->'orderedMediaIds')then raise exception 'OWNED_MEDIA_PROJECTION_INVALID';end if;
  for a in select value from jsonb_array_elements(e->'projection'->'angles')loop
   select value into image from jsonb_array_elements(s->'media')x where x->>'mediaId'=v->'orderedMediaIds'->>((a->>'angle_order')::int-1);
   if image is null or a->>'angle_key' is distinct from a->>'angle_order' or a->>'image_path' is distinct from image->'image'->>'url' or a->>'image_alt' is distinct from nullif(btrim(image->>'alt'),'')then raise exception 'OWNED_MEDIA_PROJECTION_INVALID';end if;
  end loop;
 end loop;end$$;
create function toptik_owned_media_private.batch(p text,o uuid,entries jsonb) returns jsonb language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
 if p='gid://shopify/Product/7524873044218' then return public.apply_fzt73_owned_batch(p,o,entries);
 elsif p='gid://shopify/Product/7512404951290' then return public.apply_md20_owned_batch(p,o,entries);
 else raise exception 'OWNED_MEDIA_IDENTITY_INVALID';end if;end$$;
create function public.adopt_toptik_owned_media_registry(p_product_gid text,p_owner uuid,p_request_id uuid,p_source jsonb,p_manifest jsonb,p_entries jsonb,p_approval jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare expires timestamptz;h text;previous toptik_owned_media_private.events;result jsonb;begin
 expires:=toptik_owned_media_private.lease(p_product_gid,p_owner);
 h:=toptik_owned_media_private.digest(jsonb_build_array(p_product_gid,p_source,p_manifest,p_entries,p_approval));
 select * into previous from toptik_owned_media_private.events where request_id=p_request_id;
 if found then if previous.request_hash<>h then raise exception'OWNED_MEDIA_REQUEST_CONFLICT';end if;return public.read_toptik_owned_media_registry(p_product_gid);end if;
 if p_request_id is null or jsonb_typeof(p_approval)is distinct from'object' or coalesce(p_approval->>'reviewReference','')='' or coalesce(p_approval->>'approvedAt','')='' or coalesce(p_approval->>'approvedBy','')<>'Tal' then raise exception'OWNED_MEDIA_APPROVAL_REQUIRED';end if;
 if exists(select 1 from toptik_owned_media_private.registry where product_gid=p_product_gid)then raise exception'OWNED_MEDIA_ALREADY_REGISTERED';end if;
 perform toptik_owned_media_private.verify_entries(p_product_gid,p_source,p_manifest,p_entries);
 insert into toptik_owned_media_private.registry(product_gid,binding,map_version,source_fingerprint,source_snapshot,manifest)values(p_product_gid,toptik_owned_media_private.binding(p_product_gid),1,p_source->>'fingerprint',p_source,p_manifest);
 perform toptik_owned_media_private.batch(p_product_gid,p_owner,p_entries);
 if expires<=clock_timestamp()then raise exception'OWNED_MEDIA_LEASE_REQUIRED';end if;
 result:=public.read_toptik_owned_media_registry(p_product_gid);
 insert into toptik_owned_media_private.events values(p_request_id,p_product_gid,'adopt',h,'{}',result,p_approval,clock_timestamp());return result;end$$;
create function public.read_toptik_owned_media_receipt(p_product_gid text,p_request_id uuid)returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare op toptik_owned_media_private.operations;begin
 if toptik_owned_media_private.binding(p_product_gid)is null then raise exception'OWNED_MEDIA_IDENTITY_INVALID';end if;
 select * into op from toptik_owned_media_private.operations where id=p_request_id and product_gid=p_product_gid;
 return jsonb_build_object('binding',toptik_owned_media_private.binding(p_product_gid),'operation',case when op.id is null then null else toptik_owned_media_private.operation_json(op)end);end$$;
create function public.prepare_toptik_owned_media_operation(p_product_gid text,p_owner uuid,p_request_id uuid,p_expected_map_version bigint,p_expected_source_fingerprint text,p_source jsonb,p_command jsonb,p_plan jsonb,p_phases jsonb,p_actor jsonb,p_observed_manifest jsonb default null,p_observed_entries jsonb default null)returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare expires timestamptz;r toptik_owned_media_private.registry;op toptik_owned_media_private.operations;h text;cards jsonb;ref jsonb;begin
 expires:=toptik_owned_media_private.lease(p_product_gid,p_owner);select * into r from toptik_owned_media_private.registry where product_gid=p_product_gid for update;
 if not found then raise exception'OWNED_MEDIA_NOT_REGISTERED';end if;
 h:=toptik_owned_media_private.digest(jsonb_build_array(p_product_gid,p_expected_map_version,p_expected_source_fingerprint,p_source,p_command,p_plan,p_phases,p_actor,p_observed_manifest,p_observed_entries));
 select * into op from toptik_owned_media_private.operations where id=p_request_id for update;
 if found then if op.request_hash<>h then raise exception'OWNED_MEDIA_REQUEST_CONFLICT';end if;return toptik_owned_media_private.operation_json(op);end if;
 perform toptik_owned_media_private.assert_source(p_product_gid,p_source);
 if r.map_version<>p_expected_map_version or p_source->>'fingerprint'<>p_expected_source_fingerprint then raise exception'OWNED_MEDIA_STALE_SOURCE';end if;
 if jsonb_typeof(p_actor)is distinct from'object' or p_actor->>'actorType' not in('session_admin','admin_token','system') or nullif(btrim(p_actor->>'actorId'),'')is null or length(p_actor->>'actorId')>255 then raise exception'OWNED_MEDIA_ACTOR_REQUIRED';end if;
 if r.source_fingerprint is distinct from p_source->>'fingerprint' or r.manifest is distinct from coalesce(p_observed_manifest,r.manifest) then
  if p_observed_manifest is null or p_observed_entries is null then raise exception'OWNED_MEDIA_OBSERVATION_REQUIRED';end if;
  perform toptik_owned_media_private.commit_projection(p_product_gid,p_owner,r.map_version,p_source,p_observed_manifest,p_observed_entries);
  select * into r from toptik_owned_media_private.registry where product_gid=p_product_gid for update;
 elsif p_observed_entries is not null then raise exception'OWNED_MEDIA_OBSERVATION_INVALID';end if;
 if p_command->>'requestId' is distinct from p_request_id::text or p_plan->>'requestId' is distinct from p_request_id::text or p_plan->'beforeManifest'is distinct from r.manifest
  or p_plan->>'beforeFingerprint' is distinct from p_source->>'fingerprint' or jsonb_typeof(p_phases)is distinct from'array' or jsonb_array_length(p_phases)>120
 then raise exception'OWNED_MEDIA_PLAN_INVALID';end if;
 if exists(select 1 from toptik_owned_media_private.operations where product_gid=p_product_gid and status in('prepared','running','uncertain','review'))then raise exception'OWNED_MEDIA_OPERATION_BUSY';end if;
 cards:=toptik_owned_media_private.cards(p_product_gid);
 if not exists(select 1 from jsonb_array_elements(cards)c where c->>'itemId'=p_command->>'itemId' and c->'isActive'='true'::jsonb)then raise exception'OWNED_MEDIA_REMOVED_OR_HIDDEN';end if;
 -- Validate the unchanged projection under all original private baseline/editor/outbox guards before reserving a native write.
 perform toptik_owned_media_private.batch(p_product_gid,p_owner,(select jsonb_agg(jsonb_build_object('itemId',c->>'itemId','catalogKey',c->>'catalogKey','variantGid',v.value->>'variantGid',
  'expectedVersion',c->>'expectedVersion','expectedRevision',c->'expectedRevision','projection',c->'projection'))from jsonb_array_elements(cards)c
  join lateral(select value from jsonb_array_elements(r.manifest->'variants')x where x->>'itemId'=c->>'itemId')v on true where c->'isActive'='true'::jsonb));
 insert into toptik_owned_media_private.operations(id,product_gid,request_hash,map_version,source_fingerprint,command,actor,plan,phases,expected_cards,before_graph,cursor_graph,status)
 values(p_request_id,p_product_gid,h,r.map_version,r.source_fingerprint,p_command,p_actor,p_plan,p_phases,cards,p_source,p_source,'prepared')returning * into op;
 for ref in select value from jsonb_array_elements(coalesce(p_plan->'removedReferences','[]'))loop
  insert into toptik_owned_media_private.removal_intents(operation_id,item_id,variant_gid,media_gid,before_fingerprint)
  values(op.id,(ref->>'itemId')::uuid,ref->>'variantGid',ref->>'mediaId',op.source_fingerprint);
 end loop;
 if expires<=clock_timestamp()then raise exception'OWNED_MEDIA_LEASE_REQUIRED';end if;return toptik_owned_media_private.operation_json(op);end$$;
-- Upload placeholders resolve only from completed, independently read-back private receipts.
create function toptik_owned_media_private.resolve_ref(op uuid,ref text)returns text language plpgsql stable set search_path=pg_catalog,pg_temp as $$
declare result text;n integer;begin
 if ref like 'upload:%' then
  select count(*),min(artifact->>'mediaId') into n,result from toptik_owned_media_private.phase_attempts
   where operation_id=op and status='verified' and artifact->>'uploadKey'=ref and artifact->>'mediaId'=artifact->'owned'->'media'->>'mediaId';
  if n<>1 then raise exception'OWNED_MEDIA_UPLOAD_RECEIPT_REQUIRED';end if;
 else result:=ref;end if;
 if coalesce(result,'')!~'^gid://shopify/MediaImage/[1-9][0-9]*$'then raise exception'OWNED_MEDIA_REFERENCE_INVALID';end if;return result;end$$;
create function toptik_owned_media_private.resolve_refs(op uuid,refs jsonb)returns jsonb language sql stable set search_path=pg_catalog,pg_temp as $$
 select coalesce(jsonb_agg(toptik_owned_media_private.resolve_ref(op,value)order by n),'[]'::jsonb)from jsonb_array_elements_text(refs)with ordinality a(value,n)$$;
create function toptik_owned_media_private.assert_request(op toptik_owned_media_private.operations,idx integer,request jsonb)returns void
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
create function toptik_owned_media_private.assert_delta(request jsonb,b jsonb,o jsonb,artifact jsonb)returns void
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
  if i->>'kind'='variant_append'then native:=jsonb_set(native,'{mediaIds}',(native->'mediaIds')||(i->'mediaIds'));
  elsif i->>'kind'='variant_detach'then
   if exists(select 1 from jsonb_array_elements_text(i->'mediaIds')id join jsonb_array_elements(b->'media')m on m->>'mediaId'=id where m->'image'->>'url'=native->'image'->>'url')then raise exception'OWNED_MEDIA_REFERENCE_PROTECTED';end if;
   select coalesce(jsonb_agg(id order by n),'[]'::jsonb)into actual from jsonb_array_elements_text(native->'mediaIds')with ordinality a(id,n)where not(i->'mediaIds')?id;native:=jsonb_set(native,'{mediaIds}',actual);
  else
   select v->'image'into actual from jsonb_array_elements(o->'variants')v where v->>'variantGid'=i->>'variantId';
   if not(native->'mediaIds')?(i->>'mediaId')or not exists(select 1 from jsonb_array_elements(b->'media')m where m->>'mediaId'=i->>'mediaId'and m->'image'->>'url'=actual->>'url')then raise exception'OWNED_MEDIA_READBACK_MISMATCH';end if;
   native:=jsonb_set(native,'{image}',actual);
  end if;
  select jsonb_agg(case when v->>'variantGid'=i->>'variantId'then native else v end order by n)into expected_variants from jsonb_array_elements(b->'variants')with ordinality a(v,n);
 else raise exception'OWNED_MEDIA_PHASE_INVALID';end case;
 if expected_media is distinct from o->'media'or expected_variants is distinct from o->'variants'then raise exception'OWNED_MEDIA_READBACK_MISMATCH';end if;
end$$;
create function public.read_toptik_owned_media_operation(p_product_gid text,p_owner uuid,p_operation_id uuid,p_phase_index integer)returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare expires timestamptz;op toptik_owned_media_private.operations;a toptik_owned_media_private.phase_attempts;begin
 expires:=toptik_owned_media_private.lease(p_product_gid,p_owner);select * into op from toptik_owned_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if not found or p_phase_index<0 or p_phase_index>=jsonb_array_length(op.phases)then raise exception'OWNED_MEDIA_PHASE_INVALID';end if;
 select * into a from toptik_owned_media_private.phase_attempts where operation_id=op.id and phase_index=p_phase_index;
 return jsonb_build_object('status',coalesce(a.status,'prepared'),'attemptId',a.attempt_id,'request',a.request,'requestHash',a.request_hash,
 'before',coalesce(a.before_graph,op.cursor_graph),'spec',op.phases->p_phase_index,'ack',case when a.status<>'verified'then a.artifact else null end,'artifact',case when a.status='verified'then a.artifact else null end,'observedGraph',a.observed_graph,'leaseExpiresAt',expires,
 'evidence',toptik_owned_media_private.operation_json(op)->'evidence','artifacts',toptik_owned_media_private.operation_json(op)->'artifacts','removalIntents',toptik_owned_media_private.operation_json(op)->'removalIntents');end$$;
create function public.record_toptik_owned_media_phase(p_product_gid text,p_owner uuid,p_operation_id uuid,p_phase_index integer,p_attempt_id uuid,p_action text,p_request_hash text,p_request_json jsonb,p_observed_graph jsonb,p_artifact jsonb)returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare expires timestamptz;op toptik_owned_media_private.operations;r toptik_owned_media_private.registry;a toptik_owned_media_private.phase_attempts;begin
 expires:=toptik_owned_media_private.lease(p_product_gid,p_owner);
 select * into r from toptik_owned_media_private.registry where product_gid=p_product_gid for update;
 select * into op from toptik_owned_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if not found or op.status in('verified','cancelled','review')or op.map_version<>r.map_version or p_phase_index<>op.next_phase or p_phase_index<0 or p_phase_index>=jsonb_array_length(op.phases)
  or p_attempt_id is null or coalesce(p_request_hash,'')!~'^[a-f0-9]{64}$'then raise exception'OWNED_MEDIA_PHASE_INVALID';end if;
 select * into a from toptik_owned_media_private.phase_attempts where operation_id=op.id and phase_index=p_phase_index for update;
 if p_action='review'and a.attempt_id is null then
  perform toptik_owned_media_private.assert_request(op,p_phase_index,p_request_json);
  perform toptik_owned_media_private.assert_observation(p_product_gid,p_observed_graph);
  if p_artifact->>'reason'is distinct from'GROUP_MEDIA_NOT_SENT_SOURCE_CHANGED'or p_observed_graph->>'fingerprint'=op.cursor_graph->>'fingerprint'then raise exception'OWNED_MEDIA_REVIEW_INVALID';end if;
  insert into toptik_owned_media_private.phase_attempts(operation_id,phase_index,attempt_id,request_hash,request,before_graph,status,artifact,observed_graph)
   values(op.id,p_phase_index,p_attempt_id,p_request_hash,p_request_json,op.cursor_graph,'review',p_artifact,p_observed_graph);
  insert into toptik_owned_media_private.phase_evidence(operation_id,phase_index,evidence_hash,action,observed_graph,artifact)
   values(op.id,p_phase_index,toptik_owned_media_private.digest(jsonb_build_array('review',p_observed_graph,p_artifact)),'review',p_observed_graph,p_artifact)on conflict do nothing;
  update toptik_owned_media_private.operations set status='review',updated_at=clock_timestamp()where id=op.id;
  return jsonb_build_object('status','review','mayExecute',false,'leaseExpiresAt',expires);
 end if;
 if p_action='begin'then
  if a.attempt_id is not null then
   if a.attempt_id<>p_attempt_id or a.request_hash<>p_request_hash or a.request<>p_request_json then raise exception'OWNED_MEDIA_ATTEMPT_CONFLICT';end if;
   return jsonb_build_object('status',a.status,'mayExecute',false,'leaseExpiresAt',expires);
  end if;
  if jsonb_typeof(p_request_json)is distinct from'object' or p_request_json->>'operationId' is distinct from op.id::text
   or coalesce(p_request_json->>'beforeFingerprint','')<>op.cursor_graph->>'fingerprint'
   or p_request_json->'binding'is distinct from r.binding then raise exception'OWNED_MEDIA_REQUEST_INVALID';end if;
  perform toptik_owned_media_private.assert_request(op,p_phase_index,p_request_json);
  if p_request_json->>'requestHash'is distinct from p_request_hash then raise exception'OWNED_MEDIA_REQUEST_INVALID';end if;
  insert into toptik_owned_media_private.phase_attempts(operation_id,phase_index,attempt_id,request_hash,request,before_graph,status)
  values(op.id,p_phase_index,p_attempt_id,p_request_hash,p_request_json,op.cursor_graph,'started');
  update toptik_owned_media_private.operations set status='running',updated_at=clock_timestamp()where id=op.id;
  if expires<=clock_timestamp()then raise exception'OWNED_MEDIA_LEASE_REQUIRED';end if;
  return jsonb_build_object('status','started','mayExecute',true,'leaseExpiresAt',expires);
 end if;
 if a.attempt_id is null or a.attempt_id<>p_attempt_id or a.request_hash<>p_request_hash or a.request<>p_request_json then raise exception'OWNED_MEDIA_ATTEMPT_CONFLICT';end if;
 if p_action in('review','uncertain')then
  if p_observed_graph is not null then perform toptik_owned_media_private.assert_observation(p_product_gid,p_observed_graph);end if;
  insert into toptik_owned_media_private.phase_evidence(operation_id,phase_index,evidence_hash,action,observed_graph,artifact)
   values(op.id,p_phase_index,toptik_owned_media_private.digest(jsonb_build_array(p_action,p_observed_graph,p_artifact)),p_action,p_observed_graph,p_artifact)on conflict do nothing;
 end if;
 if p_action='ack'then
  if a.artifact is not null and a.artifact is distinct from p_artifact then raise exception'OWNED_MEDIA_ARTIFACT_CONFLICT';end if;
  update toptik_owned_media_private.phase_attempts set artifact=coalesce(artifact,p_artifact)where operation_id=op.id and phase_index=p_phase_index;
 elsif p_action='uncertain'then
  update toptik_owned_media_private.phase_attempts set status='uncertain'where operation_id=op.id and phase_index=p_phase_index;
  update toptik_owned_media_private.operations set status='uncertain',updated_at=clock_timestamp()where id=op.id;
 elsif p_action='review'then
  update toptik_owned_media_private.phase_attempts set status='review'where operation_id=op.id and phase_index=p_phase_index;
  update toptik_owned_media_private.operations set status='review',updated_at=clock_timestamp()where id=op.id;
 elsif p_action='recovered'then
  if p_request_json->'input'->>'kind'='create_owned'and a.artifact->>'mediaId'is not null and a.artifact->>'mediaId'is distinct from p_artifact->'owned'->'media'->>'mediaId'then raise exception'OWNED_MEDIA_CREATE_ACK_MISMATCH';end if;
  perform toptik_owned_media_private.assert_request(op,p_phase_index,p_request_json);
  perform toptik_owned_media_private.assert_delta(p_request_json,a.before_graph,p_observed_graph,p_artifact);
  update toptik_owned_media_private.phase_attempts set status='verified',observed_graph=p_observed_graph,artifact=coalesce(p_artifact,artifact),verified_at=clock_timestamp()where operation_id=op.id and phase_index=p_phase_index;
  update toptik_owned_media_private.operations set status='running',cursor_graph=p_observed_graph,next_phase=next_phase+1,updated_at=clock_timestamp()where id=op.id;
 else raise exception'OWNED_MEDIA_ACTION_INVALID';end if;
 if expires<=clock_timestamp()then raise exception'OWNED_MEDIA_LEASE_REQUIRED';end if;
 return jsonb_build_object('status',case when p_action='recovered'then'verified'when p_action='ack'then a.status else p_action end,'mayExecute',false,'leaseExpiresAt',expires);end$$;
create function toptik_owned_media_private.commit_projection(p text,o uuid,v bigint,s jsonb,m jsonb,entries jsonb)returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
declare r toptik_owned_media_private.registry;begin
 select * into r from toptik_owned_media_private.registry where product_gid=p for update;
 if not found or r.map_version<>v then raise exception'OWNED_MEDIA_STALE_MAP';end if;
 perform toptik_owned_media_private.verify_entries(p,s,m,entries);
 update toptik_owned_media_private.registry set map_version=map_version+case when manifest is distinct from m or source_fingerprint is distinct from s->>'fingerprint'then 1 else 0 end,
  source_fingerprint=s->>'fingerprint',source_snapshot=s,manifest=m,updated_at=clock_timestamp()where product_gid=p;
 perform toptik_owned_media_private.batch(p,o,entries);end$$;
create function toptik_owned_media_private.resolved_manifest(op uuid,m jsonb)returns jsonb language plpgsql stable set search_path=pg_catalog,pg_temp as $$
declare v jsonb;vs jsonb:='[]';begin
 for v in select value from jsonb_array_elements(m->'variants')loop
  v:=jsonb_set(jsonb_set(v,'{orderedMediaIds}',toptik_owned_media_private.resolve_refs(op,v->'orderedMediaIds')),'{coverMediaId}',to_jsonb(toptik_owned_media_private.resolve_ref(op,v->>'coverMediaId')));vs:=vs||jsonb_build_array(v);
 end loop;return jsonb_set(jsonb_set(m,'{variants}',vs),'{globalOrder}',toptik_owned_media_private.resolve_refs(op,m->'globalOrder'));end$$;
create function public.commit_toptik_owned_media_operation(p_product_gid text,p_owner uuid,p_operation_id uuid,p_source jsonb,p_manifest jsonb,p_entries jsonb)returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare expires timestamptz;op toptik_owned_media_private.operations;before_state jsonb;result jsonb;c jsonb;begin
 expires:=toptik_owned_media_private.lease(p_product_gid,p_owner);select * into op from toptik_owned_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if not found then raise exception'OWNED_MEDIA_OPERATION_UNKNOWN';end if;
 if op.status='verified'then return public.read_toptik_owned_media_registry(p_product_gid);end if;
 if op.status not in('prepared','running')or op.next_phase<>jsonb_array_length(op.phases)or p_source->>'fingerprint' is distinct from op.cursor_graph->>'fingerprint'then raise exception'OWNED_MEDIA_OPERATION_NOT_VERIFIED';end if;
 -- Versions recorded before native side effects must still hold. No editor bypass.
 for c in select value from jsonb_array_elements(op.expected_cards)where value->'isActive'='true'::jsonb loop
  if not exists(select 1 from jsonb_array_elements(p_entries)e where e->>'itemId'=c->>'itemId' and e->>'expectedVersion'=c->>'expectedVersion' and e->'expectedRevision'=c->'expectedRevision')then raise exception'SYNC_COPY_CONCURRENT_UPDATE';end if;
 end loop;
 if p_manifest is distinct from toptik_owned_media_private.resolved_manifest(op.id,op.plan->'desiredManifest')then raise exception'OWNED_MEDIA_FINAL_MANIFEST_CONFLICT';end if;
 before_state:=public.read_toptik_owned_media_registry(p_product_gid);
 perform toptik_owned_media_private.commit_projection(p_product_gid,p_owner,op.map_version,p_source,p_manifest,p_entries);
 update toptik_owned_media_private.operations set status='verified',updated_at=clock_timestamp()where id=op.id;
 if expires<=clock_timestamp()then raise exception'OWNED_MEDIA_LEASE_REQUIRED';end if;
 result:=public.read_toptik_owned_media_registry(p_product_gid);
 insert into toptik_owned_media_private.events values(op.id,p_product_gid,'operation_commit',op.request_hash,before_state,result,'{}',clock_timestamp());return result;end$$;
create function public.apply_toptik_owned_media_source_projection(p_product_gid text,p_owner uuid,p_request_id uuid,p_expected_map_version bigint,p_source jsonb,p_manifest jsonb,p_entries jsonb)returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare expires timestamptz;before_state jsonb;result jsonb;h text;prev toptik_owned_media_private.events;begin
 expires:=toptik_owned_media_private.lease(p_product_gid,p_owner);
 h:=toptik_owned_media_private.digest(jsonb_build_array(p_product_gid,p_expected_map_version,p_source,p_manifest,p_entries));
 select * into prev from toptik_owned_media_private.events where request_id=p_request_id;
 if found then if prev.request_hash<>h then raise exception'OWNED_MEDIA_REQUEST_CONFLICT';end if;return public.read_toptik_owned_media_registry(p_product_gid);end if;
 if exists(select 1 from toptik_owned_media_private.operations where product_gid=p_product_gid and status in('prepared','running','uncertain','review'))then raise exception'OWNED_MEDIA_OPERATION_BUSY';end if;
 before_state:=public.read_toptik_owned_media_registry(p_product_gid);
 perform toptik_owned_media_private.commit_projection(p_product_gid,p_owner,p_expected_map_version,p_source,p_manifest,p_entries);
 if expires<=clock_timestamp()then raise exception'OWNED_MEDIA_LEASE_REQUIRED';end if;result:=public.read_toptik_owned_media_registry(p_product_gid);
 insert into toptik_owned_media_private.events values(p_request_id,p_product_gid,'native_projection',h,before_state,result,'{}',clock_timestamp());return result;end$$;
create function public.cancel_toptik_owned_media_operation(p_product_gid text,p_owner uuid,p_operation_id uuid,p_source jsonb)returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare expires timestamptz;op toptik_owned_media_private.operations;begin
 expires:=toptik_owned_media_private.lease(p_product_gid,p_owner);select * into op from toptik_owned_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if not found then raise exception'OWNED_MEDIA_OPERATION_UNKNOWN';end if;
 perform toptik_owned_media_private.assert_source(p_product_gid,p_source);
 if op.status='cancelled'then return toptik_owned_media_private.operation_json(op);end if;
 if op.status<>'prepared'or exists(select 1 from toptik_owned_media_private.phase_attempts where operation_id=op.id)or p_source->>'fingerprint'<>op.source_fingerprint then raise exception'OWNED_MEDIA_CANCEL_UNSAFE';end if;
 update toptik_owned_media_private.operations set status='cancelled',updated_at=clock_timestamp()where id=op.id returning * into op;
 if expires<=clock_timestamp()then raise exception'OWNED_MEDIA_LEASE_REQUIRED';end if;return toptik_owned_media_private.operation_json(op);end$$;
create function public.claim_toptik_owned_media_work(p_owner uuid,p_excluded_product_gids text[] default '{}')returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare op toptik_owned_media_private.operations;claim uuid:=gen_random_uuid();begin
 if p_owner is null then raise exception'OWNED_MEDIA_ACTOR_REQUIRED';end if;
 select * into op from toptik_owned_media_private.operations where status in('prepared','running','uncertain')and next_work_at<=clock_timestamp()
  and(work_expires is null or work_expires<=clock_timestamp())and not(product_gid=any(p_excluded_product_gids)) order by updated_at,id for update skip locked limit 1;
 if not found then return jsonb_build_object('operation',null);end if;
 update toptik_owned_media_private.operations set work_owner=p_owner,work_claim=claim,work_expires=clock_timestamp()+interval'90 seconds'where id=op.id;
 return jsonb_build_object('operationId',op.id,'productGid',op.product_gid,'itemId',op.command->>'itemId','requestId',op.id,'claimId',claim,'actor',op.actor,'status',op.status,'nextPhase',op.next_phase,'mapVersion',op.map_version);end$$;
create function public.finish_toptik_owned_media_work(p_operation_id uuid,p_owner uuid,p_claim_id uuid,p_status text,p_error text,p_progressed boolean)returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare op toptik_owned_media_private.operations;begin
 select * into op from toptik_owned_media_private.operations where id=p_operation_id for update;
 if not found or op.work_owner is distinct from p_owner or op.work_claim is distinct from p_claim_id then raise exception'OWNED_MEDIA_CLAIM_CONFLICT';end if;
 if p_status not in('pending','review','verified','failed','disabled')or(p_error is not null and p_error!~'^[A-Z0-9_]{1,120}$')then raise exception'OWNED_MEDIA_WORK_INVALID';end if;
 if p_status='verified'and op.status<>'verified'then raise exception'OWNED_MEDIA_OPERATION_NOT_VERIFIED';end if;
 update toptik_owned_media_private.operations set work_owner=null,work_claim=null,work_expires=null,work_error=p_error,
  status=case when p_status='review'then'review'else status end,
  next_work_at=clock_timestamp()+case when p_progressed then interval'15 seconds'else interval'60 seconds'end where id=op.id;
 return jsonb_build_object('status',case when p_status='review'then'review'else op.status end);end$$;
create function public.owned_media_work_pending()returns jsonb language sql security definer set search_path=pg_catalog,pg_temp as $$
 select jsonb_build_object('pending',exists(select 1 from toptik_owned_media_private.operations where status in('prepared','running','uncertain')))$$;
create function toptik_owned_media_private.immutable_audit()returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$begin raise exception'OWNED_MEDIA_AUDIT_IMMUTABLE';end$$;
create trigger owned_media_phase_evidence_immutable before update or delete on toptik_owned_media_private.phase_evidence for each row execute function toptik_owned_media_private.immutable_audit();
create trigger owned_media_events_immutable before update or delete on toptik_owned_media_private.events for each row execute function toptik_owned_media_private.immutable_audit();
-- Private tables and helpers are never available to browser roles or service-role direct writes.
revoke all on all functions in schema toptik_owned_media_private from public,anon,authenticated,service_role;
do $$declare grant_row record;begin for grant_row in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'and p.proname in('read_toptik_owned_media_receipt','claim_toptik_owned_media_work','finish_toptik_owned_media_work','owned_media_work_pending','read_toptik_owned_media_registry','adopt_toptik_owned_media_registry','prepare_toptik_owned_media_operation','read_toptik_owned_media_operation',
 'record_toptik_owned_media_phase','commit_toptik_owned_media_operation','apply_toptik_owned_media_source_projection','cancel_toptik_owned_media_operation')loop
 execute format('revoke all on function %s from public,anon,authenticated',grant_row.signature);
 execute format('grant execute on function %s to service_role',grant_row.signature);
end loop;end$$;
commit;
