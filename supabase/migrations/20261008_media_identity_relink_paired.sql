-- Reviewed exact adoption of an already-PAIRED baseline key by the ONE replaced Gallery angle row.
-- Live class (8.10.2026, P10OXT0529O photos 6+7): the catalog editor replaced two angle rows with new
-- rows (new UUIDs) that point at byte-identical content. 20261008_media_identity_relink.sql covers the
-- store-only case (baseline NOT merged). Here the baseline ALREADY pairs the content under the retired
-- angle key on BOTH sides, so that function correctly refuses (MEDIA_RELINK_BASELINE_MISMATCH), and the
-- planner correctly holds (#104) because every attach it could write would duplicate shown content.
-- Two narrow operator merges close the class, both APPEND ONLY, both proven by the journal alone
-- (equal recorded digests; visual similarity plays no part):
--   rekey_gallery_angle_to_baseline_key: the new angle row adopts the RETIRED gallery key itself.
--     Applies when the live store media still carries the retired key in its own provenance, so both
--     sides meet again under the baseline's key and the merged pair plans NOTHING (photo-7 shape).
--   relink_gallery_angle_key v2 (CREATE OR REPLACE below): the photo-6 shape, where the store media
--     was re-uploaded under a fresh s-media identity while the baseline still pairs the same bytes
--     under the retired gallery key. The original strict baseline condition stays the first branch;
--     the ONE new branch additionally accepts that retired-pair baseline, and only when the
--     retirement itself is already recorded as removal intents on BOTH sides, so the merged plan
--     still writes nothing: the s-media pair matches on both sides and the retired pair's absence is
--     justified by the recorded intents.
-- Writes of the rekey, mirroring the relink exactly:
--   1. one new gallery provenance row registers the angle's already-proven bytes under the retired
--      key, with the planner's own deterministic evidence id;
--   2. the gallery identity version advances through the same counter the catalog triggers use;
--   3. one new gallery observation lands at the new revision with the re-keyed refs, rebuilt and
--      revalidated by the same gallery_snapshot the ordinary observation path uses.
-- Preconditions: lease, enabled product, NO open operation, catalog identical to the latest
-- observation, the retired key proven on BOTH sides with this exact content id, the new angle key
-- proven on the gallery side with the same content id, no Shopify lineage under the new key, the
-- baseline pairing the retired key on both sides with this content and the SAME alt the angle carries.
-- The rekey additionally refuses the photo-6 shape outright (a fresh store re-upload of these bytes
-- under a key no baseline knows), and when the retired key's own gallery row already records the
-- angle's exact URL and bytes it REUSES that row as the merged ref's evidence instead of inserting
-- a copy, so capture (which prefers the baseline evidence id among equal matches) stays byte-stable.
-- Shape 2 of relink v2 proves everything the journal CAN prove; the "plans nothing" outcome further
-- assumes the live store media still carries the angle's alt and its gallery position, which the
-- operator must verify live before the merge (a drift lands as a held conflict, never a write).
begin;

create table toptik_media_private.media_identity_rekeys (
 rekey_id uuid primary key,
 product_gid text not null references toptik_media_private.products(product_gid),
 old_angle_key text not null check(old_angle_key ~ '^g-angle:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 new_angle_key text not null check(new_angle_key ~ '^g-angle:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 content_id text not null check(content_id ~ '^[a-f0-9]{64}$'),
 adopted_evidence_id text not null check(adopted_evidence_id ~ '^g:[a-f0-9]{64}$'),
 old_revision text not null,
 new_revision text not null,
 approval_reference text not null check(length(approval_reference) between 1 and 160),
 approval_evidence_sha256 text not null check(approval_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 check(old_angle_key<>new_angle_key),
 unique(product_gid,old_angle_key), unique(product_gid,new_angle_key)
);
alter table toptik_media_private.media_identity_rekeys enable row level security;
revoke all on table toptik_media_private.media_identity_rekeys from public,anon,authenticated,service_role;
create trigger immutable_record before update or delete on toptik_media_private.media_identity_rekeys
 for each row execute function toptik_media_private.immutable();

-- PRIVATE OPERATOR FUNCTION: intentionally NO EXECUTE for service_role or any user role.
-- One call merges one replaced angle row of one enabled, lease-held product back onto its own
-- retired baseline key. p_content_id is the one content id every involved row must already prove.
create function toptik_media_private.rekey_gallery_angle_to_baseline_key(
 p_product_gid text,p_lease_owner uuid,p_rekey_id uuid,p_old_angle_key text,p_new_angle_key text,
 p_content_id text,p_approval_reference text,p_approval_evidence_sha256 text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb; prior toptik_media_private.media_identity_rekeys%rowtype;
 obs toptik_media_private.gallery_observations%rowtype; st toptik_media_private.state%rowtype;
 oldp toptik_media_private.provenance%rowtype; raw0 jsonb; raw1 jsonb; ref0 jsonb; angle jsonb;
 evid text; refs1 jsonb; snap1 jsonb; r jsonb;
begin
 if p_rekey_id is null
 or coalesce(p_old_angle_key,'') !~ '^g-angle:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 or coalesce(p_new_angle_key,'') !~ '^g-angle:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 or p_old_angle_key=p_new_angle_key
 or coalesce(p_content_id,'') !~ '^[a-f0-9]{64}$'
 or length(coalesce(p_approval_reference,'')) not between 1 and 160 or p_approval_reference ~ '[[:cntrl:]]'
 or coalesce(p_approval_evidence_sha256,'') !~ '^[a-f0-9]{64}$' then raise exception 'MEDIA_REKEY_INVALID';end if;
 -- Lease, identity and the enabled product are all required: this runs only on the live, unblocked catalog.
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 -- Idempotent replay of the identical rekey only.
 select * into prior from toptik_media_private.media_identity_rekeys
 where rekey_id=p_rekey_id or (product_gid=p_product_gid and (old_angle_key in (p_old_angle_key,p_new_angle_key)
  or new_angle_key in (p_old_angle_key,p_new_angle_key)));
 if found then
  if prior.rekey_id is distinct from p_rekey_id or prior.product_gid is distinct from p_product_gid
  or prior.old_angle_key is distinct from p_old_angle_key or prior.new_angle_key is distinct from p_new_angle_key
  or prior.content_id is distinct from p_content_id
  or prior.approval_reference is distinct from p_approval_reference
  or prior.approval_evidence_sha256 is distinct from p_approval_evidence_sha256 then raise exception 'MEDIA_REKEY_REUSED';end if;
  return jsonb_build_object('status','rekeyed','replayed',true,'oldAngleKey',prior.old_angle_key,
   'newAngleKey',prior.new_angle_key,'adoptedEvidenceId',prior.adopted_evidence_id,'newRevision',prior.new_revision);
 end if;
 -- The retired key must not itself be a previous merge target or donor.
 if exists(select 1 from toptik_media_private.media_identity_relinks k
  where k.product_gid=p_product_gid and k.angle_key in (p_old_angle_key,p_new_angle_key))
 then raise exception 'MEDIA_REKEY_REUSED';end if;
 -- The stuck plan must already be closed: an open operation may still act on the old identity.
 if exists(select 1 from toptik_media_private.operations o
  where o.product_gid=p_product_gid and o.status in ('reserved','running','uncertain'))
 then raise exception 'MEDIA_REKEY_OPERATION_OPEN';end if;
 -- Byte identity is proven by the journal itself: the retired key on BOTH sides and the new angle key
 -- on the gallery side must each carry exactly this content id, with no contradicting row.
 if not exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='gallery' and v.asset_key=p_old_angle_key)
 or exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='gallery' and v.asset_key=p_old_angle_key and v.content_id is distinct from p_content_id)
 then raise exception 'MEDIA_REKEY_OLD_GALLERY_CONTENT_MISMATCH';end if;
 if not exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='shopify' and v.asset_key=p_old_angle_key)
 or exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='shopify' and v.asset_key=p_old_angle_key and v.content_id is distinct from p_content_id)
 then raise exception 'MEDIA_REKEY_OLD_SHOPIFY_CONTENT_MISMATCH';end if;
 if not exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='gallery' and v.asset_key=p_new_angle_key)
 or exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='gallery' and v.asset_key=p_new_angle_key and v.content_id is distinct from p_content_id)
 then raise exception 'MEDIA_REKEY_NEW_GALLERY_CONTENT_MISMATCH';end if;
 -- The new key must have no Shopify lineage of its own (that would make capture ambiguous later),
 -- and the retired key must exist as a recorded identity.
 if exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='shopify' and v.asset_key=p_new_angle_key)
 then raise exception 'MEDIA_REKEY_NEW_KEY_HAS_SHOPIFY_LINEAGE';end if;
 if not exists(select 1 from toptik_media_private.asset_identities a
  where a.product_gid=p_product_gid and a.asset_key=p_old_angle_key)
 then raise exception 'MEDIA_REKEY_IDENTITY_MISSING';end if;
 -- Same catalog exclusion as the version triggers and the snapshot reader take.
 perform set_config('lock_timeout','3000ms',true);
 perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 perform 1 from public.carousel_items where id=(i->>'itemId')::uuid for update;
 if not found then raise exception 'MEDIA_REKEY_GALLERY_MISSING';end if;
 -- The latest observation must BE the live catalog: same revision, same raw, internally consistent refs.
 raw0:=toptik_media_private.gallery_raw(i);
 select * into obs from toptik_media_private.gallery_observations g
 where g.product_gid=p_product_gid order by g.created_at desc,g.revision limit 1;
 if not found then raise exception 'MEDIA_REKEY_OBSERVATION_MISSING';end if;
 if obs.revision is distinct from raw0->>'revision' or obs.raw is distinct from raw0
 then raise exception 'MEDIA_REKEY_GALLERY_MOVED';end if;
 if (select count(*) from jsonb_array_elements(obs.refs) e where e->>'key'=p_new_angle_key and e->>'role'='angle')<>1
 or exists(select 1 from jsonb_array_elements(obs.refs) e where e->>'key'=p_new_angle_key and e->>'role' is distinct from 'angle')
 or exists(select 1 from jsonb_array_elements(obs.refs) e where e->>'key'=p_old_angle_key)
 then raise exception 'MEDIA_REKEY_GALLERY_REFS_MISMATCH';end if;
 select e into ref0 from jsonb_array_elements(obs.refs) e where e->>'key'=p_new_angle_key and e->>'role'='angle';
 select a into angle from jsonb_array_elements(raw0->'angles') a where a->>'id'=ref0->>'angleId';
 if angle is null then raise exception 'MEDIA_REKEY_GALLERY_REFS_MISMATCH';end if;
 -- The donor row: the new angle's own recorded lineage for this exact URL and these exact bytes.
 select * into oldp from toptik_media_private.provenance
 where evidence_id=ref0->>'evidenceId' and product_gid=p_product_gid and side='gallery' and asset_key=p_new_angle_key;
 if not found or oldp.content_id is distinct from p_content_id or oldp.proof->>'url' is distinct from angle->>'image_path'
 then raise exception 'MEDIA_REKEY_GALLERY_REFS_MISMATCH';end if;
 -- The planner digest below concatenates a JSON array by hand; any character JSON.stringify would
 -- escape (quote, backslash, control) in the donor platformRef/url would break byte equality, so refuse.
 if oldp.proof->>'platformRef' !~ ('^angle:'||(ref0->>'angleId')||'$')
 or position('"' in oldp.proof->>'url')>0 or position(chr(92) in oldp.proof->>'url')>0
 or oldp.proof->>'url' ~ '[[:cntrl:]]'
 then raise exception 'MEDIA_REKEY_DIGEST_UNSAFE';end if;
 -- The stored baseline must pair the retired key on BOTH sides with this exact content, carry the
 -- SAME alt the angle carries (so the merged pair plans nothing), and know neither the new key nor
 -- any second copy of the retired key.
 select * into st from toptik_media_private.state where product_gid=p_product_gid;
 if not found then raise exception 'MEDIA_REKEY_STATE_MISSING';end if;
 if (select count(*) from jsonb_array_elements(st.baselines->'gallery'->'assets') a
     where a->>'key'=p_old_angle_key and a->>'contentId'=p_content_id)<>1
 or (select count(*) from jsonb_array_elements(st.baselines->'shopify'->'assets') a
     where a->>'key'=p_old_angle_key and a->>'contentId'=p_content_id)<>1
 or exists(select 1 from jsonb_array_elements(st.baselines->'gallery'->'assets') a where a->>'key'=p_new_angle_key)
 or exists(select 1 from jsonb_array_elements(st.baselines->'shopify'->'assets') a where a->>'key'=p_new_angle_key)
 then raise exception 'MEDIA_REKEY_BASELINE_MISMATCH';end if;
 if coalesce(angle->>'image_alt',raw0#>>'{item,title}') is distinct from
    (select a->>'alt' from jsonb_array_elements(st.baselines->'gallery'->'assets') a where a->>'key'=p_old_angle_key)
 or coalesce(angle->>'image_alt',raw0#>>'{item,title}') is distinct from
    (select a->>'alt' from jsonb_array_elements(st.baselines->'shopify'->'assets') a where a->>'key'=p_old_angle_key)
 then raise exception 'MEDIA_REKEY_ALT_MISMATCH';end if;
 -- A fresh store re-upload of these bytes (a shopify lineage under a key no baseline knows) marks
 -- the photo-6 shape, which belongs to relink v2 and must never consume this one-shot rekey.
 if exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='shopify' and v.content_id=p_content_id
  and not exists(select 1 from jsonb_array_elements(st.baselines->'gallery'->'assets') a where a->>'key'=v.asset_key)
  and not exists(select 1 from jsonb_array_elements(st.baselines->'shopify'->'assets') b where b->>'key'=v.asset_key))
 then raise exception 'MEDIA_REKEY_FRESH_REUPLOAD_PRESENT';end if;

 -- 1. Resolve the retired key's gallery lineage for the angle's exact URL and bytes. When the old
 --    row itself already records this URL (the replaced row pointed at the same file, the live
 --    photo-7 shape), REUSE it: capture prefers the baseline evidence id among equal matches, so
 --    only the original row keeps re-observation byte-stable. Otherwise register the angle's proven
 --    bytes under the retired key with the planner's own evidence digest (JSON.stringify of
 --    [productId,key,platformRef,url,sha256]; plain ASCII inputs, so byte-exact here); the URL
 --    filter in capture then matches the adopted row alone, which is equally stable.
 select v.evidence_id into evid from toptik_media_private.provenance v
 where v.product_gid=p_product_gid and v.side='gallery' and v.asset_key=p_old_angle_key
 and v.content_id=p_content_id and v.proof->>'url'=angle->>'image_path'
 order by v.evidence_id limit 1;
 if evid is null then
  evid:='g:'||encode(sha256(convert_to(
   '["'||(i->>'productId')||'","'||p_old_angle_key||'","'||(oldp.proof->>'platformRef')||'","'||(oldp.proof->>'url')||'","'||p_content_id||'"]','UTF8')),'hex');
  if exists(select 1 from toptik_media_private.provenance v where v.evidence_id=evid)
  then raise exception 'MEDIA_REKEY_EVIDENCE_EXISTS';end if;
  insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof)
  values(evid,p_product_gid,p_old_angle_key,'gallery',p_content_id,oldp.proof);
 end if;
 -- 2. Advance the gallery identity version exactly as the catalog triggers do.
 insert into toptik_media_private.gallery_versions values((i->>'itemId')::uuid,2)
 on conflict(item_id) do update set version=gallery_versions.version+1;
 raw1:=toptik_media_private.gallery_raw(i);
 if raw1->>'revision' is not distinct from obs.revision then raise exception 'MEDIA_REKEY_REVISION_UNCHANGED';end if;
 -- 3. Land the merge as a NEW observation at the new revision; gallery_snapshot revalidates everything.
 refs1:=(select jsonb_agg(case when e->>'key'=p_new_angle_key
   then jsonb_set(jsonb_set(e,'{key}',to_jsonb(p_old_angle_key)),'{evidenceId}',to_jsonb(evid)) else e end order by n)
  from jsonb_array_elements(obs.refs) with ordinality t(e,n));
 snap1:=toptik_media_private.gallery_snapshot(raw1,refs1);
 insert into toptik_media_private.gallery_observations(product_gid,revision,raw,refs,snapshot)
 values(p_product_gid,raw1->>'revision',raw1,refs1,snap1);
 insert into toptik_media_private.media_identity_rekeys(rekey_id,product_gid,old_angle_key,new_angle_key,content_id,
  adopted_evidence_id,old_revision,new_revision,approval_reference,approval_evidence_sha256)
 values(p_rekey_id,p_product_gid,p_old_angle_key,p_new_angle_key,p_content_id,
  evid,obs.revision,raw1->>'revision',p_approval_reference,p_approval_evidence_sha256);
 r:=jsonb_build_object('status','rekeyed','replayed',false,'oldAngleKey',p_old_angle_key,
  'newAngleKey',p_new_angle_key,'adoptedEvidenceId',evid,'newRevision',raw1->>'revision');
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result)
 values(p_rekey_id,p_product_gid,null,'gallery_angle_rekeyed',
  toptik_media_private.digest(jsonb_build_object('oldAngleKey',p_old_angle_key,'newAngleKey',p_new_angle_key,
   'contentId',p_content_id,'approvalReference',p_approval_reference,'approvalEvidenceSha256',p_approval_evidence_sha256)),
  jsonb_build_object('oldAngleKey',p_old_angle_key,'newAngleKey',p_new_angle_key,'contentId',p_content_id,
   'adoptedEvidenceId',evid,'oldRevision',obs.revision,'newRevision',raw1->>'revision',
   'approvalReference',p_approval_reference,'approvalEvidenceSha256',p_approval_evidence_sha256),r);
 perform toptik_media_private.enqueue(p_product_gid,jsonb_build_object('identityRekeyed',p_rekey_id));
 return r;
