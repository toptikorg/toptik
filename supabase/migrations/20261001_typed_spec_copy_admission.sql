-- Queue exact copy-approved products for automatic independent typed initialization.
-- No source catalog values are parsed or copied. Existing disabled typed approvals remain disabled.
alter table toptik_spec_private.work_queue drop constraint if exists work_queue_product_gid_fkey;
alter table toptik_spec_private.work_queue add constraint work_queue_product_gid_fkey foreign key(product_gid) references public.shopify_gallery_copy_eligibility(product_gid);
create or replace function public.read_toptik_spec_admission(p_product_gid text,p_lease_owner uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare c public.shopify_gallery_copy_eligibility%rowtype;
begin
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into c from public.shopify_gallery_copy_eligibility where product_gid=p_product_gid and enabled for update;
 if not found or exists(select 1 from toptik_spec_private.eligibility where product_gid=p_product_gid and not enabled) then raise exception 'SPEC_APPROVAL_MISSING_OR_CHANGED';end if;
 perform public.assert_shopify_verified_copy_identity(c.carousel_item_id,c.catalog_key,c.exact_gallery_sku,c.product_gid,c.variant_gid,c.exact_shopify_sku);
 if p_lease_owner is null or not exists(select 1 from public.shopify_gallery_reconciliation_leases where product_gid=p_product_gid and owner=p_lease_owner and expires_at>clock_timestamp()+interval '2 seconds' for update) then raise exception 'SPEC_LEASE_LOST';end if;
 return jsonb_build_object('identity',jsonb_build_object('productGid',c.product_gid,'variantGid',c.variant_gid,'exactSku',c.exact_shopify_sku,'gallerySku',c.exact_gallery_sku,'itemId',c.carousel_item_id,'productHandle',c.approved_product_handle),'copyApprovalId',c.approval_id);
end $$;
create or replace function public.enqueue_toptik_spec_work(p_product_gid text,p_reason text) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare e public.shopify_gallery_copy_eligibility%rowtype;
begin
 if p_reason not in ('gallery','shopify','recovery') then raise exception 'SPEC_QUEUE_REASON_INVALID'; end if;
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select c.* into e from public.shopify_gallery_copy_eligibility c left join toptik_spec_private.eligibility s on s.product_gid=c.product_gid where c.product_gid=p_product_gid and c.enabled and coalesce(s.enabled,true);
 if not found then return false; end if;
 perform public.assert_shopify_verified_copy_identity(e.carousel_item_id,e.catalog_key,e.exact_gallery_sku,e.product_gid,e.variant_gid,e.exact_shopify_sku);
 if (select count(*) from toptik_spec_private.field_state where product_gid=p_product_gid) not in (0,19) then return false; end if;
 insert into toptik_spec_private.work_queue(product_gid) values(p_product_gid)
 on conflict(product_gid) do update set requested_generation=work_queue.requested_generation+1,attempts=0,last_error=null,
 status=case when work_queue.claim_until>clock_timestamp() then 'processing' else 'pending' end,updated_at=clock_timestamp();
 return true;
end $$;
create or replace function public.recover_toptik_spec_work() returns integer language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare c record; n integer:=0;
begin
 for c in select p.product_gid from public.shopify_gallery_copy_eligibility p left join toptik_spec_private.eligibility e using(product_gid)
 where p.enabled and coalesce(e.enabled,true) and (select count(*) from toptik_spec_private.field_state f where f.product_gid=p.product_gid) in (0,19)
 and not exists(select 1 from toptik_spec_private.work_queue q where q.product_gid=p.product_gid and
  (q.requested_generation>q.completed_generation or q.claim_until>clock_timestamp()))
 order by coalesce((select q.updated_at from toptik_spec_private.work_queue q where q.product_gid=p.product_gid),'-infinity'::timestamptz) limit 100 loop
  begin
   if public.enqueue_toptik_spec_work(c.product_gid,'recovery') then n:=n+1;end if;
  exception when raise_exception then
   if sqlerrm not in ('SYNC_COPY_APPROVAL_MISSING_OR_CHANGED','SPEC_APPROVAL_MISSING_OR_CHANGED') then raise;end if;
  end;
 end loop;
 return n;
end $$;
create or replace function toptik_spec_private.queue_copy_admission() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
 if new.enabled and not exists(select 1 from toptik_spec_private.eligibility where product_gid=new.product_gid and not enabled) then
  insert into toptik_spec_private.work_queue(product_gid) values(new.product_gid) on conflict(product_gid) do nothing;
 end if;
 return new;
end $$;
drop trigger if exists toptik_typed_copy_admission on public.shopify_gallery_copy_eligibility;
create trigger toptik_typed_copy_admission after insert or update of enabled on public.shopify_gallery_copy_eligibility for each row execute function toptik_spec_private.queue_copy_admission();
revoke all on function toptik_spec_private.queue_copy_admission() from public,anon,authenticated,service_role;
revoke all on function public.read_toptik_spec_admission(text,uuid),public.enqueue_toptik_spec_work(text,text),public.recover_toptik_spec_work() from public,anon,authenticated,service_role;
grant execute on function public.read_toptik_spec_admission(text,uuid),public.enqueue_toptik_spec_work(text,text),public.recover_toptik_spec_work() to service_role;
