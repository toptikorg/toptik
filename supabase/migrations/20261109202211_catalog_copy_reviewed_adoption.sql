-- Explicit reviewed admission of existing, uniquely bound public products. No live bootstrap runs
-- this automatically. Source/Gallery differences are retained in the immutable reviewed manifest.
begin;
create schema if not exists toptik_copy_adoption_private;
revoke all on schema toptik_copy_adoption_private from public,anon,authenticated;
create table toptik_copy_adoption_private.receipts (
 approval_id uuid primary key,plan_hash text not null,source_hash text not null,gallery_hash text not null,
 actor_id uuid not null,resolution text not null check(resolution in('preserve_both','adopt_shopify')),
 observed_source_watermark timestamptz,manifest jsonb not null,approval_evidence jsonb not null,
 committed_at timestamptz not null default clock_timestamp()
);
alter table toptik_copy_adoption_private.receipts enable row level security;
revoke all on toptik_copy_adoption_private.receipts from public,anon,authenticated,service_role;
-- Same canonical UTF-8 JSON as the application; commercial_canonical is an existing pure helper.
create function public.fingerprint_reviewed_copy_adoption(p_value jsonb) returns text
language sql immutable set search_path=pg_catalog,pg_temp as $$
 select encode(sha256(convert_to(public.commercial_canonical(p_value),'UTF8')),'hex');
$$;
create function public.fingerprint_reviewed_copy_payload(v jsonb) returns text
language sql immutable set search_path=pg_catalog,pg_temp as $$
 select encode(sha256(convert_to('{"title":'||coalesce((v->'title')::text,'null')||',"description":'||coalesce((v->'description')::text,'null')||
  ',"descriptionHtml":'||coalesce((v->'descriptionHtml')::text,'null')||',"seoTitle":'||coalesce((v->'seoTitle')::text,'null')||
  ',"seoDescription":'||coalesce((v->'seoDescription')::text,'null')||'}','UTF8')),'hex');
