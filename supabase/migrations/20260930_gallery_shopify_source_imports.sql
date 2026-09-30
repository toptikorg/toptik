-- Private raw import claims; never manufacturer verification or a public catalog insert.
-- Requires 20260930_gallery_shopify_pending_intents.sql. No backfill or activation.
create table if not exists public.shopify_gallery_creation_imports (
 vendor text not null check(vendor in ('mandarina','brics')),
 exact_manufacturer_sku text not null, manufacturer_key text not null,
 intent_id uuid not null unique references public.shopify_gallery_creation_intents(id),
 original_record jsonb not null, raw_source jsonb not null,
 source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 primary key(vendor,exact_manufacturer_sku), unique(manufacturer_key),
 check(length(exact_manufacturer_sku) between 2 and 64 and exact_manufacturer_sku=btrim(exact_manufacturer_sku)
   and exact_manufacturer_sku ~ '^[A-Za-z0-9][A-Za-z0-9._ /-]*$'),
 check(octet_length(raw_source::text)<=1000000)
);
alter table public.shopify_gallery_creation_imports enable row level security;
revoke all on public.shopify_gallery_creation_imports from public,anon,authenticated,service_role;
grant select on public.shopify_gallery_creation_imports to service_role;
drop policy if exists creation_import_private_read on public.shopify_gallery_creation_imports;
create policy creation_import_private_read on public.shopify_gallery_creation_imports for select to service_role using(true);
drop trigger if exists creation_import_immutable on public.shopify_gallery_creation_imports;
create trigger creation_import_immutable before update or delete on public.shopify_gallery_creation_imports
 for each row execute function public.creation_intent_audit_immutable();

-- Ignore only generated identities. Preserve array order, metadata, copy and image URLs.
create or replace function public.creation_import_source_hash(p_source jsonb) returns text
language sql immutable set search_path=pg_catalog,pg_temp as $$
 select encode(sha256(convert_to(((p_source-'id')||jsonb_build_object('angles',coalesce(
   (select jsonb_agg(a-'id'-'itemId' order by n) from jsonb_array_elements(p_source->'angles') with ordinality t(a,n)),
   '[]'::jsonb)))::text,'UTF8')),'hex')
$$;

-- This protects both arrival orders: import first or ordinary private editor first.
create or replace function public.creation_pending_import_identity_guard() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare keys text[];
begin
 perform set_config('lock_timeout','3000ms',true); perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 keys:=array[nullif(public.creation_catalog_key(new.record->'input'->>'shopifySku'),''),
             nullif(public.creation_catalog_key(new.record->'input'->>'manufacturerSku'),'')];
 if exists(select 1 from public.shopify_gallery_creation_intents p where p.id<>new.id and
   (nullif(public.creation_catalog_key(p.record->'input'->>'shopifySku'),'')=any(keys)
    or nullif(public.creation_catalog_key(p.record->'input'->>'manufacturerSku'),'')=any(keys)))
  or exists(select 1 from public.shopify_gallery_creation_imports r where r.intent_id<>new.id and r.manufacturer_key=any(keys))
 then raise exception 'SYNC_CREATION_IMPORT_IDENTITY_RESERVED'; end if;
 return new;
end $$;
drop trigger if exists creation_pending_import_identity_guard on public.shopify_gallery_creation_intents;
create trigger creation_pending_import_identity_guard before insert or update on public.shopify_gallery_creation_intents
 for each row execute function public.creation_pending_import_identity_guard();

