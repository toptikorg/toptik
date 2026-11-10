// Local PGlite only. Loads real ordinary journal, gallery, queue and retirement RPCs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createVerifiedImportDatabase } from './verified-native-import-sql-fixture.mjs';

const root = new URL('../../', import.meta.url);
const migration = name => readFile(new URL('supabase/migrations/' + name, root), 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const storage = 'https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/';
let serial = 9800;

export async function createRestoredRetirementDatabase() {
  const f = await createVerifiedImportDatabase();
  await f.db.exec(`create table public.carousel_items(id uuid primary key,title text,cover_image_path text,is_active boolean not null default true,catalog_number text);
create table public.carousel_item_angles(id uuid primary key,item_id uuid not null references public.carousel_items(id),angle_key text,image_path text,angle_order int);`);
  for (const name of ['20260930_gallery_media_cas.sql', '20261001_media_planning_runtime.sql', '20261007_media_queue_distinct.sql', '20261008_media_queue_priority.sql',
    '20261110084942_ordinary_restored_retirement.sql']) await f.db.exec(await migration(name));
  return f;
}

/** The saved live shape: logical step started, chain ready, zero transport work; live sides restored. */
export async function seedRestoredRetirement(f, options = {}) {
  const { db, core, rpc } = f, n = serial++, owner = randomUUID(), op = randomUUID(), actor = randomUUID(), request = randomUUID();
  const identity = { productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, itemId: randomUUID(),
    exactGallerySku: 'KF-' + n, exactShopifySku: 'KF' + n, productHandle: 'retirement-' + n }, product = identity.productId;
  const angleId = randomUUID(), addedAngleId = randomUUID();
  const asset = (key, side) => ({ key, contentId: sha(n + '-' + key), alt: 'Photo ' + key, evidenceId: `retire-${n}-${side}-${key}` });
  const proof = (a, side) => ({ evidenceId: a.evidenceId, key: a.key, side, contentId: a.contentId, proof: {
    platformRef: side === 'gallery' ? `items/${identity.itemId}/${a.key}.png` : `gid://shopify/MediaImage/${n * 10 + a.key.charCodeAt(0)}`,
    url: side === 'gallery' ? `${storage}items/${identity.itemId}/${a.key}.png` : `https://cdn.shopify.com/s/files/1/0001/${n}-${a.key}.png`,
    decodedSha256: a.contentId, mime: 'image/png', width: 800, height: 900, byteLength: 1234,
    verifiedAt: new Date().toISOString(), ownership: side === 'gallery' ? 'owned_storage' : 'reference_only' } });
  const base = Object.fromEntries(['gallery', 'shopify'].map(side => [side, { identity: structuredClone(identity), side, complete: true, revision: sha(side + '-base-' + n), assets: ['a', 'b'].map(k => asset(k, side)) }]));
  // Pin the actual fake-provider READY native revision before bootstrap/reservation.
  const native = { side: 'shopify', identity, complete: true, updatedAt: '2026-11-10T06:00:00Z', revision: '',
      media: base.shopify.assets.map(a => ({ mediaId: proof(a, 'shopify').proof.platformRef, mediaContentType: 'IMAGE', status: 'READY', fileStatus: 'READY', alt: a.alt,
        updatedAt: '2026-11-10T06:00:00Z', image: { id: `gid://shopify/ImageSource/${n * 10 + a.key.charCodeAt(0)}`, url: proof(a, 'shopify').proof.url, width: 800, height: 900 } })),
      variantMediaIds: [], variantImage: null };
  native.revision = (await db.query('select toptik_media_private.raw_transport_fingerprint($1::jsonb) v', [JSON.stringify(native)])).rows[0].v;
  const readyRevision = (await db.query('select toptik_media_private.ready_transport_fingerprint($1::jsonb) v', [JSON.stringify(native)])).rows[0].v;
  base.shopify.revision = readyRevision;
  await db.query('insert into carousel_items(id,title,cover_image_path,catalog_number,cover_image_alt) values($1,$2,$3,$4,$5)',
    [identity.itemId, 'Product', proof(base.gallery.assets[0], 'gallery').proof.url, identity.exactGallerySku, base.gallery.assets[0].alt]);
  await db.query('insert into carousel_item_angles(id,item_id,angle_key,image_path,angle_order,image_alt)values($1,$2,$3,$4,1,$5)',
    [angleId, identity.itemId, 'b', proof(base.gallery.assets[1], 'gallery').proof.url, base.gallery.assets[1].alt]);
  await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)',
    [product, identity.exactShopifySku, identity.itemId, identity.variantId, identity.exactGallerySku, identity.exactShopifySku, identity.productHandle]);
  await db.query("insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval '10 minutes')", [product, owner]);
  let raw = await rpc('read_toptik_gallery_media', [product, owner]);
  base.gallery.revision = raw.revision;
  const baselineRefs = [{ role: 'cover', angleId: null, key: 'a', evidenceId: base.gallery.assets[0].evidenceId },
    { role: 'angle', angleId, key: 'b', evidenceId: base.gallery.assets[1].evidenceId }];
  const approval = randomUUID();
  await rpc('bootstrap_toptik_media', [product, owner, approval, base, Object.values(base).flatMap(s => s.assets.map(a => proof(a, s.side))), { evidenceId: 'approved-retirement-' + n }]);
  await rpc('set_toptik_media_enabled', [product, owner, randomUUID(), true, approval]);
  await rpc('observe_toptik_gallery_media', [product, owner, raw.revision, baselineRefs]);
  await db.query('update toptik_media_private.state set version=15 where product_gid=$1', [product]);
  const added = asset('c', 'gallery');
  await rpc('register_toptik_media_provenance', [product, owner, [proof(added, 'gallery')]]);
  await db.query('insert into carousel_item_angles(id,item_id,angle_key,image_path,angle_order,image_alt)values($1,$2,$3,$4,2,$5)',
    [addedAngleId, identity.itemId, 'c', proof(added, 'gallery').proof.url, added.alt]);
  raw = await rpc('read_toptik_gallery_media', [product, owner]);
  const old = await rpc('observe_toptik_gallery_media', [product, owner, raw.revision,
    [...baselineRefs, { role: 'angle', angleId: addedAngleId, key: 'c', evidenceId: added.evidenceId }]]);
  const observed = { gallery: old.snapshot, shopify: structuredClone(base.shopify) };
  await rpc('reserve_toptik_media_operation', [product, owner, op, 15, observed, core.reconcileMedia(base, observed)]);
  if (!options.reserved) {
    await rpc('begin_toptik_media_step', [product, owner, op, 0, randomUUID(), observed]);
    const guard = { sourceFingerprint: core.mediaSnapshotFingerprint(observed.gallery), target: native, observedAt: new Date().toISOString() };
    assert.equal((await rpc('prepare_toptik_media_transport', [product, owner, op, 0, randomUUID(), ['stage_source', 'create_owned', 'associate', 'reorder'], guard])).status, 'ready');
  }
  // Actual catalog restoration, not a journal/baseline reset.
  await db.query('delete from carousel_item_angles where id=$1', [addedAngleId]);
  raw = await rpc('read_toptik_gallery_media', [product, owner]);
  const restored = await rpc('observe_toptik_gallery_media', [product, owner, raw.revision, baselineRefs]);
  const currentPair = { gallery: restored.snapshot, shopify: { ...structuredClone(base.shopify), revision: sha('fresh-native-' + n) } };
  const context = id => rpc('read_toptik_media_retirement_context', [product, owner, op, id ?? request]);
  const args = async (overrides = {}) => {
    const c = await context(overrides.requestId ?? request);
    const v = { productId: product, owner, operationId: op, requestId: request, actorId: actor, authMethod: 'session_admin', approval: 'RESTORED_BEFORE_TRANSPORT',
      expectedStateVersion: c.planningContext.stateVersion, expectedOperationVersion: c.operation.version, expectedOperationHash: c.operation.request_hash,
      queueFence: c.queueFence, currentPair, galleryRaw: raw, galleryRefs: baselineRefs, observedAt: new Date().toISOString(), ...overrides };
    return [v.productId, v.owner, v.operationId, v.requestId, v.actorId, v.authMethod, v.approval, v.expectedStateVersion, v.expectedOperationVersion,
      v.expectedOperationHash, v.queueFence, v.currentPair, v.galleryRaw, v.galleryRefs, v.observedAt];
  };
  return { ...f, identity, product, owner, op, actor, request, base, observed, currentPair, raw, refs: baselineRefs, args, context,
    retire: argv => rpc('retire_restored_toptik_media_operation', argv) };
}
