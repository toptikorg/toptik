import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createVerifiedImportDatabase, seedVerifiedImportOperation } from './helpers/verified-native-import-sql-fixture.mjs';
import { loadWrapped, staged, storageFake, store, guard } from './helpers/staged-media-harness.mjs';

Error.stackTraceLimit = 0;
const migration = readFileSync(new URL('../supabase/migrations/20261110084327_media_discovery_lineage_closure.sql', import.meta.url), 'utf8');
const oldDefinition = async db => (await db.query("select pg_get_functiondef('public.read_toptik_media_operation(uuid,integer,integer)'::regprocedure) body")).rows[0].body;
const contract = async db => (await db.query(`select oid,proowner,proacl,prosecdef,proconfig,proargtypes::text,prorettype
 from pg_proc where oid='public.read_toptik_media_operation(uuid,integer,integer)'::regprocedure`)).rows[0];
const policy = await loadWrapped('src/lib/shopify/reviewed-media-policy.ts',
  ['assertReviewedMediaOperation', 'reviewedMediaRegistry', 'loadReviewedMedia'], ['assertReviewedPersistedMedia']);

/** Native provenance comes from real verified create/associate receipts and the real register RPC.
 * The new reverse operation is reserved normally after a genuine final-readback conflict terminalizes the first operation.
 * No provenance, operation or proof is hand-inserted to make the guard pass. */
async function fixture() {
  const sql = await createVerifiedImportDatabase();
  try {
  const actualRpc = sql.rpc;
  const f = await seedVerifiedImportOperation({ ...sql, rpc: async (name, args) => {
    // The original editor-approved parent is an immutable sync-staged object.
    // Set its URL before its first real provenance registration, not after registration.
    if (name === 'register_toptik_media_provenance') for (const p of args[2]) {
      if (p.side === 'gallery' && p.key === 'c' && !p.proof.operationId) {
        p.proof.url = staged.stagedPublicUrl(staged.stagedStoragePath(args[0] && p.proof.platformRef
          ? p.proof.platformRef.split('/')[1] : '', p.proof.decodedSha256, p.proof.mime));
      }
    }
    return actualRpc(name, args);
  } });
  // Receipt authority is proven through the production register function, which checks the verified native phases.
  await f.register();
  assert.notEqual(f.nativeEntry.proof.decodedSha256, f.parent.proof.decodedSha256, 'real SQL import fixture models recompression');
  // Finish the transport, then report a real concurrent per-media timestamp change at final readback. The real RPC
  // terminalizes it as conflict, preserving its verified artifact lineage and original baseline for the next event.
  const reordered = await f.begin(f.reorderPhaseIndex, { mutationSha256: 'a'.repeat(64), mediaGids: f.raw.media.map(m => m.mediaId) });
  if (reordered.verifiedNoop) assert.equal(reordered.status, 'verified');
  else assert.equal((await f.accept(f.reorderPhaseIndex, reordered.requestHash, f.raw)).status, 'verified');
  f.raw = structuredClone(f.raw); f.raw.media[0].updatedAt = new Date().toISOString(); f.raw = await f.stamp(f.raw);
  const concurrent = structuredClone(f.expected);
  concurrent.shopify.assets.find(a => a.key === f.added.key).evidenceId = f.nativeEntry.evidenceId;
  concurrent.shopify.revision = (await f.db.query('select toptik_media_private.ready_transport_fingerprint($1::jsonb) v', [JSON.stringify(f.raw)])).rows[0].v;
  assert.equal((await f.rpc('accept_toptik_media_final_readback', [f.product, f.owner, f.op, 0, randomUUID(), concurrent,
    { sourceFingerprint: f.core.mediaSnapshotFingerprint(concurrent.gallery), target: f.raw, observedAt: new Date().toISOString() }])).status, 'conflict');
  const current = structuredClone(f.base);
  current.shopify.assets.push({ ...f.added, evidenceId: f.nativeEntry.evidenceId });
  current.shopify.revision = (await f.db.query('select toptik_media_private.ready_transport_fingerprint($1::jsonb) v', [JSON.stringify(f.raw)])).rows[0].v;
  const op = randomUUID(), plan = f.core.reconcileMedia(f.base, current);
  assert.equal(plan.patches[0].source, 'shopify'); assert.equal(plan.patches[0].target, 'gallery');
  await f.rpc('reserve_toptik_media_operation', [f.product, f.owner, op, 1, current, plan]);
  await f.rpc('begin_toptik_media_step', [f.product, f.owner, op, 0, randomUUID(), current]);
  await f.rpc('prepare_toptik_media_transport', [f.product, f.owner, op, 0, randomUUID(), ['gallery_upload', 'gallery_cas'],
    { sourceFingerprint: f.core.mediaSnapshotFingerprint(current.shopify), target: current.gallery, observedAt: new Date().toISOString() }]);
  const privateStore = storageFake(), reviews = store(privateStore);
  const stagedPath = staged.stagedStoragePath(f.identity.itemId, f.parent.proof.decodedSha256, f.parent.proof.mime);
  const receipt = staged.stagedRecord({ version: 1, kind: 'staged_gallery_upload', identity: f.identity,
    approvalId: 'synthetic-approved-exact-product', uploadPath: `items/${f.identity.itemId}/angles/${randomUUID()}.png`, stagedPath,
    imageUrl: staged.stagedPublicUrl(stagedPath), decodedSha256: f.parent.proof.decodedSha256, mime: f.parent.proof.mime,
    width: f.parent.proof.width, height: f.parent.proof.height, byteLength: f.parent.proof.byteLength,
    note: 'Offline synthetic administrator exact-model/color approval', actorId: randomUUID(), reviewedAt: new Date().toISOString(), reviewedExactSkuColor: true });
  assert.equal(receipt.imageUrl, f.parent.proof.url);
  await reviews.saveStagedReview(receipt, Date.now() + 30000);
  const reviewed = policy({ assertReviewedMediaOperation: guard.assertReviewedMediaOperation, reviewedMediaRegistry: guard.reviewedMediaRegistry,
    loadReviewedMedia: reviews.loadReviewedMedia });
  const discover = () => f.rpc('read_toptik_media_operation', [op, 0, 0]);
  return { ...f, current, op, privateStore, reviews, receipt, reviewed, discover };
  } catch (error) { await sql.db.close(); throw error; }
}

