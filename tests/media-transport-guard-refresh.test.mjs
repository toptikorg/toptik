// Shopify bumps product.updatedAt asynchronously after a media association. The
// pre-attempt guard refresh tolerates ONLY that timestamp and its derived revision.
// Real-migration integration runs on an offline PGlite engine when present
// (TOPTIK_PGLITE_DIR or the sibling sync-sql-validation package); no network.
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
const sql = migration('20261007_media_transport_guard_refresh.sql');

test('refresh is lease scoped, service only, Shopify only and never a permit', () => {
  assert.match(sql, /create or replace function public\.refresh_toptik_media_transport_guard\(/);
  assert.match(sql, /security definer set search_path=pg_catalog,pg_temp/);
  assert.match(sql, /i:=toptik_media_private\.assert_access\(p_product_gid,p_lease_owner\)/);
  assert.match(sql, /perform toptik_media_private\.assert_transport_guard\(p_fresh_guard,i,'shopify'\)/);
  assert.match(sql, /s\.body->>'target' is distinct from 'shopify' then raise exception 'MEDIA_TRANSPORT_GUARD_REFRESH_UNSUPPORTED'/);
  assert.match(sql, /revoke all on function public\.refresh_toptik_media_transport_guard\(text,uuid,uuid,int,int,uuid,jsonb\) from public,anon,authenticated,service_role/);
  assert.match(sql, /grant execute on function public\.refresh_toptik_media_transport_guard\(text,uuid,uuid,int,int,uuid,jsonb\) to service_role/);
  assert.match(sql, /e\.event_kind<>'transport_guard_refreshed' or e\.request_hash<>h or e\.product_gid<>p_product_gid/);
  assert.doesNotMatch(sql, /'mayExecute',true/);
});
test('refresh changes only the chain guard; only updatedAt and revision may drift', () => {
  const writes = [...sql.matchAll(/\b(update|insert into|delete from)\s+([a-z_.]+)/gi)].map(m => `${m[1].toLowerCase()} ${m[2]}`);
  assert.deepEqual(writes, ['update toptik_media_private.transport_chains', 'insert into toptik_media_private.events']);
  assert.match(sql, /update toptik_media_private\.transport_chains set current_guard=p_fresh_guard where operation_id=o\.id and step_index=p_step_index;/);
  assert.match(sql, /p_fresh_guard->>'sourceFingerprint' is distinct from c\.current_guard->>'sourceFingerprint'/);
  assert.match(sql, /\(\(p_fresh_guard->'target'\)-'updatedAt'-'revision'\) is distinct from \(\(c\.current_guard->'target'\)-'updatedAt'-'revision'\)/);
  assert.match(sql, /transport_attempts a where a\.operation_id=o\.id and a\.step_index=p_step_index and a\.phase_index=p_phase_index/);
  assert.match(sql, /\(p_fresh_guard#>>'\{target,updatedAt\}'\)::timestamptz<\(c\.current_guard#>>'\{target,updatedAt\}'\)::timestamptz/);
  assert.match(sql, /c\.status not in \('ready','running'\) or c\.next_phase<>p_phase_index/);
  // begin keeps the strict whole-guard comparison; this migration does not replace it.
  assert.doesNotMatch(sql, /function public\.begin_toptik_media_transport/);
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
    // Real forward chain for every function this path executes; the new file twice (idempotent).
    for (const name of ['20260930_media_sync_journal.sql', '20260930_media_transport_substeps.sql', '20260930_media_transport_runtime.sql',
      '20261001_existing_media_25mp.sql', '20261007_media_final_readback.sql', '20261007_media_transport_not_sent_precondition.sql',
      '20261007_media_transport_guard_refresh.sql', '20261007_media_transport_guard_refresh.sql']) await db.exec(migration(name));
    return { db, core };
  })();
  return ready;
}
const owner = randomUUID();
let serial = 500;
async function rpc(db, name, args) {
  const result = await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`, args.map(a => a && typeof a === 'object' ? JSON.stringify(a) : a));
  return result.rows[0].result;
}
const one = async (db, text, args = []) => (await db.query(text, args)).rows[0];
const sha = value => createHash('sha256').update(value).digest('hex');

/** Real chain: stage_source -> create_owned -> associate verified, next phase detach_old. */
async function associated() {
  const { db, core } = await database();
  const n = serial++, identity = { productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, itemId: randomUUID(),
    exactGallerySku: 'SKU-' + n, exactShopifySku: 'SKU' + n, productHandle: 'מוצר-' + n };
  await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)', [identity.productId, 'SKU' + n, identity.itemId, identity.variantId, identity.exactGallerySku, identity.exactShopifySku, identity.productHandle]);
  await db.query("insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval '5 minutes')", [identity.productId, owner]);
  const asset = (key, side) => ({ key, contentId: sha(key), alt: 'תמונה ' + key, evidenceId: `p${n}-${side}-${key}` });
  const base = Object.fromEntries(['gallery', 'shopify'].map(side => [side, { identity: structuredClone(identity), side, revision: side + '-v1', complete: true, assets: ['a', 'b'].map(k => asset(k, side)) }]));
  const proofs = Object.values(base).flatMap(s => s.assets.map(a => ({ evidenceId: a.evidenceId, key: a.key, side: s.side, contentId: a.contentId, proof: {
    platformRef: s.side === 'shopify' ? `gid://shopify/MediaImage/${a.key.charCodeAt(0)}` : `owned/${a.key}.png`,
    url: s.side === 'shopify' ? `https://cdn.shopify.com/s/files/1/0001/${a.key}.png` : `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/${a.key}.png`,
    decodedSha256: a.contentId, mime: 'image/png', width: 800, height: 900, byteLength: 1234, verifiedAt: new Date().toISOString(), ownership: s.side === 'shopify' ? 'reference_only' : 'owned_storage' } })));
  const approval = randomUUID();
  await rpc(db, 'bootstrap_toptik_media', [identity.productId, owner, approval, base, proofs, { evidenceId: 'reviewed-' + n }]);
  await rpc(db, 'set_toptik_media_enabled', [identity.productId, owner, randomUUID(), true, approval]);
  const stamp = async raw => { raw.revision = (await one(db, 'select toptik_media_private.raw_transport_fingerprint($1::jsonb) v', [JSON.stringify(raw)])).v; return raw; };
  const media = base.shopify.assets.map(a => ({ mediaId: `gid://shopify/MediaImage/${a.key.charCodeAt(0)}`, mediaContentType: 'IMAGE', status: 'READY', fileStatus: 'READY',
    updatedAt: '2026-10-07T10:00:00Z', alt: a.alt, image: { id: `gid://shopify/ImageSource/${a.key.charCodeAt(0) + 1000}`, url: `https://cdn.shopify.com/s/files/1/0001/${a.key}.png`, width: 800, height: 900 } }));
  const raw = await stamp({ side: 'shopify', identity: structuredClone(identity), complete: true, revision: '', updatedAt: '2026-10-07T10:00:00Z', media, variantMediaIds: [], variantImage: null });
  const current = structuredClone(base);
  current.shopify.revision = (await one(db, 'select toptik_media_private.ready_transport_fingerprint($1::jsonb) v', [JSON.stringify(raw)])).v;
  current.gallery.assets[0].alt = 'טקסט חלופי מעודכן'; current.gallery.revision = 'gallery-edit';
  const op = randomUUID();
  await rpc(db, 'reserve_toptik_media_operation', [identity.productId, owner, op, 1, current, core.reconcileMedia(base, current)]);
  await rpc(db, 'begin_toptik_media_step', [identity.productId, owner, op, 0, randomUUID(), current]);
  const guard = target => ({ sourceFingerprint: core.mediaSnapshotFingerprint(current.gallery), target: structuredClone(target), observedAt: new Date().toISOString() });
  const p = identity.productId;
  assert.equal((await rpc(db, 'prepare_toptik_media_transport', [p, owner, op, 0, randomUUID(), ['stage_source', 'create_owned', 'associate', 'detach_old', 'reorder'], guard(raw)])).status, 'ready');
  const begin = (phase, request, g) => rpc(db, 'begin_toptik_media_transport', [p, owner, op, 0, phase, randomUUID(), request, g]);
  const accept = (phase, requestHash, g, artifact = null) => rpc(db, 'accept_toptik_media_transport', [p, owner, op, 0, phase, randomUUID(), g, { requestHash, readbackSha256: g.target.revision, artifact }]);
  const contentId = current.shopify.assets[0].contentId, sourceEvidenceId = current.shopify.assets[0].evidenceId, storagePath = `sync-media/${identity.itemId}/${contentId}.png`;
  const stage = await begin(0, { mutationSha256: '9'.repeat(64), sourceEvidenceId, storagePath, upsert: false }, guard(raw)); assert.equal(stage.mayExecute, true);
  const staged = { contentId, decodedSha256: contentId, ready: true, url: 'https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/' + storagePath,
    width: 800, height: 900, byteLength: 1234, mime: 'image/png', storagePath };
  assert.equal((await accept(0, stage.requestHash, guard(raw), staged)).status, 'verified');
  const filename = `toptik-sync-${op.replaceAll('-', '')}-0-${contentId.slice(0, 16)}.png`;
  const create = await begin(1, { mutationSha256: 'a'.repeat(64), sourceEvidenceId, filename, duplicateResolutionMode: 'RAISE_ERROR', stagedSourceUrl: staged.url }, guard(raw));
  assert.equal(create.mayExecute, true);
  const owned = { contentId, decodedSha256: 'e'.repeat(64), ready: true, url: 'https://cdn.shopify.com/s/files/1/0001/cloned-alt.png', width: 800, height: 900,
    byteLength: 1234, mime: 'image/png', mediaGid: 'gid://shopify/MediaImage/777777', filename };
  assert.equal((await accept(1, create.requestHash, guard(raw), owned)).status, 'verified');
  const associate = await begin(2, { mutationSha256: 'b'.repeat(64), mediaGid: owned.mediaGid, productGid: p }, guard(raw)); assert.equal(associate.mayExecute, true);
  const withBoth = structuredClone(raw);
  withBoth.media.push({ mediaId: owned.mediaGid, mediaContentType: 'IMAGE', status: 'READY', fileStatus: 'READY', updatedAt: '2026-10-07T10:01:00Z',
    alt: current.gallery.assets[0].alt, image: { id: 'gid://shopify/ImageSource/888888', url: owned.url, width: 800, height: 900 } });
  withBoth.updatedAt = '2026-10-07T10:01:00Z'; await stamp(withBoth);
  assert.equal((await accept(2, associate.requestHash, guard(withBoth))).status, 'verified');
  // Shopify's asynchronous product timestamp bump a few seconds after the association.
  const bumped = structuredClone(withBoth); bumped.updatedAt = '2026-10-07T10:01:06Z'; await stamp(bumped);
  assert.notEqual(bumped.revision, withBoth.revision);
  const detach = { mutationSha256: 'c'.repeat(64), productGid: p, mediaGid: 'gid://shopify/MediaImage/97' };
  const chain = async () => one(db, 'select c.status,c.next_phase,c.current_guard,o.status op_status from toptik_media_private.transport_chains c join toptik_media_private.operations o on o.id=c.operation_id where c.operation_id=$1 and c.step_index=0', [op]);
  const refresh = (g, phase = 3, requestId = randomUUID(), actor = owner) => rpc(db, 'refresh_toptik_media_transport_guard', [p, actor, op, 0, phase, requestId, g]);
  return { db, p, op, raw, withBoth, bumped, guard, stamp, begin, detach, chain, refresh };
}

