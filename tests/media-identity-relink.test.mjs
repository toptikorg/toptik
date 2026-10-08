// A Gallery angle that re-registered the exact bytes of a store-only Shopify media under a NEW key may
// adopt that media's key, per exact pair, by an operator, after the journal itself proves byte identity
// on both sides. The merge is APPEND ONLY: one new gallery provenance row under the adopted key (the
// planner's own evidence digest), a gallery version bump through the catalog counter, and one new
// observation row at the new revision. No stored row changes; the immutable triggers stay in force.
// The harness applies the FULL gallery CAS migration (triggers included) over real carousel rows and
// creates the observation through the real observe RPC. PGlite engine: TOPTIK_PGLITE_DIR or sibling.
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
const sql = migration('20261008_media_identity_relink.sql');
const body = sql.slice(sql.indexOf('create function'));

test('relink is a private operator function: no grant, lease scoped, enabled product, recorded digests only', () => {
  assert.match(sql, /create function toptik_media_private\.relink_gallery_angle_key\(/);
  assert.match(sql, /security definer set search_path=pg_catalog,pg_temp/);
  // Lease, identity AND the enabled product are required (no p_enabled=false relaxation here).
  assert.match(sql, /i:=toptik_media_private\.assert_access\(p_product_gid,p_lease_owner\);/);
  assert.match(sql, /revoke all on function toptik_media_private\.relink_gallery_angle_key\(text,uuid,uuid,text,text,text,text,text,text\)\s+from public,anon,authenticated,service_role;/);
  assert.doesNotMatch(sql, /\bgrant\b/i);
  // Identity comes from equal content ids recorded on both sides; never from similarity.
  assert.match(body, /MEDIA_RELINK_GALLERY_CONTENT_MISMATCH/);
  assert.match(body, /MEDIA_RELINK_SHOPIFY_CONTENT_MISMATCH/);
  assert.doesNotMatch(body, /visual|distance|similar/i);
  assert.match(body, /MEDIA_RELINK_OPERATION_OPEN/);
  // The same catalog exclusion as the version triggers.
  assert.match(body, /pg_advisory_xact_lock\(hashtext\('toptik-gallery-copy-sync'\)\)/);
  assert.match(body, /perform toptik_media_private\.enqueue\(p_product_gid,/);
});
test('relink is append only: new provenance, the version counter, a new observation, its record and one event', () => {
  const writes = [...sql.matchAll(/\b(update|insert into|delete from)\s+([a-z_]+\.[a-z_]+)/gi)].map(m => `${m[1].toLowerCase()} ${m[2]}`);
  assert.deepEqual(writes, ['insert into toptik_media_private.provenance', 'insert into toptik_media_private.gallery_versions',
    'insert into toptik_media_private.gallery_observations', 'insert into toptik_media_private.media_identity_relinks',
    'insert into toptik_media_private.events']);
  assert.doesNotMatch(sql, /update toptik_media_private\.(provenance|asset_identities|events|products|state|operations|steps|gallery_observations|gallery_commits)/);
  assert.doesNotMatch(sql, /delete from/i);
  assert.doesNotMatch(sql, /disable trigger|drop trigger/i);
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
    // The FULL gallery CAS migration: immutable triggers on observations/commits, version triggers, real RPCs.
    await db.exec(migration('20260930_gallery_media_cas.sql'));
    await db.exec(migration('20261008_media_identity_relink.sql'));
    return { db, core };
  })();
  return ready;
}
const owner = randomUUID();
let serial = 400;
async function rpc(db, name, args) {
  const result = await db.query(`select ${name.includes('.') ? name : 'public.' + name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`, args.map(a => a && typeof a === 'object' ? JSON.stringify(a) : a));
  return result.rows[0].result;
}
const one = async (db, text, args = []) => (await db.query(text, args)).rows[0];
const sha = value => createHash('sha256').update(value).digest('hex');

/** Live P10OXT0129O shape over REAL carousel rows: baseline shares a,b; the store also shows x
 * (s-media). Later the Gallery gained an angle row for the same bytes under its own new key (recorded
 * through the real observe RPC); its stuck operation is already closed. */
async function rekeyedPair({ angleContent, angleAlt, openOperation = false, withRef = true, skipObservation = false } = {}) {
  const { db, core } = await database();
  const n = serial++, mediaId = 100000 + n, angleId = randomUUID();
  const identity = { productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, itemId: randomUUID(),
    exactGallerySku: 'SKU-' + n, exactShopifySku: 'SKU' + n, productHandle: 'מוצר-' + n };
  const urls = {
    a: `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/pics/${n}/a.jpg`,
    b: `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/pics/${n}/b.jpg`,
    x: `https://cdn.shopify.com/s/files/1/0001/${n}-photo6.jpg`,
  };
  await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)', [identity.productId, 'SKU' + n, identity.itemId, identity.variantId, identity.exactGallerySku, identity.exactShopifySku, identity.productHandle]);
  await db.query("insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval '5 minutes')", [identity.productId, owner]);
  const content = sha('photo-6-bytes-' + n), mediaKey = `s-media:${mediaId}`, angleKey = `g-angle:${angleId}`;
  const storeAlt = 'תמונה צד עם גלגלים ' + n, newAngleAlt = angleAlt ?? storeAlt;
  // Real catalog rows (the version triggers fire on these inserts).
  await db.query('insert into public.carousel_items(id,title,cover_image_path,cover_image_alt,is_active,catalog_number) values($1,$2,$3,$4,true,$5)', [identity.itemId, 'מוצר-' + n, urls.a, 'תמונה a', identity.exactGallerySku]);
  await db.query('insert into public.carousel_item_angles(id,item_id,angle_key,image_path,angle_order,image_alt) values($1,$2,$3,$4,1,$5)', [randomUUID(), identity.itemId, 'a1', urls.a, 'תמונה a']);
  await db.query('insert into public.carousel_item_angles(id,item_id,angle_key,image_path,angle_order,image_alt) values($1,$2,$3,$4,2,$5)', [randomUUID(), identity.itemId, 'a2', urls.b, 'תמונה b']);
  const asset = (key, side, contentId, alt) => ({ key, contentId: contentId ?? sha(key), alt: alt ?? 'תמונה ' + key, evidenceId: `p${n}-${side}-${key}` });
  const base = {
    gallery: { identity: structuredClone(identity), side: 'gallery', revision: 'gallery-v1', complete: true, assets: [asset('a', 'gallery'), asset('b', 'gallery')] },
    shopify: { identity: structuredClone(identity), side: 'shopify', revision: 'shopify-v1', complete: true, assets: [asset('a', 'shopify'), asset('b', 'shopify'), asset(mediaKey, 'shopify', content, storeAlt)] },
  };
  const proof = (a, side) => ({ evidenceId: a.evidenceId, key: a.key, side, contentId: a.contentId, proof: {
    platformRef: side === 'shopify' ? (a.key === mediaKey ? `gid://shopify/MediaImage/${mediaId}` : `gid://shopify/MediaImage/${a.key.charCodeAt(0)}`) : `angle:${a.key}`,
    url: side === 'shopify' ? `https://cdn.shopify.com/s/files/1/0001/${n}-${a.key.replace(':', '-')}.jpg` : urls[a.key],
    decodedSha256: a.contentId, mime: 'image/jpeg', width: 800, height: 900, byteLength: 1234, verifiedAt: new Date().toISOString(),
    ownership: side === 'shopify' ? 'reference_only' : 'owned_storage' } });
  const proofs = [...base.gallery.assets.map(a => proof(a, 'gallery')), ...base.shopify.assets.map(a => proof(a, 'shopify'))];
  const approval = randomUUID();
  await rpc(db, 'bootstrap_toptik_media', [identity.productId, owner, approval, base, proofs, { evidenceId: 'reviewed-' + n }]);
  await rpc(db, 'set_toptik_media_enabled', [identity.productId, owner, randomUUID(), true, approval]);
  // The later Gallery addition: a REAL angle row pointing at the store file's exact CDN URL, with the
  // same alt the store baseline carries, registered under its own new key (as production recorded it).
  const galleryContent = angleContent ?? content, angleEvidence = 'g:' + sha('angle-' + n);
  const trackedKey = withRef ? angleKey : `g-angle:${randomUUID()}`, trackedEvidence = withRef ? angleEvidence : 'g:' + sha('alt-angle-' + n);
  await db.query('insert into public.carousel_item_angles(id,item_id,angle_key,image_path,angle_order,image_alt) values($1,$2,$3,$4,3,$5)', [angleId, identity.itemId, 'a3', urls.x, newAngleAlt]);
  const angleProof = { platformRef: `angle:${angleId}`, url: urls.x, decodedSha256: galleryContent,
    mime: 'image/jpeg', width: 800, height: 900, byteLength: 1234, verifiedAt: new Date().toISOString(), ownership: 'reference_only' };
  await db.query('insert into toptik_media_private.asset_identities(product_gid,asset_key,origin_evidence_id) values($1,$2,$3)', [identity.productId, angleKey, 'g:' + sha('origin-' + n)]);
  await db.query('insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof) values($1,$2,$3,$4,$5,$6)',
    [angleEvidence, identity.productId, angleKey, 'gallery', galleryContent, JSON.stringify(angleProof)]);
  if (!withRef) {   // the angle is tracked, but under ANOTHER key than the one the relink names
    await db.query('insert into toptik_media_private.asset_identities(product_gid,asset_key,origin_evidence_id) values($1,$2,$3)', [identity.productId, trackedKey, 'g:' + sha('alt-origin-' + n)]);
    await db.query('insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof) values($1,$2,$3,$4,$5,$6)',
      [trackedEvidence, identity.productId, trackedKey, 'gallery', galleryContent, JSON.stringify(angleProof)]);
  }
  // The live observation, created through the real observe RPC at the real revision.
  const raw = await rpc(db, 'read_toptik_gallery_media', [identity.productId, owner]);
  const angles = raw.angles;
  const refFor = (a, key, evidenceId) => ({ role: 'angle', angleId: a.id, key, evidenceId });
  const refs = [{ role: 'cover', angleId: null, key: 'a', evidenceId: `p${n}-gallery-a` },
    refFor(angles[0], 'a', `p${n}-gallery-a`), refFor(angles[1], 'b', `p${n}-gallery-b`),
    refFor(angles[2], trackedKey, trackedEvidence)];
  if (!skipObservation) await rpc(db, 'observe_toptik_gallery_media', [identity.productId, owner, raw.revision, refs]);
  if (openOperation) {
    const current = structuredClone(base);
    current.gallery.assets[0].alt = 'טקסט אחר'; current.gallery.revision = 'gallery-v2';
    await rpc(db, 'reserve_toptik_media_operation', [identity.productId, owner, randomUUID(), 1, current, core.reconcileMedia(base, current)]);
  }
  const relink = (overrides = {}) => rpc(db, 'toptik_media_private.relink_gallery_angle_key', [
    identity.productId, overrides.owner ?? owner, overrides.relinkId ?? randomUUID(), overrides.mediaRef ?? `gid://shopify/MediaImage/${mediaId}`,
    overrides.angleKey ?? angleKey, overrides.mediaKey ?? mediaKey, overrides.contentId ?? content,
    overrides.approval ?? 'tal-chat-approval-20261008', overrides.evidenceSha ?? sha('evidence-' + n)]);
  return { db, core, identity, mediaId, angleId, content, mediaKey, angleKey, angleEvidence, storeAlt, urls, raw, refs, relink, n };
}