test('actual SQL discovery recovers the reviewed staged ancestor for a new native-to-Gallery attach', async () => {
  const f = await fixture();
  try {
    const before = await f.discover();
    assert.ok(before.provenance.some(p => p.evidence_id === f.nativeEntry.evidenceId));
    assert.equal(before.provenance.some(p => p.evidence_id === f.parent.evidenceId), false);
    assert.equal((await f.reviews.loadReviewedMedia(f.identity, Date.now() + 30000)).length, 1);
    await assert.rejects(f.reviewed.assertReviewedPersistedMedia(before, Date.now() + 30000), /MEDIA_REVIEW_REQUIRED/);
    const oldContract = await contract(f.db);
    await f.db.exec(migration);
    assert.deepEqual(await contract(f.db), oldContract);
    const after = await f.discover();
    assert.ok(after.provenance.some(p => p.evidence_id === f.parent.evidenceId));
    await f.reviewed.assertReviewedPersistedMedia(after, Date.now() + 30000);
    assert.deepEqual(after.transport.attempts, [], 'read does not start the transport');
    assert.deepEqual(after.transport.artifacts, []);
    assert.equal(after.step.status, 'started'); assert.equal(after.transport.chain.status, 'ready');
    assert.equal(after.operation.status, 'running');
    const version = (await f.db.query('select version from toptik_media_private.state where product_gid=$1', [f.product])).rows[0].version;
    assert.equal(version, 1, 'discovery never adopts a new baseline');
  } finally { await f.db.close(); }
});

test('a readable parent never substitutes for an actual signed staged review', async () => {
  const f = await fixture();
  try {
    await f.db.exec(migration); const discovery = await f.discover();
    const noReviews = policy({ assertReviewedMediaOperation: guard.assertReviewedMediaOperation, reviewedMediaRegistry: guard.reviewedMediaRegistry,
      loadReviewedMedia: async () => [] });
    await assert.rejects(noReviews.assertReviewedPersistedMedia(discovery, Date.now() + 30000), /MEDIA_REVIEW_REQUIRED/);
    const signedPath = [...f.privateStore.files.keys()].find(p => p.startsWith('staged-v1/'));
    const bad = JSON.parse(f.privateStore.files.get(signedPath)); bad.record.decodedSha256 = 'f'.repeat(64);
    f.privateStore.files.set(signedPath, JSON.stringify(bad));
    await assert.rejects(f.reviewed.assertReviewedPersistedMedia(discovery, Date.now() + 30000), /STAGED_MEDIA_RECORD_INVALID/);
    assert.deepEqual((await f.discover()).transport.attempts, []);
  } finally { await f.db.close(); }
});