test('without a refresh, product timestamp drift alone still conflicts at begin (the production fault)', { skip }, async () => {
  const x = await associated();
  assert.deepEqual(await x.begin(3, x.detach, x.guard(x.bumped)), { status: 'conflict', mayExecute: false });
  const c = await x.chain(); assert.equal(c.status, 'conflict'); assert.equal(c.op_status, 'conflict');
});

test('updatedAt+revision-only drift refreshes the chain guard idempotently and begin then permits', { skip }, async () => {
  const x = await associated(), before = await x.chain(), fresh = x.guard(x.bumped), requestId = randomUUID();
  assert.equal(before.current_guard.target.revision, x.withBoth.revision);
  const first = await x.refresh(fresh, 3, requestId);
  assert.deepEqual(first, { status: 'refreshed', refreshed: true, mayExecute: false, nextPhase: 3 });
  const after = await x.chain();
  assert.deepEqual(after.current_guard, fresh); assert.equal(after.status, 'running'); assert.equal(after.next_phase, 3); assert.equal(after.op_status, 'running');
  const events = async () => (await x.db.query(`select request_id,evidence from toptik_media_private.events where operation_id=$1 and event_kind='transport_guard_refreshed'`, [x.op])).rows;
  const recorded = await events(); assert.equal(recorded.length, 1); assert.equal(recorded[0].request_id, requestId);
  assert.equal(recorded[0].evidence.previousUpdatedAt, '2026-10-07T10:01:00Z'); assert.equal(recorded[0].evidence.freshUpdatedAt, '2026-10-07T10:01:06Z');
  assert.deepEqual(await x.refresh(fresh, 3, requestId), first, 'replay returns the stored result');
  assert.equal((await events()).length, 1);
  await assert.rejects(x.refresh(x.guard(x.bumped), 3, requestId), /MEDIA_REQUEST_REUSED/);
  assert.deepEqual(await x.refresh(x.guard(x.bumped)), { status: 'unchanged', refreshed: false, mayExecute: false });
  const permit = await x.begin(3, x.detach, x.guard(x.bumped));
  assert.equal(permit.mayExecute, true); assert.equal(permit.phase, 'detach_old');
  // The consumed attempt freezes its before_guard: a later refresh never touches it.
  const later = structuredClone(x.bumped); later.updatedAt = '2026-10-07T10:01:30Z'; await x.stamp(later);
  assert.deepEqual(await x.refresh(x.guard(later)), { status: 'attempt_exists', refreshed: false, mayExecute: false });
  assert.equal((await x.chain()).current_guard.target.updatedAt, '2026-10-07T10:01:06Z');
  assert.equal((await one(x.db, 'select before_guard from toptik_media_private.transport_attempts where operation_id=$1 and phase_index=3', [x.op])).before_guard.target.updatedAt, '2026-10-07T10:01:06Z');
});