end $$;

revoke all on function toptik_media_private.rekey_gallery_angle_to_baseline_key(text,uuid,uuid,text,text,text,text,text)
 from public,anon,authenticated,service_role;

-- relink v2: identical to 20261008_media_identity_relink.sql except the ONE baseline section, which
-- now accepts either the original store-only shape or the retired-pair shape described above. Every
-- other check and every write is carried over verbatim.
create or replace function toptik_media_private.relink_gallery_angle_key(
 p_product_gid text,p_lease_owner uuid,p_relink_id uuid,p_media_ref text,p_angle_key text,p_media_key text,
 p_content_id text,p_approval_reference text,p_approval_evidence_sha256 text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i jsonb; prior toptik_media_private.media_identity_relinks%rowtype;
 obs toptik_media_private.gallery_observations%rowtype; st toptik_media_private.state%rowtype;
 oldp toptik_media_private.provenance%rowtype; raw0 jsonb; raw1 jsonb; ref0 jsonb; angle jsonb;
 evid text; refs1 jsonb; snap1 jsonb; r jsonb; retired text; required_alt text;
begin
 if p_relink_id is null
 or coalesce(p_media_ref,'') !~ '^gid://shopify/MediaImage/[1-9][0-9]*$'
 or p_media_key is distinct from ('s-media:'||split_part(p_media_ref,'/',5))
 or coalesce(p_angle_key,'') !~ '^g-angle:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 or coalesce(p_content_id,'') !~ '^[a-f0-9]{64}$'
 or length(coalesce(p_approval_reference,'')) not between 1 and 160 or p_approval_reference ~ '[[:cntrl:]]'
 or coalesce(p_approval_evidence_sha256,'') !~ '^[a-f0-9]{64}$' then raise exception 'MEDIA_RELINK_INVALID';end if;
 -- Lease, identity and the enabled product are all required: this runs only on the live, unblocked catalog.
 i:=toptik_media_private.assert_access(p_product_gid,p_lease_owner);
 -- Idempotent replay of the identical relink only.
 select * into prior from toptik_media_private.media_identity_relinks
 where relink_id=p_relink_id or (product_gid=p_product_gid and (media_ref=p_media_ref or angle_key=p_angle_key));
 if found then
  if prior.relink_id is distinct from p_relink_id or prior.product_gid is distinct from p_product_gid
  or prior.media_ref is distinct from p_media_ref or prior.angle_key is distinct from p_angle_key
  or prior.media_key is distinct from p_media_key or prior.content_id is distinct from p_content_id
  or prior.approval_reference is distinct from p_approval_reference
  or prior.approval_evidence_sha256 is distinct from p_approval_evidence_sha256 then raise exception 'MEDIA_RELINK_REUSED';end if;
  return jsonb_build_object('status','relinked','replayed',true,'mediaRef',prior.media_ref,'mediaKey',prior.media_key,
   'angleKey',prior.angle_key,'adoptedEvidenceId',prior.adopted_evidence_id,'newRevision',prior.new_revision);
 end if;
 -- A key already merged by the paired-rekey path may not be merged again here.
 if exists(select 1 from toptik_media_private.media_identity_rekeys k
  where k.product_gid=p_product_gid and (k.old_angle_key=p_angle_key or k.new_angle_key=p_angle_key))
 then raise exception 'MEDIA_RELINK_REUSED';end if;
 -- The stuck plan must already be closed: an open operation may still act on the old identity.
 if exists(select 1 from toptik_media_private.operations o
  where o.product_gid=p_product_gid and o.status in ('reserved','running','uncertain'))
 then raise exception 'MEDIA_RELINK_OPERATION_OPEN';end if;
 -- Byte identity is proven by the journal itself, on BOTH sides, with one and the same content id.
 if not exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='gallery' and v.asset_key=p_angle_key)
 or exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='gallery' and v.asset_key=p_angle_key and v.content_id is distinct from p_content_id)
 then raise exception 'MEDIA_RELINK_GALLERY_CONTENT_MISMATCH';end if;
 if not exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='shopify' and v.proof->>'platformRef'=p_media_ref)
 or exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='shopify' and v.proof->>'platformRef'=p_media_ref
  and (v.asset_key is distinct from p_media_key or v.content_id is distinct from p_content_id))
 then raise exception 'MEDIA_RELINK_SHOPIFY_CONTENT_MISMATCH';end if;
 -- The adopted key must not already carry a gallery lineage, and must exist as an identity.
 if exists(select 1 from toptik_media_private.provenance v
  where v.product_gid=p_product_gid and v.side='gallery' and v.asset_key=p_media_key)
 then raise exception 'MEDIA_RELINK_TARGET_KEY_AMBIGUOUS';end if;
 if not exists(select 1 from toptik_media_private.asset_identities a
  where a.product_gid=p_product_gid and a.asset_key=p_media_key)
 then raise exception 'MEDIA_RELINK_IDENTITY_MISSING';end if;
 -- Same catalog exclusion as the version triggers and the snapshot reader take.
 perform set_config('lock_timeout','3000ms',true);
 perform pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync'));
 perform 1 from public.carousel_items where id=(i->>'itemId')::uuid for update;
 if not found then raise exception 'MEDIA_RELINK_GALLERY_MISSING';end if;
 -- The latest observation must BE the live catalog: same revision, same raw, internally consistent refs.
 raw0:=toptik_media_private.gallery_raw(i);
 select * into obs from toptik_media_private.gallery_observations g
 where g.product_gid=p_product_gid order by g.created_at desc,g.revision limit 1;
 if not found then raise exception 'MEDIA_RELINK_OBSERVATION_MISSING';end if;
 if obs.revision is distinct from raw0->>'revision' or obs.raw is distinct from raw0
 then raise exception 'MEDIA_RELINK_GALLERY_MOVED';end if;
 if (select count(*) from jsonb_array_elements(obs.refs) e where e->>'key'=p_angle_key and e->>'role'='angle')<>1
 or exists(select 1 from jsonb_array_elements(obs.refs) e where e->>'key'=p_angle_key and e->>'role' is distinct from 'angle')
 or exists(select 1 from jsonb_array_elements(obs.refs) e where e->>'key'=p_media_key)
 then raise exception 'MEDIA_RELINK_GALLERY_REFS_MISMATCH';end if;
 select e into ref0 from jsonb_array_elements(obs.refs) e where e->>'key'=p_angle_key and e->>'role'='angle';
 select a into angle from jsonb_array_elements(raw0->'angles') a where a->>'id'=ref0->>'angleId';
 if angle is null then raise exception 'MEDIA_RELINK_GALLERY_REFS_MISMATCH';end if;
 -- The donor row: the angle's own recorded lineage for this exact URL and these exact bytes.
 select * into oldp from toptik_media_private.provenance
 where evidence_id=ref0->>'evidenceId' and product_gid=p_product_gid and side='gallery' and asset_key=p_angle_key;
 if not found or oldp.content_id is distinct from p_content_id or oldp.proof->>'url' is distinct from angle->>'image_path'
 then raise exception 'MEDIA_RELINK_GALLERY_REFS_MISMATCH';end if;
 -- The planner digest below concatenates a JSON array by hand; any character JSON.stringify would
 -- escape (quote, backslash, control) in the donor platformRef/url would break byte equality, so refuse.
 if oldp.proof->>'platformRef' !~ ('^angle:'||(ref0->>'angleId')||'$')
 or position('"' in oldp.proof->>'url')>0 or position(chr(92) in oldp.proof->>'url')>0
 or oldp.proof->>'url' ~ '[[:cntrl:]]'
 then raise exception 'MEDIA_RELINK_DIGEST_UNSAFE';end if;
 -- The stored baseline must show a shape from which the merged pair plans nothing at all, with the
 -- SAME alt the angle carries. Two shapes qualify:
 --   1. store-only (original, verbatim from v1): the baseline already pairs this very s-media key;
 --   2. retired-pair (new): the baseline pairs these bytes under ONE retired gallery key on both
 --      sides, the catalog no longer carries that key, and the retirement is already recorded as
 --      removal intents on BOTH sides against the current baseline fingerprints.
 select * into st from toptik_media_private.state where product_gid=p_product_gid;
 if not found then raise exception 'MEDIA_RELINK_STATE_MISSING';end if;
 if exists(select 1 from jsonb_array_elements(st.baselines->'gallery'->'assets') a where a->>'key' in (p_media_key,p_angle_key))
 or exists(select 1 from jsonb_array_elements(st.baselines->'shopify'->'assets') a where a->>'key'=p_angle_key)
 then raise exception 'MEDIA_RELINK_BASELINE_MISMATCH';end if;
 required_alt:=coalesce(angle->>'image_alt',raw0#>>'{item,title}');
 if (select count(*) from jsonb_array_elements(st.baselines->'shopify'->'assets') a where a->>'key'=p_media_key)>=1 then
  -- Shape 1, carried over verbatim from v1.
  if (select count(*) from jsonb_array_elements(st.baselines->'shopify'->'assets') a
      where a->>'key'=p_media_key and a->>'contentId'=p_content_id)<>1
  then raise exception 'MEDIA_RELINK_BASELINE_MISMATCH';end if;
  if required_alt is distinct from
     (select a->>'alt' from jsonb_array_elements(st.baselines->'shopify'->'assets') a where a->>'key'=p_media_key)
  then raise exception 'MEDIA_RELINK_ALT_MISMATCH';end if;
 else
  -- Shape 2: exactly ONE retired gallery key pairs these bytes on both sides of the baseline.
  if (select count(*) from jsonb_array_elements(st.baselines->'gallery'->'assets') a
      where a->>'contentId'=p_content_id and a->>'key' ~ '^g-angle:')<>1
  then raise exception 'MEDIA_RELINK_BASELINE_MISMATCH';end if;
  select a->>'key' into retired from jsonb_array_elements(st.baselines->'gallery'->'assets') a
  where a->>'contentId'=p_content_id and a->>'key' ~ '^g-angle:';
  if retired is null or retired=p_angle_key
  or (select count(*) from jsonb_array_elements(st.baselines->'gallery'->'assets') a where a->>'key'=retired)<>1
  or (select count(*) from jsonb_array_elements(st.baselines->'shopify'->'assets') a
      where a->>'key'=retired and a->>'contentId'=p_content_id)<>1
  or (select count(*) from jsonb_array_elements(st.baselines->'shopify'->'assets') a where a->>'key'=retired)<>1
  or exists(select 1 from jsonb_array_elements(obs.refs) e where e->>'key'=retired)
  then raise exception 'MEDIA_RELINK_BASELINE_MISMATCH';end if;
  -- EXACTLY one live intent per side: zero means the retirement is unrecorded, and a duplicate
  -- would make every later planning read throw MEDIA_REMOVAL_EVIDENCE_DUPLICATE forever.
  if (select count(*) from toptik_media_private.removal_intents ri
      where ri.product_gid=p_product_gid and ri.side='gallery' and ri.asset_key=retired
      and ri.baseline_fingerprint=toptik_media_private.fingerprint(st.baselines->'gallery'))<>1
  or (select count(*) from toptik_media_private.removal_intents ri
      where ri.product_gid=p_product_gid and ri.side='shopify' and ri.asset_key=retired
      and ri.baseline_fingerprint=toptik_media_private.fingerprint(st.baselines->'shopify'))<>1
  then raise exception 'MEDIA_RELINK_RETIREMENT_NOT_RECORDED';end if;
  if required_alt is distinct from
     (select a->>'alt' from jsonb_array_elements(st.baselines->'gallery'->'assets') a where a->>'key'=retired)
  or required_alt is distinct from
     (select a->>'alt' from jsonb_array_elements(st.baselines->'shopify'->'assets') a where a->>'key'=retired)
  then raise exception 'MEDIA_RELINK_ALT_MISMATCH';end if;
 end if;
 -- 1. Register the angle's proven bytes under the adopted key, with the planner's own evidence digest
 --    (JSON.stringify of [productId,key,platformRef,url,sha256]; plain ASCII inputs, so byte-exact here).
 evid:='g:'||encode(sha256(convert_to(
  '["'||(i->>'productId')||'","'||p_media_key||'","'||(oldp.proof->>'platformRef')||'","'||(oldp.proof->>'url')||'","'||p_content_id||'"]','UTF8')),'hex');
 if exists(select 1 from toptik_media_private.provenance v where v.evidence_id=evid)
 then raise exception 'MEDIA_RELINK_EVIDENCE_EXISTS';end if;
 insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof)
 values(evid,p_product_gid,p_media_key,'gallery',p_content_id,oldp.proof);
 -- 2. Advance the gallery identity version exactly as the catalog triggers do.
 insert into toptik_media_private.gallery_versions values((i->>'itemId')::uuid,2)
 on conflict(item_id) do update set version=gallery_versions.version+1;
 raw1:=toptik_media_private.gallery_raw(i);
 if raw1->>'revision' is not distinct from obs.revision then raise exception 'MEDIA_RELINK_REVISION_UNCHANGED';end if;
 -- 3. Land the merge as a NEW observation at the new revision; gallery_snapshot revalidates everything
 --    (provenance pairing, duplicate keys, cover alias) exactly as the ordinary observation path does.
 refs1:=(select jsonb_agg(case when e->>'key'=p_angle_key
   then jsonb_set(jsonb_set(e,'{key}',to_jsonb(p_media_key)),'{evidenceId}',to_jsonb(evid)) else e end order by n)
  from jsonb_array_elements(obs.refs) with ordinality t(e,n));
 snap1:=toptik_media_private.gallery_snapshot(raw1,refs1);
 insert into toptik_media_private.gallery_observations(product_gid,revision,raw,refs,snapshot)
 values(p_product_gid,raw1->>'revision',raw1,refs1,snap1);
 insert into toptik_media_private.media_identity_relinks(relink_id,product_gid,media_ref,angle_key,media_key,content_id,
  adopted_evidence_id,old_revision,new_revision,approval_reference,approval_evidence_sha256)
 values(p_relink_id,p_product_gid,p_media_ref,p_angle_key,p_media_key,p_content_id,
  evid,obs.revision,raw1->>'revision',p_approval_reference,p_approval_evidence_sha256);
 r:=jsonb_build_object('status','relinked','replayed',false,'mediaRef',p_media_ref,'mediaKey',p_media_key,
  'angleKey',p_angle_key,'adoptedEvidenceId',evid,'newRevision',raw1->>'revision');
 insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result)
 values(p_relink_id,p_product_gid,null,'gallery_angle_rekeyed',
  toptik_media_private.digest(jsonb_build_object('mediaRef',p_media_ref,'angleKey',p_angle_key,'mediaKey',p_media_key,
   'contentId',p_content_id,'approvalReference',p_approval_reference,'approvalEvidenceSha256',p_approval_evidence_sha256)),
  jsonb_build_object('mediaRef',p_media_ref,'angleKey',p_angle_key,'mediaKey',p_media_key,'contentId',p_content_id,
   'adoptedEvidenceId',evid,'oldRevision',obs.revision,'newRevision',raw1->>'revision',
   'approvalReference',p_approval_reference,'approvalEvidenceSha256',p_approval_evidence_sha256),r);
 perform toptik_media_private.enqueue(p_product_gid,jsonb_build_object('identityRelinked',p_relink_id));
 return r;
end $$;

revoke all on function toptik_media_private.relink_gallery_angle_key(text,uuid,uuid,text,text,text,text,text,text)
 from public,anon,authenticated,service_role;
commit;