create or replace function public.stage_gallery_creation_import(p_record jsonb,p_vendor text,p_exact_manufacturer_sku text,p_source jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb:=p_record->'input'; v_id uuid; k text; r public.shopify_gallery_creation_imports%rowtype;
 current_record jsonb; expected_html text; expected_media jsonb; expected_category text; v_source_hash text;
begin
 if p_vendor is null or p_vendor not in ('mandarina','brics') or p_exact_manufacturer_sku is null
  or p_exact_manufacturer_sku<>btrim(p_exact_manufacturer_sku) or length(p_exact_manufacturer_sku) not between 2 and 64
  or p_exact_manufacturer_sku !~ '^[A-Za-z0-9][A-Za-z0-9._ /-]*$'
  or jsonb_typeof(p_source) is distinct from 'object' or octet_length(p_source::text)>1000000
  or jsonb_typeof(p_source->'angles') is distinct from 'array' or jsonb_array_length(p_source->'angles')>100
  or jsonb_typeof(p_source->'id') is distinct from 'string'
  or p_source->>'id' is distinct from i->>'galleryItemId'
  or p_source->>'catalogNumber' is distinct from p_exact_manufacturer_sku
  or p_record->'parentRevision' is distinct from 'null'::jsonb
  or i->'shopifySku' is distinct from 'null'::jsonb or i->'identityMappingReceiptId' is distinct from 'null'::jsonb
  or i->>'manufacturerSku' is distinct from p_exact_manufacturer_sku
  or i->>'brand' is distinct from (case p_vendor when 'mandarina' then 'Mandarina Duck' else 'Bric''s' end)
  or i->'commerce' is distinct from '{"sellingPrice":null,"currency":null,"compareAtPrice":null,"barcode":null,"taxable":null,"requiresShipping":null,"inventory":{"status":"unknown"},"storeIntent":"undecided"}'::jsonb
  or jsonb_typeof(p_record->'provenance') is distinct from 'object'
 then raise exception 'SYNC_CREATION_IMPORT_INPUT_INVALID'; end if;
 if exists(select 1 from jsonb_each(p_record->'provenance') p where p.value->'verifiedManufacturerFact' is distinct from 'false'::jsonb)
 then raise exception 'SYNC_CREATION_IMPORT_NOT_VERIFIED_EVIDENCE'; end if;
 v_id:=(i->>'galleryItemId')::uuid; k:=public.creation_catalog_key(p_exact_manufacturer_sku);
 if k='' or k in ('P10OSV0405J','P10ZJT0624U','ORI05500909','ORI05500024') then raise exception 'SYNC_CREATION_INTENT_HELD_IDENTITY'; end if;
 if exists(select 1 from jsonb_array_elements(p_source->'angles') a where jsonb_typeof(a) is distinct from 'object'
   or a->>'itemId' is distinct from p_source->>'id' or jsonb_typeof(a->'imagePath') is distinct from 'string')
 then raise exception 'SYNC_CREATION_IMPORT_SOURCE_INVALID'; end if;
 -- Mirrors plainDescriptionToHtml for legacy plain source. Rich HTML is kept byte-exact;
 -- the trusted TS parser validates its safety/plain projection before this private RPC.
 expected_html:=p_source->>'descriptionHtml';
 if expected_html is null then
  if coalesce(p_source->>'description','')='' then expected_html:='';
  else select string_agg('<p>'||replace(replace(replace(replace(replace(replace(t,'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;'),'''','&#39;'),E'\n','<br>')||'</p>','' order by n)
   into expected_html from regexp_split_to_table(replace(p_source->>'description',E'\r\n',E'\n'),E'\n{2,}') with ordinality p(t,n);
  end if;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('url',url,'alt',case when coalesce(p_source->>'color','')<>''
   then (p_source->>'title')||' — '||(p_source->>'color') else p_source->>'title' end) order by first_n),'[]'::jsonb)
 into expected_media from (select url,min(n) first_n from (
  select p_source->>'coverImagePath' url,0::bigint n union all
  select a->>'imagePath',n from jsonb_array_elements(p_source->'angles') with ordinality t(a,n)
 ) paths where coalesce(url,'')<>'' group by url) ordered;
 expected_category:=case when p_source->'techSpecs'->>'category' in ('carryon','suitcase') then p_source->'techSpecs'->>'category' else null end;
 if i->'copy'->>'title' is distinct from p_source->>'title'
  or jsonb_typeof(i->'copy'->'description') is distinct from 'string'
  or i->'copy'->>'descriptionHtml' is distinct from expected_html
  or i->'copy'->>'seoTitle' is distinct from p_source->>'seoTitle'
  or i->'copy'->>'seoDescription' is distinct from p_source->>'seoDescription'
  or i->>'category' is distinct from expected_category or i->'media' is distinct from expected_media
  or jsonb_array_length(expected_media)>30
  or i->'sourceReferences' is distinct from (case when coalesce(p_source->>'sourceUrl','')='' then '[]'::jsonb else jsonb_build_array(p_source->>'sourceUrl') end)
 then raise exception 'SYNC_CREATION_IMPORT_SOURCE_MISMATCH'; end if;
 v_source_hash:=public.creation_import_source_hash(p_source);
 perform set_config('lock_timeout','3000ms',true); perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into r from public.shopify_gallery_creation_imports where vendor=p_vendor and exact_manufacturer_sku=p_exact_manufacturer_sku for update;
 if found then
  -- Fresh scraped IDs/revisions never replace the persisted merchant record, including frozen records.
  select record into current_record from public.shopify_gallery_creation_intents where id=r.intent_id for update;
  if current_record is null or current_record->'input'->>'manufacturerSku' is distinct from p_exact_manufacturer_sku
   then raise exception 'SYNC_CREATION_IMPORT_RECEIPT_MISMATCH'; end if;
  return jsonb_build_object('record',current_record,'sourceChanged',r.source_hash<>v_source_hash,'replayed',true);
 end if;
 -- Both exact live IDs and normalized manufacturer/store identities are protected, active or inactive.
 perform public.assert_gallery_creation_intent_new(v_id,p_exact_manufacturer_sku);
 if exists(select 1 from public.shopify_gallery_creation_intents where id=v_id)
 then raise exception 'SYNC_CREATION_IMPORT_IDENTITY_RESERVED'; end if;
 current_record:=public.save_gallery_creation_intent(p_record,null);
 insert into public.shopify_gallery_creation_imports(vendor,exact_manufacturer_sku,manufacturer_key,intent_id,original_record,raw_source,source_hash)
 values(p_vendor,p_exact_manufacturer_sku,k,v_id,p_record,p_source,v_source_hash);
 return jsonb_build_object('record',current_record,'sourceChanged',false,'replayed',false);
end $$;
revoke all on function public.creation_import_source_hash(jsonb),public.creation_pending_import_identity_guard() from public,anon,authenticated,service_role;
revoke all on function public.stage_gallery_creation_import(jsonb,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.stage_gallery_creation_import(jsonb,text,text,jsonb) to service_role;