test('any other target or source difference is refused without writing anything', { skip }, async () => {
  const x = await associated(), before = await x.chain();
  const edits = [
    ['media alt', r => { r.media[1].alt = 'merchant edit'; }],
    ['media updatedAt', r => { r.media[1].updatedAt = '2026-10-07T10:01:05Z'; }],
    ['media status', r => { r.media[2].status = 'PROCESSING'; }],
    ['media image', r => { r.media[0].image.width = 801; }],
    ['media order', r => { r.media.reverse(); }],
    ['media removed', r => { r.media.splice(0, 1); }],
    ['variant media', r => { r.variantMediaIds = [r.media[1].mediaId]; r.variantImage = { id: 'gid://shopify/ProductImage/1', url: r.media[1].image.url }; }],
  ];
  for (const [name, edit] of edits) {
    const changed = structuredClone(x.bumped); edit(changed); await x.stamp(changed);
    await assert.rejects(x.refresh(x.guard(changed)), /MEDIA_TRANSPORT_GUARD_REFRESH_MISMATCH/, name);
  }
  await assert.rejects(x.refresh({ ...x.guard(x.bumped), sourceFingerprint: 'f'.repeat(64) }), /MEDIA_TRANSPORT_GUARD_REFRESH_MISMATCH/);
  // The product timestamp may only move forward.
  const older = structuredClone(x.withBoth); older.updatedAt = '2026-10-07T10:00:59Z'; await x.stamp(older);
  await assert.rejects(x.refresh(x.guard(older)), /MEDIA_TRANSPORT_GUARD_REFRESH_MISMATCH/, 'older product timestamp');
  // A forged revision (not the digest of the stored raw facts) never passes.
  await assert.rejects(x.refresh({ ...x.guard(x.bumped), target: { ...x.bumped, revision: x.withBoth.revision } }), /MEDIA_TRANSPORT_RAW_REVISION_INVALID/);
  await assert.rejects(x.refresh(x.guard(x.bumped), 4), /MEDIA_TRANSPORT_OUT_OF_ORDER/);
  assert.deepEqual(await x.refresh(x.guard(x.bumped), 2), { status: 'attempt_exists', refreshed: false, mayExecute: false });
  await assert.rejects(x.refresh(x.guard(x.bumped), 3, randomUUID(), randomUUID()), /MEDIA_LEASE_LOST/, 'other lease owner');
  const after = await x.chain(); assert.deepEqual(after, before);
  assert.equal((await one(x.db, `select count(*)::int n from toptik_media_private.events where operation_id=$1 and event_kind='transport_guard_refreshed'`, [x.op])).n, 0);
  // Real media drift still becomes the same durable begin conflict as before.
  const changed = structuredClone(x.bumped); changed.media[1].alt = 'merchant edit'; await x.stamp(changed);
  assert.deepEqual(await x.begin(3, x.detach, x.guard(changed)), { status: 'conflict', mayExecute: false });
});

test('only service_role may execute the refresh', { skip }, async () => {
  const { db } = await database();
  const row = await one(db, `select has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') auth,
    has_function_privilege('service_role',p.oid,'EXECUTE') service,p.prosecdef definer from pg_proc p where p.oid='public.refresh_toptik_media_transport_guard(text,uuid,uuid,int,int,uuid,jsonb)'::regprocedure`);
  assert.deepEqual(row, { anon: false, auth: false, service: true, definer: true });
});
