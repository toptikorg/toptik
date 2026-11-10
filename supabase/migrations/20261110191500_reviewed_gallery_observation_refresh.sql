-- Append a new observation epoch for reviewed bytes changed at an unchanged URL.
-- Never rewrite an immutable observation, edit the public catalog or reset a baseline.
begin;
create table toptik_media_private.observation_refreshes (
 product_gid text not null references toptik_media_private.products(product_gid),
 old_revision text not null, new_revision text not null,
 lease_owner uuid not null, refs_sha256 text not null check(refs_sha256~'^[a-f0-9]{64}$'),
 reviewed_evidence_ids jsonb not null check(jsonb_typeof(reviewed_evidence_ids)='array'),
 old_snapshot jsonb not null, new_snapshot jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(product_gid,old_revision), unique(product_gid,new_revision)
);
alter table toptik_media_private.observation_refreshes enable row level security;
revoke all on toptik_media_private.observation_refreshes from public,anon,authenticated,service_role;
create trigger immutable_record before update or delete on toptik_media_private.observation_refreshes
 for each row execute function toptik_media_private.immutable();

create function public.refresh_toptik_reviewed_gallery_observation(
 p_product_gid text,p_lease_owner uuid,p_expected_revision text,p_refs jsonb,p_reviewed_evidence_ids jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb;raw0 jsonb;raw1 jsonb;s jsonb;old toptik_media_private.gallery_observations%rowtype;
 r jsonb;oldr jsonb;newp toptik_media_private.provenance%rowtype;oldp toptik_media_private.provenance%rowtype;
 changed jsonb:='[]';authorized jsonb;n integer;newobs jsonb;
begin
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 if exists(select 1 from toptik_media_private.operations where product_gid=p_product_gid and status in('reserved','running','uncertain'))
  then raise exception 'MEDIA_OBSERVATION_REFRESH_OPERATION_ACTIVE';end if;
 raw0:=toptik_media_private.gallery_raw(i);
 if raw0->>'revision' is distinct from p_expected_revision then raise exception 'MEDIA_GALLERY_CAS_CHANGED';end if;
 select * into old from toptik_media_private.gallery_observations where product_gid=p_product_gid and revision=p_expected_revision;
 if not found or old.raw is distinct from raw0 then raise exception 'MEDIA_OBSERVATION_REFRESH_NOT_APPLICABLE';end if;
 s:=toptik_media_private.gallery_snapshot(raw0,p_refs);
 if old.refs=p_refs and old.snapshot=s then
  return jsonb_build_object('raw',raw0,'refs',p_refs,'snapshot',s);
 end if;
 if jsonb_typeof(p_reviewed_evidence_ids) is distinct from 'array' or jsonb_array_length(p_reviewed_evidence_ids)>31
  or exists(select 1 from jsonb_array_elements(p_reviewed_evidence_ids) x where jsonb_typeof(x)<>'string')
  then raise exception 'MEDIA_OBSERVATION_REFRESH_REVIEW_REQUIRED';end if;
 -- Identity, membership, order, physical references, URL and ALT must be unchanged.
 -- Only content/evidence fingerprints of already present exact sources can advance.
 if (select jsonb_agg(x-'evidenceId' order by ord) from jsonb_array_elements(old.refs) with ordinality a(x,ord))
  is distinct from (select jsonb_agg(x-'evidenceId' order by ord) from jsonb_array_elements(p_refs) with ordinality a(x,ord))
  or (old.snapshot-'assets') is distinct from (s-'assets')
  or (select jsonb_agg(x-'evidenceId'-'contentId' order by ord) from jsonb_array_elements(old.snapshot->'assets') with ordinality a(x,ord))
  is distinct from (select jsonb_agg(x-'evidenceId'-'contentId' order by ord) from jsonb_array_elements(s->'assets') with ordinality a(x,ord))
  then raise exception 'MEDIA_OBSERVATION_REFRESH_SOURCE_CHANGED';end if;
 for r,n in select x,ord::integer from jsonb_array_elements(p_refs) with ordinality a(x,ord) loop
  oldr:=old.refs->(n-1);
  if r->>'evidenceId'=oldr->>'evidenceId' then continue;end if;
  select * into newp from toptik_media_private.provenance where product_gid=p_product_gid and side='gallery' and asset_key=r->>'key' and evidence_id=r->>'evidenceId';
  if not found then raise exception 'MEDIA_GALLERY_PROVENANCE_MISMATCH';end if;
  select * into oldp from toptik_media_private.provenance where product_gid=p_product_gid and side='gallery' and asset_key=oldr->>'key' and evidence_id=oldr->>'evidenceId';
  if not found or oldp.proof->>'url' is distinct from newp.proof->>'url'
   then raise exception 'MEDIA_OBSERVATION_REFRESH_SOURCE_CHANGED';end if;
  -- Fresh decode proofs are concrete bytes, never synthetic transformed lineage.
  if newp.content_id is distinct from newp.proof->>'decodedSha256' or newp.proof ? 'operationId' or newp.proof ? 'sourceEvidenceId'
   then raise exception 'MEDIA_OBSERVATION_REFRESH_REVIEW_REQUIRED';end if;
  if not changed ? newp.evidence_id then changed:=changed||jsonb_build_array(newp.evidence_id);end if;
 end loop;
 select coalesce(jsonb_agg(x order by x),'[]') into authorized from jsonb_array_elements_text(p_reviewed_evidence_ids) a(x);
 if jsonb_array_length(changed)=0 or authorized is distinct from (select jsonb_agg(x order by x) from jsonb_array_elements_text(changed) a(x))
  then raise exception 'MEDIA_OBSERVATION_REFRESH_REVIEW_REQUIRED';end if;
 -- This service-only list is produced only after the worker verifies signed,
 -- exact SKU/variant/URL/current-SHA review records. SQL rechecks all identity and CAS facts.
 insert into toptik_media_private.gallery_versions(item_id,version) values((i->>'itemId')::uuid,(raw0->>'version')::bigint+1)
 on conflict(item_id) do update set version=gallery_versions.version+1;
 raw1:=toptik_media_private.gallery_raw(i);
 if (raw1-'version'-'revision') is distinct from (raw0-'version'-'revision') or raw1->>'revision'=raw0->>'revision'
  then raise exception 'MEDIA_GALLERY_CAS_CHANGED';end if;
 newobs:=public.observe_toptik_gallery_media(p_product_gid,p_lease_owner,raw1->>'revision',p_refs);
 insert into toptik_media_private.observation_refreshes(product_gid,old_revision,new_revision,lease_owner,refs_sha256,reviewed_evidence_ids,old_snapshot,new_snapshot)
 values(p_product_gid,p_expected_revision,raw1->>'revision',p_lease_owner,toptik_media_private.digest(p_refs),authorized,old.snapshot,newobs->'snapshot');
 return newobs;
end $$;
revoke all on function public.refresh_toptik_reviewed_gallery_observation(text,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.refresh_toptik_reviewed_gallery_observation(text,uuid,text,jsonb,jsonb) to service_role;
commit;
