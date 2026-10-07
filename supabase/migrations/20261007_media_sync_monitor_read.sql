-- Read-only, bounded per-SKU view of OPEN media queue rows for the admin
-- monitor. Service role only (called by the authenticated admin server route).
-- Returns no payloads, evidence, guards, URLs, tokens or provider messages:
-- last_error is passed through only when it is an allowlisted MEDIA_ code.
-- No queue, approval, baseline, history or catalog change.
begin;
create function public.read_toptik_media_sync_monitor(p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare items jsonb;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'MEDIA_MONITOR_INPUT_INVALID';end if;
 select coalesce(jsonb_agg(jsonb_build_object('sku',t.sku,'status',t.status,'last_error',t.last_error,
   'updated_at',t.updated_at,'attempts',t.attempts) order by t.updated_at,t.product_gid),'[]'::jsonb) into items
 from (select q.product_gid,e.exact_gallery_sku as sku,q.status,q.updated_at,q.attempts,
   case when q.last_error is null then null when q.last_error ~ '^MEDIA_[A-Z0-9_]{1,90}$' then q.last_error else 'MEDIA_ERROR_UNRECOGNIZED' end as last_error
  from toptik_media_private.work_queue q left join public.shopify_gallery_copy_eligibility e using(product_gid)
  where q.status in ('pending','processing','review','failed')
  order by q.updated_at,q.product_gid limit p_limit) t;
 return jsonb_build_object('observedAt',statement_timestamp(),'limit',p_limit,'items',items,
  'openTotal',(select count(*) from toptik_media_private.work_queue where status in ('pending','processing','review','failed')));
end $$;
revoke all on function public.read_toptik_media_sync_monitor(int) from public,anon,authenticated,service_role;
grant execute on function public.read_toptik_media_sync_monitor(int) to service_role;
commit;
