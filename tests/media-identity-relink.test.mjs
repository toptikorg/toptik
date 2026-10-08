// A Gallery angle that re-registered the exact bytes of a store-only Shopify media under a NEW key may
// adopt that media's key, per exact pair, by an operator, after the journal itself proves byte identity
// on both sides. The next plan then has one shared key with equal content and nothing to write (#104
// keeps holding every other duplicate shape). Only the live gallery identity map (latest observation
// refs+snapshot) changes; every immutable journal table keeps its rows. Real-migration integration runs
// on an offline PGlite engine (TOPTIK_PGLITE_DIR or the sibling package); tests skip where absent.
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
  assert.match(body, /perform toptik_media_private\.enqueue\(p_product_gid,/);
});
test('relink writes only the live identity map, its own record and one event; immutable tables stay untouched', () => {
  const writes = [...sql.matchAll(/\b(update|insert into|delete from)\s+([a-z_]+\.[a-z_]+)/gi)].map(m => `${m[1].toLowerCase()} ${m[2]}`);
  assert.deepEqual(writes, ['update toptik_media_private.gallery_observations',
    'insert into toptik_media_private.media_identity_relinks', 'insert into toptik_media_private.events']);
  assert.doesNotMatch(sql, /update toptik_media_private\.(provenance|asset_identities|events|products|state|operations|steps)/);
  assert.doesNotMatch(sql, /delete from/i);
  assert.doesNotMatch(sql, /disable trigger/i);
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
create function public.assert_shopify_verified_copy_identity(p_item uuid,p_key text,p_gsku text,p_product text,p_variant text,p_ssku text) returns void language plpgsql as $$begin
 if not exists(select 1 from public.shopify_gallery_copy_eligibility where product_gid=p_product and catalog_key=p_key and carousel_item_id=p_item and exact_gallery_sku=p_gsku and variant_gid=p_variant and exact_shopify_sku=p_ssku and enabled) then raise exception 'COPY_IDENTITY_CHANGED';end if;end$$;`);
    const queueTable = migration('20261001_media_planning_runtime.sql').match(/create table toptik_media_private\.work_queue\([\s\S]*?\);/)[0];
    const enqueue = migration('20261007_media_queue_inflight.sql').match(/create or replace function toptik_media_private\.enqueue\([\s\S]*?end \$\$;/)[0];
    const observations = migration('20260930_gallery_media_cas.sql').match(/create table toptik_media_private\.gallery_observations\([\s\S]*?\);/)[0];
    for (const name of ['20260930_media_sync_journal.sql', '20260930_media_transport_substeps.sql', '20260930_media_transport_runtime.sql',
      '20261001_existing_media_25mp.sql', '20261007_media_final_readback.sql', '20261007_media_transport_not_sent_precondition.sql']) await db.exec(migration(name));
    await db.exec(queueTable); await db.exec(enqueue); await db.exec(observations);
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

/** Live P10OXT0129O shape: baseline shares a,b; the store also shows x (s-media). Later the Gallery
 * gained an angle row for the same bytes under its own new key; its stuck operation is already closed. */
async function rekeyedPair({ angleContent, openOperation = false, withRef = true, mediaKeyInRefs = false } = {}) {
  const { db, core } = await database();
  const n = serial++, mediaId = 100000 + n, angleId = randomUUID();
  const identity = { productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, itemId: randomUUID(),
    exactGallerySku: 'SKU-' + n, exactShopifySku: 'SKU' + n, productHandle: 'מוצר-' + n };
  await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)', [identity.productId, 'SKU' + n, identity.itemId, identity.variantId, identity.exactGallerySku, identity.exactShopifySku, identity.productHandle]);
  await db.query("insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval '5 minutes')", [identity.productId, owner]);
  const content = sha('photo-6-bytes-' + n), mediaKey = `s-media:${mediaId}`, angleKey = `g-angle:${angleId}`;
  const asset = (key, side, contentId) => ({ key, contentId: contentId ?? sha(key), alt: 'תמונה ' + key, evidenceId: `p${n}-${side}-${key}` });
  const base = {
    gallery: { identity: structuredClone(identity), side: 'gallery', revision: 'gallery-v1', complete: true, assets: ['a', 'b'].map(k => asset(k, 'gallery')) },
    shopify: { identity: structuredClone(identity), side: 'shopify', revision: 'shopify-v1', complete: true, assets: [...['a', 'b'].map(k => asset(k, 'shopify')), asset(mediaKey, 'shopify', content)] },
  };
  const proof = (a, side) => ({ evidenceId: a.evidenceId, key: a.key, side, contentId: a.contentId, proof: {
    platformRef: side === 'shopify' ? (a.key === mediaKey ? `gid://shopify/MediaImage/${mediaId}` : `gid://shopify/MediaImage/${a.key.charCodeAt(0)}`) : `angle:${a.key}`,
    url: side === 'shopify' ? `https://cdn.shopify.com/s/files/1/0001/${n}-${a.key.replace(':', '-')}.jpg` : `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/pics/${n}/${a.key}.jpg`,
    decodedSha256: a.contentId, mime: 'image/jpeg', width: 800, height: 900, byteLength: 1234, verifiedAt: new Date().toISOString(),
    ownership: side === 'shopify' ? 'reference_only' : 'owned_storage' } });
  const proofs = [...base.gallery.assets.map(a => proof(a, 'gallery')), ...base.shopify.assets.map(a => proof(a, 'shopify'))];
  const approval = randomUUID();
  await rpc(db, 'bootstrap_toptik_media', [identity.productId, owner, approval, base, proofs, { evidenceId: 'reviewed-' + n }]);
  await rpc(db, 'set_toptik_media_enabled', [identity.productId, owner, randomUUID(), true, approval]);
  // The later Gallery addition: a new angle row for the exact store bytes, registered under its own key.
  const galleryContent = angleContent ?? content, angleEvidence = 'g:' + sha('angle-' + n);
  await db.query('insert into toptik_media_private.asset_identities(product_gid,asset_key,origin_evidence_id) values($1,$2,$3)', [identity.productId, angleKey, 'g:' + sha('origin-' + n)]);
  await db.query('insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof) values($1,$2,$3,$4,$5,$6)',
    [angleEvidence, identity.productId, angleKey, 'gallery', galleryContent,
     JSON.stringify({ platformRef: `angle:${angleId}`, url: `https://cdn.shopify.com/s/files/1/0001/${n}-s-media-${mediaId}.jpg`, decodedSha256: galleryContent,
       mime: 'image/jpeg', width: 800, height: 900, byteLength: 1234, verifiedAt: new Date().toISOString(), ownership: 'reference_only' })]);
  const refs = [{ role: 'cover', angleId: null, key: 'a', evidenceId: `p${n}-gallery-a` },
    { role: 'angle', angleId: randomUUID(), key: 'a', evidenceId: `p${n}-gallery-a` },
    { role: 'angle', angleId: randomUUID(), key: 'b', evidenceId: `p${n}-gallery-b` },
    ...(withRef ? [{ role: 'angle', angleId, key: angleKey, evidenceId: angleEvidence }] : []),
    ...(mediaKeyInRefs ? [{ role: 'angle', angleId: randomUUID(), key: mediaKey, evidenceId: 'x' }] : [])];
  const snapshot = { identity: structuredClone(identity), side: 'gallery', complete: true, revision: 'rev-' + n,
    assets: [...base.gallery.assets, ...(withRef ? [{ key: angleKey, contentId: galleryContent, alt: 'תמונה 6', evidenceId: angleEvidence }] : [])] };
  await db.query('insert into toptik_media_private.gallery_observations(product_gid,revision,raw,refs,snapshot) values($1,$2,$3,$4,$5)',
    [identity.productId, 'rev-' + n, '{}', JSON.stringify(refs), JSON.stringify(snapshot)]);
  if (openOperation) {
    const current = structuredClone(base);
    current.gallery.assets[0].alt = 'טקסט אחר'; current.gallery.revision = 'gallery-v2';
    await rpc(db, 'reserve_toptik_media_operation', [identity.productId, owner, randomUUID(), 1, current, core.reconcileMedia(base, current)]);
  }
  const relink = (overrides = {}) => rpc(db, 'toptik_media_private.relink_gallery_angle_key', [
    identity.productId, overrides.owner ?? owner, overrides.relinkId ?? randomUUID(), overrides.mediaRef ?? `gid://shopify/MediaImage/${mediaId}`,
    overrides.angleKey ?? angleKey, overrides.mediaKey ?? mediaKey, overrides.contentId ?? content,
    overrides.approval ?? 'tal-chat-approval-20261008', overrides.evidenceSha ?? sha('evidence-' + n)]);
  return { db, core, identity, mediaId, angleId, content, mediaKey, angleKey, angleEvidence, relink, n };
}

