-- Service-only minimal edits for existing exact bindings. No inventory quantities or tracking writes.
-- Shopify's native variant/product mutations have no compare-and-set argument. The runtime
-- re-reads immediately before dispatch; this journal gives one-shot dispatch, not remote atomic CAS.
create table if not exists public.shopify_gallery_commerce_commands(
 id uuid primary key,item_id uuid not null references public.carousel_items(id),product_gid text not null,
 actor_id uuid not null,baseline jsonb not null,expected_hash text not null,patch jsonb not null,request jsonb not null,desired jsonb not null,
 state text not null default 'pending' check(state in ('pending','confirmed','review')),
 dispatched_at timestamptz,readback jsonb,created_at timestamptz not null default clock_timestamp()
);
create unique index if not exists commerce_one_pending_product on public.shopify_gallery_commerce_commands(product_gid) where state='pending';
create table if not exists public.shopify_gallery_commerce_edit_receipts(
 id uuid primary key references public.shopify_gallery_commerce_commands(id),readback jsonb not null,state text not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table public.shopify_gallery_commerce_commands enable row level security;
alter table public.shopify_gallery_commerce_edit_receipts enable row level security;
revoke all on public.shopify_gallery_commerce_commands,public.shopify_gallery_commerce_edit_receipts from public,anon,authenticated,service_role;
grant select on public.shopify_gallery_commerce_commands,public.shopify_gallery_commerce_edit_receipts to service_role;
drop policy if exists commerce_command_read on public.shopify_gallery_commerce_commands;
create policy commerce_command_read on public.shopify_gallery_commerce_commands for select to service_role using(true);
drop policy if exists commerce_edit_receipt_read on public.shopify_gallery_commerce_edit_receipts;
create policy commerce_edit_receipt_read on public.shopify_gallery_commerce_edit_receipts for select to service_role using(true);
drop trigger if exists commerce_edit_receipt_immutable on public.shopify_gallery_commerce_edit_receipts;
create trigger commerce_edit_receipt_immutable before update or delete on public.shopify_gallery_commerce_edit_receipts for each row execute function public.commercial_immutable();

create or replace function public.read_bound_commerce_identity(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare e public.shopify_gallery_copy_eligibility%rowtype; b public.shopify_gallery_bindings%rowtype;
begin
 select * into e from public.shopify_gallery_copy_eligibility where carousel_item_id=p_item_id and enabled;
 select * into b from public.shopify_gallery_bindings where carousel_item_id=p_item_id;
 if e.carousel_item_id is null or b.carousel_item_id is null or e.catalog_key<>b.catalog_key or e.product_gid<>b.product_gid or e.variant_gid<>b.variant_gid
  or e.approved_product_handle<>b.product_handle or not public.shopify_safe_product_handle(b.product_handle)
  or e.allowed_fields<>array['title','description','seoTitle','seoDescription']
  or not exists(select 1 from public.carousel_items where id=p_item_id and catalog_number=e.exact_gallery_sku)
  or not exists(select 1 from public.shopify_gallery_sync_state where catalog_key=e.catalog_key and gallery_baseline_payload is not null and shopify_baseline_payload is not null)
  or (select count(*) from public.shopify_gallery_bindings where product_gid=e.product_gid)<>1
  or (select count(*) from public.carousel_items where public.creation_catalog_key(catalog_number)=e.catalog_key)<>1
 then raise exception 'FINALIZE_EDIT_IDENTITY_CHANGED';end if;
 return jsonb_build_object('itemId',p_item_id,'catalogKey',e.catalog_key,'exactGallerySku',e.exact_gallery_sku,'sku',e.exact_shopify_sku,
  'productGid',e.product_gid,'variantGid',e.variant_gid,'handle',e.approved_product_handle,'approvalId',e.approval_id);
end $$;
create or replace function public.commerce_edit_assert(p_item uuid,p_owner uuid,p_baseline jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if p_baseline->'identity' is distinct from public.read_bound_commerce_identity(p_item) then raise exception 'FINALIZE_EDIT_IDENTITY_CHANGED';end if;
 if p_owner is null or not exists(select 1 from public.shopify_gallery_reconciliation_leases where product_gid=p_baseline->'identity'->>'productGid' and owner=p_owner and expires_at>clock_timestamp()+interval '2 seconds' for update)
 then raise exception 'FINALIZE_OWNED_LEASE_REQUIRED';end if;
end $$;
create or replace function public.commerce_edit_snapshot(v jsonb) returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
declare k text; f jsonb:=v->'fields';
begin
 if not public.creation_has_keys(v,array['identity','currency','fields','tracked','productUpdatedAt','variantUpdatedAt','inventoryUpdatedAt','publication','variantPublication','protectedHash'])
  or octet_length(v::text)>10000 or jsonb_typeof(v->'tracked') is distinct from 'boolean'
  or jsonb_typeof(v->'publication') is distinct from 'boolean' or jsonb_typeof(v->'variantPublication') is distinct from 'boolean'
  or jsonb_typeof(v->'currency') is distinct from 'string' or v->>'currency' !~ '^[A-Z]{3}$'
  or jsonb_typeof(v->'protectedHash') is distinct from 'string' or v->>'protectedHash' !~ '^[a-f0-9]{64}$'
  or not public.creation_has_keys(f,array['price','compareAtPrice','barcode','taxable','requiresShipping','status'])
  or jsonb_typeof(f->'status') is distinct from 'string' or f->>'status' not in ('ACTIVE','DRAFT','ARCHIVED') then raise exception 'FINALIZE_EDIT_SNAPSHOT_INVALID';end if;
 perform public.creation_assert_commercial(f-'status');
 foreach k in array array['productUpdatedAt','variantUpdatedAt','inventoryUpdatedAt'] loop
  if jsonb_typeof(v->k) is distinct from 'string' or not isfinite((v->>k)::timestamptz) then raise exception 'FINALIZE_EDIT_SNAPSHOT_INVALID';end if;
 end loop;
end $$;
create or replace function public.stage_bound_commerce_edit(p_id uuid,p_item_id uuid,p_actor uuid,p_owner uuid,p_expected_hash text,p_baseline jsonb,p_patch jsonb,p_observed_at timestamptz) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r public.shopify_gallery_commerce_commands%rowtype; desired jsonb; vars jsonb; variant jsonb; query text; payload text; k text;
begin
 if p_id is null or p_actor is null or p_item_id is null or p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb or octet_length(p_patch::text)>2000 then raise exception 'FINALIZE_EDIT_PATCH_INVALID';end if;
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 perform public.commerce_edit_snapshot(p_baseline);perform public.commerce_edit_assert(p_item_id,p_owner,p_baseline);
 if p_expected_hash is distinct from public.commercial_hash(p_baseline) then raise exception 'FINALIZE_EDIT_STALE';end if;
 select * into r from public.shopify_gallery_commerce_commands where id=p_id for update;
 if found then
  if r.item_id=p_item_id and r.actor_id=p_actor and r.expected_hash=p_expected_hash and r.patch=p_patch then return to_jsonb(r);end if;
  raise exception 'FINALIZE_EDIT_REQUEST_REUSED';
 end if;
 if p_observed_at is null or p_observed_at not between clock_timestamp()-interval '15 seconds' and clock_timestamp()+interval '5 seconds' then raise exception 'FINALIZE_EDIT_FRESH_READ_REQUIRED';end if;
 if exists(select 1 from public.shopify_gallery_commerce_commands where product_gid=p_baseline->'identity'->>'productGid' and state='pending') then raise exception 'FINALIZE_EDIT_PENDING_EXISTS';end if;
 for k in select jsonb_object_keys(p_patch) loop
  if k not in ('price','compareAtPrice','barcode','taxable','requiresShipping','status') or p_patch->k is not distinct from p_baseline->'fields'->k then raise exception 'FINALIZE_EDIT_PATCH_INVALID';end if;
 end loop;
 if p_patch?'status' and p_patch-'status'<>'{}'::jsonb then raise exception 'FINALIZE_EDIT_PATCH_INVALID';end if;
 desired:=jsonb_set(p_baseline,'{fields}',(p_baseline->'fields')||p_patch);perform public.commerce_edit_snapshot(desired);
 if desired=p_baseline or (p_patch?'price' and (p_patch->>'price')::numeric<=0)
  or ((p_patch?'price' or p_patch?'compareAtPrice') and desired->'fields'->'compareAtPrice'<>'null'::jsonb and (desired->'fields'->>'compareAtPrice')::numeric<=(desired->'fields'->>'price')::numeric) then raise exception 'FINALIZE_EDIT_PATCH_INVALID';end if;
 if p_patch?'status' then
  vars:=jsonb_build_object('product',jsonb_build_object('id',p_baseline->'identity'->'productGid','status',p_patch->'status'));
  query:='mutation BoundCommerceStatus($product:ProductUpdateInput!){productUpdate(product:$product){product{id} userErrors{field message}}}';payload:='productUpdate';
 else
  variant:=jsonb_build_object('id',p_baseline->'identity'->'variantGid')||(p_patch-'requiresShipping');
  if p_patch?'requiresShipping' then variant:=variant||jsonb_build_object('inventoryItem',jsonb_build_object('requiresShipping',p_patch->'requiresShipping'));end if;
  vars:=jsonb_build_object('productId',p_baseline->'identity'->'productGid','variants',jsonb_build_array(variant));
  query:='mutation BoundCommerceVariant($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){productVariants{id} userErrors{field message}}}';payload:='productVariantsBulkUpdate';
 end if;
 insert into public.shopify_gallery_commerce_commands(id,item_id,product_gid,actor_id,baseline,expected_hash,patch,request,desired)
 values(p_id,p_item_id,p_baseline->'identity'->>'productGid',p_actor,p_baseline,p_expected_hash,p_patch,jsonb_build_object('query',query,'variables',vars,'payload',payload),desired) returning * into r;
 return to_jsonb(r);
end $$;
create or replace function public.dispatch_bound_commerce_edit(p_id uuid,p_owner uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r public.shopify_gallery_commerce_commands%rowtype;
begin
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into r from public.shopify_gallery_commerce_commands where id=p_id for update;
 if r.id is null or r.state<>'pending' or r.dispatched_at is not null or r.created_at<clock_timestamp()-interval '15 seconds' then raise exception 'FINALIZE_EDIT_ALREADY_DISPATCHED';end if;
 perform public.commerce_edit_assert(r.item_id,p_owner,r.baseline);
 update public.shopify_gallery_commerce_commands set dispatched_at=clock_timestamp() where id=p_id;
 return r.request;
end $$;
create or replace function public.ack_bound_commerce_edit(p_id uuid,p_owner uuid,p_readback jsonb,p_observed_at timestamptz) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r public.shopify_gallery_commerce_commands%rowtype; got jsonb; expected jsonb; outcome text; visible boolean; k text;
begin
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into r from public.shopify_gallery_commerce_commands where id=p_id for update;
 if r.id is null then raise exception 'FINALIZE_EDIT_NOT_FOUND';end if;
 if r.state<>'pending' then return to_jsonb(r);end if;
 perform public.commerce_edit_assert(r.item_id,p_owner,r.baseline);perform public.commerce_edit_snapshot(p_readback);
 if p_observed_at is null or p_observed_at not between clock_timestamp()-interval '15 seconds' and clock_timestamp()+interval '5 seconds' then raise exception 'FINALIZE_EDIT_FRESH_READ_REQUIRED';end if;
 got:=p_readback-'productUpdatedAt'-'variantUpdatedAt'-'inventoryUpdatedAt';expected:=r.desired-'productUpdatedAt'-'variantUpdatedAt'-'inventoryUpdatedAt';
 -- These booleans can derive from product status; only a status command may change them.
 if r.patch?'status' then got:=got-'publication'-'variantPublication';expected:=expected-'publication'-'variantPublication';end if;
 outcome:=case when r.dispatched_at is not null and got=expected then 'confirmed' else 'review' end;
 foreach k in array array['productUpdatedAt','variantUpdatedAt','inventoryUpdatedAt'] loop
  if (p_readback->>k)::timestamptz<(r.baseline->>k)::timestamptz then outcome:='review';end if;
 end loop;
 if outcome='confirmed' and r.patch?'status' then
  visible:=p_readback->'fields'->>'status'='ACTIVE' and p_readback->'publication'='true'::jsonb and p_readback->'variantPublication'='true'::jsonb;
  update public.shopify_gallery_bindings set is_published=visible,source_updated_at=(p_readback->>'productUpdatedAt')::timestamptz where catalog_key=r.baseline->'identity'->>'catalogKey';
  update public.shopify_gallery_public_links set is_published=visible where catalog_key=r.baseline->'identity'->>'catalogKey';
 end if;
 update public.shopify_gallery_commerce_commands set state=outcome,readback=p_readback where id=p_id returning * into r;
 insert into public.shopify_gallery_commerce_edit_receipts(id,readback,state) values(p_id,p_readback,outcome);
 return to_jsonb(r);
end $$;
revoke all on function public.read_bound_commerce_identity(uuid),public.commerce_edit_assert(uuid,uuid,jsonb),public.commerce_edit_snapshot(jsonb),
 public.stage_bound_commerce_edit(uuid,uuid,uuid,uuid,text,jsonb,jsonb,timestamptz),public.dispatch_bound_commerce_edit(uuid,uuid),public.ack_bound_commerce_edit(uuid,uuid,jsonb,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.read_bound_commerce_identity(uuid),public.stage_bound_commerce_edit(uuid,uuid,uuid,uuid,text,jsonb,jsonb,timestamptz),public.dispatch_bound_commerce_edit(uuid,uuid),public.ack_bound_commerce_edit(uuid,uuid,jsonb,timestamptz) to service_role;
