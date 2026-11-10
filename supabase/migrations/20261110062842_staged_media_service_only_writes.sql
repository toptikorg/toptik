-- Keep replayed environments aligned with the already service-only live bucket.
-- Do not change objects, buckets, grants, public reads or unrelated policies.
begin;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage'
      and c.relname = 'objects'
      and c.relkind in ('r', 'p')
      and c.relrowsecurity
  ) then
    raise exception 'STAGED_MEDIA_STORAGE_RLS_REQUIRED';
  end if;
end
$$;

drop policy if exists "carousel_media_auth_insert" on storage.objects;
drop policy if exists "carousel_media_auth_update" on storage.objects;
drop policy if exists "carousel_media_auth_delete" on storage.objects;

commit;