test('same-product/key/content closure is bounded, cycle-safe, and does not expose unrelated proofs', async t => {
  const f = await fixture();
  try {
    await f.db.exec(migration);
    const root = f.nativeEntry.evidenceId, parent = f.parent.evidenceId;
    const saved = (await f.db.query('select * from toptik_media_private.provenance where evidence_id=$1', [parent])).rows[0];
    // Negative corruption fixtures deliberately disable the immutable trigger in this isolated DB only.
    // They test that malformed/missing/foreign ancestry cannot become authority; production registration stays unchanged.
    const foreign = await seedVerifiedImportOperation(f);
    await f.db.exec('alter table toptik_media_private.provenance disable trigger immutable_record;begin');
    for (const [name, change] of [
      ['missing parent', () => f.db.query('delete from toptik_media_private.provenance where evidence_id=$1', [parent])],
      ['different semantic content', () => f.db.query("update toptik_media_private.provenance set content_id=repeat('f',64) where evidence_id=$1", [parent])],
      ['different product', () => f.db.query('update toptik_media_private.provenance set product_gid=$2 where evidence_id=$1', [parent, foreign.product])],
      ['different logical key', () => f.db.query("update toptik_media_private.provenance set asset_key='a' where evidence_id=$1", [parent])],
      ['malformed link', () => f.db.query("update toptik_media_private.provenance set proof=jsonb_set(proof,'{sourceEvidenceId}','3'::jsonb) where evidence_id=$1", [root])],
      ['self cycle', () => f.db.query("update toptik_media_private.provenance set proof=jsonb_set(proof,'{sourceEvidenceId}',to_jsonb(evidence_id)) where evidence_id=$1", [root])],
    ]) await t.test(name, async () => {
      await f.db.exec('savepoint negative_case');
      try { await change(); const d = await f.discover();
        assert.equal(d.provenance.some(p => p.evidence_id === parent), false);
        await assert.rejects(f.reviewed.assertReviewedPersistedMedia(d, Date.now() + 30000), /MEDIA_REVIEW_REQUIRED/);
      } finally { await f.db.exec('rollback to savepoint negative_case;release savepoint negative_case'); }
    });
    await t.test('eight-node read bound retains no ninth ancestor and TS guard still holds a depth-exhausted chain', async () => {
      const ids = Array.from({ length: 9 }, (_, i) => 'bounded-parent-' + i);
      const db = f.db;
      for (let i = 0; i < ids.length; i++) {
        const proof = { ...saved.proof, operationId: randomUUID(), sourceEvidenceId: ids[i + 1] ?? root,
          url: `https://cdn.shopify.com/s/files/1/0001/bounded-${i}.png`, platformRef: `gid://shopify/MediaImage/${900000 + i}` };
        await db.query('insert into toptik_media_private.provenance(evidence_id,product_gid,asset_key,side,content_id,proof) values($1,$2,$3,$4,$5,$6)',
          [ids[i], f.product, saved.asset_key, 'shopify', saved.content_id, JSON.stringify(proof)]);
      }
      await db.query("update toptik_media_private.provenance set proof=jsonb_set(proof,'{sourceEvidenceId}',to_jsonb($2::text)) where evidence_id=$1", [root, ids[0]]);
      const d = await f.discover(), returned = d.provenance.filter(p => p.evidence_id.startsWith('bounded-parent-'));
      assert.equal(returned.length, 7); assert.equal(returned.some(p => p.evidence_id === ids[7]), false);
      await assert.rejects(f.reviewed.assertReviewedPersistedMedia(d, Date.now() + 30000), /MEDIA_REVIEW_REQUIRED/);
    });
  } finally { await f.db.close(); }
});

test('service-only ACL, function identity and idempotent replay remain exact', async () => {
  const f = await fixture();
  try {
    const before = await contract(f.db); await f.db.exec(migration);
    const definition = await oldDefinition(f.db); await f.db.exec(migration);
    assert.equal(await oldDefinition(f.db), definition); assert.deepEqual(await contract(f.db), before);
    const roles = await f.db.query(`select role,has_function_privilege(role,'public.read_toptik_media_operation(uuid,integer,integer)','execute') allowed
      from unnest(array['anon','authenticated','service_role']) role`);
    assert.deepEqual(Object.fromEntries(roles.rows.map(r => [r.role, r.allowed])), { anon: false, authenticated: false, service_role: true });
    for (const role of ['anon', 'authenticated']) {
      await f.db.exec('set role ' + role);
      try { await assert.rejects(f.discover(), /permission denied/); } finally { await f.db.exec('reset role'); }
    }
  } finally { await f.db.close(); }
});

test('unexpected predecessor aborts without modifying the function', async () => {
  const f = await createVerifiedImportDatabase();
  try {
    const definition = (await oldDefinition(f.db)).replace("where v.product_gid=o.product_gid and v.evidence_id in (", "where v.product_gid=o.product_gid and true and v.evidence_id in (");
    await f.db.exec(definition); const before = await oldDefinition(f.db);
    await assert.rejects(f.db.exec(migration), /MEDIA_DISCOVERY_PREDECESSOR_CHANGED/);
    await f.db.exec('rollback'); assert.equal(await oldDefinition(f.db), before);
  } finally { await f.db.close(); }
});
