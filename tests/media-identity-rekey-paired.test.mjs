// A replaced Gallery angle row may merge back onto its OWN retired, already-PAIRED baseline key
// (photo-7 shape), and relink v2 may adopt a freshly re-uploaded s-media identity when the baseline
// still pairs the same bytes under a retired gallery key whose retirement is recorded as removal
// intents on BOTH sides (photo-6 shape). Both merges are APPEND ONLY and proven by recorded digests
// alone. The harness applies the FULL gallery CAS migration over real carousel rows, exactly like
// media-identity-relink.test.mjs, plus the paired-rekey migration under test.
import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = name => readFileSync(path.join(repo, 'supabase/migrations', name), 'utf8');
const sql = migration('20261008_media_identity_relink_paired.sql');
const body = sql.slice(sql.indexOf('create table'));   // past the narrative header

test('both operator functions stay private, digest-proven and advisory-locked; no grants anywhere', () => {
  assert.match(sql, /create function toptik_media_private\.rekey_gallery_angle_to_baseline_key\(/);
  assert.match(sql, /create or replace function toptik_media_private\.relink_gallery_angle_key\(/);
  assert.equal([...sql.matchAll(/security definer set search_path=pg_catalog,pg_temp/g)].length, 2);
  assert.match(sql, /revoke all on function toptik_media_private\.rekey_gallery_angle_to_baseline_key\(text,uuid,uuid,text,text,text,text,text\)\s+from public,anon,authenticated,service_role;/);
  assert.match(sql, /revoke all on function toptik_media_private\.relink_gallery_angle_key\(text,uuid,uuid,text,text,text,text,text,text\)\s+from public,anon,authenticated,service_role;/);
  assert.doesNotMatch(sql, /\bgrant\b/i);
  assert.doesNotMatch(body, /visual|distance|similar/i);
  assert.equal([...sql.matchAll(/pg_advisory_xact_lock\(hashtext\('toptik-gallery-copy-sync'\)\)/g)].length, 2);
  // The new shape-2 branch demands recorded retirements; nothing writes or invents them here.
  assert.match(sql, /MEDIA_RELINK_RETIREMENT_NOT_RECORDED/);
  assert.doesNotMatch(sql, /insert into toptik_media_private\.removal_intents/);
});
test('every write in the migration is an append; immutable tables stay immutable', () => {
  const writes = [...sql.matchAll(/\b(update|insert into|delete from)\s+([a-z_]+\.[a-z_]+)/gi)].map(m => `${m[1].toLowerCase()} ${m[2]}`);
  assert.deepEqual(writes, [
    'insert into toptik_media_private.provenance', 'insert into toptik_media_private.gallery_versions',
    'insert into toptik_media_private.gallery_observations', 'insert into toptik_media_private.media_identity_rekeys',
    'insert into toptik_media_private.events',
    'insert into toptik_media_private.provenance', 'insert into toptik_media_private.gallery_versions',
    'insert into toptik_media_private.gallery_observations', 'insert into toptik_media_private.media_identity_relinks',
    'insert into toptik_media_private.events']);
  assert.doesNotMatch(sql, /update toptik_media_private\.(provenance|asset_identities|events|products|state|operations|steps|gallery_observations|gallery_commits|removal_intents)/);
  assert.doesNotMatch(sql, /delete from/i);
  assert.doesNotMatch(sql, /disable trigger|drop trigger|alter table toptik_media_private\.(?!media_identity_rekeys)/i);
  assert.match(sql, /create trigger immutable_record before update or delete on toptik_media_private\.media_identity_rekeys/);
});

const engine = process.env.TOPTIK_PGLITE_DIR ?? path.resolve(repo, '../sync-sql-validation-20260930/package');
const skip = existsSync(path.join(engine, 'dist/index.js')) ? false : `PGlite engine not found at ${engine}`;
const coreUrl = 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(resolveImageLimits(readFileSync(path.join(repo, 'src/lib/shopify/media-sync-core.ts'), 'utf8')))).toString('base64');

let ready;
function database() {
  ready ??= (async () => {
    const { PGlite } = await import(pathToFileURL(path.join(engine, 'dist/index.js')).href);
    const core = await import(coreUrl), db = new PGlite();
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create table public.shopify_gallery_copy_eligibility(product_gid text primary key,catalog_key text,carousel_item_id uuid,variant_gid text,exact_gallery_sku text,exact_shopify_sku text,approved_product_handle text,enabled boolean);
create table public.shopify_gallery_reconciliation_leases(product_gid text primary key,owner uuid,expires_at timestamptz);
create table public.shopify_webhook_events(id uuid,topic text,shop_domain text,payload jsonb,delivery_id text);
create table public.carousel_items(id uuid primary key,title text,cover_image_path text,is_active boolean not null default true,catalog_number text);
create table public.carousel_item_angles(id uuid primary key,item_id uuid not null references public.carousel_items(id),angle_key text,image_path text,angle_order int);
create function public.assert_shopify_verified_copy_identity(p_item uuid,p_key text,p_gsku text,p_product text,p_variant text,p_ssku text) returns void language plpgsql as $$begin
 if not exists(select 1 from public.shopify_gallery_copy_eligibility where product_gid=p_product and catalog_key=p_key and carousel_item_id=p_item and exact_gallery_sku=p_gsku and variant_gid=p_variant and exact_shopify_sku=p_ssku and enabled) then raise exception 'COPY_IDENTITY_CHANGED';end if;end$$;`);
    const queueTable = migration('20261001_media_planning_runtime.sql').match(/create table toptik_media_private\.work_queue\([\s\S]*?\);/)[0];
    const enqueue = migration('20261007_media_queue_inflight.sql').match(/create or replace function toptik_media_private\.enqueue\([\s\S]*?end \$\$;/)[0];
    for (const name of ['20260930_media_sync_journal.sql', '20260930_media_transport_substeps.sql', '20260930_media_transport_runtime.sql',
      '20261001_existing_media_25mp.sql', '20261007_media_final_readback.sql', '20261007_media_transport_not_sent_precondition.sql']) await db.exec(migration(name));
    await db.exec(queueTable); await db.exec(enqueue);
    await db.exec(migration('20260930_gallery_media_cas.sql'));
    await db.exec(migration('20261008_media_identity_relink.sql'));
    await db.exec(migration('20261008_media_identity_relink_paired.sql'));
    await db.exec(migration('20261008_media_identity_relink_paired_fix.sql'));
    return { db, core };
  })();
  return ready;
}
const owner = randomUUID();
let serial = 700;
async function rpc(db, name, args) {
  const result = await db.query(`select ${name.includes('.') ? name : 'public.' + name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`, args.map(a => a && typeof a === 'object' ? JSON.stringify(a) : a));
  return result.rows[0].result;
}
const one = async (db, text, args = []) => (await db.query(text, args)).rows[0];
const sha = value => createHash('sha256').update(value).digest('hex');

/** Live P10OXT0529O photo-7 shape: the baseline pairs the bytes under the RETIRED angle key R on BOTH
 * sides; the live store media still carries R in its own shopify provenance; the catalog's replaced
 * row N carries the same bytes and the same alt, registered through the real observe RPC. */
async function pairedShapes({ photo6 = false, angleContent, angleAlt, intents = true, openOperation = false, extraBaselineCopy = false, oldUrlDiffers = false, oldGalleryAltShort = false } = {}) {
  const { db, core } = await database();
  const n = serial++, mediaId = 200000 + n, oldAngleId = randomUUID(), newAngleId = randomUUID();
  const identity = { productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, itemId: randomUUID(),
    exactGallerySku: 'SKU-' + n, exactShopifySku: 'SKU' + n, productHandle: 'מוצר-' + n };
  const urls = {
    a: `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/pics/${n}/a.jpg`,
    x: `https://cdn.shopify.com/s/files/1/0001/${n}-photo.jpg`,
  };
  await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)', [identity.productId, 'SKU' + n, identity.itemId, identity.variantId, identity.exactGallerySku, identity.exactShopifySku, identity.productHandle]);
  await db.query("insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval '5 minutes')", [identity.productId, owner]);
  const content = sha('paired-bytes-' + n), oldKey = `g-angle:${oldAngleId}`, newKey = `g-angle:${newAngleId}`, mediaKey = `s-media:${mediaId}`;
  const pairedAlt = 'תמונה משותפת ' + n, newAlt = angleAlt ?? pairedAlt;
  await db.query('insert into public.carousel_items(id,title,cover_image_path,cover_image_alt,is_active,catalog_number) values($1,$2,$3,$4,true,$5)', [identity.itemId, 'מוצר-' + n, urls.a, 'תמונה a', identity.exactGallerySku]);
  await db.query('insert into public.carousel_item_angles(id,item_id,angle_key,image_path,angle_order,image_alt) values($1,$2,$3,$4,1,$5)', [randomUUID(), identity.itemId, 'a1', urls.a, 'תמונה a']);
  // Production gallery evidence ids follow the planner's g:<sha256> format; the rekey may REUSE one.
  const asset = (key, side, contentId, alt) => ({ key, contentId: contentId ?? sha(key), alt: alt ?? 'תמונה ' + key,
    evidenceId: side === 'gallery' && key.startsWith('g-angle:') ? 'g:' + sha(`p${n}-${side}-${key}`) : `p${n}-${side}-${key}` });
  // The baseline pairs a plus the retired key on both sides (photo-7), or the same with the store
  // media later re-uploaded under a fresh s-media identity (photo-6).
  const base = {
    gallery: { identity: structuredClone(identity), side: 'gallery', revision: 'gallery-v1', complete: true, assets: [asset('a', 'gallery'), asset(oldKey, 'gallery', content, oldGalleryAltShort ? 'גרסה קצרה היסטורית' : pairedAlt)] },
    shopify: { identity: structuredClone(identity), side: 'shopify', revision: 'shopify-v1', complete: true, assets: [asset('a', 'shopify'), asset(oldKey, 'shopify', content, pairedAlt)] },
  };
  if (extraBaselineCopy) base.gallery.assets.push(asset(`g-angle:${randomUUID()}`, 'gallery', content, pairedAlt));
  const proof = (a, side) => ({ evidenceId: a.evidenceId, key: a.key, side, contentId: a.contentId, proof: {
    platformRef: side === 'shopify' ? `gid://shopify/MediaImage/${a.key === oldKey ? mediaId : a.key.charCodeAt(0)}` : `angle:${a.key}`,
    url: side === 'shopify' ? `https://cdn.shopify.com/s/files/1/0001/${n}-${a.key.replace(':', '-')}.jpg`
      : (a.key === 'a' ? urls.a : (oldUrlDiffers ? urls.x.replace('-photo.jpg', '-previous.jpg') : urls.x)),
    decodedSha256: a.contentId, mime: 'image/jpeg', width: 800, height: 900, byteLength: 1234, verifiedAt: new Date().toISOString(),
    ownership: side === 'shopify' || a.key !== 'a' ? 'reference_only' : 'owned_storage' } });
  const proofs = [...base.gallery.assets.map(a => proof(a, 'gallery')), ...base.shopify.assets.map(a => proof(a, 'shopify'))];
  const approval = randomUUID();
  await rpc(db, 'bootstrap_toptik_media', [identity.productId, owner, approval, base, proofs, { evidenceId: 'reviewed-' + n }]);
  await rpc(db, 'set_toptik_media_enabled', [identity.productId, owner, randomUUID(), true, approval]);
  let freshMediaId = mediaId;
  if (photo6) {
    // The store media was re-uploaded: a FRESH media id under its own s-media identity and provenance.
    freshMediaId = mediaId + 500000;
    await db.query('insert into toptik_media_private.asset_identities(product_gid,asset_key,origin_evidence_id) values($1,$2,$3)', [identity.productId, `s-media:${freshMediaId}`, 's:' + sha('fresh-' + n)]);
    await db.query('insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof) values($1,$2,$3,$4,$5,$6)',
      ['s:' + sha('fresh-prov-' + n), identity.productId, `s-media:${freshMediaId}`, 'shopify', content,
       JSON.stringify({ platformRef: `gid://shopify/MediaImage/${freshMediaId}`, url: urls.x, decodedSha256: content, mime: 'image/jpeg', width: 800, height: 900, byteLength: 1234, verifiedAt: new Date().toISOString(), ownership: 'reference_only' })]);
  }
  // The replaced catalog row: same bytes, same alt, its own new key, as production recorded it.
  const angleEvidence = 'g:' + sha('new-angle-' + n), galleryContent = angleContent ?? content;
  await db.query('insert into public.carousel_item_angles(id,item_id,angle_key,image_path,angle_order,image_alt) values($1,$2,$3,$4,2,$5)', [newAngleId, identity.itemId, 'a2', urls.x, newAlt]);
  await db.query('insert into toptik_media_private.asset_identities(product_gid,asset_key,origin_evidence_id) values($1,$2,$3)', [identity.productId, newKey, 'g:' + sha('new-origin-' + n)]);
  await db.query('insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof) values($1,$2,$3,$4,$5,$6)',
    [angleEvidence, identity.productId, newKey, 'gallery', galleryContent,
     JSON.stringify({ platformRef: `angle:${newAngleId}`, url: urls.x, decodedSha256: galleryContent, mime: 'image/jpeg', width: 800, height: 900, byteLength: 1234, verifiedAt: new Date().toISOString(), ownership: 'reference_only' })]);
  const raw = await rpc(db, 'read_toptik_gallery_media', [identity.productId, owner]);
  const refs = [{ role: 'cover', angleId: null, key: 'a', evidenceId: `p${n}-gallery-a` },
    { role: 'angle', angleId: raw.angles[0].id, key: 'a', evidenceId: `p${n}-gallery-a` },
    { role: 'angle', angleId: raw.angles[1].id, key: newKey, evidenceId: angleEvidence }];
  await rpc(db, 'observe_toptik_gallery_media', [identity.productId, owner, raw.revision, refs]);
  if (intents && photo6) {
    for (const side of ['gallery', 'shopify']) {
      const fp = (await one(db, `select toptik_media_private.fingerprint(s.baselines->'${side}') f from toptik_media_private.state s where s.product_gid=$1`, [identity.productId])).f;
      await db.query('insert into toptik_media_private.removal_intents values($1,$2,$3,$4,$5,$6,$7,clock_timestamp())',
        [randomUUID(), identity.productId, side, oldKey, fp, side === 'gallery' ? 'authenticated_editor' : 'signed_shopify_event', JSON.stringify({ kind: 'test' })]);
    }
  }
  if (openOperation) {
    const current = structuredClone(base);
    current.gallery.assets[0].alt = 'טקסט אחר'; current.gallery.revision = 'gallery-v2';
    await rpc(db, 'reserve_toptik_media_operation', [identity.productId, owner, randomUUID(), 1, current, core.reconcileMedia(base, current)]);
  }
  const rekey = (overrides = {}) => rpc(db, 'toptik_media_private.rekey_gallery_angle_to_baseline_key', [
    identity.productId, overrides.owner ?? owner, overrides.rekeyId ?? randomUUID(), overrides.oldKey ?? oldKey,
    overrides.newKey ?? newKey, overrides.contentId ?? content,
    overrides.approval ?? 'tal-chat-approval-20261008', overrides.evidenceSha ?? sha('evidence-' + n)]);
  const relink = (overrides = {}) => rpc(db, 'toptik_media_private.relink_gallery_angle_key', [
    identity.productId, overrides.owner ?? owner, overrides.relinkId ?? randomUUID(),
    overrides.mediaRef ?? `gid://shopify/MediaImage/${freshMediaId}`, overrides.angleKey ?? newKey,
    overrides.mediaKey ?? `s-media:${freshMediaId}`, overrides.contentId ?? content,
    overrides.approval ?? 'tal-chat-approval-20261008', overrides.evidenceSha ?? sha('evidence-' + n)]);
  return { db, core, identity, mediaId, freshMediaId, oldAngleId, newAngleId, content, oldKey, newKey, mediaKey, pairedAlt, urls, raw, refs, rekey, relink, angleEvidence, n };
}

test('photo-7: the new angle adopts its retired baseline key; the merged pair plans nothing at all', { skip }, async () => {
  const f = await pairedShapes();
  const rekeyId = randomUUID();
  const r = await f.rekey({ rekeyId });
  assert.equal(r.status, 'rekeyed'); assert.equal(r.replayed, false);
  assert.equal(r.oldAngleKey, f.oldKey); assert.equal(r.newAngleKey, f.newKey);
  // The old row already records this exact URL and bytes, so the merge REUSES its evidence id.
  const expected = 'g:' + sha(`p${f.n}-gallery-${f.oldKey}`);
  assert.equal(r.adoptedEvidenceId, expected);
  assert.equal(Number((await one(f.db, "select count(*) c from toptik_media_private.provenance where product_gid=$1 and asset_key=$2 and side='gallery'", [f.identity.productId, f.oldKey])).c), 1);
  const newProv = await one(f.db, 'select asset_key,side,content_id,proof from toptik_media_private.provenance where evidence_id=$1', [expected]);
  assert.equal(newProv.asset_key, f.oldKey); assert.equal(newProv.side, 'gallery'); assert.equal(newProv.content_id, f.content);
  const fresh = await one(f.db, 'select revision,refs,snapshot from toptik_media_private.gallery_observations where product_gid=$1 order by created_at desc limit 1', [f.identity.productId]);
  assert.equal(fresh.revision, r.newRevision);
  const angleRef = fresh.refs.find(e => e.angleId === f.newAngleId);
  assert.equal(angleRef.key, f.oldKey); assert.equal(angleRef.evidenceId, expected);
  assert.deepEqual(fresh.snapshot.assets.map(a => a.key), ['a', f.oldKey]);
  // The planner now sees the baseline pair restored on both sides: zero conflicts, zero patches.
  const st = await one(f.db, 'select baselines from toptik_media_private.state where product_gid=$1', [f.identity.productId]);
  const current = structuredClone(st.baselines);
  current.gallery.assets = structuredClone(fresh.snapshot.assets);
  const plan = f.core.reconcileMedia(st.baselines, current);
  assert.deepEqual(plan.conflicts, []); assert.deepEqual(plan.patches, []);
  const q = await one(f.db, 'select status,evidence from toptik_media_private.work_queue where product_gid=$1', [f.identity.productId]);
  assert.equal(q.status, 'pending'); assert.equal(q.evidence.identityRekeyed, rekeyId);
  const ev = await one(f.db, 'select event_kind from toptik_media_private.events where request_id=$1', [rekeyId]);
  assert.equal(ev.event_kind, 'gallery_angle_rekeyed');
});
test('photo-7 with a moved URL: the merge registers the adopted copy under the planner digest', { skip }, async () => {
  const f = await pairedShapes({ oldUrlDiffers: true });
  const r = await f.rekey();
  const expected = 'g:' + sha(JSON.stringify([f.identity.productId, f.oldKey, `angle:${f.newAngleId}`, f.urls.x, f.content]));
  assert.equal(r.adoptedEvidenceId, expected);
  const newProv = await one(f.db, 'select asset_key,side,content_id,proof from toptik_media_private.provenance where evidence_id=$1', [expected]);
  assert.equal(newProv.asset_key, f.oldKey); assert.equal(newProv.proof.url, f.urls.x);
  assert.equal(Number((await one(f.db, "select count(*) c from toptik_media_private.provenance where product_gid=$1 and asset_key=$2 and side='gallery'", [f.identity.productId, f.oldKey])).c), 2);
});
test('photo-7 refusals: content mismatch, foreign shopify lineage, alt drift, open operation, replay rules', { skip }, async () => {
  const wrongContent = await pairedShapes({ angleContent: sha('other-bytes') });
  await assert.rejects(wrongContent.rekey(), /MEDIA_REKEY_NEW_GALLERY_CONTENT_MISMATCH/);
  const lineage = await pairedShapes();
  await lineage.db.query('insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof) values($1,$2,$3,$4,$5,$6)',
    ['s:' + sha('rogue-' + lineage.n), lineage.identity.productId, lineage.newKey, 'shopify', lineage.content, JSON.stringify({ platformRef: 'gid://shopify/MediaImage/9', url: 'https://cdn.shopify.com/s/files/1/0001/rogue.jpg' })]);
  await assert.rejects(lineage.rekey(), /MEDIA_REKEY_NEW_KEY_HAS_SHOPIFY_LINEAGE/);
  const badAlt = await pairedShapes({ angleAlt: 'אחר לגמרי' });
  await assert.rejects(badAlt.rekey(), /MEDIA_REKEY_ALT_MISMATCH/);
  const open = await pairedShapes({ openOperation: true });
  await assert.rejects(open.rekey(), /MEDIA_REKEY_OPERATION_OPEN/);
  const f = await pairedShapes();
  const rekeyId = randomUUID(), evidenceSha = sha('evidence-' + f.n);
  const first = await f.rekey({ rekeyId, evidenceSha });
  const again = await f.rekey({ rekeyId, evidenceSha });
  assert.equal(again.replayed, true); assert.equal(again.newRevision, first.newRevision);
  await assert.rejects(f.rekey({ rekeyId, approval: 'another' }), /MEDIA_REKEY_REUSED/);
  await assert.rejects(f.rekey(), /MEDIA_REKEY_REUSED/);
  // Refused attempts write nothing.
  for (const g of [wrongContent, lineage, badAlt, open]) {
    assert.equal(Number((await one(g.db, 'select count(*) c from toptik_media_private.media_identity_rekeys where product_gid=$1', [g.identity.productId])).c), 0);
  }
});
test('photo-7: a baseline that does not pair the retired key on both sides is refused', { skip }, async () => {
  const f = await pairedShapes();
  // Name a retired key the baseline never paired.
  await assert.rejects(f.rekey({ oldKey: `g-angle:${randomUUID()}` }), /MEDIA_REKEY_OLD_GALLERY_CONTENT_MISMATCH|MEDIA_REKEY_IDENTITY_MISSING/);
});
test('photo-6: relink v2 adopts the fresh s-media identity only over a fully recorded retirement', { skip }, async () => {
  const noIntents = await pairedShapes({ photo6: true, intents: false });
  await assert.rejects(noIntents.relink(), /MEDIA_RELINK_RETIREMENT_NOT_RECORDED/);
  const f = await pairedShapes({ photo6: true });
  const relinkId = randomUUID();
  const r = await f.relink({ relinkId });
  assert.equal(r.status, 'relinked'); assert.equal(r.replayed, false);
  assert.equal(r.mediaKey, `s-media:${f.freshMediaId}`);
  const fresh = await one(f.db, 'select revision,refs,snapshot from toptik_media_private.gallery_observations where product_gid=$1 order by created_at desc limit 1', [f.identity.productId]);
  assert.equal(fresh.revision, r.newRevision);
  assert.deepEqual(fresh.snapshot.assets.map(a => a.key), ['a', `s-media:${f.freshMediaId}`]);
  // The merged plan: the s-media pair matches on both sides; the retired pair's absence is justified
  // by the recorded intents; zero conflicts and zero patches remain.
  const st = await one(f.db, 'select baselines from toptik_media_private.state where product_gid=$1', [f.identity.productId]);
  const current = structuredClone(st.baselines);
  current.gallery.assets = structuredClone(fresh.snapshot.assets);
  current.shopify.assets = [structuredClone(st.baselines.shopify.assets[0]),
    { key: `s-media:${f.freshMediaId}`, contentId: f.content, alt: f.pairedAlt, evidenceId: 's:' + sha('fresh-prov-' + f.n) }];
  const removals = ['gallery', 'shopify'].map(side => ({ side, key: f.oldKey, requestId: randomUUID(),
    kind: side === 'gallery' ? 'authenticated_editor' : 'signed_shopify_event',
    expectedBaselineFingerprint: f.core.mediaSnapshotFingerprint(st.baselines[side]) }));
  const plan = f.core.reconcileMedia(st.baselines, current, removals);
  assert.deepEqual(plan.conflicts, []); assert.deepEqual(plan.patches, []);
});
test('a duplicate removal intent is refused before it can wedge planning forever', { skip }, async () => {
  const f = await pairedShapes({ photo6: true });
  const fp = (await one(f.db, `select toptik_media_private.fingerprint(s.baselines->'gallery') f from toptik_media_private.state s where s.product_gid=$1`, [f.identity.productId])).f;
  await f.db.query('insert into toptik_media_private.removal_intents values($1,$2,$3,$4,$5,$6,$7,clock_timestamp())',
    [randomUUID(), f.identity.productId, 'gallery', f.oldKey, fp, 'authenticated_editor', JSON.stringify({ kind: 'dup' })]);
  await assert.rejects(f.relink(), /MEDIA_RELINK_RETIREMENT_NOT_RECORDED/);
});
test('the rekey refuses the photo-6 shape outright', { skip }, async () => {
  const fresh = await pairedShapes({ photo6: true });
  await assert.rejects(fresh.rekey(), /MEDIA_REKEY_FRESH_REUPLOAD_PRESENT/);
});
test('photo-6 with the live historical short gallery alt merges cleanly (the 0529O refusal case)', { skip }, async () => {
  const f = await pairedShapes({ photo6: true, oldGalleryAltShort: true });
  const r = await f.relink();
  assert.equal(r.status, 'relinked');
  const fresh = await one(f.db, 'select snapshot from toptik_media_private.gallery_observations where product_gid=$1 order by created_at desc limit 1', [f.identity.productId]);
  assert.deepEqual(fresh.snapshot.assets.map(a => a.key), ['a', `s-media:${f.freshMediaId}`]);
});
test('photo-6 refusals: an ambiguous retired pair and the original strict shape both stay closed', { skip }, async () => {
  const twoCopies = await pairedShapes({ photo6: true, extraBaselineCopy: true });
  await assert.rejects(twoCopies.relink(), /MEDIA_RELINK_BASELINE_MISMATCH/);
  // Shape 1 strict behaviour is unchanged: naming a media the baseline pairs under its own s-media
  // key with DIFFERENT bytes still refuses (regression guard for the v1 branch).
  const f = await pairedShapes({ photo6: true });
  await assert.rejects(f.relink({ contentId: sha('not-the-bytes') }), /MEDIA_RELINK_GALLERY_CONTENT_MISMATCH|MEDIA_RELINK_SHOPIFY_CONTENT_MISMATCH/);
});
