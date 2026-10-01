-- Atomic merchant Save All. A worker changing copy, specs or images invalidates
-- the browser revision, so an older tab cannot silently restore stale values.
begin;
alter table public.carousel_items add column if not exists editor_revision bigint not null default 1;
alter table public.carousel_settings add column if not exists editor_revision bigint not null default 1;
alter table public.carousel_items add column if not exists cover_image_alt text;
alter table public.carousel_item_angles add column if not exists image_alt text;

create or replace function public.gallery_editor_revision_bump()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (to_jsonb(new) - 'editor_revision' - 'updated_at') is distinct from
     (to_jsonb(old) - 'editor_revision' - 'updated_at') then
    new.editor_revision := old.editor_revision + 1;
  else
    -- Only the angle trigger may advance an otherwise unchanged parent row.
    new.editor_revision := case when pg_trigger_depth() > 1 and new.editor_revision = old.editor_revision + 1
      then new.editor_revision else old.editor_revision end;
  end if;
  return new;
end $$;
drop trigger if exists gallery_item_editor_revision on public.carousel_items;
create trigger gallery_item_editor_revision before update on public.carousel_items
for each row execute function public.gallery_editor_revision_bump();
drop trigger if exists gallery_settings_editor_revision on public.carousel_settings;
create trigger gallery_settings_editor_revision before update on public.carousel_settings
for each row execute function public.gallery_editor_revision_bump();

create or replace function public.gallery_angle_editor_revision_bump()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and to_jsonb(new) is not distinct from to_jsonb(old) then return new; end if;
  if tg_op <> 'INSERT' then
    update public.carousel_items set editor_revision = editor_revision + 1 where id = old.item_id;
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.item_id <> old.item_id) then
    update public.carousel_items set editor_revision = editor_revision + 1 where id = new.item_id;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists gallery_angle_editor_revision on public.carousel_item_angles;
create trigger gallery_angle_editor_revision after insert or update or delete on public.carousel_item_angles
for each row execute function public.gallery_angle_editor_revision_bump();

create or replace function public.save_gallery_catalog_atomic(
  p_items jsonb, p_expected_versions jsonb, p_expected_editor_revisions jsonb,
  p_angles jsonb, p_settings jsonb, p_expected_settings_revision bigint, p_media_actor jsonb default null
) returns table(id uuid) language plpgsql security definer set search_path = public, pg_temp as $$
declare incoming jsonb; previous_revision bigint; expected_revision bigint; settings_revision bigint; prior_actor text;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 5000
    or jsonb_typeof(p_expected_editor_revisions) is distinct from 'object'
    or jsonb_typeof(p_angles) is distinct from 'array' or jsonb_array_length(p_angles) > 150000
    or jsonb_typeof(p_settings) is distinct from 'object'
    or coalesce((p_settings->>'autoplay_ms')::integer,0) not between 1500 and 12000
    or coalesce(p_settings->>'transition_mode','') not in ('shatter-particle','curtain-fade')
    or not(p_settings ? 'autoplay_ms') then raise exception 'GALLERY_EDITOR_INPUT_INVALID'; end if;
  if (select count(*) <> count(distinct value->>'id') from jsonb_array_elements(p_items))
    or (select count(*) <> count(distinct value->>'id') from jsonb_array_elements(p_angles))
    or exists(select 1 from jsonb_array_elements(p_angles) a
      where not exists(select 1 from jsonb_array_elements(p_items) i where i.value->>'id' = a.value->>'item_id'))
    or exists(select 1 from jsonb_array_elements(p_angles) a group by a.value->>'item_id' having count(*) > 30)
    then raise exception 'GALLERY_EDITOR_IDENTITIES_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
  select s.editor_revision into settings_revision from public.carousel_settings s where s.id = 1 for update;
  if settings_revision is null or p_expected_settings_revision is null or settings_revision <> p_expected_settings_revision
    then raise exception 'GALLERY_EDITOR_SETTINGS_STALE_RELOAD'; end if;
  for incoming in select value from jsonb_array_elements(p_items) order by value->>'id' loop
    if not (p_expected_editor_revisions ? (incoming->>'id')) then raise exception 'GALLERY_EDITOR_REVISION_REQUIRED'; end if;
    expected_revision := (p_expected_editor_revisions->>(incoming->>'id'))::bigint;
    select i.editor_revision into previous_revision from public.carousel_items i where i.id = (incoming->>'id')::uuid for update;
    if (found and (expected_revision is null or expected_revision <> previous_revision))
      or (not found and expected_revision is not null) then raise exception 'GALLERY_EDITOR_STALE_RELOAD'; end if;
  end loop;
  if exists(select 1 from public.carousel_item_angles a join jsonb_array_elements(p_angles) submitted
    on a.id = (submitted.value->>'id')::uuid where a.item_id <> (submitted.value->>'item_id')::uuid)
    then raise exception 'GALLERY_EDITOR_ANGLE_IDENTITY_CHANGED'; end if;
  prior_actor := current_setting('toptik.media_editor_actor', true);
  perform set_config('toptik.media_editor_actor', coalesce(p_media_actor,'{}'::jsonb)::text, true);
  -- Existing copy CAS and durable copy outbox run in this same transaction.
  perform public.save_gallery_items_with_copy_cas(p_items, p_expected_versions);
  update public.carousel_items i set cover_image_alt = v.value->>'cover_image_alt'
    from jsonb_array_elements(p_items) v where i.id = (v.value->>'id')::uuid and v.value ? 'cover_image_alt';
  -- Avoid firing BEFORE INSERT transport-version triggers for existing angles.
  update public.carousel_item_angles target set angle_key=a.angle_key,image_path=a.image_path,
    angle_order=a.angle_order,image_alt=a.image_alt
    from jsonb_to_recordset(p_angles) a(id uuid,item_id uuid,angle_key text,image_path text,angle_order integer,image_alt text)
    where target.id=a.id and (target.angle_key,target.image_path,target.angle_order,target.image_alt)
      is distinct from (a.angle_key,a.image_path,a.angle_order,a.image_alt);
  insert into public.carousel_item_angles (id,item_id,angle_key,image_path,angle_order,image_alt)
    select a.id,a.item_id,a.angle_key,a.image_path,a.angle_order,a.image_alt
    from jsonb_to_recordset(p_angles) a(id uuid,item_id uuid,angle_key text,image_path text,angle_order integer,image_alt text)
    where not exists(select 1 from public.carousel_item_angles existing where existing.id=a.id);
  delete from public.carousel_item_angles a
    where exists(select 1 from jsonb_array_elements(p_items) i where i.value->>'id'=a.item_id::text)
      and not exists(select 1 from jsonb_array_elements(p_angles) i where i.value->>'id'=a.id::text);
  update public.carousel_settings set autoplay_ms=(p_settings->>'autoplay_ms')::integer,
    transition_mode=p_settings->>'transition_mode' where carousel_settings.id=1;
  perform set_config('toptik.media_editor_actor', coalesce(prior_actor,''), true);
  return query select (value->>'id')::uuid from jsonb_array_elements(p_items);
end $$;
revoke all on function public.gallery_editor_revision_bump(), public.gallery_angle_editor_revision_bump() from public, anon, authenticated, service_role;
revoke all on function public.save_gallery_catalog_atomic(jsonb,jsonb,jsonb,jsonb,jsonb,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.save_gallery_catalog_atomic(jsonb,jsonb,jsonb,jsonb,jsonb,bigint,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
