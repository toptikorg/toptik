-- Service-only planning context and durable wakeups for already enabled media
-- identities. No bootstrap, activation, identity assignment or catalog writes.
create function public.read_toptik_media_planning_context(p_product_gid text,p_lease_owner uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;j jsonb;r jsonb;refs jsonb;proofs jsonb;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 j:=public.read_toptik_media_journal(p_product_gid,p_lease_owner);
 r:=toptik_media_private.gallery_raw(i);
 select x.refs into refs from toptik_media_private.gallery_observations x where product_gid=p_product_gid order by created_at desc,revision limit 1;
 if refs is null then raise exception 'MEDIA_GALLERY_BOOTSTRAP_REQUIRED';end if;
 select coalesce(jsonb_agg(to_jsonb(p) order by evidence_id),'[]'::jsonb) into proofs from toptik_media_private.provenance p where product_gid=p_product_gid;
 if jsonb_array_length(proofs)>2000 or octet_length(proofs::text)>8000000 then raise exception 'MEDIA_PLANNING_CONTEXT_LIMIT';end if;
 return j||jsonb_build_object('galleryRaw',r,'galleryRefs',refs,'provenance',proofs);
end $$;

create table toptik_media_private.work_queue(
 product_gid text primary key references public.shopify_gallery_copy_eligibility(product_gid),
 generation bigint not null default 1 check(generation>0), status text not null default 'pending' check(status in('pending','processing','done','failed','review')),
 claim_id uuid null, claimed_generation bigint null, claimed_at timestamptz null,
 evidence jsonb not null default '{}'::jsonb check(jsonb_typeof(evidence)='object'),
 attempts integer not null default 0, last_error text null, updated_at timestamptz not null default clock_timestamp());
alter table toptik_media_private.work_queue enable row level security;
revoke all on toptik_media_private.work_queue from public,anon,authenticated,service_role;

create function toptik_media_private.enqueue(p_product text,p_evidence jsonb) returns boolean
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare e public.shopify_gallery_copy_eligibility%rowtype;
begin
 perform set_config('lock_timeout','3000ms',true);perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 select * into e from public.shopify_gallery_copy_eligibility where product_gid=p_product and enabled;
 if not found or exists(select 1 from toptik_media_private.products where product_gid=p_product and not enabled) then return false;end if;
 perform public.assert_shopify_verified_copy_identity(e.carousel_item_id,e.catalog_key,e.exact_gallery_sku,e.product_gid,e.variant_gid,e.exact_shopify_sku);
 insert into toptik_media_private.work_queue(product_gid,evidence) values(p_product,p_evidence)
 on conflict(product_gid) do update set generation=work_queue.generation+1,
  status=case when work_queue.status='processing' then 'processing' else 'pending' end,
  evidence=work_queue.evidence||excluded.evidence,last_error=null,updated_at=clock_timestamp();
 return true;
end $$;
create function public.enqueue_toptik_gallery_media_work(p_item_ids uuid[],p_actor jsonb) returns integer
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare e record;n integer:=0;
begin
 if p_item_ids is null or cardinality(p_item_ids)>5000 or array_position(p_item_ids,null) is not null
 or jsonb_typeof(p_actor) is distinct from 'object' or not(p_actor ?& array['actorType','actorId']) or (select count(*) from jsonb_object_keys(p_actor))<>2
 or not coalesce((p_actor->>'actorType'='supabase_user' and p_actor->>'actorId'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
  or (p_actor->>'actorType'='admin_panel_token' and p_actor->>'actorId'='configured-admin-panel'),false) then raise exception 'MEDIA_QUEUE_ACTOR_INVALID';end if;
 for e in select distinct product_gid from public.shopify_gallery_copy_eligibility where carousel_item_id=any(p_item_ids) and enabled loop
  if toptik_media_private.enqueue(e.product_gid,jsonb_build_object('gallery',p_actor)) then n:=n+1;end if;
 end loop;return n;
end $$;
create function public.enqueue_toptik_shopify_media_work(p_product_gid text,p_event_id uuid default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare e public.shopify_webhook_events%rowtype;proof jsonb:='{}'::jsonb;
begin
 if coalesce(p_product_gid,'')!~'^gid://shopify/Product/[1-9][0-9]*$' then raise exception 'MEDIA_QUEUE_PRODUCT_INVALID';end if;
 if p_event_id is not null then
  select * into e from public.shopify_webhook_events where id=p_event_id and topic='products/update' and shop_domain='toptikcoil.myshopify.com';
  if not found or coalesce(e.payload->>'admin_graphql_api_id','gid://shopify/Product/'||(e.payload->>'id')) is distinct from p_product_gid
   or length(btrim(coalesce(e.delivery_id,'')))=0 then raise exception 'MEDIA_QUEUE_WEBHOOK_INVALID';end if;
  proof:=jsonb_build_object('shopify',jsonb_build_object('kind','signed_shopify_event','eventId',e.id,'deliveryId',e.delivery_id));
 end if;
 return toptik_media_private.enqueue(p_product_gid,proof);
end $$;
create function public.claim_toptik_media_work(p_claim_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r toptik_media_private.work_queue%rowtype;
begin
 if p_claim_id is null then raise exception 'MEDIA_QUEUE_CLAIM_INVALID';end if;
 select q.* into r from toptik_media_private.work_queue q join public.shopify_gallery_copy_eligibility e on e.product_gid=q.product_gid and e.enabled
 left join toptik_media_private.products p on p.product_gid=q.product_gid
 where (p.product_gid is null or p.enabled) and (q.status in('pending','failed') or (q.status='processing' and q.claimed_at<clock_timestamp()-interval '5 minutes'))
 order by q.updated_at,q.product_gid limit 1 for update of q skip locked;
 if not found then return null;end if;
 update toptik_media_private.work_queue set status='processing',claim_id=p_claim_id,claimed_generation=generation,claimed_at=clock_timestamp(),attempts=attempts+1
 where product_gid=r.product_gid;
 return jsonb_build_object('productId',r.product_gid,'claimId',p_claim_id,'generation',r.generation,'evidence',r.evidence,
  'initialized',exists(select 1 from toptik_media_private.products where product_gid=r.product_gid));
end $$;
create function public.finish_toptik_media_work(p_product_gid text,p_claim_id uuid,p_generation bigint,p_status text,p_error text default null) returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare r toptik_media_private.work_queue%rowtype;
begin
 if p_claim_id is null or p_generation is null or p_generation<1 or p_status is null or p_status not in('pending','done','failed','review')
  or (p_error is not null and p_error!~'^MEDIA_[A-Z0-9_]{1,90}$') then raise exception 'MEDIA_QUEUE_FINISH_INVALID';end if;
 select * into r from toptik_media_private.work_queue where product_gid=p_product_gid for update;
 if not found or r.status<>'processing' or r.claim_id is distinct from p_claim_id or r.claimed_generation is distinct from p_generation then raise exception 'MEDIA_QUEUE_CLAIM_CHANGED';end if;
 update toptik_media_private.work_queue set status=case when generation>p_generation then 'pending' else p_status end,
  evidence=case when generation=p_generation and p_status='done' then '{}'::jsonb else evidence end,
  claim_id=null,claimed_generation=null,claimed_at=null,last_error=p_error,updated_at=clock_timestamp() where product_gid=p_product_gid;
 return true;
end $$;
create function public.recover_toptik_media_work() returns integer
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p record;n integer:=0;
begin
 for p in select e.product_gid from public.shopify_gallery_copy_eligibility e left join toptik_media_private.products m using(product_gid)
  where e.enabled and (m.product_gid is null or m.enabled) order by e.product_gid limit 5000 loop
  begin if toptik_media_private.enqueue(p.product_gid,'{}'::jsonb) then n:=n+1;end if;
  exception when others then if sqlerrm not in('SYNC_COPY_APPROVAL_MISSING_OR_CHANGED','MEDIA_APPROVAL_MISSING_OR_CHANGED') then raise;end if;end;
 end loop;return n;
end $$;
create function public.toptik_media_work_pending() returns boolean
language sql security definer set search_path=pg_catalog,pg_temp as $$
 select exists(select 1 from toptik_media_private.work_queue q join public.shopify_gallery_copy_eligibility e using(product_gid)
  left join toptik_media_private.products p using(product_gid) where e.enabled and (p.product_gid is null or p.enabled) and q.status='pending');
$$;
-- Atomic catalog writes enqueue within the same transaction. Only the
-- authenticated catalog RPC supplies the transaction-local merchant actor.
-- Other writes enqueue recovery without inventing removal authorization.
create function toptik_media_private.queue_gallery_row_change() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare ids uuid[];a jsonb;raw_actor text;e record;
begin
 if tg_table_name='carousel_items' then
  if tg_op='UPDATE' and jsonb_build_array(new.title,new.cover_image_path,new.cover_image_alt,new.is_active)
    is not distinct from jsonb_build_array(old.title,old.cover_image_path,old.cover_image_alt,old.is_active) then return new;end if;
  ids:=array[new.id];
 else
  if tg_op='UPDATE' and to_jsonb(new) is not distinct from to_jsonb(old) then return new;end if;
  if tg_op='INSERT' then ids:=array[new.item_id];
  elsif tg_op='DELETE' then ids:=array[old.item_id];
  else ids:=array[old.item_id,new.item_id];end if;
 end if;
 raw_actor:=current_setting('toptik.media_editor_actor',true);
 if nullif(raw_actor,'') is not null then a:=raw_actor::jsonb;end if;
 if a is not null and a<>'{}'::jsonb then
  perform public.enqueue_toptik_gallery_media_work(ids,a);
 else
  for e in select distinct product_gid from public.shopify_gallery_copy_eligibility where carousel_item_id=any(ids) and enabled loop
   perform toptik_media_private.enqueue(e.product_gid,'{}'::jsonb);
  end loop;
 end if;
 return coalesce(new,old);
end $$;
create trigger gallery_media_durable_wakeup after insert or update on public.carousel_items
 for each row execute function toptik_media_private.queue_gallery_row_change();
create trigger gallery_angle_media_durable_wakeup after insert or update or delete on public.carousel_item_angles
 for each row execute function toptik_media_private.queue_gallery_row_change();

-- This inbox is writable only by the verified webhook receiver/service role.
-- A signed inbox insert and its media wakeup must commit together.
create function toptik_media_private.queue_signed_shopify_change() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare p text;
begin
 if new.topic<>'products/update' or new.shop_domain<>'toptikcoil.myshopify.com' then return new;end if;
 p:=coalesce(new.payload->>'admin_graphql_api_id','gid://shopify/Product/'||(new.payload->>'id'));
 if coalesce(p,'')!~'^gid://shopify/Product/[1-9][0-9]*$' or not exists(
   select 1 from public.shopify_gallery_copy_eligibility where product_gid=p and enabled) then return new;end if;
 begin
  perform public.enqueue_toptik_shopify_media_work(p,new.id);
 exception when others then
  -- Drift is held by both identity gates. Do not break the existing copy inbox;
  -- daily media recovery retries only after exact identity is repaired.
  if sqlerrm not in('SYNC_COPY_APPROVAL_MISSING_OR_CHANGED','MEDIA_APPROVAL_MISSING_OR_CHANGED') then raise;end if;
 end;
 return new;
end $$;
create trigger shopify_media_durable_wakeup after insert on public.shopify_webhook_events
 for each row execute function toptik_media_private.queue_signed_shopify_change();

create function public.read_toptik_media_bootstrap_context(p_product_gid text,p_lease_owner uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;r toptik_media_private.products%rowtype;
begin
 i:=toptik_media_private.assert_copy_identity(p_product_gid,p_lease_owner);
 select * into r from toptik_media_private.products where product_gid=p_product_gid;
 if found and r.identity<>i then raise exception 'MEDIA_APPROVAL_MISSING_OR_CHANGED';end if;
 return jsonb_build_object('identity',i,'galleryRaw',toptik_media_private.gallery_raw(i),
  'initialized',r.product_gid is not null,'enabled',coalesce(r.enabled,false),'approvalId',r.approval_id);
end $$;
create function public.initialize_toptik_media_observation(p_product_gid text,p_lease_owner uuid,p_approval_id uuid,
 p_pair jsonb,p_proofs jsonb,p_evidence jsonb,p_refs jsonb,p_enable boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;raw jsonb;observed jsonb;r jsonb;
begin
 i:=toptik_media_private.assert_copy_identity(p_product_gid,p_lease_owner);
 if p_enable is null then raise exception 'MEDIA_APPROVAL_INVALID';end if;
 raw:=toptik_media_private.gallery_raw(i);
 if raw->>'revision' is distinct from p_pair#>>'{gallery,revision}' then raise exception 'MEDIA_GALLERY_CAS_CHANGED';end if;
 r:=public.bootstrap_toptik_media(p_product_gid,p_lease_owner,p_approval_id,p_pair,p_proofs,p_evidence);
 observed:=public.observe_toptik_gallery_media(p_product_gid,p_lease_owner,raw->>'revision',p_refs);
 if observed->'snapshot' is distinct from p_pair->'gallery' then raise exception 'MEDIA_BOOTSTRAP_OBSERVATION_MISMATCH';end if;
 if p_enable then perform public.set_toptik_media_enabled(p_product_gid,p_lease_owner,pg_catalog.gen_random_uuid(),true,p_approval_id);end if;
 return jsonb_build_object('initialized',true,'approvalId',p_approval_id,'enabled',p_enable or (r->>'enabled')::boolean,'replayed',(r->>'replayed')::boolean);
end $$;

do $$ declare f record;begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in(
 'read_toptik_media_planning_context','enqueue_toptik_gallery_media_work','enqueue_toptik_shopify_media_work','claim_toptik_media_work','finish_toptik_media_work','recover_toptik_media_work','toptik_media_work_pending','read_toptik_media_bootstrap_context','initialize_toptik_media_observation') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.sig);execute format('grant execute on function %s to service_role',f.sig);
 end loop;
end $$;
revoke all on all functions in schema toptik_media_private from public,anon,authenticated,service_role;
