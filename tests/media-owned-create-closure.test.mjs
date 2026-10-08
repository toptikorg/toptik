// An uncertain create_owned whose association never ran may be closed by an operator, per exact
// attempt, so the planner re-plans from the current state instead of attaching the owned file.
// Real-migration integration runs on an offline PGlite engine (TOPTIK_PGLITE_DIR or the sibling
// sync-sql-validation package); no network. Database tests skip with a reason where it is absent (CI).
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
const sql = migration('20261008_media_owned_create_closure.sql');

test('closure is a private operator function: no grant, lease scoped, never a permit or a receipt', () => {
  assert.match(sql, /create function toptik_media_private\.close_uncertain_owned_create\(/);
  assert.match(sql, /security definer set search_path=pg_catalog,pg_temp/);
  assert.match(sql, /i:=toptik_media_private\.assert_access\(p_product_gid,p_lease_owner\)/);
  assert.match(sql, /revoke all on function toptik_media_private\.close_uncertain_owned_create\(text,uuid,uuid,uuid,text,text,text,boolean,text,text\)\s+from public,anon,authenticated,service_role;/);
  assert.doesNotMatch(sql, /\bgrant\b/i);
  assert.doesNotMatch(sql, /'mayExecute',true/);
  assert.match(sql, /if p_observed_attached then raise exception 'MEDIA_OWNED_CREATE_CLOSE_ATTACHED_USE_READBACK'/);
  assert.match(sql, /a\.receipt is not null/);
  assert.match(sql, /perform toptik_media_private\.enqueue\(p_product_gid,/);
});
test('closure writes only status transitions, its own record, one event and the wakeup', () => {
  const writes = [...sql.matchAll(/\b(update|insert into|delete from)\s+([a-z_]+\.[a-z_]+)/gi)].map(m => `${m[1].toLowerCase()} ${m[2]}`);
  assert.deepEqual(writes, ['insert into toptik_media_private.owned_create_closures', 'update toptik_media_private.transport_attempts',
    'update toptik_media_private.transport_chains', 'update toptik_media_private.steps', 'update toptik_media_private.operations',
    'insert into toptik_media_private.events']);
  assert.doesNotMatch(sql, /set[^;]*\b(receipt|before_guard|after_guard|current_guard|request|request_hash)\s*=/i);
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
    for (const name of ['20260930_media_sync_journal.sql', '20260930_media_transport_substeps.sql', '20260930_media_transport_runtime.sql',
      '20261001_existing_media_25mp.sql', '20261007_media_final_readback.sql', '20261007_media_transport_not_sent_precondition.sql']) await db.exec(migration(name));
    await db.exec(queueTable); await db.exec(enqueue);
    await db.exec(migration('20261008_media_owned_create_closure.sql'));
    return { db, core };
  })();
  return ready;
}
const owner = randomUUID();
let serial = 900;
async function rpc(db, name, args) {
  const result = await db.query(`select ${name.includes('.') ? name : 'public.' + name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`, args.map(a => a && typeof a === 'object' ? JSON.stringify(a) : a));
  return result.rows[0].result;
}
const one = async (db, text, args = []) => (await db.query(text, args)).rows[0];
const sha = value => createHash('sha256').update(value).digest('hex');

/** Real chain: stage_source verified, create_owned begun and (by default) marked uncertain: the live P10OXT0529O shape. */
async function pausedCreate({ uncertain = true, verifyCreate = false, beginAssociate = false } = {}) {
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
    updatedAt: '2026-10-08T06:40:00Z', alt: a.alt, image: { id: `gid://shopify/ImageSource/${a.key.charCodeAt(0) + 1000}`, url: `https://cdn.shopify.com/s/files/1/0001/${a.key}.png`, width: 800, height: 900 } }));
  const raw = await stamp({ side: 'shopify', identity: structuredClone(identity), complete: true, revision: '', updatedAt: '2026-10-08T06:40:00Z', media, variantMediaIds: [], variantImage: null });
  const current = structuredClone(base);
  current.shopify.revision = (await one(db, 'select toptik_media_private.ready_transport_fingerprint($1::jsonb) v', [JSON.stringify(raw)])).v;
  current.gallery.assets[0].alt = 'טקסט חלופי מעודכן'; current.gallery.revision = 'gallery-edit';
  const p = identity.productId, op = randomUUID();
  await rpc(db, 'reserve_toptik_media_operation', [p, owner, op, 1, current, core.reconcileMedia(base, current)]);
  await rpc(db, 'begin_toptik_media_step', [p, owner, op, 0, randomUUID(), current]);
  const guard = target => ({ sourceFingerprint: core.mediaSnapshotFingerprint(current.gallery), target: structuredClone(target), observedAt: new Date().toISOString() });
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
  if (verifyCreate || beginAssociate) {
    const owned = { contentId, decodedSha256: 'e'.repeat(64), ready: true, url: 'https://cdn.shopify.com/s/files/1/0001/cloned.png', width: 800, height: 900,
      byteLength: 1234, mime: 'image/png', mediaGid: 'gid://shopify/MediaImage/777777', filename };
    assert.equal((await accept(1, create.requestHash, guard(raw), owned)).status, 'verified');
    if (beginAssociate) assert.equal((await begin(2, { mutationSha256: 'b'.repeat(64), mediaGid: owned.mediaGid, productGid: p }, guard(raw))).mayExecute, true);
  } else if (uncertain) assert.equal((await rpc(db, 'mark_toptik_media_transport_uncertain', [p, owner, op, 0, 1, randomUUID(), { outcome: 'unknown' }])).status, 'uncertain');
  const attempt = await one(db, 'select * from toptik_media_private.transport_attempts where operation_id=$1 and step_index=0 and phase_index=1', [op]);
  const args = (over = {}) => { const v = { p, owner, closure: randomUUID(), attempt: attempt.attempt_id, hash: create.requestHash, filename,
    file: 'gid://shopify/MediaImage/46419385647354', attached: false, reference: 'TopTik operator closure ' + n, evidence: sha('evidence-' + n), ...over };
    return [v.p, v.owner, v.closure, v.attempt, v.hash, v.filename, v.file, v.attached, v.reference, v.evidence]; };
  const close = argv => rpc(db, 'toptik_media_private.close_uncertain_owned_create', argv);
  const state = async () => ({ op: await one(db, 'select status,version,next_step from toptik_media_private.operations where id=$1', [op]),
    step: (await one(db, 'select status from toptik_media_private.steps where operation_id=$1 and step_index=0', [op])).status,
    chain: await one(db, 'select status,next_phase,current_guard from toptik_media_private.transport_chains where operation_id=$1 and step_index=0', [op]),
    attempt: await one(db, 'select status,receipt,before_guard,after_guard,request,request_hash from toptik_media_private.transport_attempts where attempt_id=$1', [attempt.attempt_id]),
    stageAttempt: (await one(db, 'select status from toptik_media_private.transport_attempts where operation_id=$1 and step_index=0 and phase_index=0', [op])).status,
    queue: await one(db, 'select status,last_error,evidence from toptik_media_private.work_queue where product_gid=$1', [p]),
    closures: Number((await one(db, 'select count(*) n from toptik_media_private.owned_create_closures where original_attempt_id=$1', [attempt.attempt_id])).n) });
  return { db, core, p, op, attempt, create, filename, raw, guard, begin, args, close, state, current };
}

