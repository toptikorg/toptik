-- POST-reorder proof only. Pre-call fingerprints, permits and final readback stay strict.
begin;

create or replace function toptik_media_private.reorder_media_matches(before_media jsonb,ids jsonb,observed jsonb)
returns boolean language plpgsql set search_path=pg_catalog,pg_temp as $$
declare target text;n bigint;old_n bigint;photo jsonb;actual jsonb;
 stamp_pattern constant text:='^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d([.]\d{1,6})?(Z|[+-](0\d|1[0-5]):[0-5]\d)$';
begin
 if jsonb_typeof(before_media)is distinct from'array'or jsonb_typeof(ids)is distinct from'array'
  or jsonb_typeof(observed)is distinct from'array'or jsonb_array_length(ids)=0
  or jsonb_array_length(ids)<>jsonb_array_length(before_media)or jsonb_array_length(observed)<>jsonb_array_length(ids)
  or exists(select 1 from jsonb_array_elements(ids)x where jsonb_typeof(x)is distinct from'string')
  or(select count(distinct value)from jsonb_array_elements_text(ids))<>jsonb_array_length(ids)
  then return false;end if;
 for target,n in select value,ordinality from jsonb_array_elements_text(ids)with ordinality loop
  select value,ordinality into photo,old_n from jsonb_array_elements(before_media)with ordinality where value->>'mediaId'=target;
  actual:=observed->(n::int-1);
  if photo is null or actual->>'mediaId'is distinct from target then return false;end if;
  if old_n=n then
   if photo is distinct from actual then return false;end if;
  else
   if(photo-'updatedAt')is distinct from(actual-'updatedAt')
    or coalesce(photo->>'updatedAt','')!~stamp_pattern
    or coalesce(actual->>'updatedAt','')!~stamp_pattern
    or not isfinite((photo->>'updatedAt')::timestamptz)or not isfinite((actual->>'updatedAt')::timestamptz)
    or(actual->>'updatedAt')::timestamptz<(photo->>'updatedAt')::timestamptz then return false;end if;
  end if;
 end loop;
 return true;
exception when invalid_datetime_format or datetime_field_overflow then return false;
end$$;
revoke all on function toptik_media_private.reorder_media_matches(jsonb,jsonb,jsonb)from public,anon,authenticated,service_role;

-- Replace only the exact prior reorder predicate. CREATE OR REPLACE preserves
-- the public RPC's signature, owner, security settings and existing ACL.
do $patch$
declare body text;old_block text:=$old$ elsif a.phase='reorder' then
  select coalesce(jsonb_agg(m order by x.n),'[]'::jsonb) into expected_media from jsonb_array_elements_text(a.request->'mediaGids') with ordinality x(id,n)
  join lateral (select value from jsonb_array_elements(before_raw->'media') where value->>'mediaId'=x.id) y(m) on true;
  if after_raw->'media'<>expected_media or after_raw->'variantMediaIds'<>before_raw->'variantMediaIds' or after_raw->'variantImage'<>before_raw->'variantImage' then valid:=false;end if;$old$;
new_block text:=$new$ elsif a.phase='reorder' then
  if not toptik_media_private.reorder_media_matches(before_raw->'media',a.request->'mediaGids',after_raw->'media')
   or after_raw->'variantMediaIds'<>before_raw->'variantMediaIds' or after_raw->'variantImage'<>before_raw->'variantImage' then valid:=false;end if;$new$;
begin
 body:=pg_get_functiondef('public.accept_toptik_media_transport(text,uuid,uuid,integer,integer,uuid,jsonb,jsonb)'::regprocedure);
 body:=replace(body,E'\r\n',E'\n');
 if strpos(body,new_block)>0 and strpos(body,old_block)=0 then return;end if;
 if (length(body)-length(replace(body,old_block,'')))/length(old_block)<>1 then
  raise exception 'MEDIA_REORDER_ACCEPT_PREDECESSOR_CHANGED';
 end if;
 execute replace(body,old_block,new_block);
end$patch$;
commit;
