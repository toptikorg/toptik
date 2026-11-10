// Real migrations + public service RPCs in local PGlite. No network, external DB or native writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createVerifiedImportDatabase, seedVerifiedImportOperation } from './helpers/verified-native-import-sql-fixture.mjs';

const migration = new URL('../supabase/migrations/20261110092500_verified_native_import_provenance.sql', import.meta.url);
const count = async db => Number((await db.query('select count(*) n from toptik_media_private.provenance')).rows[0].n);
const state = async f => (await f.db.query(`select o.status,o.version,o.next_step,s.baselines,s.version state_version,
 st.status step_status,tc.status chain_status,tc.next_phase
 from toptik_media_private.operations o join toptik_media_private.state s on s.product_gid=o.product_gid
 join toptik_media_private.steps st on st.operation_id=o.id and st.step_index=0
 join toptik_media_private.transport_chains tc on tc.operation_id=o.id and tc.step_index=0 where o.id=$1`, [f.op])).rows[0];

test('only exact verified native import receipts authorize semantic provenance, with equal or recompressed bytes', { timeout: 60000 }, async t => {
  const dbf = await createVerifiedImportDatabase(), { db } = dbf;
  try {
    await t.test('recompressed native bytes register through the real public RPC without advancing journal or baselines', async () => {
      const f = await seedVerifiedImportOperation(dbf), before = await state(f), n = await count(db);
      assert.notEqual(f.nativeEntry.contentId, f.nativeEntry.proof.decodedSha256);
      assert.equal(await f.register(), true);
      assert.equal(await count(db), n + 1);
      assert.deepEqual((await db.query('select proof from toptik_media_private.provenance where evidence_id=$1', [f.nativeEntry.evidenceId])).rows[0].proof, f.nativeEntry.proof);
      assert.deepEqual(await state(f), before);
      assert.equal(await f.register(), true, 'exact immutable replay is accepted');
      assert.equal(await count(db), n + 1);
    });
    await t.test('equal-byte native imports retain the same operation/source lineage', async () => {
      const f = await seedVerifiedImportOperation(dbf, { equalBytes: true });
      assert.equal(f.nativeEntry.contentId, f.nativeEntry.proof.decodedSha256);
      assert.equal(await f.register(), true);
    });
    const alt = await seedVerifiedImportOperation(dbf, { kind: 'alt' });
    const foreignParent = structuredClone(alt.parent); foreignParent.evidenceId += '-unobserved';
    foreignParent.proof.platformRef = 'gid://shopify/MediaImage/888888888';
    foreignParent.proof.url = 'https://cdn.shopify.com/s/files/1/0001/unobserved.png';
    await alt.register([foreignParent]);
    const altBaseline = await count(db);
    const rejectAltMutation = async (name, sql, args, entry = alt.nativeEntry) => t.test(name, async () => {
      await db.exec('begin');
      try {
        await db.query(sql, args);
        await assert.rejects(alt.register([entry]), /MEDIA_IMPORT_LINEAGE_REQUIRED/);
      } finally { await db.exec('rollback'); }
      assert.equal(await count(db), altBaseline, 'rejected ALT import writes no provenance');
    });
    for (const [name, sql, args] of [
      ['missing native source membership', "update toptik_media_private.operations set observed_pair=jsonb_set(observed_pair,'{shopify,assets}',jsonb_build_array(observed_pair#>'{shopify,assets,1}')) where id=$1", [alt.op]],
      ['duplicate native source key', "update toptik_media_private.operations set observed_pair=jsonb_set(observed_pair,'{shopify,assets}',(observed_pair#>'{shopify,assets}')||jsonb_build_array(observed_pair#>'{shopify,assets,0}')) where id=$1", [alt.op]],
      ['different native source evidence', "update toptik_media_private.operations set observed_pair=jsonb_set(observed_pair,'{shopify,assets,0,evidenceId}',to_jsonb('not-the-parent'::text)) where id=$1", [alt.op]],
      ['different native source content', "update toptik_media_private.operations set observed_pair=jsonb_set(observed_pair,'{shopify,assets,0,contentId}',to_jsonb(repeat('f',64))) where id=$1", [alt.op]],
      ['different native source variant identity', "update toptik_media_private.operations set observed_pair=jsonb_set(observed_pair,'{shopify,identity,variantId}',to_jsonb('gid://shopify/ProductVariant/888888'::text)) where id=$1", [alt.op]],
      ['stale pinned baseline version', 'update toptik_media_private.state set version=version+1 where product_gid=$1', [alt.product]],
      ['missing baseline source membership', "update toptik_media_private.state set baselines=jsonb_set(baselines,'{shopify,assets}',jsonb_build_array(baselines#>'{shopify,assets,1}')) where product_gid=$1", [alt.product]],
      ['duplicate baseline source key', "update toptik_media_private.state set baselines=jsonb_set(baselines,'{shopify,assets}',(baselines#>'{shopify,assets}')||jsonb_build_array(baselines#>'{shopify,assets,0}')) where product_gid=$1", [alt.product]],
      ['different baseline source evidence', "update toptik_media_private.state set baselines=jsonb_set(baselines,'{shopify,assets,0,evidenceId}',to_jsonb('not-the-baseline-parent'::text)) where product_gid=$1", [alt.product]],
      ['different baseline source content', "update toptik_media_private.state set baselines=jsonb_set(baselines,'{shopify,assets,0,contentId}',to_jsonb(repeat('f',64))) where product_gid=$1", [alt.product]],
      ['different baseline source side', "update toptik_media_private.state set baselines=jsonb_set(baselines,'{shopify,side}',to_jsonb('gallery'::text)) where product_gid=$1", [alt.product]],
      ['different baseline source variant identity', "update toptik_media_private.state set baselines=jsonb_set(baselines,'{shopify,identity,variantId}',to_jsonb('gid://shopify/ProductVariant/888888'::text)) where product_gid=$1", [alt.product]],
    ]) await rejectAltMutation('ALT refuses ' + name, sql, args);
    const foreignEntry = structuredClone(alt.nativeEntry); foreignEntry.proof.sourceEvidenceId = foreignParent.evidenceId;
    await rejectAltMutation('ALT refuses an existing same-product/key/content parent outside its native observation',
      `with changed_step as (update toptik_media_private.steps set expected_pair=jsonb_set(expected_pair,'{shopify,assets,0,evidenceId}',to_jsonb($2::text)) where operation_id=$1 returning operation_id)
       update toptik_media_private.transport_attempts set request=jsonb_set(request,'{sourceEvidenceId}',to_jsonb($2::text)) where operation_id in (select operation_id from changed_step) and phase='create_owned'`,
      [alt.op, foreignParent.evidenceId], foreignEntry);
    await t.test('ALT clone recompression registers from the exact existing Shopify parent after old-reference detach', async () => {
      assert.equal(alt.parent.side, 'shopify'); assert.equal(alt.reorderPhaseIndex, 4);
      assert.equal(alt.added.key, 'a'); assert.equal(alt.expected.shopify.assets[0].evidenceId, alt.parent.evidenceId);
      assert.notEqual(alt.nativeEntry.contentId, alt.nativeEntry.proof.decodedSha256);
      assert.equal(alt.raw.media.some(m => m.mediaId === alt.parent.proof.platformRef), false);
      assert.equal((await db.query("select status from toptik_media_private.transport_attempts where operation_id=$1 and phase='detach_old'", [alt.op])).rows[0].status, 'verified');
      const before = await state(alt); assert.equal(await alt.register(), true);
      assert.equal(await count(db), altBaseline + 1); assert.deepEqual(await state(alt), before);
    });
    await t.test('equal-byte ALT clone keeps the exact native parent lineage', async () => {
      const f = await seedVerifiedImportOperation(dbf, { kind: 'alt', equalBytes: true });
      assert.equal(f.nativeEntry.contentId, f.nativeEntry.proof.decodedSha256);
      assert.equal(await f.register(), true);
    });
    const f = await seedVerifiedImportOperation(dbf), baseline = await count(db);
    const rejectProof = async (name, change) => t.test(name, async () => {
      const p = structuredClone(f.nativeEntry); p.evidenceId += '-bad'; change(p);
      await assert.rejects(f.register([p]), /MEDIA_(IMPORT_LINEAGE_REQUIRED|PROVENANCE_INVALID)/);
      assert.equal(await count(db), baseline, 'rejected proof writes no provenance');
    });
    for (const [field, value] of Object.entries({ platformRef: 'gid://shopify/MediaImage/123456789', url: 'https://cdn.shopify.com/s/files/1/0001/other.png',
      decodedSha256: '1'.repeat(64), mime: 'image/jpeg', width: 801, height: 901, byteLength: 1235, ownership: 'owned_storage',
      sourceEvidenceId: 'unknown-parent', operationId: randomUUID() })) {
      await rejectProof('refuses altered proof ' + field, p => { p.proof[field] = value; });
    }
    const otherOp = (await db.query('select id from toptik_media_private.operations where product_gid<>$1 limit 1', [f.product])).rows[0].id;
    await rejectProof('refuses a real operation from another product', p => { p.proof.operationId = otherOp; });
    await rejectProof('refuses another logical key', p => { p.key = 'a'; });
    await rejectProof('refuses another semantic content', p => { p.contentId = '2'.repeat(64); });
    await rejectProof('refuses sourceEvidenceId without operationId', p => { delete p.proof.operationId; });
    await rejectProof('refuses operationId without sourceEvidenceId', p => { delete p.proof.sourceEvidenceId; });
    await rejectProof('refuses malformed operation identity without a UUID cast fallback', p => { p.proof.operationId = 'not-an-operation'; });
    const rejectMutation = async (name, sql, args = []) => t.test(name, async () => {
      await db.exec('begin');
      try {
        await db.query(sql, args);
        await assert.rejects(f.register(), /MEDIA_IMPORT_LINEAGE_REQUIRED/);
      } finally { await db.exec('rollback'); }
      assert.equal(await count(db), baseline, 'denied transaction writes no provenance');
    });
    for (const phase of ['create_owned', 'associate']) {
      for (const status of ['started', 'uncertain', 'conflict']) await rejectMutation(`refuses ${status} ${phase}`,
        'update toptik_media_private.transport_attempts set status=$3 where operation_id=$1 and phase=$2', [f.op, phase, status]);
      await rejectMutation(`refuses ${phase} without its durable receipt`,
        'update toptik_media_private.transport_attempts set receipt=null where operation_id=$1 and phase=$2', [f.op, phase]);
      await rejectMutation(`refuses ambiguous duplicate ${phase} receipts`,
        `insert into toptik_media_private.transport_attempts(operation_id,step_index,phase_index,attempt_id,phase,request_hash,request,before_guard,after_guard,status,receipt)
         select operation_id,step_index,8,$3,phase,request_hash,request,before_guard,after_guard,status,receipt
         from toptik_media_private.transport_attempts where operation_id=$1 and phase=$2`, [f.op, phase, randomUUID()]);
    }
    for (const [name, sql, args] of [
      ['wrong association product', "update toptik_media_private.transport_attempts set request=jsonb_set(request,'{productGid}',to_jsonb('gid://shopify/Product/999999'::text)) where operation_id=$1 and phase='associate'", [f.op]],
      ['wrong association media', "update toptik_media_private.transport_attempts set request=jsonb_set(request,'{mediaGid}',to_jsonb('gid://shopify/MediaImage/999999'::text)) where operation_id=$1 and phase='associate'", [f.op]],
      ['duplicate associated native identity', "update toptik_media_private.transport_attempts set after_guard=jsonb_set(after_guard,'{target,media}',(after_guard#>'{target,media}')||jsonb_build_array((after_guard#>'{target,media,2}')||jsonb_build_object('image',jsonb_build_object('url','https://cdn.shopify.com/s/files/1/0001/other.png')))) where operation_id=$1 and phase='associate'", [f.op]],
      ['wrong create parent', "update toptik_media_private.transport_attempts set request=jsonb_set(request,'{sourceEvidenceId}',to_jsonb('another-parent'::text)) where operation_id=$1 and phase='create_owned'", [f.op]],
      ['wrong step key', "update toptik_media_private.steps set body=jsonb_set(body,'{key}',to_jsonb('a'::text)) where operation_id=$1 and step_index=0", [f.op]],
      ['wrong step source', "update toptik_media_private.steps set body=jsonb_set(body,'{source}',to_jsonb('shopify'::text)) where operation_id=$1 and step_index=0", [f.op]],
      ['duplicate source logical key', "update toptik_media_private.operations set observed_pair=jsonb_set(observed_pair,'{gallery,assets}',(observed_pair#>'{gallery,assets}')||jsonb_build_array(observed_pair#>'{gallery,assets,2}')) where id=$1", [f.op]],
      ['wrong step target', "update toptik_media_private.steps set body=jsonb_set(body,'{target}',to_jsonb('gallery'::text)) where operation_id=$1 and step_index=0", [f.op]],
      ['wrong expected semantic content', "update toptik_media_private.steps set expected_pair=jsonb_set(expected_pair,'{shopify,assets,2,contentId}',to_jsonb(repeat('f',64))) where operation_id=$1 and step_index=0", [f.op]],
      ['wrong current step', 'update toptik_media_private.operations set next_step=1 where id=$1', [f.op]],
      ['conflicted step', "update toptik_media_private.steps set status='conflict' where operation_id=$1", [f.op]],
      ['conflicted chain', "update toptik_media_private.transport_chains set status='conflict' where operation_id=$1", [f.op]],
      ['conflicted operation', "update toptik_media_private.operations set status='conflict' where id=$1", [f.op]],
    ]) await rejectMutation('refuses ' + name, sql, args);
    await t.test('a batch containing one invalid proof rolls back an earlier valid proof', async () => {
      const wrong = structuredClone(f.nativeEntry); wrong.evidenceId += '-wrong'; wrong.proof.width++;
      await assert.rejects(f.register([f.nativeEntry, wrong]), /MEDIA_IMPORT_LINEAGE_REQUIRED/);
      assert.equal(await count(db), baseline);
    });
    await t.test('the public RPC still requires the exact lease and enabled identity', async () => {
      await assert.rejects(f.rpc('register_toptik_media_provenance', [f.product, randomUUID(), [f.nativeEntry]]), /MEDIA_LEASE_LOST/);
      await db.query('update toptik_media_private.products set enabled=false where product_gid=$1', [f.product]);
      await assert.rejects(f.register(), /MEDIA_APPROVAL_MISSING_OR_CHANGED/);
      assert.equal(await count(db), baseline);
    });
    await t.test('migration replay preserves the owner, function signature, ACL and configuration', async () => {
      const info = async () => (await db.query(`select proowner,proacl,prosecdef,proconfig,prorettype,proargtypes,prolang,
        has_function_privilege('service_role',oid,'EXECUTE') service_exec,
        has_function_privilege('anon',oid,'EXECUTE') anon_exec,
        has_function_privilege('authenticated',oid,'EXECUTE') authenticated_exec
        from pg_proc where oid='toptik_media_private.register(text,jsonb)'::regprocedure`)).rows[0];
      const before = await info();
      assert.equal(before.service_exec, false); assert.equal(before.anon_exec, false); assert.equal(before.authenticated_exec, false);
      await db.exec(await readFile(migration, 'utf8'));
      assert.deepEqual(await info(), before);
    });
  } finally { await db.close(); }
});