test('an uncertain create_owned is closed: history kept, no receipt invented, operation conflicts, product woken', { skip }, async () => {
  const f = await pausedCreate(), before = await f.state();
  assert.equal(before.attempt.status, 'uncertain'); assert.equal(before.attempt.receipt, null); assert.equal(before.op.status, 'running'); assert.equal(before.chain.next_phase, 1);
  const argv = f.args(), out = await f.close(argv);
  assert.deepEqual(out, { status: 'conflict', closed: true, replayed: false, mayExecute: false, ownedFileObserved: true });
  const after = await f.state();
  assert.equal(after.op.status, 'conflict'); assert.equal(after.op.version, before.op.version + 1);
  assert.equal(after.step, 'conflict'); assert.equal(after.chain.status, 'conflict'); assert.equal(after.attempt.status, 'conflict');
  for (const k of ['receipt', 'before_guard', 'after_guard', 'request', 'request_hash']) assert.deepEqual(after.attempt[k], before.attempt[k], k);
  assert.deepEqual(after.chain.current_guard, before.chain.current_guard);
  assert.equal(after.stageAttempt, 'verified', 'the verified storage phase keeps its history');
  assert.equal(after.closures, 1);
  assert.equal(after.queue.status, 'pending'); assert.equal(after.queue.evidence.ownedCreateClosed, argv[2]);
  const ev = await one(f.db, 'select event_kind,evidence,result from toptik_media_private.events where request_id=$1', [argv[2]]);
  assert.equal(ev.event_kind, 'owned_create_closed'); assert.equal(ev.evidence.observedFileId, 'gid://shopify/MediaImage/46419385647354'); assert.equal(ev.evidence.observedAttached, false);
  // The association can never be permitted on the closed chain.
  await assert.rejects(f.begin(2, { mutationSha256: 'b'.repeat(64), mediaGid: 'gid://shopify/MediaImage/777777', productGid: f.p }, f.guard(f.raw)), /MEDIA_TRANSPORT_OUT_OF_ORDER/);
  // The planner gate is open again: a fresh operation from the current state can be reserved.
  const fresh = await rpc(f.db, 'reserve_toptik_media_operation', [f.p, owner, randomUUID(), 1, f.current, f.core.reconcileMedia(f.current, f.current)]);
  assert.equal(fresh.status, 'reserved');
  // Identical replay is a no-op; any other closure of the same attempt is refused; the record is immutable.
  assert.deepEqual(await f.close(argv), { status: 'conflict', closed: true, replayed: true, mayExecute: false });
  await assert.rejects(f.close(f.args()), /MEDIA_OWNED_CREATE_CLOSE_REUSED/);
  await assert.rejects(f.db.query('update toptik_media_private.owned_create_closures set approval_reference=$1', ['x']), /MEDIA_IMMUTABLE_RECORD/);
});
test('a create_owned that never answered (started) closes the same way; an unseen file is recorded as null', { skip }, async () => {
  const f = await pausedCreate({ uncertain: false });
  assert.equal((await f.state()).attempt.status, 'started');
  assert.deepEqual(await f.close(f.args({ file: null })), { status: 'conflict', closed: true, replayed: false, mayExecute: false, ownedFileObserved: false });
});
test('an owned file observed ATTACHED to the product is refused: readback owns that case', { skip }, async () => {
  const f = await pausedCreate();
  await assert.rejects(f.close(f.args({ attached: true })), /MEDIA_OWNED_CREATE_CLOSE_ATTACHED_USE_READBACK/);
  const s = await f.state(); assert.equal(s.op.status, 'running'); assert.equal(s.attempt.status, 'uncertain'); assert.equal(s.closures, 0);
});
test('a verified create_owned, or one whose association was permitted, is never closed', { skip }, async () => {
  const verified = await pausedCreate({ verifyCreate: true });
  await assert.rejects(verified.close(verified.args()), /MEDIA_OWNED_CREATE_CLOSE_OUT_OF_ORDER/);
  const associating = await pausedCreate({ beginAssociate: true });
  await assert.rejects(associating.close(associating.args()), /MEDIA_OWNED_CREATE_CLOSE_OUT_OF_ORDER/);
  assert.equal((await associating.state()).closures, 0);
});
for (const [name, over, error] of [
  ['request hash', { hash: 'f'.repeat(64) }, /MEDIA_OWNED_CREATE_CLOSE_REQUEST_CHANGED/],
  ['owned filename', { filename: 'toptik-sync-' + 'a'.repeat(32) + '-0-' + 'b'.repeat(16) + '.png' }, /MEDIA_OWNED_CREATE_CLOSE_REQUEST_CHANGED/],
  ['malformed filename', { filename: 'P10OXT0529O-06.jpg' }, /MEDIA_OWNED_CREATE_CLOSE_INVALID/],
  ['malformed file id', { file: 'gid://shopify/Product/1' }, /MEDIA_OWNED_CREATE_CLOSE_INVALID/],
  ['missing attached flag', { attached: null }, /MEDIA_OWNED_CREATE_CLOSE_INVALID/],
  ['approval reference', { reference: '' }, /MEDIA_OWNED_CREATE_CLOSE_INVALID/],
  ['approval evidence', { evidence: 'not-a-hash' }, /MEDIA_OWNED_CREATE_CLOSE_INVALID/],
  ['missing attempt', { attempt: randomUUID() }, /MEDIA_OWNED_CREATE_CLOSE_ATTEMPT_MISSING/],
  ['foreign lease', { owner: randomUUID() }, /MEDIA_/],
]) test(`closure refuses a wrong ${name} and writes nothing`, { skip }, async () => {
  const f = await pausedCreate();
  await assert.rejects(f.close(f.args(over)), error);
  const s = await f.state(); assert.equal(s.attempt.status, 'uncertain'); assert.equal(s.op.status, 'running'); assert.equal(s.closures, 0); assert.equal(s.queue, undefined);
});
test('a storage-phase attempt is not this function\'s case', { skip }, async () => {
  const f = await pausedCreate();
  const stageAttempt = await one(f.db, 'select attempt_id from toptik_media_private.transport_attempts where operation_id=$1 and step_index=0 and phase_index=0', [f.op]);
  await assert.rejects(f.close(f.args({ attempt: stageAttempt.attempt_id })), /MEDIA_OWNED_CREATE_CLOSE_OUT_OF_ORDER/);
});
