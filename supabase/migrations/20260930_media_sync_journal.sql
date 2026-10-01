-- Additive, default-disabled private media journal. Does not mutate product media,
-- carousel data, copy/spec baselines, public links, commerce or existing approvals.
create schema if not exists toptik_media_private;
revoke all on schema toptik_media_private from public,anon,authenticated,service_role;
grant usage on schema toptik_media_private to service_role;

create table toptik_media_private.products (
 product_gid text primary key references public.shopify_gallery_copy_eligibility(product_gid),
 identity jsonb not null, approval_id uuid not null unique, approval_evidence jsonb not null,
 enabled boolean not null default false, created_at timestamptz not null default clock_timestamp()
);
create table toptik_media_private.state (
 product_gid text primary key references toptik_media_private.products(product_gid),
 version bigint not null default 1 check(version>0), baselines jsonb not null,
 updated_at timestamptz not null default clock_timestamp()
);
create table toptik_media_private.asset_identities (
 product_gid text not null references toptik_media_private.products(product_gid),
 asset_key text not null, origin_evidence_id text not null, created_at timestamptz not null default clock_timestamp(),
 primary key(product_gid,asset_key)
);
create table toptik_media_private.provenance (
 evidence_id text primary key, product_gid text not null, asset_key text not null,
 side text not null check(side in ('gallery','shopify')), content_id text not null,
 proof jsonb not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(product_gid,asset_key) references toptik_media_private.asset_identities(product_gid,asset_key)
);
create table toptik_media_private.removal_intents (
 request_id uuid primary key, product_gid text not null references toptik_media_private.products(product_gid),
 side text not null check(side in ('gallery','shopify')), asset_key text not null,
 baseline_fingerprint text not null, kind text not null, auth_evidence jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create table toptik_media_private.operations (
 id uuid primary key, product_gid text not null references toptik_media_private.products(product_gid),
 state_version bigint not null, plan jsonb not null, initial_pair jsonb not null, request_hash text not null,
 observed_pair jsonb not null, status text not null default 'reserved'
 check(status in ('reserved','running','uncertain','verified','conflict')),
 next_step int not null default 0, version bigint not null default 1,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create unique index media_one_active_operation on toptik_media_private.operations(product_gid)
 where status in ('reserved','running','uncertain');
create table toptik_media_private.steps (
 operation_id uuid not null references toptik_media_private.operations(id), step_index int not null,
 body jsonb not null, expected_pair jsonb, readback_pair jsonb, attempt_id uuid, detach_verified boolean not null default false,
 status text not null default 'ready' check(status in ('ready','started','uncertain','verified','conflict')),
 started_at timestamptz, verified_at timestamptz, primary key(operation_id,step_index)
);
create table toptik_media_private.events (
 request_id uuid primary key, product_gid text not null references toptik_media_private.products(product_gid),
 operation_id uuid references toptik_media_private.operations(id), event_kind text not null,
 request_hash text not null, evidence jsonb not null, result jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);

create function toptik_media_private.digest(p_value jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(p_value::text,'UTF8')),'hex');
$$;
create function toptik_media_private.immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_table_name='products' and tg_op='UPDATE' and to_jsonb(new)-'enabled'=to_jsonb(old)-'enabled' then return new;end if;
 raise exception 'MEDIA_IMMUTABLE_RECORD';
end $$;


do $$ declare t text;begin
 foreach t in array array['products','asset_identities','provenance','removal_intents','events'] loop
  execute format('create trigger immutable_record before update or delete on toptik_media_private.%I for each row execute function toptik_media_private.immutable()',t);
 end loop;
end $$;

create function toptik_media_private.assert_copy_identity(p_product text,p_owner uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare e public.shopify_gallery_copy_eligibility%rowtype; i jsonb;
begin
 if p_product is null or p_owner is null then raise exception 'MEDIA_IDENTITY_INVALID';end if;
 perform set_config('lock_timeout','3000ms',true);
 perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into e from public.shopify_gallery_copy_eligibility where product_gid=p_product and enabled for update;
 if not found then raise exception 'MEDIA_APPROVAL_MISSING_OR_CHANGED';end if;
 perform public.assert_shopify_verified_copy_identity(e.carousel_item_id,e.catalog_key,e.exact_gallery_sku,e.product_gid,e.variant_gid,e.exact_shopify_sku);
 perform 1 from public.shopify_gallery_reconciliation_leases where product_gid=p_product and owner=p_owner and expires_at>clock_timestamp() for update;
 if not found then raise exception 'MEDIA_LEASE_LOST';end if;
 i:=jsonb_build_object('productId',e.product_gid,'variantId',e.variant_gid,'itemId',e.carousel_item_id,
 'exactGallerySku',e.exact_gallery_sku,'exactShopifySku',e.exact_shopify_sku,'productHandle',e.approved_product_handle);
 return i;
end $$;
create function toptik_media_private.assert_access(p_product text,p_owner uuid,p_enabled boolean default true) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;r toptik_media_private.products%rowtype;
begin
 i:=toptik_media_private.assert_copy_identity(p_product,p_owner);
 select * into r from toptik_media_private.products where product_gid=p_product for update;
 if not found or r.identity<>i or (p_enabled and not r.enabled) then raise exception 'MEDIA_APPROVAL_MISSING_OR_CHANGED';end if;
 return i;
end $$;

create function toptik_media_private.assert_snapshot(p_snapshot jsonb,p_side text,p_identity jsonb,p_provenance boolean default true)
returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
declare a jsonb;
begin
 if jsonb_typeof(p_snapshot) is distinct from 'object' or not(p_snapshot ?& array['identity','side','revision','complete','assets'])
 or (select count(*) from jsonb_object_keys(p_snapshot))<>5 or p_snapshot->'identity' is distinct from p_identity
 or p_snapshot->>'side' is distinct from p_side or p_side not in ('gallery','shopify') or p_snapshot->'complete' is distinct from 'true'::jsonb
 or jsonb_typeof(p_snapshot->'revision') is distinct from 'string' or length(btrim(p_snapshot->>'revision')) not between 1 and 512
 or jsonb_typeof(p_snapshot->'assets') is distinct from 'array' or jsonb_array_length(p_snapshot->'assets')>250
 or octet_length(p_snapshot::text)>1000000 then raise exception 'MEDIA_COMPLETE_SNAPSHOT_REQUIRED';end if;
 if jsonb_array_length(p_snapshot->'assets')<>(select count(distinct value->>'key') from jsonb_array_elements(p_snapshot->'assets')) then raise exception 'MEDIA_DUPLICATE_ASSET';end if;
 for a in select value from jsonb_array_elements(p_snapshot->'assets') loop
  if jsonb_typeof(a) is distinct from 'object' or not(a ?& array['key','contentId','alt','evidenceId']) or (select count(*) from jsonb_object_keys(a))<>4
  or jsonb_typeof(a->'key') is distinct from 'string' or jsonb_typeof(a->'contentId') is distinct from 'string' or jsonb_typeof(a->'evidenceId') is distinct from 'string'
  or coalesce(a->>'key','') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' or coalesce(a->>'contentId','') !~ '^[a-f0-9]{64}$'
  or jsonb_typeof(a->'alt') is distinct from 'string' or length(a->>'alt')>512 or (a->>'alt')~'[\x01-\x08\x0b\x0c\x0e-\x1f]'
  or coalesce(a->>'evidenceId','') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' then raise exception 'MEDIA_ASSET_INVALID';end if;
  if p_provenance and not exists(select 1 from toptik_media_private.provenance where evidence_id=a->>'evidenceId'
   and product_gid=p_identity->>'productId' and asset_key=a->>'key' and side=p_side and content_id=a->>'contentId') then raise exception 'MEDIA_PROVENANCE_REQUIRED';end if;
 end loop;
end $$;
create function toptik_media_private.assert_pair(p_pair jsonb,p_identity jsonb,p_provenance boolean default true) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
 if jsonb_typeof(p_pair) is distinct from 'object' or not(p_pair ?& array['gallery','shopify']) or (select count(*) from jsonb_object_keys(p_pair))<>2 then raise exception 'MEDIA_PAIR_INVALID';end if;
 perform toptik_media_private.assert_snapshot(p_pair->'gallery','gallery',p_identity,p_provenance);
 perform toptik_media_private.assert_snapshot(p_pair->'shopify','shopify',p_identity,p_provenance);
end $$;
-- Match the TS fingerprint byte-for-byte, including escaped Unicode/string data.
create function toptik_media_private.fingerprint(s jsonb) returns text language plpgsql immutable set search_path=pg_catalog as $$
declare identity_text text;assets_text text;canonical text;
begin
 select '['||string_agg(to_json(s#>>array['identity',k])::text,',' order by n)||']' into identity_text
 from unnest(array['productId','variantId','itemId','exactGallerySku','exactShopifySku','productHandle']) with ordinality x(k,n);
 select '['||coalesce(string_agg('['||to_json(a->>'key')::text||','||to_json(a->>'contentId')::text||','||to_json(a->>'alt')::text||','||to_json(a->>'evidenceId')::text||']',',' order by n),'')||']'
 into assets_text from jsonb_array_elements(s->'assets') with ordinality x(a,n);
 canonical:='{"identity":'||identity_text||',"side":'||to_json(s->>'side')::text||',"revision":'||to_json(s->>'revision')::text||',"assets":'||assets_text||'}';
 return encode(sha256(convert_to(canonical,'UTF8')),'hex');
end $$;
create function toptik_media_private.semantic(s jsonb) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_array(a->>'key',a->>'contentId',a->>'alt') order by n),'[]'::jsonb)
 from jsonb_array_elements(s->'assets') with ordinality x(a,n);
$$;
create function toptik_media_private.asset(s jsonb,k text) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select a from jsonb_array_elements(s->'assets') a where a->>'key'=k;
$$;

-- Proofs are supplied only by the server's bounded fetch/decode adapter, never a browser.
-- contentId is either the decoded byte hash or a verified journal-owned import lineage.
create function toptik_media_private.register(p_product text,p_proofs jsonb) returns void
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
   select * into parent from toptik_media_private.provenance where evidence_id=x#>>'{proof,sourceEvidenceId}' and product_gid=p_product and asset_key=x->>'key' and content_id=x->>'contentId' and side<>x->>'side';
   if not found then raise exception 'MEDIA_IMPORT_LINEAGE_REQUIRED';end if;
   select * into op from toptik_media_private.operations where id=(proof->>'operationId')::uuid and product_gid=p_product and status in ('running','uncertain');
   if not found or not exists(select 1 from toptik_media_private.steps where operation_id=op.id and status in ('started','uncertain')
    and body->>'target'=x->>'side' and body->>'key'=x->>'key' and body->>'kind' in ('attach','replace_reference')
    and body#>>'{value,contentId}'=x->>'contentId') then raise exception 'MEDIA_IMPORT_LINEAGE_REQUIRED';end if;
  elsif proof?'sourceEvidenceId' or proof?'operationId' then raise exception 'MEDIA_REDUNDANT_LINEAGE_INVALID';end if;
  insert into toptik_media_private.asset_identities(product_gid,asset_key,origin_evidence_id) values(p_product,x->>'key',x->>'evidenceId') on conflict do nothing;
  insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof)
   values(x->>'evidenceId',p_product,x->>'key',x->>'side',x->>'contentId',proof);
 end loop;
end $$;

create function public.bootstrap_toptik_media(p_product_gid text,p_lease_owner uuid,p_approval_id uuid,p_pair jsonb,p_proofs jsonb,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;r toptik_media_private.products%rowtype;
begin
 i:=toptik_media_private.assert_copy_identity(p_product_gid,p_lease_owner);
 if p_approval_id is null or jsonb_typeof(p_evidence) is distinct from 'object' or length(coalesce(p_evidence->>'evidenceId','')) not between 1 and 512 or octet_length(p_evidence::text)>100000 then raise exception 'MEDIA_APPROVAL_INVALID';end if;
 select * into r from toptik_media_private.products where product_gid=p_product_gid;
 if found then
  if r.identity<>i or r.approval_id<>p_approval_id or r.approval_evidence<>p_evidence or not exists(select 1 from toptik_media_private.events where request_id=p_approval_id and request_hash=toptik_media_private.digest(jsonb_build_object('pair',p_pair,'proofs',p_proofs,'evidence',p_evidence))) then raise exception 'MEDIA_BOOTSTRAP_REUSED';end if;
  return jsonb_build_object('version',1,'enabled',r.enabled,'replayed',true);
 end if;
 insert into toptik_media_private.products(product_gid,identity,approval_id,approval_evidence) values(p_product_gid,i,p_approval_id,p_evidence);
 perform toptik_media_private.register(p_product_gid,p_proofs);
 perform toptik_media_private.assert_pair(p_pair,i);
 insert into toptik_media_private.state(product_gid,baselines) values(p_product_gid,p_pair);
 insert into toptik_media_private.events(request_id,product_gid,event_kind,request_hash,evidence,result)
 values(p_approval_id,p_product_gid,'bootstrap',toptik_media_private.digest(jsonb_build_object('pair',p_pair,'proofs',p_proofs,'evidence',p_evidence)),p_evidence,jsonb_build_object('version',1,'enabled',false));
 return jsonb_build_object('version',1,'enabled',false,'replayed',false);
end $$;
create function public.set_toptik_media_enabled(p_product_gid text,p_lease_owner uuid,p_request_id uuid,p_enabled boolean,p_approval_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare h text;r toptik_media_private.events%rowtype;result jsonb;
begin
 perform toptik_media_private.assert_access(p_product_gid,p_lease_owner,false);
 if p_request_id is null or p_enabled is null or not exists(select 1 from toptik_media_private.products where product_gid=p_product_gid and approval_id=p_approval_id) then raise exception 'MEDIA_APPROVAL_INVALID';end if;
 h:=toptik_media_private.digest(jsonb_build_object('product',p_product_gid,'enabled',p_enabled,'approval',p_approval_id));
 select * into r from toptik_media_private.events where request_id=p_request_id;
 if found then if r.request_hash<>h or r.event_kind<>'enable' then raise exception 'MEDIA_REQUEST_REUSED';end if;return r.result;end if;
 update toptik_media_private.products set enabled=p_enabled where product_gid=p_product_gid;
 result:=jsonb_build_object('enabled',p_enabled);
 insert into toptik_media_private.events values(p_request_id,p_product_gid,null,'enable',h,jsonb_build_object('approvalId',p_approval_id),result,clock_timestamp());
 return result;
end $$;
create function public.register_toptik_media_provenance(p_product_gid text,p_lease_owner uuid,p_proofs jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin perform toptik_media_private.assert_access(p_product_gid,p_lease_owner);perform toptik_media_private.register(p_product_gid,p_proofs);return true;end $$;

create function public.record_toptik_media_removal(p_product_gid text,p_lease_owner uuid,p_request_id uuid,p_side text,p_key text,p_baseline_fingerprint text,p_auth_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare s toptik_media_private.state%rowtype;r toptik_media_private.removal_intents%rowtype;kind text;event public.shopify_webhook_events%rowtype;
begin
 perform toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 select * into s from toptik_media_private.state where product_gid=p_product_gid for update;
 if p_request_id is null or p_side not in ('gallery','shopify') or p_side is null or not exists(select 1 from toptik_media_private.asset_identities where product_gid=p_product_gid and asset_key=p_key)
 or jsonb_typeof(p_auth_evidence) is distinct from 'object' or octet_length(p_auth_evidence::text)>10000 then raise exception 'MEDIA_REMOVAL_AUTH_INVALID';end if;
 kind:=case p_side when 'gallery' then 'authenticated_editor' else 'signed_shopify_event' end;
 select * into r from toptik_media_private.removal_intents where request_id=p_request_id;
 if found then
  if r.product_gid<>p_product_gid or r.side<>p_side or r.asset_key<>p_key or r.baseline_fingerprint<>p_baseline_fingerprint or r.auth_evidence<>p_auth_evidence then raise exception 'MEDIA_REQUEST_REUSED';end if;
 else
  if p_baseline_fingerprint is distinct from toptik_media_private.fingerprint(s.baselines->p_side) or toptik_media_private.asset(s.baselines->p_side,p_key) is null then raise exception 'MEDIA_REMOVAL_BASELINE_STALE';end if;
  if p_side='gallery' then
   if p_auth_evidence->>'kind' is distinct from 'authenticated_editor'
    or not coalesce((p_auth_evidence->>'actorType'='supabase_user' and coalesce(p_auth_evidence->>'actorId','')~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
     or (p_auth_evidence->>'actorType'='admin_panel_token' and p_auth_evidence->>'actorId'='configured-admin-panel'),false)
    or p_auth_evidence->>'requestId' is distinct from p_request_id::text or p_auth_evidence->>'origin' is distinct from 'https://landing.toptik.co.il'
    or exists(select 1 from jsonb_object_keys(p_auth_evidence) k where k not in ('kind','actorType','actorId','requestId','origin')) then raise exception 'MEDIA_REMOVAL_AUTH_INVALID';end if;
  else
   select * into event from public.shopify_webhook_events where id=(p_auth_evidence->>'eventId')::uuid and topic='products/update' and shop_domain='toptikcoil.myshopify.com';
   if not found or coalesce(event.payload->>'admin_graphql_api_id','gid://shopify/Product/'||(event.payload->>'id')) is distinct from p_product_gid
    or length(btrim(coalesce(event.delivery_id,'')))=0 or jsonb_typeof(p_auth_evidence->'deliveryId') is distinct from 'string'
    or p_auth_evidence->>'kind' is distinct from 'signed_shopify_event' or p_auth_evidence->>'deliveryId' is distinct from event.delivery_id
    or exists(select 1 from jsonb_object_keys(p_auth_evidence) k where k not in ('kind','eventId','deliveryId')) then raise exception 'MEDIA_REMOVAL_AUTH_INVALID';end if;
  end if;
  insert into toptik_media_private.removal_intents values(p_request_id,p_product_gid,p_side,p_key,p_baseline_fingerprint,kind,p_auth_evidence,clock_timestamp());
 end if;
 return jsonb_build_object('side',p_side,'key',p_key,'requestId',p_request_id,'kind',kind,'expectedBaselineFingerprint',p_baseline_fingerprint);
end $$;

-- Pure application of one authorized reference operation. Attach appends first;
-- the frozen reorder step is performed after all reference operations.
create function toptik_media_private.apply_step(p_pair jsonb,p_body jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog,pg_temp as $$
declare target text:=p_body->>'target';kind text:=p_body->>'kind';k text:=p_body->>'key';assets jsonb;old jsonb;result jsonb;keys jsonb;
begin
 if target is null or target not in ('gallery','shopify') or kind is null or kind not in ('attach','detach_reference','replace_reference','alt','reorder') then raise exception 'MEDIA_STEP_INVALID';end if;
 assets:=p_pair#>array[target,'assets'];old:=toptik_media_private.asset(p_pair->target,k);
 if kind='attach' then
  if old is not null or jsonb_array_length(assets)>=250 or p_body#>>'{value,key}' is distinct from k then raise exception 'MEDIA_ATTACH_INVALID';end if;
  result:=assets||jsonb_build_array(p_body->'value');
 elsif kind='detach_reference' then
  if old is null or jsonb_array_length(assets)<=1 then raise exception 'MEDIA_LAST_IMAGE_OR_REFERENCE_PROTECTED';end if;
  select coalesce(jsonb_agg(a order by n),'[]'::jsonb) into result from jsonb_array_elements(assets) with ordinality x(a,n) where a->>'key'<>k;
 elsif kind in ('replace_reference','alt') then
  if old is null then raise exception 'MEDIA_REFERENCE_MISSING';end if;
  select jsonb_agg(case when a->>'key'=k then a||case kind when 'alt' then jsonb_build_object('alt',p_body->'value') else p_body->'value' end else a end order by n)
  into result from jsonb_array_elements(assets) with ordinality x(a,n);
 else
  keys:=p_body->'keys';
  if jsonb_typeof(keys) is distinct from 'array' or jsonb_array_length(keys)<>jsonb_array_length(assets)
   or jsonb_array_length(keys)<>(select count(distinct value) from jsonb_array_elements(keys))
   or exists(select 1 from jsonb_array_elements_text(keys) x(v) where not exists(select 1 from jsonb_array_elements(assets) a where a->>'key'=x.v)) then raise exception 'MEDIA_REORDER_NOT_PERMUTATION';end if;
  select coalesce(jsonb_agg(toptik_media_private.asset(p_pair->target,x.v) order by x.n),'[]'::jsonb) into result from jsonb_array_elements_text(keys) with ordinality x(v,n);
 end if;
 return jsonb_set(p_pair,array[target,'assets'],result);
end $$;

create function public.reserve_toptik_media_operation(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_expected_version bigint,p_current jsonb,p_plan jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;s toptik_media_private.state%rowtype;o toptik_media_private.operations%rowtype;h text;body jsonb;
 projected jsonb;source text;target text;kind text;k text;asset jsonb;idx int:=0;side text;result jsonb;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if p_operation_id is null or p_expected_version is null or p_expected_version<1 or octet_length(p_plan::text)>3000000 then raise exception 'MEDIA_OPERATION_INVALID';end if;
 perform toptik_media_private.assert_pair(p_current,i);
 h:=toptik_media_private.digest(jsonb_build_object('product',p_product_gid,'version',p_expected_version,'current',p_current,'plan',p_plan));
 select * into o from toptik_media_private.operations where id=p_operation_id for update;
 if found then
  if o.product_gid<>p_product_gid or o.request_hash<>h then raise exception 'MEDIA_OPERATION_ID_REUSED';end if;
  return jsonb_build_object('operationId',o.id,'status',o.status,'version',o.version,'nextStep',o.next_step,'replayed',true,'mayExecute',false);
 end if;
 select * into s from toptik_media_private.state where product_gid=p_product_gid for update;
 if not found or s.version<>p_expected_version then raise exception 'MEDIA_BASELINE_CAS_CONFLICT';end if;
 if exists(select 1 from toptik_media_private.operations where product_gid=p_product_gid and status in ('reserved','running','uncertain')) then raise exception 'MEDIA_OPERATION_PENDING_RECOVERY';end if;
 if jsonb_typeof(p_plan) is distinct from 'object' or not(p_plan ?& array['identity','preconditions','patches','orders','conflicts','projected'])
 or (select count(*) from jsonb_object_keys(p_plan))<>6 or p_plan->'identity' is distinct from i
 or p_plan->'conflicts' is distinct from '[]'::jsonb or jsonb_typeof(p_plan->'patches') is distinct from 'array'
 or jsonb_array_length(p_plan->'patches')>1000 or jsonb_typeof(p_plan->'orders') is distinct from 'array' or jsonb_array_length(p_plan->'orders')>2
 then raise exception 'MEDIA_PLAN_INVALID_OR_CONFLICTED';end if;
 foreach side in array array['gallery','shopify'] loop
  if p_plan#>>array['preconditions',side,'revision'] is distinct from p_current#>>array[side,'revision']
   or p_plan#>>array['preconditions',side,'fingerprint'] is distinct from toptik_media_private.fingerprint(p_current->side) then raise exception 'MEDIA_PLAN_PRECONDITION_MISMATCH';end if;
 end loop;
 projected:=p_current;
 insert into toptik_media_private.operations(id,product_gid,state_version,plan,initial_pair,request_hash,observed_pair)
 values(p_operation_id,p_product_gid,s.version,p_plan,p_current,h,p_current);
 for body in select value from jsonb_array_elements(p_plan->'patches') loop
  source:=body->>'source';target:=body->>'target';kind:=body->>'kind';k:=body->>'key';
  if source is null or source not in ('gallery','shopify') or target is null or target not in ('gallery','shopify') or source=target
  or coalesce(k,'') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' or kind is null or kind not in ('attach','detach_reference','replace_reference','alt')
  or exists(select 1 from jsonb_object_keys(body) x where x not in ('source','target','key','kind','value')) then raise exception 'MEDIA_STEP_INVALID';end if;
  asset:=toptik_media_private.asset(p_current->source,k);
  if kind='detach_reference' then
   if asset is not null or not exists(select 1 from toptik_media_private.removal_intents ri where ri.product_gid=p_product_gid and ri.side=source and ri.asset_key=k
     and ri.baseline_fingerprint=toptik_media_private.fingerprint(s.baselines->source))
    or (toptik_media_private.asset(p_current->target,k)-'evidenceId') is distinct from (toptik_media_private.asset(s.baselines->target,k)-'evidenceId')
    then raise exception 'MEDIA_DETACH_NOT_AUTHORIZED';end if;
  elsif kind='attach' and body->'value' is distinct from asset then raise exception 'MEDIA_ATTACH_SOURCE_MISMATCH';
  elsif kind='replace_reference' and (asset is null or body->'value' is distinct from jsonb_build_object('contentId',asset->'contentId','evidenceId',asset->'evidenceId')) then raise exception 'MEDIA_REPLACE_SOURCE_MISMATCH';
  elsif kind='alt' and (asset is null or body->'value' is distinct from asset->'alt') then raise exception 'MEDIA_ALT_SOURCE_MISMATCH';end if;
  projected:=toptik_media_private.apply_step(projected,body);
  perform toptik_media_private.assert_pair(projected,i,false);
  insert into toptik_media_private.steps(operation_id,step_index,body) values(p_operation_id,idx,body);idx:=idx+1;
 end loop;
 for body in select value from jsonb_array_elements(p_plan->'orders') loop
  if jsonb_typeof(body) is distinct from 'object' or not(body ?& array['target','keys']) or (select count(*) from jsonb_object_keys(body))<>2 then raise exception 'MEDIA_REORDER_INVALID';end if;
  body:=body||jsonb_build_object('kind','reorder');projected:=toptik_media_private.apply_step(projected,body);
  insert into toptik_media_private.steps(operation_id,step_index,body) values(p_operation_id,idx,body);idx:=idx+1;
 end loop;
 foreach side in array array['gallery','shopify'] loop
  if projected#>array[side,'assets'] is distinct from p_plan#>array['projected',side] then raise exception 'MEDIA_PROJECTION_NOT_PLAN_RESULT';end if;
 end loop;
 result:=jsonb_build_object('operationId',p_operation_id,'status','reserved','version',1,'nextStep',0,'steps',idx,'replayed',false,'mayExecute',false);
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result)
 values(p_operation_id,p_product_gid,p_operation_id,'reserved',h,jsonb_build_object('stateVersion',s.version,'current',p_current,'plan',p_plan),result);
 return result;
end $$;

create function public.begin_toptik_media_step(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_attempt_id uuid,p_fresh jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;r toptik_media_private.events%rowtype;h text;result jsonb;expected jsonb;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);perform toptik_media_private.assert_pair(p_fresh,i);
 if p_attempt_id is null then raise exception 'MEDIA_ATTEMPT_INVALID';end if;
 h:=toptik_media_private.digest(jsonb_build_object('product',p_product_gid,'operation',p_operation_id,'step',p_step_index,'fresh',p_fresh));
 select * into r from toptik_media_private.events where request_id=p_attempt_id;
 if found then
  if r.request_hash<>h or r.event_kind<>'begin' then raise exception 'MEDIA_ATTEMPT_ID_REUSED';end if;
  return r.result||jsonb_build_object('mayExecute',false,'replayed',true);
 end if;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if not found then raise exception 'MEDIA_OPERATION_MISSING';end if;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 if not found or o.next_step<>p_step_index then raise exception 'MEDIA_STEP_OUT_OF_ORDER';end if;
 if s.status<>'ready' then return jsonb_build_object('mayExecute',false,'status',s.status,'replayed',true,'body',s.body,'attemptId',s.attempt_id);end if;
 if o.status not in ('reserved','running') or not exists(select 1 from toptik_media_private.state where product_gid=p_product_gid and version=o.state_version) then raise exception 'MEDIA_OPERATION_STATE_CHANGED';end if;
 if p_fresh<>o.observed_pair then
  update toptik_media_private.operations set status='conflict',version=version+1,updated_at=clock_timestamp() where id=o.id;
  update toptik_media_private.steps set status='conflict' where operation_id=o.id and step_index=p_step_index;
  result:=jsonb_build_object('mayExecute',false,'status','conflict','code','MEDIA_SOURCE_OR_TARGET_CHANGED');
 else
  expected:=toptik_media_private.apply_step(p_fresh,s.body);
  update toptik_media_private.steps set status='started',attempt_id=p_attempt_id,expected_pair=expected,started_at=clock_timestamp() where operation_id=o.id and step_index=p_step_index;
  update toptik_media_private.operations set status='running',version=version+1,updated_at=clock_timestamp() where id=o.id;
  result:=jsonb_build_object('mayExecute',true,'status','started','body',s.body,'attemptId',p_attempt_id,'replayed',false);
 end if;
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result)
 values(p_attempt_id,p_product_gid,o.id,'begin',h,jsonb_build_object('stepIndex',p_step_index,'fresh',p_fresh),result);
 return result;
end $$;

create function public.mark_toptik_media_uncertain(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_request_id uuid,p_transport_receipt jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;r toptik_media_private.events%rowtype;h text;result jsonb;
begin
 perform toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if p_request_id is null or jsonb_typeof(p_transport_receipt) is distinct from 'object' or octet_length(p_transport_receipt::text)>4000
  or exists(select 1 from jsonb_object_keys(p_transport_receipt) k where k not in ('transport','requestId','jobId','mediaIds','outcome'))
  or coalesce(p_transport_receipt->>'transport','') not in ('fileCreate','fileUpdate','productReorderMedia','galleryMediaCAS')
  or coalesce(p_transport_receipt->>'outcome','') not in ('unknown','accepted','processing','readback_required')
  or (p_transport_receipt?'requestId' and coalesce(p_transport_receipt->>'requestId','') !~ '^[A-Za-z0-9_-]{1,128}$')
  or (p_transport_receipt?'jobId' and coalesce(p_transport_receipt->>'jobId','') !~ '^gid://shopify/Job/[1-9][0-9]*$')
  or (p_transport_receipt?'mediaIds' and (jsonb_typeof(p_transport_receipt->'mediaIds') is distinct from 'array' or jsonb_array_length(p_transport_receipt->'mediaIds')>250
    or exists(select 1 from jsonb_array_elements_text(p_transport_receipt->'mediaIds') a where a !~ '^gid://shopify/MediaImage/[1-9][0-9]*$')))
  then raise exception 'MEDIA_TRANSPORT_RECEIPT_INVALID';end if;
 h:=toptik_media_private.digest(jsonb_build_object('product',p_product_gid,'operation',p_operation_id,'step',p_step_index,'receipt',p_transport_receipt));
 select * into r from toptik_media_private.events where request_id=p_request_id;
 if found then if r.request_hash<>h or r.event_kind<>'uncertain' then raise exception 'MEDIA_REQUEST_REUSED';end if;return r.result;end if;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if not found or o.status not in ('running','uncertain') or o.next_step<>p_step_index then raise exception 'MEDIA_OPERATION_STATE_CHANGED';end if;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 if not found or s.status not in ('started','uncertain') then raise exception 'MEDIA_STEP_NOT_STARTED';end if;
 update toptik_media_private.steps set status='uncertain' where operation_id=o.id and step_index=p_step_index;
 update toptik_media_private.operations set status='uncertain',version=version+1,updated_at=clock_timestamp() where id=o.id;
 result:=jsonb_build_object('status','uncertain','mayExecute',false,'readbackRequired',true);
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result) values(p_request_id,p_product_gid,o.id,'uncertain',h,p_transport_receipt,result);
 return result;
end $$;

create function public.accept_toptik_media_readback(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_step_index int,p_request_id uuid,p_observed jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.steps%rowtype;r toptik_media_private.events%rowtype;h text;result jsonb;side text;valid bool:=true;target text;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);perform toptik_media_private.assert_pair(p_observed,i);
 if p_request_id is null then raise exception 'MEDIA_READBACK_INVALID';end if;
 h:=toptik_media_private.digest(jsonb_build_object('product',p_product_gid,'operation',p_operation_id,'step',p_step_index,'observed',p_observed));
 select * into r from toptik_media_private.events where request_id=p_request_id;
 if found then if r.request_hash<>h or r.event_kind<>'readback' then raise exception 'MEDIA_REQUEST_REUSED';end if;return r.result;end if;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 if not found or o.status not in ('running','uncertain') or o.next_step<>p_step_index then raise exception 'MEDIA_OPERATION_STATE_CHANGED';end if;
 select * into s from toptik_media_private.steps where operation_id=o.id and step_index=p_step_index for update;
 if not found or s.status not in ('started','uncertain') then raise exception 'MEDIA_STEP_NOT_STARTED';end if;
 target:=s.body->>'target';
 foreach side in array array['gallery','shopify'] loop
  if toptik_media_private.semantic(p_observed->side)<>toptik_media_private.semantic(s.expected_pair->side)
   or (side<>target and p_observed->side<>o.observed_pair->side) then valid:=false;end if;
 end loop;
 update toptik_media_private.steps set status=case when valid then 'verified' else 'conflict' end,readback_pair=p_observed,
  detach_verified=(s.body->>'kind'='detach_reference' and toptik_media_private.asset(p_observed->'gallery',s.body->>'key') is null and toptik_media_private.asset(p_observed->'shopify',s.body->>'key') is null),
  verified_at=case when valid then clock_timestamp() else null end where operation_id=o.id and step_index=p_step_index;
 update toptik_media_private.operations set status=case when valid then 'running' else 'conflict' end,observed_pair=p_observed,
  next_step=case when valid then next_step+1 else next_step end,version=version+1,updated_at=clock_timestamp() where id=o.id;
 result:=jsonb_build_object('status',case when valid then 'verified' else 'conflict' end,'mayExecute',false,
 'code',case when valid then 'MEDIA_STEP_READBACK_VERIFIED' else 'MEDIA_READBACK_CONCURRENT_CHANGE' end,'nextStep',case when valid then o.next_step+1 else o.next_step end);
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result)
 values(p_request_id,p_product_gid,o.id,'readback',h,jsonb_build_object('stepIndex',p_step_index,'observed',p_observed,'expected',s.expected_pair),result);
 return result;
end $$;

create function public.commit_toptik_media_operation(p_product_gid text,p_lease_owner uuid,p_operation_id uuid,p_request_id uuid,p_fresh jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;o toptik_media_private.operations%rowtype;s toptik_media_private.state%rowtype;r toptik_media_private.events%rowtype;h text;result jsonb;side text;valid bool:=true;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);perform toptik_media_private.assert_pair(p_fresh,i);
 if p_request_id is null then raise exception 'MEDIA_COMMIT_INVALID';end if;
 h:=toptik_media_private.digest(jsonb_build_object('product',p_product_gid,'operation',p_operation_id,'fresh',p_fresh));
 select * into r from toptik_media_private.events where request_id=p_request_id;
 if found then if r.request_hash<>h or r.event_kind<>'commit' then raise exception 'MEDIA_REQUEST_REUSED';end if;return r.result;end if;
 select * into o from toptik_media_private.operations where id=p_operation_id and product_gid=p_product_gid for update;
 select * into s from toptik_media_private.state where product_gid=p_product_gid for update;
 if o.id is null or o.status not in ('reserved','running') or s.version<>o.state_version
 or exists(select 1 from toptik_media_private.steps where operation_id=o.id and status<>'verified') then raise exception 'MEDIA_COMMIT_NOT_READY';end if;
 if p_fresh<>o.observed_pair then valid:=false;end if;
 foreach side in array array['gallery','shopify'] loop
  if toptik_media_private.semantic(p_fresh->side)<>toptik_media_private.semantic(jsonb_build_object('assets',o.plan#>array['projected',side])) then valid:=false;end if;
 end loop;
 if valid then
  update toptik_media_private.state set baselines=p_fresh,version=version+1,updated_at=clock_timestamp() where product_gid=p_product_gid;
 end if;
 update toptik_media_private.operations set status=case when valid then 'verified' else 'conflict' end,version=version+1,updated_at=clock_timestamp() where id=o.id;
 result:=jsonb_build_object('status',case when valid then 'verified' else 'conflict' end,'stateVersion',case when valid then s.version+1 else s.version end,'mayExecute',false);
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result)
 values(p_request_id,p_product_gid,o.id,'commit',h,jsonb_build_object('fresh',p_fresh),result);
 return result;
end $$;

-- Genuine concurrent choices remain explicit and durable. A later edit/event can
-- replan them; only a verified new baseline makes the old generation historical.
create function public.record_toptik_media_conflict(p_product_gid text,p_lease_owner uuid,p_request_id uuid,p_expected_version bigint,p_current jsonb,p_conflicts jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;s toptik_media_private.state%rowtype;r toptik_media_private.events%rowtype;h text;c jsonb;result jsonb;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);perform toptik_media_private.assert_pair(p_current,i);
 if p_request_id is null or p_expected_version is null or jsonb_typeof(p_conflicts) is distinct from 'array' or jsonb_array_length(p_conflicts) not between 1 and 1000 then raise exception 'MEDIA_CONFLICT_INVALID';end if;
 for c in select value from jsonb_array_elements(p_conflicts) loop
  if jsonb_typeof(c) is distinct from 'object' or not(c ?& array['key','field','code']) or (select count(*) from jsonb_object_keys(c))<>3
   or coalesce(c->>'key','') !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' or coalesce(c->>'field','') not in ('membership','content','alt','order')
   or coalesce(c->>'code','') !~ '^MEDIA_[A-Z_]{1,80}$' then raise exception 'MEDIA_CONFLICT_INVALID';end if;
 end loop;
 h:=toptik_media_private.digest(jsonb_build_object('product',p_product_gid,'version',p_expected_version,'current',p_current,'conflicts',p_conflicts));
 select * into r from toptik_media_private.events where request_id=p_request_id;
 if found then if r.request_hash<>h or r.event_kind<>'planner_conflict' then raise exception 'MEDIA_REQUEST_REUSED';end if;return r.result;end if;
 select * into s from toptik_media_private.state where product_gid=p_product_gid for update;
 if s.version<>p_expected_version then raise exception 'MEDIA_BASELINE_CAS_CONFLICT';end if;
 result:=jsonb_build_object('status','conflict','stateVersion',s.version,'mayExecute',false,'retained',true);
 insert into toptik_media_private.events(request_id,product_gid,event_kind,request_hash,evidence,result)
 values(p_request_id,p_product_gid,'planner_conflict',h,jsonb_build_object('stateVersion',s.version,'current',p_current,'conflicts',p_conflicts),result);
 return result;
end $$;

-- Receipt generation is a read of verified private steps plus current complete
-- absence readback. Browser-supplied operation IDs/receipts are never accepted.
create function public.read_toptik_media_journal(p_product_gid text,p_lease_owner uuid,p_current jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;s toptik_media_private.state%rowtype;result jsonb;intents jsonb;receipts jsonb:='[]'::jsonb;r record;source text;target text;active_op uuid;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 select * into s from toptik_media_private.state where product_gid=p_product_gid;
 if p_current is not null then perform toptik_media_private.assert_pair(p_current,i);end if;
 select coalesce(jsonb_agg(jsonb_build_object('side',x.side,'key',x.asset_key,'requestId',x.request_id,'kind',x.kind,'expectedBaselineFingerprint',x.baseline_fingerprint) order by x.created_at),'[]'::jsonb)
 into intents from toptik_media_private.removal_intents x where x.product_gid=p_product_gid and x.baseline_fingerprint=toptik_media_private.fingerprint(s.baselines->x.side);
 if p_current is not null then
  for r in select distinct on(st.body->>'source',st.body->>'key') st.body,st.readback_pair,o.id operation_id,x.request_id
   from toptik_media_private.steps st join toptik_media_private.operations o on o.id=st.operation_id
   join toptik_media_private.removal_intents x on x.product_gid=o.product_gid and x.side=st.body->>'source' and x.asset_key=st.body->>'key'
   where o.product_gid=p_product_gid and o.state_version=s.version and st.detach_verified and st.body->>'kind'='detach_reference'
    and x.baseline_fingerprint=toptik_media_private.fingerprint(s.baselines->x.side)
   order by st.body->>'source',st.body->>'key',st.verified_at desc loop
   source:=r.body->>'source';target:=r.body->>'target';
   if toptik_media_private.asset(p_current->source,r.body->>'key') is null and toptik_media_private.asset(p_current->target,r.body->>'key') is null then
    receipts:=receipts||jsonb_build_array(jsonb_build_object('source',source,'target',target,'key',r.body->>'key','operationId',r.operation_id,
      'sourceIntentId',r.request_id,'sourceBaselineFingerprint',toptik_media_private.fingerprint(s.baselines->source),
      'targetBaselineFingerprint',toptik_media_private.fingerprint(s.baselines->target),'targetAbsentReadbackRevision',p_current#>>array[target,'revision']));
   end if;
  end loop;
 end if;
 select id into active_op from toptik_media_private.operations where product_gid=p_product_gid and status<>'verified'
 order by (status in ('reserved','running','uncertain')) desc,created_at desc limit 1;
 select jsonb_build_object('identity',i,'stateVersion',s.version,'baselines',s.baselines,'removals',intents,'detached',receipts,
 'operations',coalesce((select jsonb_agg(to_jsonb(o)) from toptik_media_private.operations o where id=active_op),'[]'::jsonb),
 'steps',coalesce((select jsonb_agg(to_jsonb(st) order by st.step_index) from toptik_media_private.steps st join toptik_media_private.operations o on o.id=st.operation_id
  where o.id=active_op and st.step_index between greatest(0,o.next_step-1) and o.next_step),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(to_jsonb(e) order by created_at) from (select * from toptik_media_private.events
  where operation_id=active_op and event_kind='uncertain' order by created_at desc limit 20) e),'[]'::jsonb),
 'conflicts',coalesce((select jsonb_agg(to_jsonb(e) order by created_at) from (select * from toptik_media_private.events
  where product_gid=p_product_gid and event_kind='planner_conflict' and evidence->>'stateVersion'=s.version::text order by created_at desc limit 5) e),'[]'::jsonb)) into result;
 return result;
end $$;

do $$ declare t text;r record;begin
 foreach t in array array['products','state','asset_identities','provenance','removal_intents','operations','steps','events'] loop
  execute format('alter table toptik_media_private.%I enable row level security',t);
  execute format('revoke all on toptik_media_private.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on toptik_media_private.%I to service_role',t);
  execute format('create policy service_read on toptik_media_private.%I for select to service_role using(true)',t);
 end loop;
 for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and p.proname in ('bootstrap_toptik_media','set_toptik_media_enabled','register_toptik_media_provenance','record_toptik_media_removal','reserve_toptik_media_operation','begin_toptik_media_step','mark_toptik_media_uncertain','accept_toptik_media_readback','commit_toptik_media_operation','read_toptik_media_journal','record_toptik_media_conflict') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
  execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
revoke all on all functions in schema toptik_media_private from public,anon,authenticated,service_role;
