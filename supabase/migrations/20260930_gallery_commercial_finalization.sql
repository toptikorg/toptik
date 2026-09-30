-- Local candidate. Requires the actual creation + pending + source-import chain.
-- SQL stores explicit merchant facts and one-shot intents. It performs NO Shopify calls.
create table if not exists public.gallery_creation_commercial_intents(
 id uuid primary key, item_id uuid not null unique references public.shopify_gallery_creation_drafts(id),
 revision text not null check(revision ~ '^[a-f0-9]{64}$'), record jsonb not null,
 frozen_at timestamptz, created_at timestamptz not null default clock_timestamp()
);
create table if not exists public.gallery_creation_commercial_intent_events(
 intent_id uuid not null references public.gallery_creation_commercial_intents(id), revision text not null,
 record jsonb not null, created_at timestamptz not null default clock_timestamp(), primary key(intent_id,revision)
);
create table if not exists public.gallery_creation_commercial_jobs(
 item_id uuid primary key references public.shopify_gallery_creation_drafts(id),
 intent_id uuid not null unique references public.gallery_creation_commercial_intents(id),
 plan jsonb not null, state jsonb not null, version bigint not null check(version>0),
 created_at timestamptz not null default clock_timestamp()
);
create table if not exists public.gallery_creation_commercial_events(
 item_id uuid not null references public.gallery_creation_commercial_jobs(item_id),
 from_version bigint not null, state jsonb not null, created_at timestamptz not null default clock_timestamp(),
 primary key(item_id,from_version)
);
create table if not exists public.gallery_creation_commercial_dispatches(
 item_id uuid not null references public.gallery_creation_commercial_jobs(item_id),
 step_index integer not null, request jsonb not null, owner uuid not null,
 dispatched_at timestamptz not null default clock_timestamp(), primary key(item_id,step_index)
);
create table if not exists public.gallery_creation_commercial_receipts(
 item_id uuid primary key references public.gallery_creation_commercial_jobs(item_id),
 receipt_id uuid not null unique, product_gid text not null unique, variant_gid text not null unique,
 plan_hash text not null, final_state_version bigint not null, snapshot jsonb not null, request jsonb not null, result jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);

