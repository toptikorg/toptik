// Offline fixture with real journal/transport/register functions. No network or native writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { resolveImageLimits } from './existing-media-limits.mjs';

const repo = new URL('../../', import.meta.url);
const migration = name => readFile(new URL('supabase/migrations/' + name, repo), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const origin = 'https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/';
let serial = 9400;

export async function createVerifiedImportDatabase() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create table public.shopify_gallery_copy_eligibility(product_gid text primary key,catalog_key text,carousel_item_id uuid,variant_gid text,exact_gallery_sku text,exact_shopify_sku text,approved_product_handle text,enabled boolean);
create table public.shopify_gallery_reconciliation_leases(product_gid text primary key,owner uuid,expires_at timestamptz);
create table public.shopify_webhook_events(id uuid,topic text,shop_domain text,payload jsonb,delivery_id text);
create function public.assert_shopify_verified_copy_identity(p_item uuid,p_key text,p_gsku text,p_product text,p_variant text,p_ssku text) returns void language plpgsql as $$begin
 if not exists(select 1 from public.shopify_gallery_copy_eligibility where product_gid=p_product and catalog_key=p_key and carousel_item_id=p_item and exact_gallery_sku=p_gsku and variant_gid=p_variant and exact_shopify_sku=p_ssku and enabled) then raise exception 'COPY_IDENTITY_CHANGED';end if;end$$;`);
  for (const name of ['20260930_media_sync_journal.sql', '20260930_media_transport_substeps.sql',
    '20260930_media_transport_runtime.sql', '20261001_existing_media_25mp.sql', '20261007_media_final_readback.sql',
    '20261110092500_verified_native_import_provenance.sql']) await db.exec(await migration(name));
  const source = resolveImageLimits(await readFile(new URL('src/lib/shopify/media-sync-core.ts', repo), 'utf8'));
  const core = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
  const rpc = async (name, args) => (await db.query(`select ${name.includes('.') ? name : 'public.' + name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`,
    args.map(a => a && typeof a === 'object' ? JSON.stringify(a) : a))).rows[0].result;
  return { db, core, rpc };
}

/** Real attach or ALT clone through verified association/detachment, before register and final reorder. */
export async function seedVerifiedImportOperation(f, options = {}) {
  const { db, core, rpc } = f, n = serial++, owner = randomUUID(), op = randomUUID();
  const kind = options.kind ?? 'attach';
  assert.ok(['attach', 'alt'].includes(kind));
  const identity = { productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, itemId: randomUUID(),
    exactGallerySku: 'SKU-' + n, exactShopifySku: 'SKU' + n, productHandle: 'fixture-' + n };
  const product = identity.productId;
  await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)',
    [product, 'SKU' + n, identity.itemId, identity.variantId, identity.exactGallerySku, identity.exactShopifySku, identity.productHandle]);
  await db.query("insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval '5 minutes')", [product, owner]);
  const extension = mime => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' })[mime];
  const asset = (key, side) => ({ key, contentId: options.baseMetadata?.[key]?.sha256 ?? (kind === 'alt' && key === 'a' && options.sourceContentId ? options.sourceContentId : sha(key + n)),
    alt: 'Photo ' + key, evidenceId: `p${n}-${side}-${key}` });
  const base = Object.fromEntries(['gallery', 'shopify'].map(side => [side, { identity: structuredClone(identity), side, revision: side + '-v1', complete: true,
    assets: ['a', 'b'].map(key => asset(key, side)) }]));
  const makeProof = (a, side) => {
    const metadata = options.baseMetadata?.[a.key], mime = metadata?.mime ?? 'image/png', ext = extension(mime);
    return { evidenceId: a.evidenceId, key: a.key, side, contentId: a.contentId, proof: {
      platformRef: side === 'shopify' ? `gid://shopify/MediaImage/${n * 10 + a.key.charCodeAt(0)}` : `items/${identity.itemId}/${a.key}.${ext}`,
      url: side === 'shopify' ? `https://cdn.shopify.com/s/files/1/0001/${n}-${a.key}.${ext}` : `${origin}items/${identity.itemId}/${a.key}.${ext}`,
      decodedSha256: metadata?.sha256 ?? a.contentId, mime, width: metadata?.width ?? 800, height: metadata?.height ?? 900, byteLength: metadata?.byteLength ?? 1234,
      verifiedAt: new Date().toISOString(), ownership: side === 'shopify' ? 'reference_only' : 'owned_storage' } };
  };
  const approval = randomUUID();
  const bootstrapProofs = Object.values(base).flatMap(s => s.assets.map(a => makeProof(a, s.side)));
  await rpc('bootstrap_toptik_media', [product, owner, approval, base, bootstrapProofs, { evidenceId: 'reviewed-' + n }]);
  await rpc('set_toptik_media_enabled', [product, owner, randomUUID(), true, approval]);
  const stamp = async r => { r.revision = (await db.query('select toptik_media_private.raw_transport_fingerprint($1::jsonb) v', [JSON.stringify(r)])).rows[0].v; return r; };
  let raw = await stamp({ side: 'shopify', identity: structuredClone(identity), complete: true, revision: '', updatedAt: '2026-11-10T06:00:00Z',
    media: base.shopify.assets.map(a => { const p = makeProof(a, 'shopify').proof; return { mediaId: p.platformRef, mediaContentType: 'IMAGE', status: 'READY', fileStatus: 'READY',
      updatedAt: '2026-11-10T06:00:00Z', alt: a.alt, image: { id: `gid://shopify/ImageSource/${n * 10 + a.key.charCodeAt(0)}`, url: p.url, width: p.width, height: p.height } }; }),
    variantMediaIds: [], variantImage: null });
  const current = structuredClone(base);
  current.shopify.revision = (await db.query('select toptik_media_private.ready_transport_fingerprint($1::jsonb) v', [JSON.stringify(raw)])).rows[0].v;
  const added = kind === 'alt' ? current.gallery.assets[0] : asset('c', 'gallery');
  const parent = kind === 'alt' ? structuredClone(bootstrapProofs.find(p => p.side === 'shopify' && p.key === added.key)) : makeProof(added, 'gallery');
  if (kind === 'alt') {
    added.alt = 'Reviewed new ALT for existing photo'; current.gallery.revision = sha('gallery-alt-edit-' + n);
  } else {
    if (options.sourceContentId) { added.contentId = options.sourceContentId; parent.contentId = added.contentId; parent.proof.decodedSha256 = added.contentId; }
    current.gallery.assets.push(added); current.gallery.revision = sha('gallery-new-angle-' + n);
    await rpc('register_toptik_media_provenance', [product, owner, [parent]]);
  }
  await rpc('reserve_toptik_media_operation', [product, owner, op, 1, current, core.reconcileMedia(base, current)]);
  await rpc('begin_toptik_media_step', [product, owner, op, 0, randomUUID(), current]);
  const guard = target => ({ sourceFingerprint: core.mediaSnapshotFingerprint(current.gallery), target: structuredClone(target), observedAt: new Date().toISOString() });
  const phases = kind === 'alt' ? ['stage_source', 'create_owned', 'associate', 'detach_old', 'reorder'] : ['stage_source', 'create_owned', 'associate', 'reorder'];
  assert.equal((await rpc('prepare_toptik_media_transport', [product, owner, op, 0, randomUUID(), phases, guard(raw)])).status, 'ready');
  const begin = (phase, request, target = raw) => rpc('begin_toptik_media_transport', [product, owner, op, 0, phase, randomUUID(), request, guard(target)]);
  const accept = (phase, hash, target = raw, artifact = null) => rpc('accept_toptik_media_transport', [product, owner, op, 0, phase, randomUUID(), guard(target),
    { requestHash: hash, readbackSha256: target.revision, artifact }]);
  const contentId = added.contentId, sourceExt = extension(parent.proof.mime), sourceSha = parent.proof.decodedSha256;
  const storagePath = `sync-media/${identity.itemId}/${sourceSha}.${sourceExt}`;
  const staged = { contentId, decodedSha256: sourceSha, ready: true, url: origin + storagePath,
    width: parent.proof.width, height: parent.proof.height, byteLength: parent.proof.byteLength, mime: parent.proof.mime, storagePath };
  const stage = await begin(0, { mutationSha256: sha('stage'), sourceEvidenceId: parent.evidenceId, storagePath, upsert: false });
  assert.equal((await accept(0, stage.requestHash, raw, staged)).status, 'verified');
  const filename = `toptik-sync-${op.replaceAll('-', '')}-0-${sourceSha.slice(0, 16)}.${sourceExt}`;
  const create = await begin(1, { mutationSha256: sha('create'), sourceEvidenceId: parent.evidenceId, filename, duplicateResolutionMode: 'RAISE_ERROR', stagedSourceUrl: staged.url });
  const native = options.nativeMetadata, nativeMime = native?.mime ?? 'image/png';
  const artifact = { contentId, decodedSha256: native?.sha256 ?? (options.equalBytes ? contentId : options.decodedSha256 ?? sha('native-' + n)), ready: true,
    url: `https://cdn.shopify.com/s/files/1/0001/${n}-native.${extension(nativeMime)}`,
    width: native?.width ?? 800, height: native?.height ?? 900, byteLength: native?.byteLength ?? 1234, mime: nativeMime,
    mediaGid: `gid://shopify/MediaImage/${n * 10 + 900}`, filename };
  assert.equal((await accept(1, create.requestHash, raw, artifact)).status, 'verified');
  const associate = await begin(2, { mutationSha256: sha('associate'), mediaGid: artifact.mediaGid, productGid: product });
  raw = await stamp({ ...raw, media: [...raw.media, { mediaId: artifact.mediaGid, mediaContentType: 'IMAGE', status: 'READY', fileStatus: 'READY', updatedAt: raw.updatedAt,
    alt: added.alt, image: { id: `gid://shopify/ImageSource/${n * 10 + 900}`, url: artifact.url, width: artifact.width, height: artifact.height } }] });
  assert.equal((await accept(2, associate.requestHash, raw)).status, 'verified');
  if (kind === 'alt') {
    const detach = await begin(3, { mutationSha256: sha('detach'), mediaGid: parent.proof.platformRef, productGid: product });
    raw = await stamp({ ...raw, media: raw.media.filter(m => m.mediaId !== parent.proof.platformRef) });
    assert.equal((await accept(3, detach.requestHash, raw)).status, 'verified');
  }
  const nativeEntry = { evidenceId: `p${n}-native-${added.key}`, key: added.key, side: 'shopify', contentId, proof: {
    platformRef: artifact.mediaGid, url: artifact.url, decodedSha256: artifact.decodedSha256, mime: artifact.mime,
    width: artifact.width, height: artifact.height, byteLength: artifact.byteLength, verifiedAt: new Date().toISOString(), ownership: 'reference_only',
    sourceEvidenceId: parent.evidenceId, operationId: op } };
  const expected = (await db.query('select expected_pair from toptik_media_private.steps where operation_id=$1 and step_index=0', [op])).rows[0].expected_pair;
  return { ...f, kind, phases, reorderPhaseIndex: phases.length - 1, identity, product, p: product, owner, op, current, base, expected, raw, artifact, parent, added, nativeEntry, guard, stamp, begin, accept,
    register: entries => rpc('register_toptik_media_provenance', [product, owner, entries ?? [nativeEntry]]) };
}