$$;
create function public.read_reviewed_copy_adoption_receipt(p_approval_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
 select jsonb_build_object('approvalId',approval_id,'planHash',plan_hash,'actorId',actor_id,
  'resolution',resolution,'committedAt',committed_at)
 from toptik_copy_adoption_private.receipts where approval_id=p_approval_id;
$$;

-- Narrow privileged boundary: callers must already authenticate an owner and freshly read Shopify.
-- The function cannot fetch Shopify. It compares all local observations again under the product
-- lease/row locks, and commits approval, independent copy baselines and receipt in one transaction.
create function public.commit_reviewed_copy_adoption(p_plan jsonb,p_approval jsonb,p_owner uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
 o jsonb:=p_plan->'observation'; p jsonb:=o->'source'; g jsonb:=o->'gallery'; b jsonb:=o->'binding';
 v_product text:=p->>'id'; v_key text:=b->>'catalog_key'; v_item uuid:=(g->>'id')::uuid;
 v_approval uuid:=(p_approval->>'approvalId')::uuid; v_actor uuid:=(p_approval->>'actorId')::uuid;
 v_resolution text:=p_plan->>'resolution'; v_activation text:='reviewed-existing-copy:'||(p_approval->>'approvalId');
 c public.carousel_items%rowtype; binding public.shopify_gallery_bindings%rowtype;
 link public.shopify_gallery_public_links%rowtype; old_receipt toptik_copy_adoption_private.receipts%rowtype;
 source_copy jsonb:=p_plan->'shopifyCopy'; desired_copy jsonb:=p_plan->'proposedGalleryCopy'; local_copy jsonb;
 v_hash text:=public.fingerprint_reviewed_copy_adoption(p_plan-'planHash');
begin
 if p_plan->>'policy' is distinct from 'reviewed-existing-copy-v1' or p_plan->'approved' is distinct from 'false'::jsonb
  or v_resolution not in('preserve_both','adopt_shopify') or o->>'shopDomain' is distinct from 'toptikcoil.myshopify.com'
  or p_plan->>'planHash' is distinct from v_hash or p_approval->>'planHash' is distinct from v_hash
  or p_approval->>'sourceHash' is distinct from p_plan->>'sourceHash'
  or p_approval->>'galleryHash' is distinct from p_plan->>'galleryHash'
  or p_plan->>'sourceHash' is distinct from public.fingerprint_reviewed_copy_adoption(p)
  or p_plan->>'galleryHash' is distinct from public.fingerprint_reviewed_copy_adoption(jsonb_build_object(
    'gallery',g,'binding',b,'publicLink',o->'publicLink','approval',o->'approval','state',o->'state','unresolvedOutbox',o->'unresolvedOutbox'))
  or p_approval->'observedSourceWatermark' is distinct from p_plan->'observedSourceWatermark'
  or p_plan->'observedSourceWatermark' is distinct from b->'source_updated_at'
  or v_actor is null or length(btrim(coalesce(p_approval->>'reviewReference','')))=0
  or coalesce((p_approval->>'approvedAt')::timestamptz between clock_timestamp()-interval '1 day' and clock_timestamp()+interval '30 seconds',false) is not true
 then raise exception 'COPY_ADOPTION_REVIEW_REQUIRED'; end if;
 select * into old_receipt from toptik_copy_adoption_private.receipts where approval_id=v_approval;
 if found then
  if old_receipt.plan_hash<>v_hash or old_receipt.actor_id<>v_actor or old_receipt.resolution<>v_resolution
   then raise exception 'COPY_ADOPTION_RECEIPT_CONFLICT'; end if;
  return public.read_reviewed_copy_adoption_receipt(v_approval);
 end if;
 if p->>'status' is distinct from 'ACTIVE' or p->'publishedOnPublication' is distinct from 'true'::jsonb
  or jsonb_array_length(p->'variants')<>1 or p->'variants'->0->>'id' is distinct from b->>'variant_gid'
  or p->'variants'->0->>'sku' is distinct from g->>'catalog_number'
  or b->>'product_gid' is distinct from v_product or b->>'carousel_item_id' is distinct from g->>'id'
  or p->>'handle' is distinct from b->>'product_handle' or not public.shopify_safe_product_handle(p->>'handle')
  or lower(btrim(p->>'vendor')) not in('mandarina duck','bric''s','bric’s','brics','samsonite','american tourister','porsche design')
  or p_plan->>'category' not in('carryon','suitcase','backpacks','laptop-bags','fashion-bags','travel-bags','wallets','pouches')
  or o->'approval' is distinct from 'null'::jsonb or o->'state' is distinct from 'null'::jsonb
  or o->'unresolvedOutbox' is distinct from '[]'::jsonb
 then raise exception 'COPY_ADOPTION_IDENTITY_CONFLICT'; end if;
 perform set_config('lock_timeout','3000ms',true);
 perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 perform public.read_toptik_media_lease(v_product,p_owner);
 select * into c from public.carousel_items where id=v_item for update;
 if not found or to_jsonb(c) is distinct from g or c.is_active is not true then raise exception 'COPY_ADOPTION_OBSERVATION_CHANGED'; end if;
 select * into binding from public.shopify_gallery_bindings where catalog_key=v_key for update;
 if not found or to_jsonb(binding) is distinct from b or binding.is_published is not true
  or (select count(*) from public.shopify_gallery_bindings where product_gid=v_product)<>1
  then raise exception 'COPY_ADOPTION_OBSERVATION_CHANGED'; end if;
 select * into link from public.shopify_gallery_public_links where catalog_key=v_key for update;
 if not found or to_jsonb(link) is distinct from o->'publicLink' or not link.is_published
  then raise exception 'COPY_ADOPTION_OBSERVATION_CHANGED'; end if;
 if exists(select 1 from public.shopify_gallery_copy_eligibility where product_gid=v_product or catalog_key=v_key or carousel_item_id=v_item)
  or exists(select 1 from public.shopify_gallery_sync_state where catalog_key=v_key)
  or exists(select 1 from public.shopify_gallery_content_outbox where (carousel_item_id=v_item or catalog_key=v_key) and status in('pending','processing','review','failed'))
 then raise exception 'COPY_ADOPTION_OBSERVATION_CHANGED'; end if;
 local_copy:=jsonb_build_object('title',c.title,'description',coalesce(c.description,''),'descriptionHtml',c.description_html,'seoTitle',c.seo_title,'seoDescription',c.seo_description);
 if local_copy is distinct from p_plan->'galleryCopy' or source_copy->>'title' is distinct from p->>'title'
  or source_copy->>'descriptionHtml' is distinct from p->>'descriptionHtml'
  or source_copy->'seoTitle' is distinct from p->'seoTitle' or source_copy->'seoDescription' is distinct from p->'seoDescription'
  or desired_copy is distinct from (case when v_resolution='adopt_shopify' then source_copy else local_copy end)
 then raise exception 'COPY_ADOPTION_COPY_INVALID'; end if;
 if v_resolution='adopt_shopify' then
  update public.carousel_items set title=desired_copy->>'title',description=desired_copy->>'description',
   description_html=desired_copy->>'descriptionHtml',seo_title=desired_copy->>'seoTitle',seo_description=desired_copy->>'seoDescription'
   where id=v_item returning * into c;
 end if;
 insert into public.shopify_gallery_copy_activations(approval_id,manifest_sha256,source_file_sha256,manifest)
 values(v_activation,v_hash,p_plan->>'sourceHash',p_plan);
 insert into public.shopify_gallery_copy_eligibility(product_gid,catalog_key,carousel_item_id,variant_gid,exact_gallery_sku,exact_shopify_sku,approved_product_handle,allowed_fields,enabled,approval_id,approved_source_updated_at,alias_evidence)
 values(v_product,v_key,v_item,binding.variant_gid,c.catalog_number,p->'variants'->0->>'sku',binding.product_handle,
  array['title','description','seoTitle','seoDescription'],true,v_activation,(p->>'updatedAt')::timestamptz,'{}');
 insert into public.shopify_gallery_sync_state(catalog_key,last_synced_payload,last_synced_hash,gallery_baseline_payload,shopify_baseline_payload,gallery_updated_at,shopify_updated_at,synced_at)
 values(v_key,desired_copy,public.fingerprint_reviewed_copy_payload(desired_copy),desired_copy,source_copy,c.copy_updated_at,(p->>'updatedAt')::timestamptz,clock_timestamp());
 insert into public.shopify_gallery_copy_activation_receipts(catalog_key,approval_id,snapshot) values(v_key,v_activation,p_plan);
 insert into public.shopify_gallery_copy_activation_events(approval_id,event_kind) values(v_activation,'created'),(v_activation,'enabled');
 -- Binding, public link and their version watermark are deliberately never updated by adoption.
 insert into toptik_copy_adoption_private.receipts(approval_id,plan_hash,source_hash,gallery_hash,actor_id,resolution,observed_source_watermark,manifest,approval_evidence)
 values(v_approval,v_hash,p_plan->>'sourceHash',p_plan->>'galleryHash',v_actor,v_resolution,binding.source_updated_at,p_plan,p_approval);
 return public.read_reviewed_copy_adoption_receipt(v_approval);
end;
$$;
revoke all on function public.fingerprint_reviewed_copy_adoption(jsonb),public.fingerprint_reviewed_copy_payload(jsonb),public.read_reviewed_copy_adoption_receipt(uuid),public.commit_reviewed_copy_adoption(jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.fingerprint_reviewed_copy_adoption(jsonb),public.fingerprint_reviewed_copy_payload(jsonb),public.read_reviewed_copy_adoption_receipt(uuid),public.commit_reviewed_copy_adoption(jsonb,jsonb,uuid) to service_role;

-- Some existing bindings carry an observation-clock watermark newer than Shopify.updatedAt.
-- Never lower it. An older source can be acknowledged only when BOTH publication projections
-- already match exactly, performing zero writes; an actual publication/identity change still fails.
create or replace function public.refresh_shopify_gallery_publication(
 p_product_gid text,p_owner uuid,p_is_published boolean,p_source_updated_at timestamptz,p_handle text,p_visible_variant_gids text[]
) returns integer language plpgsql security invoker set search_path='' as $$
declare b public.shopify_gallery_bindings%rowtype; visible boolean; changed integer:=0;
begin
 if p_product_gid is null or p_product_gid!~'^gid://shopify/Product/[0-9]+$' or p_owner is null or p_is_published is null or p_visible_variant_gids is null
  or (p_is_published and(p_source_updated_at is null or p_handle is null or p_handle!~'^[A-Za-z0-9א-ת][A-Za-z0-9א-ת-]*$' or length(p_handle)>255))
  or exists(select 1 from unnest(p_visible_variant_gids) v where v is null or v!~'^gid://shopify/ProductVariant/[0-9]+$')
  or (not p_is_published and cardinality(p_visible_variant_gids)>0)
 then raise exception 'SYNC_PUBLICATION_INPUT_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 perform public.read_toptik_media_lease(p_product_gid,p_owner);
 for b in select * from public.shopify_gallery_bindings where product_gid=p_product_gid order by catalog_key for update loop
  visible:=p_is_published and b.variant_gid=any(p_visible_variant_gids);
  if p_source_updated_at is not null and b.source_updated_at>p_source_updated_at then
   if b.is_published is distinct from visible or (visible and b.product_handle is distinct from p_handle)
    or not exists(select 1 from public.shopify_gallery_public_links l where l.catalog_key=b.catalog_key
     and l.is_published=visible and l.product_handle=case when visible then p_handle else '' end
     and l.variant_id=case when visible then split_part(b.variant_gid,'/',5) else '0' end)
   then raise exception 'SYNC_PUBLICATION_STALE_SNAPSHOT'; end if;
   continue;
  end if;
  if b.is_published is distinct from visible or (visible and b.product_handle is distinct from p_handle) then
   update public.shopify_gallery_bindings set is_published=visible,product_handle=case when visible then p_handle else product_handle end,
    source_updated_at=coalesce(p_source_updated_at,source_updated_at),synced_at=clock_timestamp() where catalog_key=b.catalog_key;
   changed:=changed+1;
  end if;
  insert into public.shopify_gallery_public_links(catalog_key,product_handle,variant_id,is_published,updated_at)
  values(b.catalog_key,case when visible then p_handle else '' end,case when visible then split_part(b.variant_gid,'/',5) else '0' end,visible,clock_timestamp())
  on conflict(catalog_key) do update set product_handle=excluded.product_handle,variant_id=excluded.variant_id,is_published=excluded.is_published,updated_at=excluded.updated_at
  where(public.shopify_gallery_public_links.product_handle,public.shopify_gallery_public_links.variant_id,public.shopify_gallery_public_links.is_published)
   is distinct from(excluded.product_handle,excluded.variant_id,excluded.is_published);
 end loop;
 return changed;
end;
$$;
commit;
