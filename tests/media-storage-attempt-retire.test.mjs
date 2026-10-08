// A stale storage attempt whose create-only object is absent may be retired by an
// operator, per exact attempt, so the planner re-plans from the current state.
// Real-migration integration runs on an offline PGlite engine (TOPTIK_PGLITE_DIR or the
// sibling sync-sql-validation package); no network. The engine is required, not optional.
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
const sql = migration('20261008_media_storage_attempt_retire.sql');
const signature = 'toptik_media_private.retire_stale_storage_attempt(text,uuid,uuid,uuid,text,text,text,text)';

test('retirement is a private operator function: no grant, lease scoped, fail-closed absence, never a permit', () => {
  assert.match(sql, /create function toptik_media_private\.retire_stale_storage_attempt\(/);
  assert.match(sql, /security definer set search_path=pg_catalog,pg_temp/);
  assert.match(sql, /i:=toptik_media_private\.assert_access\(p_product_gid,p_lease_owner\)/);
  assert.match(sql, /revoke all on function toptik_media_private\.retire_stale_storage_attempt\(text,uuid,uuid,uuid,text,text,text,text\)\s+from public,anon,authenticated,service_role;/);
  assert.doesNotMatch(sql, /\bgrant\b/i);
  assert.doesNotMatch(sql, /'mayExecute',true/);
  assert.match(sql, /if row_security_active\('storage\.objects'::regclass\) then raise exception 'MEDIA_STORAGE_RETIRE_ABSENCE_UNVERIFIABLE'/);
  assert.match(sql, /exists\(select 1 from storage\.objects where bucket_id='carousel-media' and name=p_storage_path\)/);
  assert.match(sql, /perform toptik_media_private\.enqueue\(p_product_gid,/);
});
test('retirement writes only status transitions, its own record, one event and the wakeup', () => {
  const writes = [...sql.matchAll(/\b(update|insert into|delete from)\s+([a-z_]+\.[a-z_]+)/gi)].map(m => `${m[1].toLowerCase()} ${m[2]}`);
  assert.deepEqual(writes, ['insert into toptik_media_private.storage_attempt_retirements', 'update toptik_media_private.transport_attempts',
    'update toptik_media_private.transport_chains', 'update toptik_media_private.steps', 'update toptik_media_private.operations',
    'insert into toptik_media_private.events']);
  assert.doesNotMatch(sql, /set[^;]*\b(receipt|before_guard|after_guard|current_guard|request|request_hash)\s*=/i);
});

const engine = process.env.TOPTIK_PGLITE_DIR ?? path.resolve(repo, '../sync-sql-validation-20260930/package');
// Same convention as the other real-SQL suites: database tests skip (with a reason) where the
// offline engine is not installed, e.g. CI; the static checks above always run.
const skip = existsSync(path.join(engine, 'dist/index.js')) ? false : `PGlite engine not found at ${engine}`;
const coreUrl = 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(resolveImageLimits(readFileSync(path.join(repo, 'src/lib/shopify/media-sync-core.ts'), 'utf8')))).toString('base64');

let ready;
function database() {
  ready ??= (async () => {
    const { PGlite } = await import(pathToFileURL(path.join(engine, 'dist/index.js')).href);
    const core = await import(coreUrl), db = new PGlite();
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create schema storage;create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,created_at timestamptz default now());
create table public.shopify_gallery_copy_eligibility(product_gid text primary key,catalog_key text,carousel_item_id uuid,variant_gid text,exact_gallery_sku text,exact_shopify_sku text,approved_product_handle text,enabled boolean);
create table public.shopify_gallery_reconciliation_leases(product_gid text primary key,owner uuid,expires_at timestamptz);
create table public.shopify_webhook_events(id uuid,topic text,shop_domain text,payload jsonb,delivery_id text);
create table public.test_gallery_snapshots(product_gid text primary key,snapshot jsonb);
-- Test double for the Gallery read only (20260930_gallery_media_cas.sql needs the full catalog schema).
create function public.read_toptik_gallery_media_snapshot(p_product_gid text) returns jsonb language sql as $$select snapshot from public.test_gallery_snapshots where product_gid=p_product_gid$$;
create function public.assert_shopify_verified_copy_identity(p_item uuid,p_key text,p_gsku text,p_product text,p_variant text,p_ssku text) returns void language plpgsql as $$begin
 if not exists(select 1 from public.shopify_gallery_copy_eligibility where product_gid=p_product and catalog_key=p_key and carousel_item_id=p_item and exact_gallery_sku=p_gsku and variant_gid=p_variant and exact_shopify_sku=p_ssku and enabled) then raise exception 'COPY_IDENTITY_CHANGED';end if;end$$;`);
    // The whole planning migration needs the full catalog schema; take its exact queue table
    // and the latest production enqueue (20261007_media_queue_inflight.sql) verbatim.
    const queueTable = migration('20261001_media_planning_runtime.sql').match(/create table toptik_media_private\.work_queue\([\s\S]*?\);/)[0];
    const enqueue = migration('20261007_media_queue_inflight.sql').match(/create or replace function toptik_media_private\.enqueue\([\s\S]*?end \$\$;/)[0];
    for (const name of ['20260930_media_sync_journal.sql', '20260930_media_transport_substeps.sql', '20260930_media_transport_runtime.sql',
      '20261001_existing_media_25mp.sql', '20261007_media_final_readback.sql', '20261007_media_transport_not_sent_precondition.sql']) await db.exec(migration(name));
    await db.exec(queueTable); await db.exec(enqueue);
    for (const name of ['20261007_media_storage_repair.sql', '20261008_media_storage_attempt_retire.sql']) await db.exec(migration(name));
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

/** Real chain up to a phase-0 stage_source attempt (the 20 production cases' shape). */
async function staleStage({ uncertain = true } = {}) {
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
    updatedAt: '2026-10-02T00:00:00Z', alt: a.alt, image: { id: `gid://shopify/ImageSource/${a.key.charCodeAt(0) + 1000}`, url: `https://cdn.shopify.com/s/files/1/0001/${a.key}.png`, width: 800, height: 900 } }));
  const raw = await stamp({ side: 'shopify', identity: structuredClone(identity), complete: true, revision: '', updatedAt: '2026-10-02T00:00:00Z', media, variantMediaIds: [], variantImage: null });
  const current = structuredClone(base);
  current.shopify.revision = (await one(db, 'select toptik_media_private.ready_transport_fingerprint($1::jsonb) v', [JSON.stringify(raw)])).v;
  current.gallery.assets[0].alt = 'טקסט חלופי מעודכן'; current.gallery.revision = 'gallery-edit';
  const p = identity.productId, plan = core.reconcileMedia(base, current);
  const guard = target => ({ sourceFingerprint: core.mediaSnapshotFingerprint(current.gallery), target: structuredClone(target), observedAt: new Date().toISOString() });
  const contentId = current.shopify.assets[0].contentId, sourceEvidenceId = current.shopify.assets[0].evidenceId, storagePath = `sync-media/${identity.itemId}/${contentId}.png`;
  /** reserve -> begin step -> prepare -> begin stage_source; returns the begin result. */
  const startStage = async op => {
    await rpc(db, 'reserve_toptik_media_operation', [p, owner, op, 1, current, plan]);
    await rpc(db, 'begin_toptik_media_step', [p, owner, op, 0, randomUUID(), current]);
    assert.equal((await rpc(db, 'prepare_toptik_media_transport', [p, owner, op, 0, randomUUID(), ['stage_source', 'create_owned', 'associate', 'detach_old', 'reorder'], guard(raw)])).status, 'ready');
    return rpc(db, 'begin_toptik_media_transport', [p, owner, op, 0, 0, randomUUID(), { mutationSha256: '9'.repeat(64), sourceEvidenceId, storagePath, upsert: false }, guard(raw)]);
  };
  const op = randomUUID(), stage = await startStage(op);
  assert.equal(stage.mayExecute, true);
  if (uncertain) assert.equal((await rpc(db, 'mark_toptik_media_transport_uncertain', [p, owner, op, 0, 0, randomUUID(), { outcome: 'unknown' }])).status, 'uncertain');
  const attempt = await one(db, 'select * from toptik_media_private.transport_attempts where operation_id=$1 and step_index=0 and phase_index=0', [op]);
  await db.query('insert into public.test_gallery_snapshots values($1,$2)', [p, JSON.stringify(current.gallery)]);
  const args = (over = {}) => { const v = { p, owner, retirement: randomUUID(), attempt: attempt.attempt_id, hash: stage.requestHash, path: storagePath,
    reference: 'TopTik operator retirement ' + n, evidence: sha('evidence-' + n), ...over };
    return [v.p, v.owner, v.retirement, v.attempt, v.hash, v.path, v.reference, v.evidence]; };
  const retire = argv => rpc(db, 'toptik_media_private.retire_stale_storage_attempt', argv);
  const state = async () => ({ op: (await one(db, 'select status,version from toptik_media_private.operations where id=$1', [op])),
    step: (await one(db, 'select status from toptik_media_private.steps where operation_id=$1 and step_index=0', [op])).status,
    chain: (await one(db, 'select status,current_guard from toptik_media_private.transport_chains where operation_id=$1 and step_index=0', [op])),
    attempt: (await one(db, 'select status,receipt,before_guard,after_guard,request,request_hash from toptik_media_private.transport_attempts where attempt_id=$1', [attempt.attempt_id])),
    queue: await one(db, 'select status,last_error,evidence from toptik_media_private.work_queue where product_gid=$1', [p]),
    retirements: Number((await one(db, 'select count(*) n from toptik_media_private.storage_attempt_retirements where original_attempt_id=$1', [attempt.attempt_id])).n) });
  return { db, core, p, op, attempt, stage, storagePath, raw, args, retire, state, startStage, current, sourceEvidenceId, contentId, identity };
}

test('an absent object is retired: history kept, operation conflicts, product woken, re-plan admitted', { skip }, async () => {
  const f = await staleStage();
  await f.db.query("insert into toptik_media_private.work_queue(product_gid,status,last_error) values($1,'pending','MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED')", [f.p]);
  const before = await f.state();
  assert.equal(before.attempt.status, 'uncertain'); assert.equal(before.op.status, 'running');
  const argv = f.args(), out = await f.retire(argv);
  assert.deepEqual(out, { status: 'conflict', retired: true, replayed: false, mayExecute: false, galleryChanged: false });
  const after = await f.state();
  assert.equal(after.op.status, 'conflict'); assert.equal(after.op.version, before.op.version + 1);
  assert.equal(after.step, 'conflict'); assert.equal(after.chain.status, 'conflict'); assert.equal(after.attempt.status, 'conflict');
  for (const k of ['receipt', 'before_guard', 'after_guard', 'request', 'request_hash']) assert.deepEqual(after.attempt[k], before.attempt[k], k);
  assert.deepEqual(after.chain.current_guard, before.chain.current_guard);
  assert.equal(after.retirements, 1);
  assert.equal(after.queue.status, 'pending'); assert.equal(after.queue.last_error, null); assert.equal(after.queue.evidence.storageAttemptRetired, argv[2]);
  const ev = await one(f.db, 'select event_kind,evidence,result from toptik_media_private.events where request_id=$1', [argv[2]]);
  assert.equal(ev.event_kind, 'storage_attempt_retired'); assert.equal(ev.evidence.frozenStoreUpdatedAt, '2026-10-02T00:00:00Z');
  assert.equal(ev.evidence.galleryFingerprintNow, f.core.mediaSnapshotFingerprint(f.current.gallery), 'SQL and TS gallery fingerprints agree');
  // The retired attempt can never be revived or repaired.
  await assert.rejects(rpc(f.db, 'mark_toptik_media_transport_uncertain', [f.p, owner, f.op, 0, 0, randomUUID(), { outcome: 'unknown' }]));
  await assert.rejects(rpc(f.db, 'toptik_media_private.authorize_storage_repair', [f.p, owner, randomUUID(), f.attempt.attempt_id, f.stage.requestHash, f.storagePath,
    f.contentId, 'ref', 'a'.repeat(64), new Date(Date.now() + 3600_000).toISOString(), after.chain.current_guard]), /MEDIA_STORAGE_REPAIR_OUT_OF_ORDER/);
  // The planner gate is open: a fresh operation reserves and gets a new one-shot upload permit.
  const replanned = await f.startStage(randomUUID());
  assert.equal(replanned.mayExecute, true);
  // Identical replay is a no-op; any other retirement of the same attempt is refused.
  assert.deepEqual(await f.retire(argv), { status: 'conflict', retired: true, replayed: true, mayExecute: false });
  await assert.rejects(f.retire(f.args()), /MEDIA_STORAGE_RETIRE_REUSED/);
  await assert.rejects(f.db.query('update toptik_media_private.storage_attempt_retirements set approval_reference=$1', ['x']), /MEDIA_IMMUTABLE_RECORD/);
});
test('a started (never answered) attempt is retired the same way', { skip }, async () => {
  const f = await staleStage({ uncertain: false });
  assert.equal((await f.state()).attempt.status, 'started');
  assert.equal((await f.retire(f.args())).retired, true);
  assert.equal((await f.state()).op.status, 'conflict');
});
test('a changed gallery is recorded as server-side drift evidence', { skip }, async () => {
  const f = await staleStage(), changed = structuredClone(f.current.gallery); changed.revision = 'gallery-later';
  await f.db.query('update public.test_gallery_snapshots set snapshot=$2 where product_gid=$1', [f.p, JSON.stringify(changed)]);
  assert.equal((await f.retire(f.args())).galleryChanged, true);
});
test('an existing object is never retired: verified readback is the path', { skip }, async () => {
  const f = await staleStage();
  await f.db.query("insert into storage.objects(bucket_id,name) values('carousel-media',$1)", [f.storagePath]);
  await assert.rejects(f.retire(f.args()), /MEDIA_STORAGE_RETIRE_OBJECT_EXISTS_USE_READBACK/);
  const s = await f.state(); assert.equal(s.op.status, 'running'); assert.equal(s.attempt.status, 'uncertain'); assert.equal(s.retirements, 0);
});
test('a same-named object in another bucket does not count as the upload', { skip }, async () => {
  const f = await staleStage();
  await f.db.query("insert into storage.objects(bucket_id,name) values('other-bucket',$1)", [f.storagePath]);
  assert.equal((await f.retire(f.args())).retired, true);
});
test('an existing repair approval blocks retirement', { skip }, async () => {
  const f = await staleStage(), a = f.attempt;
  await f.db.query(`insert into toptik_media_private.storage_repair_approvals(approval_id,original_attempt_id,product_gid,operation_id,step_index,phase_index,
    original_request_hash,storage_path,source_sha256,source_evidence_id,identity,scope_hash,approval_reference,approval_evidence_sha256,expires_at)
    values($1,$2,$3,$4,0,0,$5,$6,$7,'e',$8,$7,'ref',$7,clock_timestamp()+interval '1 hour')`, [randomUUID(), a.attempt_id, f.p, f.op, f.stage.requestHash, f.storagePath, 'f'.repeat(64), JSON.stringify(f.identity)]);
  await assert.rejects(f.retire(f.args()), /MEDIA_STORAGE_RETIRE_REPAIR_APPROVAL_EXISTS/);
});
for (const [name, over, error] of [
  ['request hash', { hash: 'f'.repeat(64) }, /MEDIA_STORAGE_RETIRE_REQUEST_CHANGED/],
  ['storage path', { path: 'sync-media/other/' + 'a'.repeat(64) + '.png' }, /MEDIA_STORAGE_RETIRE_REQUEST_CHANGED/],
  ['approval reference', { reference: '' }, /MEDIA_STORAGE_RETIRE_INVALID/],
  ['approval evidence', { evidence: 'not-a-hash' }, /MEDIA_STORAGE_RETIRE_INVALID/],
  ['missing attempt', { attempt: randomUUID() }, /MEDIA_STORAGE_RETIRE_ATTEMPT_MISSING/],
  ['foreign lease', { owner: randomUUID() }, /MEDIA_/],
]) test(`retirement refuses a wrong ${name} and writes nothing`, { skip }, async () => {
  const f = await staleStage();
  await assert.rejects(f.retire(f.args(over)), error);
  const s = await f.state(); assert.equal(s.attempt.status, 'uncertain'); assert.equal(s.retirements, 0); assert.equal(s.queue, undefined);
});
test('a verified storage phase can never be retired', { skip }, async () => {
  const f = await staleStage();
  await f.db.query("update toptik_media_private.transport_attempts set status='verified' where attempt_id=$1", [f.attempt.attempt_id]);
  await assert.rejects(f.retire(f.args()), /MEDIA_STORAGE_RETIRE_OUT_OF_ORDER/);
});
test('no application role may execute the operator function', { skip }, async () => {
  const { db } = await database();
  for (const role of ['service_role', 'authenticated', 'anon'])
    assert.equal((await one(db, 'select has_function_privilege($1,$2,$3) v', [role, signature, 'execute'])).v, false, role);
});