test('relink lands append only: adopted provenance, bumped version, new observation; old rows untouched', { skip }, async () => {
  const f = await rekeyedPair();
  const before = await one(f.db, 'select version from toptik_media_private.gallery_versions where item_id=$1', [f.identity.itemId]);
  const relinkId = randomUUID();
  const r = await f.relink({ relinkId });
  assert.equal(r.status, 'relinked'); assert.equal(r.replayed, false);
  assert.equal(r.mediaKey, f.mediaKey); assert.equal(r.angleKey, f.angleKey);
  assert.notEqual(r.newRevision, f.raw.revision);
  // The planner's own evidence digest for the adopted key.
  const expected = 'g:' + sha(JSON.stringify([f.identity.productId, f.mediaKey, `angle:${f.angleId}`, f.urls.x, f.content]));
  assert.equal(r.adoptedEvidenceId, expected);
  const newProv = await one(f.db, 'select asset_key,side,content_id,proof from toptik_media_private.provenance where evidence_id=$1', [expected]);
  assert.equal(newProv.asset_key, f.mediaKey); assert.equal(newProv.side, 'gallery'); assert.equal(newProv.content_id, f.content);
  assert.equal(newProv.proof.url, f.urls.x);
  // Version advanced through the catalog counter; the OLD observation row is byte-identical.
  const after = await one(f.db, 'select version from toptik_media_private.gallery_versions where item_id=$1', [f.identity.itemId]);
  assert.equal(Number(after.version), Number(before.version) + 1);
  const rows = await f.db.query('select revision,refs,snapshot from toptik_media_private.gallery_observations where product_gid=$1 order by created_at', [f.identity.productId]);
  assert.equal(rows.rows.length, 2);
  assert.deepEqual(rows.rows[0].refs, f.refs);
  const fresh = rows.rows[1];
  assert.equal(fresh.revision, r.newRevision);
  const angleRef = fresh.refs.find(e => e.angleId === f.angleId);
  assert.equal(angleRef.key, f.mediaKey);
  assert.equal(angleRef.evidenceId, expected);
  assert.deepEqual(fresh.snapshot.assets.map(a => a.key), ['a', 'b', f.mediaKey]);
  const merged = fresh.snapshot.assets[2];
  assert.equal(merged.contentId, f.content); assert.equal(merged.alt, f.storeAlt); assert.equal(merged.evidenceId, expected);
  // Old gallery lineage and baselines are untouched.
  assert.equal(Number((await one(f.db, "select count(*) c from toptik_media_private.provenance where product_gid=$1 and asset_key=$2", [f.identity.productId, f.angleKey])).c), 1);
  const st = await one(f.db, 'select baselines from toptik_media_private.state where product_gid=$1', [f.identity.productId]);
  assert.deepEqual(st.baselines.shopify.assets.map(a => a.key), ['a', 'b', f.mediaKey]);
  assert.deepEqual(st.baselines.gallery.assets.map(a => a.key), ['a', 'b']);
  const ev = await one(f.db, 'select event_kind,operation_id from toptik_media_private.events where request_id=$1', [relinkId]);
  assert.equal(ev.event_kind, 'gallery_angle_rekeyed'); assert.equal(ev.operation_id, null);
  const q = await one(f.db, 'select status,evidence from toptik_media_private.work_queue where product_gid=$1', [f.identity.productId]);
  assert.equal(q.status, 'pending'); assert.equal(q.evidence.identityRelinked, relinkId);
});
test('every reader works after the relink: re-observation reuses the new row and the snapshot reader resolves', { skip }, async () => {
  const f = await rekeyedPair();
  const r = await f.relink();
  // The next worker pass: read -> observe at the NEW revision with the stored refs -> byte-equal reuse.
  const raw1 = await rpc(f.db, 'read_toptik_gallery_media', [f.identity.productId, owner]);
  assert.equal(raw1.revision, r.newRevision);
  const stored = await one(f.db, 'select refs from toptik_media_private.gallery_observations where product_gid=$1 and revision=$2', [f.identity.productId, r.newRevision]);
  const again = await rpc(f.db, 'observe_toptik_gallery_media', [f.identity.productId, owner, raw1.revision, stored.refs]);
  assert.equal(again.snapshot.assets.length, 3);
  assert.equal(Number((await one(f.db, 'select count(*) c from toptik_media_private.gallery_observations where product_gid=$1', [f.identity.productId])).c), 2);
  // The read-only snapshot reader (transport guards, runtime readers) resolves the adopted lineage.
  const snap = await rpc(f.db, 'read_toptik_gallery_media_snapshot', [f.identity.productId]);
  assert.deepEqual(snap.assets.map(a => a.key), ['a', 'b', f.mediaKey]);
});
test('after the relink the planner has nothing to write; the unmerged shape stays held by #104', { skip }, async () => {
  const f = await rekeyedPair();
  await f.relink();
  const st = await one(f.db, 'select baselines from toptik_media_private.state where product_gid=$1', [f.identity.productId]);
  const obs = await one(f.db, 'select snapshot from toptik_media_private.gallery_observations where product_gid=$1 order by created_at desc limit 1', [f.identity.productId]);
  const current = structuredClone(st.baselines);
  current.gallery.assets = structuredClone(obs.snapshot.assets);
  const plan = f.core.reconcileMedia(st.baselines, current);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.patches, []);
  // Before the relink, the identical observation attached a second copy (held since #104, 73f2b3d).
  const before = structuredClone(st.baselines);
  before.gallery.assets = obs.snapshot.assets.map(a => a.key === f.mediaKey ? { key: f.angleKey, contentId: f.content, alt: a.alt, evidenceId: f.angleEvidence } : a);
  assert.deepEqual(f.core.reconcileMedia(st.baselines, before).conflicts.map(c => c.code), ['MEDIA_ATTACH_TARGET_HAS_SAME_CONTENT']);
});
test('an identical replay returns the stored result and writes nothing new', { skip }, async () => {
  const f = await rekeyedPair();
  const relinkId = randomUUID(), evidenceSha = sha('evidence-' + f.n);
  const first = await f.relink({ relinkId, evidenceSha });
  const again = await f.relink({ relinkId, evidenceSha });
  assert.equal(again.replayed, true);
  assert.equal(again.newRevision, first.newRevision);
  assert.equal(Number((await one(f.db, 'select count(*) c from toptik_media_private.media_identity_relinks where product_gid=$1', [f.identity.productId])).c), 1);
  assert.equal(Number((await one(f.db, 'select count(*) c from toptik_media_private.gallery_observations where product_gid=$1', [f.identity.productId])).c), 2);
  assert.equal(Number((await one(f.db, "select count(*) c from toptik_media_private.events where product_gid=$1 and event_kind='gallery_angle_rekeyed'", [f.identity.productId])).c), 1);
});
test('a changed replay of the same relink id or the same pair is refused', { skip }, async () => {
  const f = await rekeyedPair();
  const relinkId = randomUUID();
  await f.relink({ relinkId });
  await assert.rejects(f.relink({ relinkId, approval: 'another-approval' }), /MEDIA_RELINK_REUSED/);
  await assert.rejects(f.relink(), /MEDIA_RELINK_REUSED/);   // same pair, new id
});
test('an open operation blocks the relink: the stuck plan must be closed first', { skip }, async () => {
  const f = await rekeyedPair({ openOperation: true });
  await assert.rejects(f.relink(), /MEDIA_RELINK_OPERATION_OPEN/);
});
test('content ids must match on both sides; similarity has no standing', { skip }, async () => {
  const different = await rekeyedPair({ angleContent: sha('a-different-photo') });
  await assert.rejects(different.relink({ contentId: different.content }), /MEDIA_RELINK_GALLERY_CONTENT_MISMATCH/);
  const f = await rekeyedPair();
  await assert.rejects(f.relink({ contentId: sha('not-the-stored-bytes') }), /MEDIA_RELINK_GALLERY_CONTENT_MISMATCH|MEDIA_RELINK_SHOPIFY_CONTENT_MISMATCH/);
});
test('a moved catalog, a missing ref and an alt mismatch are all refused before any write', { skip }, async () => {
  const moved = await rekeyedPair();
  await moved.db.query('update public.carousel_items set title=title||\' חדש\' where id=$1', [moved.identity.itemId]);
  await assert.rejects(moved.relink(), /MEDIA_RELINK_GALLERY_MOVED/);
  const noRef = await rekeyedPair({ withRef: false });
  await assert.rejects(noRef.relink(), /MEDIA_RELINK_GALLERY_REFS_MISMATCH/);
  const badAlt = await rekeyedPair({ angleAlt: 'different' });
  await assert.rejects(badAlt.relink(), /MEDIA_RELINK_ALT_MISMATCH/);
  for (const g of [moved, noRef, badAlt]) {
    assert.equal(Number((await one(g.db, 'select count(*) c from toptik_media_private.media_identity_relinks where product_gid=$1', [g.identity.productId])).c), 0);
    assert.equal(Number((await one(g.db, "select count(*) c from toptik_media_private.provenance where product_gid=$1 and asset_key=$2 and side='gallery'", [g.identity.productId, g.mediaKey])).c), 0);
  }
});
test('a second gallery lineage for the store key is refused; the derived key must spell the media id; a foreign lease is refused', { skip }, async () => {
  const f = await rekeyedPair();
  await f.db.query('insert into toptik_media_private.asset_identities(product_gid,asset_key,origin_evidence_id) values($1,$2,$3) on conflict do nothing', [f.identity.productId, f.mediaKey, 'seed']);
  await f.db.query('insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof) values($1,$2,$3,$4,$5,$6)',
    ['g:' + sha('rogue-' + f.n), f.identity.productId, f.mediaKey, 'gallery', f.content, JSON.stringify({ platformRef: 'angle:rogue', url: 'https://cdn.shopify.com/s/files/1/0001/rogue.jpg' })]);
  await assert.rejects(f.relink(), /MEDIA_RELINK_TARGET_KEY_AMBIGUOUS/);
  const g = await rekeyedPair();
  await assert.rejects(g.relink({ mediaKey: 's-media:1' }), /MEDIA_RELINK_INVALID/);
  await assert.rejects(g.relink({ owner: randomUUID() }), /LEASE|ACCESS|OWNER/i);
});
