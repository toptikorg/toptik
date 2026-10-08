-- Shape-2 alt correction for relink_gallery_angle_key v2 (installed minutes earlier from
-- 20261008_media_identity_relink_paired.sql): the retired-pair branch wrongly demanded the angle's
-- alt to equal BOTH baseline alts of the RETIRED key. Those are historical values of an asset that
-- is absent from both current sides with recorded removal intents, so they play no part in any
-- future plan; the live P10OXT0529O gallery baseline stores the older short alt format and the
-- correct merge was refused (MEDIA_RELINK_ALT_MISMATCH). Shape 1 and every other check, write and
-- refusal are carried over verbatim; this file only re-replaces the function.
begin;

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
  -- The retired pair is absent from BOTH current sides and its removal is intent-justified, so its
  -- HISTORICAL baseline alts play no part in any future plan (live case: the old gallery alt used a
  -- shorter format). The live s-media alt is compared by the planner itself at plan time, where a
  -- drift lands as a held conflict, never a write. No alt precondition applies to shape 2.
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