test('relink rewrites the live identity map in place: refs and snapshot adopt the store key together', { skip }, async () => {
  const f = await rekeyedPair();
  const relinkId = randomUUID();
  const r = await f.relink({ relinkId });
  assert.deepEqual(r, { status: 'relinked', replayed: false, mediaRef: `gid://shopify/MediaImage/${f.mediaId}`, mediaKey: f.mediaKey, angleKey: f.angleKey, observedRevision: 'rev-' + f.n });
  const obs = await one(f.db, 'select refs,snapshot from toptik_media_private.gallery_observations where product_gid=$1 and revision=$2', [f.identity.productId, 'rev-' + f.n]);
  const angleRef = obs.refs.find(e => e.angleId === f.angleId);
  assert.equal(angleRef.key, f.mediaKey);
  assert.equal(angleRef.evidenceId, f.angleEvidence);
  assert.deepEqual(obs.refs.filter(e => e.key === f.angleKey), []);
  const moved = obs.snapshot.assets.find(a => a.key === f.mediaKey);
  assert.equal(moved.contentId, f.content);
  assert.equal(moved.evidenceId, f.angleEvidence);
  assert.deepEqual(obs.snapshot.assets.map(a => a.key), ['a', 'b', f.mediaKey]);
  // The journal keeps every stored row: provenance, identities and baselines are untouched.
  assert.equal(Number((await one(f.db, "select count(*) c from toptik_media_private.provenance where product_gid=$1 and asset_key=$2 and side='gallery'", [f.identity.productId, f.angleKey])).c), 1);
  assert.equal(Number((await one(f.db, 'select count(*) c from toptik_media_private.asset_identities where product_gid=$1 and asset_key=$2', [f.identity.productId, f.angleKey])).c), 1);
  const st = await one(f.db, 'select baselines from toptik_media_private.state where product_gid=$1', [f.identity.productId]);
  assert.deepEqual(st.baselines.shopify.assets.map(a => a.key), ['a', 'b', f.mediaKey]);
  assert.deepEqual(st.baselines.gallery.assets.map(a => a.key), ['a', 'b']);
  const ev = await one(f.db, 'select event_kind,operation_id,result from toptik_media_private.events where request_id=$1', [relinkId]);
  assert.equal(ev.event_kind, 'gallery_angle_rekeyed');
  assert.equal(ev.operation_id, null);
  const q = await one(f.db, 'select status,evidence from toptik_media_private.work_queue where product_gid=$1', [f.identity.productId]);
  assert.equal(q.status, 'pending');
  assert.equal(q.evidence.identityRelinked, relinkId);
});
test('after the relink the planner has nothing to write for the merged pair', { skip }, async () => {
  const f = await rekeyedPair();
  await f.relink();
  const st = await one(f.db, 'select baselines from toptik_media_private.state where product_gid=$1', [f.identity.productId]);
  const obs = await one(f.db, 'select snapshot from toptik_media_private.gallery_observations where product_gid=$1', [f.identity.productId]);
  const merged = st.baselines.shopify.assets.find(a => a.key === f.mediaKey);
  const current = structuredClone(st.baselines);
  current.gallery.assets = obs.snapshot.assets.map(a => a.key === f.mediaKey ? { ...a, alt: merged.alt } : a);
  const plan = f.core.reconcileMedia(st.baselines, current);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.patches, []);
  // Before the relink, the identical observation attached a second copy (held by #104 since 73f2b3d).
  const before = structuredClone(st.baselines);
  before.gallery.assets = obs.snapshot.assets.map(a => a.key === f.mediaKey ? { key: f.angleKey, contentId: f.content, alt: merged.alt, evidenceId: f.angleEvidence } : a);
  assert.deepEqual(f.core.reconcileMedia(st.baselines, before).conflicts.map(c => c.code), ['MEDIA_ATTACH_TARGET_HAS_SAME_CONTENT']);
});
test('an identical replay returns the stored result and writes nothing new', { skip }, async () => {
  const f = await rekeyedPair();
  const relinkId = randomUUID(), evidenceSha = sha('evidence-' + f.n);
  await f.relink({ relinkId, evidenceSha });
  const again = await f.relink({ relinkId, evidenceSha });
  assert.equal(again.replayed, true);
  assert.equal(again.mediaKey, f.mediaKey);
  assert.equal(Number((await one(f.db, 'select count(*) c from toptik_media_private.media_identity_relinks where product_gid=$1', [f.identity.productId])).c), 1);
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
test('the live identity map must carry the angle key once and must not already carry the store key', { skip }, async () => {
  const noRef = await rekeyedPair({ withRef: false });
  await assert.rejects(noRef.relink(), /MEDIA_RELINK_GALLERY_REFS_MISMATCH/);
  const adopted = await rekeyedPair({ mediaKeyInRefs: true });
  await assert.rejects(adopted.relink(), /MEDIA_RELINK_GALLERY_REFS_MISMATCH/);
});
test('a second gallery lineage for the store key, or a baseline already carrying either key, is refused', { skip }, async () => {
  const f = await rekeyedPair();
  await f.db.query('insert into toptik_media_private.asset_identities(product_gid,asset_key,origin_evidence_id) values($1,$2,$3) on conflict do nothing', [f.identity.productId, f.mediaKey, 'seed']);
  await f.db.query('insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof) values($1,$2,$3,$4,$5,$6)',
    ['g:' + sha('rogue-' + f.n), f.identity.productId, f.mediaKey, 'gallery', f.content, JSON.stringify({ platformRef: 'angle:rogue', url: 'https://cdn.shopify.com/s/files/1/0001/rogue.jpg' })]);
  await assert.rejects(f.relink(), /MEDIA_RELINK_TARGET_KEY_AMBIGUOUS/);
  const g = await rekeyedPair();
  await g.db.query(`update toptik_media_private.state set baselines=jsonb_set(baselines,'{gallery,assets}',baselines->'gallery'->'assets'||jsonb_build_array(jsonb_build_object('key',$2::text,'contentId',$3::text,'alt','x','evidenceId','e'))) where product_gid=$1`, [g.identity.productId, g.angleKey, g.content]);
  await assert.rejects(g.relink(), /MEDIA_RELINK_BASELINE_MISMATCH/);
});
test('the derived key must spell the exact media id, and a foreign lease holder is refused', { skip }, async () => {
  const f = await rekeyedPair();
  await assert.rejects(f.relink({ mediaKey: 's-media:1' }), /MEDIA_RELINK_INVALID/);
  await assert.rejects(f.relink({ owner: randomUUID() }), /LEASE|ACCESS|OWNER/i);
});