create or replace function public.commercial_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'FINALIZE_IMMUTABLE'; end $$;
do $$ declare t text; begin
 foreach t in array array['gallery_creation_commercial_intents','gallery_creation_commercial_intent_events','gallery_creation_commercial_jobs',
 'gallery_creation_commercial_events','gallery_creation_commercial_dispatches','gallery_creation_commercial_receipts'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to service_role',t);
  execute format('drop policy if exists commercial_service_read on public.%I',t);
  execute format('create policy commercial_service_read on public.%I for select to service_role using(true)',t);
  if t not in ('gallery_creation_commercial_intents','gallery_creation_commercial_jobs') then
   execute format('drop trigger if exists commercial_immutable on public.%I',t);
   execute format('create trigger commercial_immutable before update or delete on public.%I for each row execute function public.commercial_immutable()',t);
  end if;
 end loop;
end $$;

create or replace function public.commercial_command(p_plan jsonb,p_state jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog,pg_temp as $$
declare s jsonb:=p_plan->'steps'->((p_state->>'index')::int); v jsonb:=p_state->'observed'; e jsonb:=v; i jsonb:=v->'identity';
 c jsonb:=p_plan->'intent'->'commercial'; q jsonb; l jsonb; stock jsonb; vars jsonb; req jsonb; query text; h text; attempt text;
 k text:=s->>'kind'; location text:=s->>'locationId';
begin
 h:=public.commercial_hash(jsonb_build_object('plan',p_plan->>'hash','index',(p_state->>'index')::int));
 attempt:=substr(h,1,8)||'-'||substr(h,9,4)||'-8'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12);
 if k='commerce' then
  vars:=jsonb_build_object('productId',i->'productGid','variants',jsonb_build_array(jsonb_build_object('id',i->'variantGid','price',c->'price','compareAtPrice',c->'compareAtPrice',
   'barcode',c->'barcode','taxable',c->'taxable','inventoryPolicy','DENY','inventoryItem',jsonb_build_object('tracked',true,'requiresShipping',true))));
  e:=jsonb_set(e,'{commercial}',c);
  query:='mutation FinalizeVariant($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){productVariants{id} userErrors{field message}}}';
 elsif k in ('activate_location','set_stock') then
  select value into l from jsonb_array_elements(v->'levels') where value->>'locationId'=location;
  select value into stock from jsonb_array_elements(p_plan->'intent'->'stock') where value->>'locationId'=location;
  if stock is null then raise exception 'FINALIZE_STEP_INVALID'; end if;
  if k='activate_location' then
   vars:=jsonb_build_object('inventoryItemId',i->'inventoryItemGid','locationId',location,'key',attempt);
   if l is null then
    vars:=vars||jsonb_build_object('available',stock->'available');
    l:=jsonb_build_object('locationId',location,'active',true,'quantities',jsonb_build_object('available',stock->'available','onHand',stock->'available',
     'committed',0,'reserved',0,'damaged',0,'safetyStock',0,'qualityControl',0,'incoming',0));
   else l:=jsonb_set(l,'{active}','true'); end if;
   query:='mutation FinalizeLocation($inventoryItemId:ID!,$locationId:ID!,$available:Int,$key:String!){inventoryActivate(inventoryItemId:$inventoryItemId,locationId:$locationId,available:$available) @idempotent(key:$key){inventoryLevel{id} userErrors{field message}}}';
   if not(vars?'available') then query:=replace(replace(query,',$available:Int',''),',available:$available','');end if;
  else
   if l is null or l->'active' is distinct from 'true'::jsonb then raise exception 'FINALIZE_LOCATION_NOT_ACTIVE';end if;
   q:=l->'quantities';
   vars:=jsonb_build_object('key',attempt,'input',jsonb_build_object('name','available','reason','correction','referenceDocumentUri','gid://toptik-gallery/CreationStock/'||(p_plan->'intent'->>'intentId'),
    'quantities',jsonb_build_array(jsonb_build_object('inventoryItemId',i->'inventoryItemGid','locationId',location,'quantity',stock->'available','changeFromQuantity',q->'available'))));
   l:=jsonb_set(jsonb_set(l,'{quantities,onHand}',to_jsonb((q->>'onHand')::int+(stock->>'available')::int-(q->>'available')::int)),'{quantities,available}',stock->'available');
   query:='mutation FinalizeStock($input:InventorySetQuantitiesInput!,$key:String!){inventorySetQuantities(input:$input) @idempotent(key:$key){inventoryAdjustmentGroup{createdAt} userErrors{field message}}}';
  end if;
  e:=jsonb_set(e,'{levels}',(select jsonb_agg(value order by value->>'locationId') from
   (select value from jsonb_array_elements(e->'levels') where value->>'locationId'<>location union all select l) a));
 elsif k='activate_product' then
  vars:=jsonb_build_object('product',jsonb_build_object('id',i->'productGid','status','ACTIVE'));e:=jsonb_set(e,'{productStatus}','"ACTIVE"');
  query:='mutation FinalizeStatus($product:ProductUpdateInput!){productUpdate(product:$product){product{id status} userErrors{field message}}}';
 elsif k in ('publish_variant','publish_product') then
  vars:=jsonb_build_object('id',case when k='publish_variant' then i->'variantGid' else i->'productGid' end,'input',jsonb_build_array(jsonb_build_object('publicationId','gid://shopify/Publication/79538258170')));
  if k='publish_variant' then
   e:=jsonb_set(e,'{variantOnlinePublished}','true');
   query:='mutation FinalizeVariantPublication($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){publishable{__typename} userErrors{field message}}}';
  else
   e:=jsonb_set(e,'{publicationIds}','["gid://shopify/Publication/79538258170"]');
   query:='mutation FinalizePublication($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){publishable{__typename} userErrors{field message}}}';
  end if;
 else raise exception 'FINALIZE_STEP_INVALID'; end if;
 req:=jsonb_build_object('apiVersion','2026-07','operation',k,'query',query,'variables',vars);
 if k in ('activate_location','set_stock') then req:=req||jsonb_build_object('idempotencyKey',attempt);end if;
 return jsonb_build_object('step',s,'attemptId',attempt,'request',req,'expected',e);
end $$;

create or replace function public.reserve_gallery_commercial_finalization(p_plan jsonb,p_state jsonb,p_owner uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare item uuid; intent public.gallery_creation_commercial_intents%rowtype; d public.shopify_gallery_creation_drafts%rowtype;
 j public.gallery_creation_commercial_jobs%rowtype; proof jsonb; steps jsonb:='[]'; stock jsonb; l jsonb; initial jsonb; c jsonb;
begin
 if p_owner is null or not public.creation_has_keys(p_plan,array['policyVersion','intent','creation','initial','steps','hash']) or octet_length(p_plan::text)>2500000
  or p_plan->>'policyVersion' is distinct from 'gallery-commerce-finalization-v1' or p_plan->>'hash' is distinct from public.commercial_hash(p_plan-'hash')
 then raise exception 'FINALIZE_PLAN_INVALID'; end if;
 item:=(p_plan->'intent'->>'galleryItemId')::uuid;perform public.commercial_assert_source(item,p_owner,p_plan);
 select * into intent from public.gallery_creation_commercial_intents where item_id=item for update;
 if intent.id is null or intent.record is distinct from p_plan->'intent' then raise exception 'FINALIZE_INTENT_CAS';end if;
 select * into j from public.gallery_creation_commercial_jobs where item_id=item for update;
 if found then
  if j.plan=p_plan and exists(select 1 from public.gallery_creation_commercial_events where item_id=item and from_version=0 and state=p_state) then return public.commercial_job_record(item);end if;
  raise exception 'FINALIZE_PLAN_ALREADY_RESERVED';
 end if;
 select * into d from public.shopify_gallery_creation_drafts where id=item;
 select patch->'readbackProof' into proof from public.shopify_gallery_creation_events where draft_id=item and patch?'readbackProof' order by from_version desc limit 1;
 initial:=p_plan->'initial';c:=p_plan->'creation';
 if proof is null or c->>'readbackCopyMediaFingerprint' is distinct from public.commercial_readback_hash(proof)
  or c->>'readbackGalleryRowFingerprint' is distinct from d.source_row_hash
  or c->'readbackCommerce' is distinct from proof->'snapshot'->'commercial'
  or (c->>'readbackGalleryCopyVersion')::timestamptz is distinct from (d.source->>'copyUpdatedAt')::timestamptz
  or initial->>'productStatus' is distinct from 'DRAFT' or initial->'publicationIds' is distinct from '[]'::jsonb
  or initial->>'productUpdatedAt' is distinct from d.receipt->>'shopifyUpdatedAt'
  or (initial->'commercial')-'tracked'-'inventoryPolicy' is distinct from proof->'snapshot'->'commercial'
  or (initial->'shopifyCopy')-'description' is distinct from proof->'snapshot'->'copy'
 then raise exception 'FINALIZE_DRAFT_READBACK_CHANGED';end if;
 perform public.commercial_assert_snapshot(item,initial,p_plan);
 if initial->'commercial' is distinct from intent.record->'commercial' then steps:=steps||jsonb_build_array(jsonb_build_object('kind','commerce'));end if;
 for stock in select value from jsonb_array_elements(intent.record->'stock') loop
  select value into l from jsonb_array_elements(initial->'levels') where value->>'locationId'=stock->>'locationId';
  if l is null or l->'active'='false'::jsonb then steps:=steps||jsonb_build_array(jsonb_build_object('kind','activate_location','locationId',stock->'locationId'));end if;
  if l is not null and l->'quantities'->'available' is distinct from stock->'available' then steps:=steps||jsonb_build_array(jsonb_build_object('kind','set_stock','locationId',stock->'locationId'));end if;
 end loop;
 if initial->'variantOnlinePublished'='false'::jsonb then steps:=steps||jsonb_build_array(jsonb_build_object('kind','publish_variant'));end if;
 steps:=steps||jsonb_build_array(jsonb_build_object('kind','activate_product'),jsonb_build_object('kind','publish_product'));
 if p_plan->'steps' is distinct from steps or p_state is distinct from jsonb_build_object('planHash',p_plan->'hash','version',1,'index',0,'observed',initial,'pending',null,'review',null)
 then raise exception 'FINALIZE_STATE_INVALID';end if;
 insert into public.gallery_creation_commercial_jobs(item_id,intent_id,plan,state,version) values(item,intent.id,p_plan,p_state,1);
 insert into public.gallery_creation_commercial_events(item_id,from_version,state) values(item,0,p_state);
 update public.gallery_creation_commercial_intents set frozen_at=clock_timestamp() where id=intent.id;
 return public.commercial_job_record(item);
end $$;

create or replace function public.claim_gallery_commercial_finalization(p_id uuid,p_owner uuid,p_seconds integer default 60) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.gallery_creation_commercial_jobs%rowtype;
begin
 if p_owner is null or p_id is null or p_seconds is null or p_seconds not between 30 and 300 then raise exception 'FINALIZE_LEASE_INVALID';end if;
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into j from public.gallery_creation_commercial_jobs where item_id=p_id for update;
 if not found then raise exception 'FINALIZE_JOB_MISSING';end if;
 if exists(select 1 from public.gallery_creation_commercial_receipts where item_id=p_id) then return public.commercial_job_record(p_id);end if;
 if public.claim_gallery_shopify_draft(p_id,p_owner,p_seconds) is null then return null;end if;
 perform public.commercial_assert_source(p_id,p_owner,j.plan);return public.commercial_job_record(p_id);
end $$;

create or replace function public.save_gallery_commercial_finalization(p_id uuid,p_owner uuid,p_expected_version bigint,p_state jsonb,p_observed_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.gallery_creation_commercial_jobs%rowtype; old jsonb; pending jsonb; expected jsonb; obs jsonb; e jsonb; k text;
begin
 if p_owner is null or p_expected_version is null or p_state is null or octet_length(p_state::text)>2500000 then raise exception 'FINALIZE_STATE_INVALID';end if;
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into j from public.gallery_creation_commercial_jobs where item_id=p_id for update;
 if not found then raise exception 'FINALIZE_JOB_MISSING';end if;
 perform public.commercial_assert_source(p_id,p_owner,j.plan);
 if exists(select 1 from public.gallery_creation_commercial_receipts where item_id=p_id) then raise exception 'FINALIZE_ALREADY_BOUND';end if;
 select state into e from public.gallery_creation_commercial_events where item_id=p_id and from_version=p_expected_version;
 if found then
  if e=p_state then return public.commercial_job_record(p_id);end if;
  raise exception 'FINALIZE_REQUEST_REUSED';
 end if;
 if j.version<>p_expected_version then raise exception 'FINALIZE_STATE_CAS';end if;
 old:=j.state;
 if old->'review'<>'null'::jsonb or (old->>'index')::int>=jsonb_array_length(j.plan->'steps') then raise exception 'FINALIZE_STATE_TERMINAL';end if;
 if old->'pending'='null'::jsonb then
  pending:=public.commercial_command(j.plan,old);
  expected:=jsonb_set(jsonb_set(old,'{pending}',pending),'{version}',to_jsonb(j.version+1));
  if p_state is distinct from expected then raise exception 'FINALIZE_START_INVALID';end if;
 else
  if p_observed_at is null or p_observed_at not between clock_timestamp()-interval '30 seconds' and clock_timestamp()+interval '10 seconds' then raise exception 'FINALIZE_FRESH_PROOF_REQUIRED';end if;
  if p_state->'review'='"FINALIZE_READBACK_CONCURRENT_OR_UNCERTAIN"'::jsonb then
   expected:=jsonb_set(jsonb_set(old,'{review}',p_state->'review'),'{version}',to_jsonb(j.version+1));
   if p_state is distinct from expected then raise exception 'FINALIZE_REVIEW_INVALID';end if;
  else
   if not exists(select 1 from public.gallery_creation_commercial_dispatches where item_id=p_id and step_index=(old->>'index')::int) then raise exception 'FINALIZE_DISPATCH_REQUIRED';end if;
   obs:=p_state->'observed';perform public.commercial_assert_snapshot(p_id,obs,j.plan);
   if public.commercial_semantic(obs,old->'pending'->'step'->>'kind'='publish_product') is distinct from public.commercial_semantic(old->'pending'->'expected',old->'pending'->'step'->>'kind'='publish_product') then raise exception 'FINALIZE_READBACK_CHANGED';end if;
   foreach k in array array['productUpdatedAt','variantUpdatedAt','inventoryUpdatedAt'] loop
    if (obs->>k)::timestamptz<(old->'observed'->>k)::timestamptz then raise exception 'FINALIZE_READBACK_CHANGED';end if;
   end loop;
   expected:=jsonb_set(jsonb_set(jsonb_set(jsonb_set(old,'{observed}',obs),'{pending}','null'),'{index}',to_jsonb((old->>'index')::int+1)),'{version}',to_jsonb(j.version+1));
   if p_state is distinct from expected then raise exception 'FINALIZE_ACK_INVALID';end if;
  end if;
 end if;
 update public.gallery_creation_commercial_jobs set state=p_state,version=j.version+1 where item_id=p_id;
 insert into public.gallery_creation_commercial_events(item_id,from_version,state) values(p_id,j.version,p_state);
 return public.commercial_job_record(p_id);
end $$;

create or replace function public.dispatch_gallery_commercial_finalization(p_id uuid,p_owner uuid,p_expected_version bigint) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare j public.gallery_creation_commercial_jobs%rowtype;
begin
 if p_owner is null or p_expected_version is null then raise exception 'FINALIZE_DISPATCH_INVALID';end if;
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into j from public.gallery_creation_commercial_jobs where item_id=p_id for update;
 if not found then raise exception 'FINALIZE_JOB_MISSING';end if;
 perform public.commercial_assert_source(p_id,p_owner,j.plan);
 if j.version<>p_expected_version or j.state->'pending'='null'::jsonb or j.state->'review'<>'null'::jsonb then raise exception 'FINALIZE_DISPATCH_INVALID';end if;
 if exists(select 1 from public.gallery_creation_commercial_dispatches where item_id=p_id and step_index=(j.state->>'index')::int) then raise exception 'FINALIZE_ALREADY_DISPATCHED';end if;
 insert into public.gallery_creation_commercial_dispatches(item_id,step_index,request,owner) values(p_id,(j.state->>'index')::int,j.state->'pending'->'request',p_owner);
 return true;
end $$;
-- JS canonical object keys, without jsonb::text spaces. Price fields are strings;
-- quantity fields are integers. This hash is integrity metadata, not authorization.
create or replace function public.commercial_canonical(v jsonb) returns text language sql immutable set search_path=pg_catalog,pg_temp as $$
 select case jsonb_typeof(v)
 when 'object' then '{'||coalesce((select string_agg(to_jsonb(key)::text||':'||public.commercial_canonical(value),',' order by key collate "C") from jsonb_each(v)),'')||'}'
 when 'array' then '['||coalesce((select string_agg(public.commercial_canonical(value),',' order by ord) from jsonb_array_elements(v) with ordinality a(value,ord)),'')||']'
 else v::text end
$$;
create or replace function public.commercial_hash(v jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(public.commercial_canonical(v),'UTF8')),'hex')
$$;
create or replace function public.commercial_copy(p_id uuid) returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
 select jsonb_build_object('title',title,'description',description,'descriptionHtml',description_html,'seoTitle',seo_title,'seoDescription',seo_description) from public.carousel_items where id=p_id
$$;
create or replace function public.commercial_readback_hash(v jsonb) returns text language sql immutable set search_path=pg_catalog,pg_temp as $$
 select public.commercial_hash(jsonb_build_object('copy',v->'snapshot'->'copy','media',
  (select jsonb_agg(value-'verifiedAt' order by ord) from jsonb_array_elements(v->'media') with ordinality a(value,ord))))
$$;
create or replace function public.commercial_assert_intent(v jsonb) returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
declare s jsonb; c jsonb; p jsonb;
begin
 if not public.creation_has_keys(v,array['intentId','galleryItemId','sourceFingerprint','frozenPendingRevision','currency','targetStatus','storeIntent','commercial','stock','provenance','revision'])
  or octet_length(v::text)>50000 or v->>'targetStatus' is distinct from 'ACTIVE' or v->>'storeIntent' is distinct from 'publish_when_ready'
  or v->>'currency' !~ '^[A-Z]{3}$' or jsonb_typeof(v->'currency') is distinct from 'string'
  or v->>'sourceFingerprint' !~ '^[a-f0-9]{64}$' or jsonb_typeof(v->'sourceFingerprint') is distinct from 'string'
  or v->>'frozenPendingRevision' !~ '^[a-f0-9]{64}$' or jsonb_typeof(v->'frozenPendingRevision') is distinct from 'string'
  or v->>'revision' is distinct from public.commercial_hash(v-'revision')
 then raise exception 'FINALIZE_MERCHANT_DETAILS_REQUIRED'; end if;
 if (v->>'intentId')::uuid is null or (v->>'galleryItemId')::uuid is null then raise exception 'FINALIZE_ID_INVALID'; end if;
 c:=v->'commercial';p:=v->'provenance';
 if not public.creation_has_keys(c,array['price','compareAtPrice','barcode','taxable','requiresShipping','inventoryPolicy','tracked'])
  or jsonb_typeof(c->'price') is distinct from 'string' or c->>'price' !~ '^(0|[1-9][0-9]{0,6})[.][0-9]{2}$' or (c->>'price')::numeric<=0
  or (c->'compareAtPrice'<>'null'::jsonb and (jsonb_typeof(c->'compareAtPrice') is distinct from 'string' or c->>'compareAtPrice' !~ '^(0|[1-9][0-9]{0,6})[.][0-9]{2}$' or (c->>'compareAtPrice')::numeric<=(c->>'price')::numeric))
  or (c->'barcode'<>'null'::jsonb and (jsonb_typeof(c->'barcode') is distinct from 'string' or length(c->>'barcode')>64))
  or jsonb_typeof(c->'taxable') is distinct from 'boolean' or c->'requiresShipping' is distinct from 'true'::jsonb
  or c->>'inventoryPolicy' is distinct from 'DENY' or c->'tracked' is distinct from 'true'::jsonb
  or not public.creation_has_keys(p,array['authority','actorId','requestId','savedAt']) or p->>'authority' is distinct from 'authenticated_gallery_editor'
  or (p->>'actorId')::uuid is null or (p->>'requestId')::uuid is null or (p->>'savedAt')::timestamptz is null
  or jsonb_typeof(v->'stock') is distinct from 'array' or jsonb_array_length(v->'stock') not between 1 and 20
 then raise exception 'FINALIZE_MERCHANT_DETAILS_REQUIRED'; end if;
 for s in select value from jsonb_array_elements(v->'stock') loop
  if not public.creation_has_keys(s,array['locationId','available','basis','evidenceId'])
   or jsonb_typeof(s->'locationId') is distinct from 'string' or s->>'locationId' !~ '^gid://shopify/Location/[1-9][0-9]*$'
   or jsonb_typeof(s->'available') is distinct from 'number' or s->>'available' !~ '^[0-9]+$' or (s->>'available')::numeric>1000000
   or s->>'basis' is distinct from 'merchant_count' or (s->>'evidenceId')::uuid is null then raise exception 'FINALIZE_STOCK_DETAILS_REQUIRED'; end if;
 end loop;
 if (select count(distinct value->>'locationId') from jsonb_array_elements(v->'stock'))<>jsonb_array_length(v->'stock')
 then raise exception 'FINALIZE_DUPLICATE_LOCATION'; end if;
end $$;

create or replace function public.commercial_assert_source(p_id uuid,p_owner uuid,p_plan jsonb default null) returns void
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare d public.shopify_gallery_creation_drafts%rowtype; n public.shopify_gallery_creation_intents%rowtype; c jsonb;
begin
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into d from public.shopify_gallery_creation_drafts where id=p_id for update;
 select * into n from public.shopify_gallery_creation_intents where id=p_id for update;
 if d.id is null or n.id is null or d.stage<>'draft_ready' or n.frozen_at is null
  or n.record->'input'->'commerce'->>'storeIntent' is distinct from 'publish_when_ready' then raise exception 'FINALIZE_DRAFT_READY_REQUIRED'; end if;
 perform public.creation_assert_source(p_id);
 if p_owner is not null and (d.lease_owner is distinct from p_owner or d.lease_expires_at is null or d.lease_expires_at<=clock_timestamp()+interval '2 seconds'
  or not exists(select 1 from public.shopify_gallery_reconciliation_leases where product_gid=d.product_gid and owner=p_owner and expires_at>clock_timestamp()+interval '2 seconds'))
 then raise exception 'FINALIZE_OWNED_LEASE_REQUIRED'; end if;
 if d.catalog_key in ('P10OSV0405J','P10ZJT0624U','ORI05500909','ORI05500024') or d.source->>'brand' not in ('Mandarina Duck','Bric''s','Samsonite')
 then raise exception 'FINALIZE_HELD_IDENTITY'; end if;
 if p_plan is not null then
  c:=p_plan->'creation';
  if c->>'receiptId' is distinct from p_id::text or c->'receipt' is distinct from d.receipt or (c->>'creationRevision')::bigint is distinct from d.version
   or c->>'frozenPendingRevision' is distinct from n.revision or c->>'pendingStoreIntent' is distinct from 'publish_when_ready'
   or c->'sourceIdentity' is distinct from jsonb_build_object('shopifySku',d.source->'shopifySku','manufacturerSku',d.source->'manufacturerSku','brand',d.source->'brand')
   or p_plan->'intent'->>'sourceFingerprint' is distinct from d.ready_proof->>'sourceFingerprint'
   or p_plan->'intent'->>'frozenPendingRevision' is distinct from n.revision
   or p_plan->'intent'->>'currency' is distinct from n.record->'input'->'commerce'->>'currency'
  then raise exception 'FINALIZE_SOURCE_CAS_CHANGED'; end if;
 end if;
end $$;

create or replace function public.save_gallery_creation_commerce(p_intent jsonb,p_expected_revision text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r public.gallery_creation_commercial_intents%rowtype; v_id uuid; v_item uuid; d public.shopify_gallery_creation_drafts%rowtype; n public.shopify_gallery_creation_intents%rowtype;
begin
 perform public.commercial_assert_intent(p_intent);v_id:=(p_intent->>'intentId')::uuid;v_item:=(p_intent->>'galleryItemId')::uuid;
 perform public.commercial_assert_source(v_item,null);
 select * into d from public.shopify_gallery_creation_drafts where id=v_item;
 select * into n from public.shopify_gallery_creation_intents where id=v_item;
 if p_intent->>'sourceFingerprint' is distinct from d.ready_proof->>'sourceFingerprint' or p_intent->>'frozenPendingRevision' is distinct from n.revision
  or p_intent->>'currency' is distinct from n.record->'input'->'commerce'->>'currency' then raise exception 'FINALIZE_SOURCE_CAS_CHANGED'; end if;
 select * into r from public.gallery_creation_commercial_intents where item_id=v_item or id=v_id for update;
 if found then
  if r.id<>v_id or r.item_id<>v_item then raise exception 'FINALIZE_IDENTITY_IMMUTABLE'; end if;
  if r.record=p_intent then return r.record; end if;
  if r.frozen_at is not null then raise exception 'FINALIZE_INTENT_FROZEN'; end if;
  if p_expected_revision is distinct from r.revision then raise exception 'FINALIZE_INTENT_CAS'; end if;
 elsif p_expected_revision is not null then raise exception 'FINALIZE_INTENT_CAS'; end if;
 if (p_intent->'provenance'->>'savedAt')::timestamptz not between clock_timestamp()-interval '5 minutes' and clock_timestamp()+interval '30 seconds'
 then raise exception 'FINALIZE_FRESH_PROVENANCE_REQUIRED'; end if;
 insert into public.gallery_creation_commercial_intents(id,item_id,revision,record) values(v_id,v_item,p_intent->>'revision',p_intent)
 on conflict(id) do update set revision=excluded.revision,record=excluded.record;
 insert into public.gallery_creation_commercial_intent_events(intent_id,revision,record) values(v_id,p_intent->>'revision',p_intent);
 return p_intent;
end $$;

create or replace function public.commercial_job_record(p_id uuid) returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
 select jsonb_build_object('id',j.item_id,'plan',j.plan,'state',j.state,'boundReceipt',r.result)
 from public.gallery_creation_commercial_jobs j left join public.gallery_creation_commercial_receipts r using(item_id) where j.item_id=p_id
$$;
create or replace function public.commercial_semantic(v jsonb,published boolean default false) returns jsonb language sql immutable set search_path=pg_catalog,pg_temp as $$
 select case when published then jsonb_set(v-'productUpdatedAt'-'variantUpdatedAt'-'inventoryUpdatedAt'-'decodedImagesVerifiedAt','{levels}',
  (select coalesce(jsonb_agg(jsonb_build_object('locationId',value->'locationId','active',value->'active') order by value->>'locationId'),'[]') from jsonb_array_elements(v->'levels')))
 else v-'productUpdatedAt'-'variantUpdatedAt'-'inventoryUpdatedAt'-'decodedImagesVerifiedAt' end
$$;
create or replace function public.commercial_assert_snapshot(p_id uuid,v jsonb,p_plan jsonb,p_fresh boolean default true) returns void
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare d public.shopify_gallery_creation_drafts%rowtype; i jsonb; l jsonb; q jsonb; k text; c jsonb; row_version timestamptz;
begin
 select * into d from public.shopify_gallery_creation_drafts where id=p_id;i:=v->'identity';
 if not public.creation_has_keys(v,array['identity','variantCount','productStatus','productUpdatedAt','variantUpdatedAt','inventoryUpdatedAt','publicationIds','variantOnlinePublished','commercial','levels','levelsComplete','copyMediaFingerprint','decodedImagesVerifiedAt','galleryRowFingerprint','galleryCopyVersion','galleryCopy','shopifyCopy','otherProductDataFingerprint','otherInventoryDataFingerprint'])
  or not public.creation_has_keys(i,array['itemId','productGid','variantGid','inventoryItemGid','sku','manufacturerSku','brand','handle','customId','sourceFingerprint'])
  or i->>'itemId' is distinct from p_id::text or i->>'productGid' is distinct from d.product_gid or i->>'variantGid' is distinct from d.variant_gid
  or i->>'inventoryItemGid' !~ '^gid://shopify/InventoryItem/[1-9][0-9]*$' or jsonb_typeof(i->'inventoryItemGid') is distinct from 'string'
  or i->>'sku' is distinct from d.source->>'shopifySku' or i->'manufacturerSku' is distinct from d.source->'manufacturerSku' or i->'brand' is distinct from d.source->'brand'
  or i->'customId' is distinct from d.receipt->'customId' or i->'sourceFingerprint' is distinct from d.ready_proof->'sourceFingerprint'
  or not public.shopify_safe_product_handle(i->>'handle') or v->'variantCount' is distinct from '1'::jsonb or v->'levelsComplete' is distinct from 'true'::jsonb
  or jsonb_typeof(v->'variantOnlinePublished') is distinct from 'boolean' or v->>'productStatus' not in ('DRAFT','ACTIVE') or jsonb_typeof(v->'productStatus') is distinct from 'string'
  or v->'galleryCopy' is distinct from public.commercial_copy(p_id) or v->>'galleryRowFingerprint' is distinct from d.source_row_hash
  or v->>'copyMediaFingerprint' is distinct from p_plan->'creation'->>'readbackCopyMediaFingerprint'
  or jsonb_typeof(v->'levels') is distinct from 'array' or jsonb_array_length(v->'levels')>100
  or jsonb_typeof(v->'publicationIds') is distinct from 'array' or jsonb_array_length(v->'publicationIds')>100
 then raise exception 'FINALIZE_SNAPSHOT_INVALID'; end if;
 select copy_updated_at into row_version from public.carousel_items where id=p_id;
 if (v->>'galleryCopyVersion')::timestamptz is distinct from row_version then raise exception 'FINALIZE_SOURCE_CAS_CHANGED'; end if;
 foreach k in array array['productUpdatedAt','variantUpdatedAt','inventoryUpdatedAt','decodedImagesVerifiedAt'] loop
  if jsonb_typeof(v->k) is distinct from 'string' or not isfinite((v->>k)::timestamptz) or (v->>k)::timestamptz>clock_timestamp()+interval '30 seconds' then raise exception 'FINALIZE_SNAPSHOT_INVALID'; end if;
 end loop;
 if p_fresh and (v->>'decodedImagesVerifiedAt')::timestamptz<clock_timestamp()-interval '5 minutes' then raise exception 'FINALIZE_FRESH_PROOF_REQUIRED'; end if;
 foreach k in array array['otherProductDataFingerprint','otherInventoryDataFingerprint'] loop
  if jsonb_typeof(v->k) is distinct from 'string' or v->>k !~ '^[a-f0-9]{64}$' then raise exception 'FINALIZE_SNAPSHOT_INVALID'; end if;
 end loop;
 c:=v->'commercial';
 if not public.creation_has_keys(c,array['price','compareAtPrice','barcode','taxable','requiresShipping','inventoryPolicy','tracked'])
  or jsonb_typeof(c->'tracked') is distinct from 'boolean' or jsonb_typeof(c->'inventoryPolicy') is distinct from 'string'
  or c->>'inventoryPolicy' not in ('DENY','CONTINUE') then raise exception 'FINALIZE_COMMERCE_INVALID';end if;
 perform public.creation_assert_commercial(c-'tracked'-'inventoryPolicy');
 foreach k in array array['galleryCopy','shopifyCopy'] loop
  c:=v->k;
  if not public.creation_has_keys(c,array['title','description','descriptionHtml','seoTitle','seoDescription'])
   or jsonb_typeof(c->'title') is distinct from 'string' or length(c->>'title') not between 1 and 120
   or (c->'description'<>'null'::jsonb and (jsonb_typeof(c->'description') is distinct from 'string' or length(c->>'description')>50000))
   or (c->'descriptionHtml'<>'null'::jsonb and (jsonb_typeof(c->'descriptionHtml') is distinct from 'string' or length(c->>'descriptionHtml')>250000))
   or (c->'seoTitle'<>'null'::jsonb and (jsonb_typeof(c->'seoTitle') is distinct from 'string' or length(c->>'seoTitle')>512))
   or (c->'seoDescription'<>'null'::jsonb and (jsonb_typeof(c->'seoDescription') is distinct from 'string' or length(c->>'seoDescription')>5000))
  then raise exception 'FINALIZE_COPY_INVALID';end if;
 end loop;
 if (select count(distinct value->>'locationId') from jsonb_array_elements(v->'levels'))<>jsonb_array_length(v->'levels')
  or (select count(distinct value) from jsonb_array_elements(v->'publicationIds'))<>jsonb_array_length(v->'publicationIds') then raise exception 'FINALIZE_DUPLICATE_IDENTITY'; end if;
 for l in select value from jsonb_array_elements(v->'levels') loop
  q:=l->'quantities';
  if not public.creation_has_keys(l,array['locationId','active','quantities']) or jsonb_typeof(l->'active') is distinct from 'boolean'
   or jsonb_typeof(l->'locationId') is distinct from 'string' or l->>'locationId' !~ '^gid://shopify/Location/[1-9][0-9]*$'
   or not public.creation_has_keys(q,array['available','onHand','committed','reserved','damaged','safetyStock','qualityControl','incoming']) then raise exception 'FINALIZE_STOCK_INVALID'; end if;
  for k in select jsonb_object_keys(q) loop
   if jsonb_typeof(q->k) is distinct from 'number' or q->>k !~ '^[0-9]+$' or (q->>k)::numeric>1000000 then raise exception 'FINALIZE_STOCK_INVALID'; end if;
  end loop;
  if (q->>'onHand')::int<>(q->>'available')::int+(q->>'committed')::int+(q->>'reserved')::int+(q->>'damaged')::int+(q->>'safetyStock')::int+(q->>'qualityControl')::int then raise exception 'FINALIZE_STOCK_INVALID'; end if;
 end loop;
 for l in select value from jsonb_array_elements(v->'publicationIds') loop
  if jsonb_typeof(l) is distinct from 'string' or l#>>'{}' !~ '^gid://shopify/Publication/[1-9][0-9]*$' then raise exception 'FINALIZE_PUBLICATION_INVALID'; end if;
 end loop;
end $$;

create or replace function public.commercial_protected_hash(p_id uuid,p_key text,p_approval text) returns text
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare t text; v jsonb:='{}'; rows jsonb; predicate text;
begin
 foreach t in array array['carousel_items','carousel_item_angles','carousel_settings','shopify_gallery_bindings','shopify_gallery_public_links','shopify_gallery_sync_state',
  'shopify_gallery_copy_eligibility','shopify_gallery_copy_activations','shopify_gallery_copy_activation_receipts','shopify_gallery_copy_activation_events','shopify_gallery_content_outbox'] loop
  predicate:=case when t='carousel_items' then format('id<>%L::uuid',p_id)
   when t in ('shopify_gallery_bindings','shopify_gallery_copy_eligibility') then format('carousel_item_id<>%L::uuid',p_id)
   when t in ('shopify_gallery_public_links','shopify_gallery_sync_state','shopify_gallery_copy_activation_receipts') then format('catalog_key<>%L',p_key)
   when t in ('shopify_gallery_copy_activations','shopify_gallery_copy_activation_events') then format('approval_id<>%L',p_approval)
   else 'true' end;
  execute format('select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),''[]''::jsonb) from public.%I r where %s',t,predicate) into rows;
  v:=v||jsonb_build_object(t,rows);
 end loop;
 return public.commercial_hash(v);
end $$;

create or replace function public.finalize_gallery_shopify_public_creation(p_request jsonb,p_owner uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p_id uuid; j public.gallery_creation_commercial_jobs%rowtype; d public.shopify_gallery_creation_drafts%rowtype;
 r public.gallery_creation_commercial_receipts%rowtype; s jsonb; i jsonb; gallery jsonb; shopcopy jsonb; old_item jsonb; protected text;
 approval text; v_result jsonb; receipt uuid; k text; manifest jsonb;
begin
 if p_owner is null or not public.creation_has_keys(p_request,array['p_intent_id','p_intent_revision','p_creation_receipt_id','p_creation_revision','p_plan_hash','p_expected_state_version','p_lease_owner',
  'p_item_id','p_exact_sku','p_product_gid','p_variant_gid','p_inventory_item_gid','p_handle','p_source_fingerprint','p_expected_gallery_row_hash','p_expected_copy_version',
  'p_gallery_baseline','p_shopify_baseline','p_live_commerce','p_live_inventory','p_publication_id','p_verified_at','p_snapshot_hash','p_snapshot'])
  or octet_length(p_request::text)>2500000 then raise exception 'FINALIZE_REQUEST_INVALID';end if;
 p_id:=(p_request->>'p_item_id')::uuid;
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into j from public.gallery_creation_commercial_jobs where item_id=p_id for update;
 if not found then raise exception 'FINALIZE_JOB_MISSING';end if;
 if p_request->>'p_plan_hash' is distinct from j.plan->>'hash' or (p_request->>'p_expected_state_version')::bigint is distinct from j.version
  or p_request->>'p_intent_id' is distinct from j.intent_id::text or p_request->>'p_intent_revision' is distinct from j.plan->'intent'->>'revision'
 then raise exception 'FINALIZE_STATE_CAS';end if;
 select * into r from public.gallery_creation_commercial_receipts where item_id=p_id;
 if found then
  -- Durable receipt replay after a lost DB response. Never touch public data again,
  -- including current Shopify-authoritative inventory after real sales.
  if r.plan_hash=j.plan->>'hash' and r.final_state_version=j.version and r.request=p_request then return r.result;end if;
  raise exception 'FINALIZE_RECEIPT_CONFLICT';
 end if;
 perform public.commercial_assert_source(p_id,p_owner,j.plan);
 if (p_request->>'p_lease_owner')::uuid is distinct from p_owner or p_request->>'p_creation_receipt_id' is distinct from p_id::text
  or (p_request->>'p_creation_revision')::bigint is distinct from (j.plan->'creation'->>'creationRevision')::bigint
  or j.state->'pending'<>'null'::jsonb or j.state->'review'<>'null'::jsonb or (j.state->>'index')::int<>jsonb_array_length(j.plan->'steps')
  or (select count(*) from public.gallery_creation_commercial_dispatches where item_id=p_id)<>jsonb_array_length(j.plan->'steps')
 then raise exception 'FINALIZE_PUBLICATION_NOT_VERIFIED';end if;
 s:=p_request->'p_snapshot';perform public.commercial_assert_snapshot(p_id,s,j.plan);i:=s->'identity';
 if jsonb_typeof(p_request->'p_verified_at') is distinct from 'string' or not isfinite((p_request->>'p_verified_at')::timestamptz)
  or (p_request->>'p_verified_at')::timestamptz not between clock_timestamp()-interval '30 seconds' and clock_timestamp()+interval '10 seconds'
  or p_request->>'p_snapshot_hash' is distinct from public.commercial_hash(s)
  or public.commercial_semantic(s,true) is distinct from public.commercial_semantic(j.state->'observed',true)
  or s->>'productStatus' is distinct from 'ACTIVE' or s->'publicationIds' is distinct from '["gid://shopify/Publication/79538258170"]'::jsonb
  or s->'variantOnlinePublished' is distinct from 'true'::jsonb or s->'commercial' is distinct from j.plan->'intent'->'commercial'
 then raise exception 'FINALIZE_FINAL_READBACK_CHANGED';end if;
 foreach k in array array['productUpdatedAt','variantUpdatedAt','inventoryUpdatedAt'] loop
  if (s->>k)::timestamptz<(j.state->'observed'->>k)::timestamptz then raise exception 'FINALIZE_FINAL_READBACK_CHANGED';end if;
 end loop;
 if p_request->>'p_exact_sku' is distinct from i->>'sku' or p_request->>'p_product_gid' is distinct from i->>'productGid'
  or p_request->>'p_variant_gid' is distinct from i->>'variantGid' or p_request->>'p_inventory_item_gid' is distinct from i->>'inventoryItemGid'
  or p_request->>'p_handle' is distinct from i->>'handle' or p_request->>'p_source_fingerprint' is distinct from i->>'sourceFingerprint'
  or p_request->>'p_expected_gallery_row_hash' is distinct from s->>'galleryRowFingerprint' or p_request->>'p_expected_copy_version' is distinct from s->>'galleryCopyVersion'
  or p_request->'p_gallery_baseline' is distinct from s->'galleryCopy' or p_request->'p_shopify_baseline' is distinct from s->'shopifyCopy'
  or p_request->'p_live_commerce' is distinct from s->'commercial' or p_request->'p_live_inventory' is distinct from s->'levels'
  or p_request->>'p_publication_id' is distinct from 'gid://shopify/Publication/79538258170'
 then raise exception 'FINALIZE_REQUEST_INVALID';end if;
 select * into d from public.shopify_gallery_creation_drafts where id=p_id;
 approval:='gallery-create-commercial:'||p_id::text;
 if exists(select 1 from public.shopify_gallery_copy_activations where approval_id=approval)
  or exists(select 1 from public.shopify_gallery_public_links where variant_id=replace(d.variant_gid,'gid://shopify/ProductVariant/',''))
 then raise exception 'FINALIZE_EXISTING_APPROVED_PRODUCT';end if;
 select to_jsonb(t) into old_item from public.carousel_items t where id=p_id;
 protected:=public.commercial_protected_hash(p_id,d.catalog_key,approval);gallery:=s->'galleryCopy';shopcopy:=s->'shopifyCopy';receipt:=gen_random_uuid();
 manifest:=jsonb_build_object('policyVersion','gallery-commerce-finalization-v1','itemId',p_id,'intentId',j.intent_id,'planHash',j.plan->'hash','receiptId',receipt,
  'sourceFingerprint',i->'sourceFingerprint','frozenPendingRevision',j.plan->'creation'->'frozenPendingRevision');
 insert into public.shopify_gallery_bindings(catalog_key,carousel_item_id,product_gid,variant_gid,product_handle,is_published,source_updated_at)
  values(d.catalog_key,p_id,d.product_gid,d.variant_gid,i->>'handle',true,(s->>'productUpdatedAt')::timestamptz);
 insert into public.shopify_gallery_public_links(catalog_key,product_handle,variant_id,is_published)
  values(d.catalog_key,i->>'handle',replace(d.variant_gid,'gid://shopify/ProductVariant/',''),true);
 insert into public.shopify_gallery_sync_state(catalog_key,last_synced_payload,last_synced_hash,gallery_baseline_payload,shopify_baseline_payload,gallery_updated_at,shopify_updated_at)
  values(d.catalog_key,shopcopy,public.commercial_hash(shopcopy),gallery,shopcopy,(s->>'galleryCopyVersion')::timestamptz,(s->>'productUpdatedAt')::timestamptz);
 insert into public.shopify_gallery_copy_activations(approval_id,manifest_sha256,source_file_sha256,manifest)
  values(approval,public.commercial_hash(manifest),j.plan->>'hash',manifest);
 insert into public.shopify_gallery_copy_eligibility(product_gid,catalog_key,carousel_item_id,variant_gid,exact_gallery_sku,exact_shopify_sku,approved_product_handle,enabled,approval_id,approved_source_updated_at,alias_evidence)
  values(d.product_gid,d.catalog_key,p_id,d.variant_gid,i->>'sku',i->>'sku',i->>'handle',true,approval,(s->>'productUpdatedAt')::timestamptz,
   jsonb_build_object('policyVersion','gallery-commerce-finalization-v1','creationReceiptId',p_id,'finalizationReceiptId',receipt,'sourceFingerprint',i->'sourceFingerprint'));
 update public.carousel_items set is_active=true where id=p_id and not is_active;
 if not found then raise exception 'FINALIZE_SOURCE_CAS_CHANGED';end if;
 insert into public.shopify_gallery_copy_activation_receipts(catalog_key,approval_id,snapshot) values(d.catalog_key,approval,public.verified_copy_current_receipt(p_id,d.catalog_key));
 insert into public.shopify_gallery_copy_activation_events(approval_id,event_kind) values(approval,'created'),(approval,'enabled');
 v_result:=jsonb_build_object('receiptId',receipt,'productGid',d.product_gid,'variantGid',d.variant_gid);
 insert into public.gallery_creation_commercial_receipts(item_id,receipt_id,product_gid,variant_gid,plan_hash,final_state_version,snapshot,request,result)
  values(p_id,receipt,d.product_gid,d.variant_gid,j.plan->>'hash',j.version,s,p_request,v_result);
 if public.commercial_protected_hash(p_id,d.catalog_key,approval) is distinct from protected
  or (select to_jsonb(t)-'updated_at' from public.carousel_items t where id=p_id) is distinct from jsonb_set(old_item-'updated_at','{is_active}','true')
  or not exists(select 1 from public.shopify_gallery_bindings where catalog_key=d.catalog_key and carousel_item_id=p_id and product_gid=d.product_gid and variant_gid=d.variant_gid and product_handle=i->>'handle' and is_published)
  or not exists(select 1 from public.shopify_gallery_public_links where catalog_key=d.catalog_key and product_handle=i->>'handle' and variant_id=replace(d.variant_gid,'gid://shopify/ProductVariant/','') and is_published)
  or not exists(select 1 from public.shopify_gallery_sync_state where catalog_key=d.catalog_key and gallery_baseline_payload=gallery and shopify_baseline_payload=shopcopy)
  or not exists(select 1 from public.shopify_gallery_copy_eligibility where catalog_key=d.catalog_key and carousel_item_id=p_id and product_gid=d.product_gid and variant_gid=d.variant_gid
   and exact_gallery_sku=i->>'sku' and exact_shopify_sku=i->>'sku' and approved_product_handle=i->>'handle' and enabled and approval_id=approval)
  or not exists(select 1 from public.gallery_creation_commercial_receipts where item_id=p_id and snapshot=s and request=p_request and gallery_creation_commercial_receipts.result=v_result)
 then raise exception 'FINALIZE_UNEXPECTED_WRITE';end if;
 return v_result;
end $$;

-- Bounded admin-only classification. A retained immutable draft receipt alone
-- never makes a private item ordinary. Current copy/stock/active flags may change
-- after finalization and therefore are deliberately not compared to old snapshots.
create or replace function public.read_finalized_gallery_creation_items(p_item_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare result jsonb;
begin
 if p_item_ids is null or cardinality(p_item_ids)>1000 or array_position(p_item_ids,null) is not null
  or cardinality(p_item_ids)<>(select count(distinct v) from unnest(p_item_ids) v)
 then raise exception 'FINALIZE_ITEM_IDS_INVALID';end if;
 select coalesce(jsonb_agg(r.item_id order by r.item_id),'[]'::jsonb) into result
 from public.gallery_creation_commercial_receipts r
 join public.gallery_creation_commercial_jobs j on j.item_id=r.item_id and j.plan->>'hash'=r.plan_hash and j.version=r.final_state_version
 join public.shopify_gallery_creation_drafts d on d.id=r.item_id and d.stage='draft_ready' and d.product_gid=r.product_gid and d.variant_gid=r.variant_gid
  and d.receipt=j.plan->'creation'->'receipt' and d.version=(j.plan->'creation'->>'creationRevision')::bigint
  and d.receipt->>'productGid'=r.product_gid and d.receipt->>'variantGid'=r.variant_gid
  and d.ready_proof->'sourceFingerprint'=r.snapshot->'identity'->'sourceFingerprint'
 join public.carousel_items g on g.id=r.item_id and g.catalog_number=d.source->>'shopifySku'
 join public.shopify_gallery_bindings b on b.carousel_item_id=r.item_id and b.catalog_key=d.catalog_key and b.product_gid=r.product_gid and b.variant_gid=r.variant_gid
 join public.shopify_gallery_copy_eligibility e on e.carousel_item_id=r.item_id and e.catalog_key=d.catalog_key and e.product_gid=r.product_gid and e.variant_gid=r.variant_gid
  and e.exact_gallery_sku=d.source->>'shopifySku' and e.exact_shopify_sku=d.source->>'shopifySku' and e.approved_product_handle=b.product_handle
  and e.approval_id='gallery-create-commercial:'||r.item_id::text
 join public.shopify_gallery_copy_activations a on a.approval_id=e.approval_id and a.manifest->>'policyVersion'='gallery-commerce-finalization-v1'
  and a.manifest->>'receiptId'=r.receipt_id::text and a.manifest->>'planHash'=r.plan_hash
 where r.item_id=any(p_item_ids)
  and (select count(*) from public.carousel_items all_items where public.creation_catalog_key(all_items.catalog_number)=d.catalog_key)=1
  and r.result=jsonb_build_object('receiptId',r.receipt_id,'productGid',r.product_gid,'variantGid',r.variant_gid)
  and r.snapshot->'identity'->>'productGid'=r.product_gid and r.snapshot->'identity'->>'variantGid'=r.variant_gid;
 return jsonb_build_object('finalizedItemIds',result);
end $$;

-- All helpers are private, including trigger functions. Only reviewed public RPCs
-- have service EXECUTE; anon/authenticated cannot read any commercial state.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and (p.proname like 'commercial\_%' escape '\' or p.proname in
   ('save_gallery_creation_commerce','reserve_gallery_commercial_finalization','claim_gallery_commercial_finalization','save_gallery_commercial_finalization','dispatch_gallery_commercial_finalization','finalize_gallery_shopify_public_creation','read_finalized_gallery_creation_items')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.save_gallery_creation_commerce(jsonb,text),public.reserve_gallery_commercial_finalization(jsonb,jsonb,uuid),
 public.claim_gallery_commercial_finalization(uuid,uuid,integer),public.save_gallery_commercial_finalization(uuid,uuid,bigint,jsonb,timestamptz),
 public.dispatch_gallery_commercial_finalization(uuid,uuid,bigint),public.finalize_gallery_shopify_public_creation(jsonb,uuid),public.read_finalized_gallery_creation_items(uuid[]) to service_role;
