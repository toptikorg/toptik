-- Private incomplete drafts. No existing Gallery item, approval, Shopify product or stock is changed.
-- Requires 20260930_gallery_shopify_draft_creation.sql; no automatic backfill/activation.
create table if not exists public.shopify_gallery_creation_intents (
 id uuid primary key, catalog_key text unique, record jsonb not null,
 revision text not null check(revision ~ '^[a-f0-9]{64}$'), frozen_at timestamptz,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create table if not exists public.shopify_gallery_creation_intent_events (
 id uuid not null references public.shopify_gallery_creation_intents(id), revision text not null,
 record jsonb not null, created_at timestamptz not null default clock_timestamp(), primary key(id,revision)
);
-- A trusted reviewed source pipeline provisions these receipts; browser APIs cannot create them.
-- Absence is a genuine identity-evidence gap and holds the local draft.
create table if not exists public.shopify_gallery_creation_mappings (
 id uuid primary key, gallery_item_id uuid not null, exact_shopify_sku text not null,
 exact_manufacturer_sku text not null, source_url text not null,
 evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz not null, revoked boolean not null default false,
 check(source_url ~ '^https://[^/@[:space:]]+/' and length(source_url)<=2000)
);
alter table public.shopify_gallery_creation_intents enable row level security;
alter table public.shopify_gallery_creation_intent_events enable row level security;
alter table public.shopify_gallery_creation_mappings enable row level security;
revoke all on public.shopify_gallery_creation_intents, public.shopify_gallery_creation_intent_events,
 public.shopify_gallery_creation_mappings from public,anon,authenticated,service_role;
grant select on public.shopify_gallery_creation_intents, public.shopify_gallery_creation_intent_events,
 public.shopify_gallery_creation_mappings to service_role;
drop policy if exists creation_intent_private_read on public.shopify_gallery_creation_intents;
create policy creation_intent_private_read on public.shopify_gallery_creation_intents for select to service_role using(true);
drop policy if exists creation_intent_private_read on public.shopify_gallery_creation_intent_events;
create policy creation_intent_private_read on public.shopify_gallery_creation_intent_events for select to service_role using(true);
drop policy if exists creation_intent_private_read on public.shopify_gallery_creation_mappings;
create policy creation_intent_private_read on public.shopify_gallery_creation_mappings for select to service_role using(true);

create or replace function public.assert_gallery_creation_intent_new(p_id uuid,p_sku text) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare k text:=nullif(public.creation_catalog_key(p_sku),'');
begin
 if p_id is null or (p_sku is not null and (p_sku<>btrim(p_sku) or length(p_sku) not between 2 and 64
  or p_sku !~ '^[A-Za-z0-9][A-Za-z0-9._ /-]*$' or k is null)) then raise exception 'SYNC_CREATION_INTENT_INPUT_INVALID'; end if;
 if k in ('P10OSV0405J','P10ZJT0624U','ORI05500909','ORI05500024') then raise exception 'SYNC_CREATION_INTENT_HELD_IDENTITY'; end if;
 if exists(select 1 from public.carousel_items where id=p_id or public.creation_catalog_key(catalog_number)=k)
  or exists(select 1 from public.shopify_gallery_bindings where carousel_item_id=p_id or catalog_key=k)
  or exists(select 1 from public.shopify_gallery_copy_eligibility where carousel_item_id=p_id or catalog_key=k
    or public.creation_catalog_key(exact_gallery_sku)=k or public.creation_catalog_key(exact_shopify_sku)=k)
  or exists(select 1 from public.shopify_gallery_public_links where catalog_key=k)
  or exists(select 1 from public.shopify_gallery_sync_state where catalog_key=k)
  or exists(select 1 from public.shopify_gallery_creation_drafts where id=p_id or catalog_key=k)
 then raise exception 'SYNC_CREATION_INTENT_EXISTING_PRODUCT_USE_SYNC'; end if;
end $$;

create or replace function public.save_gallery_creation_intent(p_record jsonb,p_expected_revision text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r public.shopify_gallery_creation_intents%rowtype; i jsonb:=p_record->'input'; v_id uuid; k text; s text; m text; v_at timestamptz;
begin
 if not public.creation_has_keys(p_record,array['policyVersion','input','revision','parentRevision','updatedAt','provenance'])
  or p_record->>'policyVersion' is distinct from 'gallery-creation-intent-v1' or octet_length(p_record::text)>400000
  or jsonb_typeof(p_record->'revision') is distinct from 'string' or p_record->>'revision' !~ '^[a-f0-9]{64}$'
  or (p_expected_revision is not null and p_expected_revision !~ '^[a-f0-9]{64}$')
  or not public.creation_has_keys(i,array['galleryItemId','shopifySku','manufacturerSku','identityMappingReceiptId','brand','category','copy','media','commerce','sourceReferences'])
  or jsonb_typeof(i->'shopifySku') not in ('null','string') or jsonb_typeof(i->'manufacturerSku') not in ('null','string')
  or (i->>'brand' is not null and i->>'brand' not in ('Mandarina Duck','Bric''s','Samsonite'))
  or i->'commerce'->'inventory' is distinct from '{"status":"unknown"}'::jsonb
  or i->'commerce'->>'storeIntent' not in ('undecided','draft','publish_when_ready')
 then raise exception 'SYNC_CREATION_INTENT_INPUT_INVALID'; end if;
 v_id:=(i->>'galleryItemId')::uuid; s:=i->>'shopifySku'; m:=i->>'manufacturerSku'; k:=nullif(public.creation_catalog_key(s),'');
 v_at:=(p_record->>'updatedAt')::timestamptz;
 if v_at is null or not isfinite(v_at) or v_at>clock_timestamp()+interval '30 seconds' or v_at<clock_timestamp()-interval '5 minutes'
  then raise exception 'SYNC_CREATION_INTENT_EDIT_TIME_INVALID'; end if;
 if m is not null and (m<>btrim(m) or length(m) not between 2 and 64 or m !~ '^[A-Za-z0-9][A-Za-z0-9._ /-]*$'
  or public.creation_catalog_key(m) in ('P10OSV0405J','P10ZJT0624U','ORI05500909','ORI05500024'))
 then raise exception 'SYNC_CREATION_INTENT_HELD_IDENTITY'; end if;
 perform set_config('lock_timeout','3000ms',true); perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into r from public.shopify_gallery_creation_intents where id=v_id for update;
 if found then
  if r.frozen_at is not null then raise exception 'SYNC_CREATION_INTENT_FROZEN'; end if;
  -- Idempotent retry after a lost save response requires the same complete record.
  if r.revision=p_record->>'revision' and r.record=p_record and
    (p_expected_revision=r.revision or p_expected_revision is not distinct from r.record->>'parentRevision') then return r.record; end if;
  if p_expected_revision is distinct from r.revision or p_record->>'parentRevision' is distinct from r.revision then raise exception 'SYNC_CREATION_INTENT_STALE_EDIT'; end if;
  if (r.record->'input'->>'shopifySku' is not null and r.record->'input'->>'shopifySku' is distinct from s)
   or (r.record->'input'->>'manufacturerSku' is not null and r.record->'input'->>'manufacturerSku' is distinct from m)
   then raise exception 'SYNC_CREATION_INTENT_IDENTITY_IMMUTABLE'; end if;
  if v_at<(r.record->>'updatedAt')::timestamptz then raise exception 'SYNC_CREATION_INTENT_EDIT_TIME_INVALID'; end if;
 elsif p_expected_revision is not null or p_record->>'parentRevision' is not null then raise exception 'SYNC_CREATION_INTENT_STALE_EDIT'; end if;
 perform public.assert_gallery_creation_intent_new(v_id,s);
 if exists(select 1 from public.shopify_gallery_creation_intents where id<>v_id and catalog_key=k)
 then raise exception 'SYNC_CREATION_INTENT_SKU_RESERVED'; end if;
 insert into public.shopify_gallery_creation_intents(id,catalog_key,record,revision) values(v_id,k,p_record,p_record->>'revision')
 on conflict(id) do update set catalog_key=excluded.catalog_key,record=excluded.record,revision=excluded.revision,updated_at=clock_timestamp();
 insert into public.shopify_gallery_creation_intent_events(id,revision,record) values(v_id,p_record->>'revision',p_record);
 return p_record;
end $$;

create or replace function public.promote_gallery_creation_intent(p_id uuid,p_expected_revision text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r public.shopify_gallery_creation_intents%rowtype; m public.shopify_gallery_creation_mappings%rowtype;
 i jsonb; d jsonb; mapping jsonb:='null'::jsonb; result jsonb;
begin
 perform set_config('lock_timeout','3000ms',true); perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into r from public.shopify_gallery_creation_intents where id=p_id for update;
 if not found or p_expected_revision is null or r.revision is distinct from p_expected_revision then raise exception 'SYNC_CREATION_INTENT_STALE_EDIT'; end if;
 i:=r.record->'input';
 if r.frozen_at is not null then
  perform public.creation_assert_source(p_id);
  return public.creation_record(p_id)||'{"replayed":true}'::jsonb;
 end if;
 perform public.assert_gallery_creation_intent_new(p_id,i->>'shopifySku');
 if i->'commerce'->>'storeIntent' not in ('draft','publish_when_ready') then raise exception 'SYNC_CREATION_INTENT_DETAILS_REQUIRED'; end if;
 if i->>'manufacturerSku' is not null and i->>'manufacturerSku' is distinct from i->>'shopifySku' then
  select * into m from public.shopify_gallery_creation_mappings where id=(i->>'identityMappingReceiptId')::uuid and not revoked;
  if not found or m.gallery_item_id<>p_id or m.exact_shopify_sku is distinct from i->>'shopifySku'
   or m.exact_manufacturer_sku is distinct from i->>'manufacturerSku' or m.verified_at>clock_timestamp()+interval '30 seconds'
  then raise exception 'SYNC_CREATION_INTENT_MAPPING_RECEIPT_MISMATCH'; end if;
  mapping:=jsonb_build_object('shopifySku',m.exact_shopify_sku,'manufacturerSku',m.exact_manufacturer_sku,
    'sourceUrl',m.source_url,'evidenceSha256',m.evidence_sha256,'verifiedAt',to_char(m.verified_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 elsif i->>'identityMappingReceiptId' is not null then raise exception 'SYNC_CREATION_INTENT_UNUSED_MAPPING_RECEIPT'; end if;
 d:=jsonb_build_object('galleryItemId',p_id,'copyUpdatedAt',r.record->>'updatedAt','shopifySku',i->>'shopifySku',
   'manufacturerSku',i->'manufacturerSku','identityMapping',mapping,'brand',i->'brand','category',i->'category',
   'copy',i->'copy','media',i->'media','commerce',(i->'commerce')||'{"storeIntent":"draft"}'::jsonb);
 result:=public.reserve_gallery_shopify_draft(d);
 update public.shopify_gallery_creation_intents set frozen_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_id;
 return result;
end $$;

create or replace function public.creation_intent_audit_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'SYNC_CREATION_INTENT_IMMUTABLE'; end $$;
-- The older completed-draft endpoint cannot consume another pending intent's SKU
-- or bypass the pending record's frozen source/identity evidence.
create or replace function public.creation_pending_reservation_guard() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare r public.shopify_gallery_creation_intents%rowtype; i jsonb; m public.shopify_gallery_creation_mappings%rowtype; expected jsonb; mapping jsonb:='null'::jsonb;
begin
 select * into r from public.shopify_gallery_creation_intents where id=new.id or catalog_key=new.catalog_key for update;
 if not found then
  if new.source->>'manufacturerSku' is not null and new.source->>'manufacturerSku' is distinct from new.source->>'shopifySku'
    or new.source->'identityMapping' is distinct from 'null'::jsonb
  then raise exception 'SYNC_CREATION_INTENT_MAPPING_RECEIPT_REQUIRED'; end if;
  return new;
 end if;
 if r.id<>new.id then raise exception 'SYNC_CREATION_INTENT_SKU_RESERVED'; end if;
 i:=r.record->'input';
 if i->'commerce'->>'storeIntent' not in ('draft','publish_when_ready') then raise exception 'SYNC_CREATION_INTENT_DETAILS_REQUIRED'; end if;
 if i->>'manufacturerSku' is not null and i->>'manufacturerSku' is distinct from i->>'shopifySku' then
  select * into m from public.shopify_gallery_creation_mappings where id=(i->>'identityMappingReceiptId')::uuid and not revoked;
  if not found or m.gallery_item_id<>r.id or m.exact_shopify_sku is distinct from i->>'shopifySku'
   or m.exact_manufacturer_sku is distinct from i->>'manufacturerSku' or m.verified_at>clock_timestamp()+interval '30 seconds'
  then raise exception 'SYNC_CREATION_INTENT_MAPPING_RECEIPT_MISMATCH'; end if;
  mapping:=jsonb_build_object('shopifySku',m.exact_shopify_sku,'manufacturerSku',m.exact_manufacturer_sku,'sourceUrl',m.source_url,
    'evidenceSha256',m.evidence_sha256,'verifiedAt',to_char(m.verified_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 elsif i->>'identityMappingReceiptId' is not null then raise exception 'SYNC_CREATION_INTENT_UNUSED_MAPPING_RECEIPT'; end if;
 expected:=jsonb_build_object('galleryItemId',r.id,'copyUpdatedAt',r.record->>'updatedAt','shopifySku',i->>'shopifySku',
  'manufacturerSku',i->'manufacturerSku','identityMapping',mapping,'brand',i->'brand','category',i->'category','copy',i->'copy',
  'media',i->'media','commerce',(i->'commerce')||'{"storeIntent":"draft"}'::jsonb);
 if new.source is distinct from expected then raise exception 'SYNC_CREATION_INTENT_SOURCE_CHANGED'; end if;
 update public.shopify_gallery_creation_intents set frozen_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.id;
 return new;
end $$;
drop trigger if exists creation_pending_reservation_guard on public.shopify_gallery_creation_drafts;
create trigger creation_pending_reservation_guard before insert on public.shopify_gallery_creation_drafts
 for each row execute function public.creation_pending_reservation_guard();
drop trigger if exists creation_intent_audit_immutable on public.shopify_gallery_creation_intent_events;
create trigger creation_intent_audit_immutable before update or delete on public.shopify_gallery_creation_intent_events
 for each row execute function public.creation_intent_audit_immutable();
revoke all on function public.assert_gallery_creation_intent_new(uuid,text),public.creation_intent_audit_immutable(),public.creation_pending_reservation_guard() from public,anon,authenticated,service_role;
revoke all on function public.save_gallery_creation_intent(jsonb,text),public.promote_gallery_creation_intent(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.save_gallery_creation_intent(jsonb,text),public.promote_gallery_creation_intent(uuid,text) to service_role;
