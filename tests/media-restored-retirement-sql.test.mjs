// Actual ordinary RPCs on local PGlite. No network, deployed database, or native platform writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRestoredRetirementDatabase, seedRestoredRetirement } from './helpers/media-restored-retirement-sql-fixture.mjs';

const row = async (db, query, args = []) => (await db.query(query, args)).rows[0];
const snapshot = async f => ({
  op: (await row(f.db, 'select to_jsonb(o) v from toptik_media_private.operations o where id=$1', [f.op])).v,
  state: (await row(f.db, 'select to_jsonb(s) v from toptik_media_private.state s where product_gid=$1', [f.product])).v,
  steps: (await f.db.query('select * from toptik_media_private.steps where operation_id=$1 order by step_index', [f.op])).rows,
  chains: (await f.db.query('select * from toptik_media_private.transport_chains where operation_id=$1 order by step_index', [f.op])).rows,
  provenance: (await f.db.query('select * from toptik_media_private.provenance where product_gid=$1 order by evidence_id', [f.product])).rows,
  queue: (await row(f.db, 'select to_jsonb(q) v from toptik_media_private.work_queue q where product_gid=$1', [f.product]))?.v ?? null,
  events: (await f.db.query('select * from toptik_media_private.events where product_gid=$1 order by request_id', [f.product])).rows,
  gallery: await f.rpc('read_toptik_gallery_media', [f.product, f.owner]),
});

test('restored ordinary retirement is fenced, transport-free and terminal conflict only', { timeout: 60000 }, async t => {
  const dbf = await createRestoredRetirementDatabase(), { db } = dbf;
  try {
    await t.test('read context is exact by operation ID and read only', async () => {
      const f = await seedRestoredRetirement(dbf), before = await snapshot(f), c = await f.context();
      assert.equal(c.operation.id, f.op); assert.equal(c.operation.status, 'running'); assert.equal(c.operation.version, 2);
      assert.deepEqual(c.steps.map(s => s.status), ['started', 'ready']); assert.deepEqual(c.chains.map(s => [s.status, s.next_phase]), [['ready', 0]]);
      assert.equal(c.transportAttemptCount, 0); assert.equal(c.transportArtifactCount, 0); assert.equal(c.galleryCommitCount, 0);
      assert.equal(c.priorReceipt, null); assert.deepEqual(c.queueFence, before.queue);
      assert.deepEqual(c.planningContext, await f.rpc('read_toptik_media_planning_context', [f.product, f.owner]));
      assert.deepEqual(await snapshot(f), before);
    });
    await t.test('running saved case retires only its operation, appends audit, and enqueues pending', async () => {
      const f = await seedRestoredRetirement(dbf), before = await snapshot(f), argv = await f.args(), result = await f.retire(argv), after = await snapshot(f);
      assert.deepEqual(result, { status: 'conflict', retiredBeforeTransport: true, replayed: false, mayExecute: false, code: 'MEDIA_RESTORED_BEFORE_TRANSPORT',
        operationId: f.op, requestId: f.request, operationVersion: 3, stateVersion: 15, queueStatus: 'pending' });
      assert.deepEqual(after.op, { ...before.op, status: 'conflict', version: 3, updated_at: after.op.updated_at });
      assert.notEqual(after.op.updated_at, before.op.updated_at);
      assert.equal((await row(db, 'select $1::timestamptz > $2::timestamptz v', [after.op.updated_at, before.op.updated_at])).v, true);
      for (const key of ['state', 'steps', 'chains', 'provenance', 'gallery']) assert.deepEqual(after[key], before[key], key + ' unchanged');
      assert.equal(after.queue.status, 'pending'); assert.equal(after.queue.generation, before.queue.generation + 1);
      assert.equal(after.queue.claim_id, null); assert.equal(after.queue.claimed_generation, null); assert.equal(after.queue.routine, false);
      assert.equal(after.queue.evidence.restoredBeforeTransport, f.request);
      assert.equal(after.events.length, before.events.length + 1);
      const receipt = (await f.context()).priorReceipt;
      assert.equal(receipt.event_kind, 'restored_before_transport'); assert.equal(receipt.evidence.command.actorId, f.actor);
      assert.equal(receipt.evidence.command.approval, 'RESTORED_BEFORE_TRANSPORT');
      assert.deepEqual(receipt.evidence.before.operation, before.op); assert.deepEqual(receipt.evidence.before.state, before.state);
      assert.deepEqual(receipt.evidence.fences.queueFence, argv[10]); assert.deepEqual(receipt.evidence.capture.currentPair, f.currentPair);
      await assert.rejects(db.query("update toptik_media_private.events set event_kind='other' where request_id=$1", [f.request]), /MEDIA_IMMUTABLE_RECORD/);
      const replay = await f.retire(await f.args());
      assert.deepEqual(replay, { ...result, replayed: true }); assert.deepEqual(await snapshot(f), after, 'replay writes nothing');
      const newPair = structuredClone(f.currentPair); newPair.shopify.revision = 'new-revision-only';
      assert.equal((await f.retire(await f.args({ currentPair: newPair }))).replayed, true);
      await assert.rejects(f.retire(await f.args({ actorId: randomUUID() })), /MEDIA_RETIREMENT_REQUEST_REUSED/);
      await assert.rejects(f.retire(await f.args({ authMethod: 'admin_token' })), /MEDIA_RETIREMENT_REQUEST_REUSED/);
      await assert.rejects(f.retire(await f.args({ requestId: randomUUID() })), /MEDIA_RETIREMENT_OPERATION_STATE/);
      await db.exec('begin');
      try {
        await db.query('update toptik_media_private.operations set version=version+1 where id=$1', [f.op]);
        await assert.rejects(f.retire(await f.args()), /MEDIA_RETIREMENT_REPLAY_CHANGED/);
      } finally { await db.exec('rollback'); }
      await db.exec('begin');
      try {
        await db.query("update toptik_media_private.work_queue set status='done' where product_gid=$1", [f.product]);
        const replayDone = await f.retire(await f.args());
        assert.equal(replayDone.status, 'conflict'); assert.equal(replayDone.replayed, true); assert.equal(replayDone.queueStatus, 'done');
      } finally { await db.exec('rollback'); }
      await db.exec('begin');
      try {
        await db.query('update toptik_media_private.state set version=version+1 where product_gid=$1', [f.product]);
        await assert.rejects(f.retire(await f.args()), /MEDIA_RETIREMENT_VERSION_CHANGED/);
      } finally { await db.exec('rollback'); }
      await db.exec('begin');
      try {
        await db.query("update toptik_media_private.state set baselines=jsonb_set(baselines,'{shopify,revision}',to_jsonb('changed-baseline'::text)) where product_gid=$1", [f.product]);
        await assert.rejects(f.retire(await f.args()), /MEDIA_RETIREMENT_REPLAY_CHANGED/);
      } finally { await db.exec('rollback'); }
      await db.exec('begin');
      try {
        await db.query(`insert into toptik_media_private.operations(id,product_gid,state_version,plan,initial_pair,request_hash,observed_pair)
         select $2,product_gid,state_version,plan,initial_pair,request_hash,observed_pair from toptik_media_private.operations where id=$1`, [f.op, randomUUID()]);
        await assert.rejects(f.retire(await f.args()), /MEDIA_RETIREMENT_NEW_OPERATION/);
      } finally { await db.exec('rollback'); }
    });
    await t.test('reserved operation with ready steps and absent chain can retire', async () => {
      const f = await seedRestoredRetirement(dbf, { reserved: true }), c = await f.context();
      assert.equal(c.operation.status, 'reserved'); assert.deepEqual(c.chains, []);
      assert.equal((await f.retire(await f.args())).status, 'conflict');
    });
    const f = await seedRestoredRetirement(dbf);
    const rejectArgs = async (name, over, pattern = /MEDIA_RETIREMENT_/) => t.test(name, async () => {
      const before = await snapshot(f); await assert.rejects(f.retire(await f.args(over)), pattern); assert.deepEqual(await snapshot(f), before);
    });
    for (const [name, over] of [
      ['wrong approval', { approval: 'RETIRE' }], ['absent actor', { actorId: null }], ['wrong auth method', { authMethod: 'public' }],
      ['stale state version', { expectedStateVersion: 14 }], ['stale operation version', { expectedOperationVersion: 1 }],
      ['wrong operation hash', { expectedOperationHash: 'f'.repeat(64) }], ['stale observed time', { observedAt: '2020-01-01T00:00:00Z' }],
      ['future observed time', { observedAt: '2099-01-01T00:00:00Z' }], ['wrong queue generation', { queueFence: { ...(await f.context()).queueFence, generation: 99999 } }],
      ['missing queue fence', { queueFence: null }], ['wrong lease owner', { owner: randomUUID() }],
    ]) await rejectArgs('refuses ' + name, over);
    for (const side of ['gallery', 'shopify']) for (const field of ['alt', 'contentId', 'evidenceId', 'key', 'order', 'identity', 'complete']) {
      const pair = structuredClone(f.currentPair);
      if (field === 'order') pair[side].assets.reverse();
      else if (field === 'identity') pair[side].identity.variantId = 'gid://shopify/ProductVariant/1';
      else if (field === 'complete') pair[side].complete = false;
      else pair[side].assets[0][field] = field === 'contentId' ? 'e'.repeat(64) : 'different';
      await rejectArgs(`refuses restored ${side} with changed ${field}`, { currentPair: pair });
    }
    const wrongRaw = structuredClone(f.raw); wrongRaw.item.cover_image_alt = 'not-live';
    await rejectArgs('refuses fabricated gallery raw', { galleryRaw: wrongRaw }, /MEDIA_RETIREMENT_GALLERY_CHANGED/);
    const wrongRefs = structuredClone(f.refs); wrongRefs[0].evidenceId = 'not-registered';
    await rejectArgs('refuses fabricated gallery references', { galleryRefs: wrongRefs }, /MEDIA_RETIREMENT_GALLERY_INVALID/);
    const rejectMutation = async (name, sql, args = [], pattern = /MEDIA_RETIREMENT_/) => t.test(name, async () => {
      const argv = await f.args(), before = await snapshot(f);
      await db.exec('begin');
      try { await db.query(sql, args); await assert.rejects(f.retire(argv), pattern); }
      finally { await db.exec('rollback'); }
      assert.deepEqual(await snapshot(f), before, 'failure leaves no retirement writes');
    });
    for (const status of ['started', 'uncertain', 'verified', 'conflict']) await rejectMutation('refuses any transport attempt: ' + status,
      `insert into toptik_media_private.transport_attempts(operation_id,step_index,phase_index,attempt_id,phase,request_hash,request,before_guard,status)
       values($1,0,0,$2,'stage_source',repeat('a',64),'{}','{}',$3)`, [f.op, randomUUID(), status], /MEDIA_RETIREMENT_TRANSPORT_EXISTS/);
    await rejectMutation('refuses transport with a persisted artifact',
      `with attempt as (insert into toptik_media_private.transport_attempts(operation_id,step_index,phase_index,attempt_id,phase,request_hash,request,before_guard,status)
       values($1,0,0,$2,'stage_source',repeat('a',64),'{}','{}','verified') returning operation_id,step_index,phase_index)
       insert into toptik_media_private.transport_artifacts(operation_id,step_index,phase_index,artifact) select operation_id,step_index,phase_index,'{}' from attempt`,
      [f.op, randomUUID()], /MEDIA_RETIREMENT_TRANSPORT_EXISTS/);
    await rejectMutation('refuses transport with a gallery commit receipt',
      `with attempt as (insert into toptik_media_private.transport_attempts(operation_id,step_index,phase_index,attempt_id,phase,request_hash,request,before_guard,status)
       values($1,0,0,$2,'gallery_cas',repeat('a',64),'{}','{}','verified') returning *)
       insert into toptik_media_private.gallery_commits(operation_id,step_index,phase_index,attempt_id,request_id,product_gid,request_hash,before_revision,after_raw,refs,snapshot)
       select operation_id,step_index,phase_index,attempt_id,$3,$4,request_hash,'before','{}','[]','{}' from attempt`,
      [f.op, randomUUID(), randomUUID(), f.product], /MEDIA_RETIREMENT_TRANSPORT_EXISTS/);
    for (const status of ['verified', 'uncertain', 'conflict']) await rejectMutation('refuses progressed logical step ' + status,
      'update toptik_media_private.steps set status=$2 where operation_id=$1 and step_index=0', [f.op, status], /MEDIA_RETIREMENT_LOGICAL_PROGRESS/);
    for (const [name, sql, args] of [
      ['logical readback', "update toptik_media_private.steps set readback_pair='{}' where operation_id=$1 and step_index=0", [f.op]],
      ['logical detached evidence', 'update toptik_media_private.steps set detach_verified=true where operation_id=$1 and step_index=0', [f.op]],
      ['logical verified timestamp', 'update toptik_media_private.steps set verified_at=clock_timestamp() where operation_id=$1 and step_index=0', [f.op]],
      ['later started logical step', "update toptik_media_private.steps set status='started' where operation_id=$1 and step_index=1", [f.op]],
      ['next step advanced', 'update toptik_media_private.operations set next_step=1 where id=$1', [f.op]],
      ['chain phase advanced', 'update toptik_media_private.transport_chains set next_phase=1 where operation_id=$1', [f.op]],
      ['running chain', "update toptik_media_private.transport_chains set status='running' where operation_id=$1", [f.op]],
      ['uncertain operation', "update toptik_media_private.operations set status='uncertain' where id=$1", [f.op]],
      ['queue claim changed', 'update toptik_media_private.work_queue set claim_id=$2 where product_gid=$1', [f.product, randomUUID()]],
      ['queue generation changed', 'update toptik_media_private.work_queue set generation=generation+1 where product_gid=$1', [f.product]],
      ['missing queue row', 'delete from toptik_media_private.work_queue where product_gid=$1', [f.product]],
      ['expired lease', "update shopify_gallery_reconciliation_leases set expires_at=clock_timestamp()-interval '1 second' where product_gid=$1", [f.product]],
      ['disabled media approval', 'update toptik_media_private.products set enabled=false where product_gid=$1', [f.product]],
      ['disabled copy approval', 'update shopify_gallery_copy_eligibility set enabled=false where product_gid=$1', [f.product]],
      ['gallery changed after capture', "update carousel_items set cover_image_alt='live change' where id=$1", [f.identity.itemId]],
    ]) await rejectMutation('refuses ' + name, sql, args);
    await t.test('a matching fresh active queue claim still refuses retirement', async () => {
      const before = await snapshot(f); await db.exec('begin');
      try {
        await db.query("update toptik_media_private.work_queue set status='processing',claim_id=$2,claimed_generation=generation,claimed_at=clock_timestamp() where product_gid=$1", [f.product, randomUUID()]);
        await assert.rejects(f.retire(await f.args()), /MEDIA_RETIREMENT_QUEUE_BUSY/);
      } finally { await db.exec('rollback'); }
      assert.deepEqual(await snapshot(f), before);
    });
    await t.test('lease expiry during validation is checked immediately before writes', async () => {
      const argv = await f.args(), before = await snapshot(f);
      const definition = (await row(db, "select pg_get_functiondef('toptik_media_private.gallery_raw(jsonb)'::regprocedure) v")).v;
      const injected = definition.replace('begin\n', "begin\n update public.shopify_gallery_reconciliation_leases set expires_at=clock_timestamp()-interval '1 second' where product_gid=i->>'productId';\n");
      assert.notEqual(injected, definition); await db.exec('begin');
      try { await db.exec(injected); await assert.rejects(f.retire(argv), /MEDIA_RETIREMENT_LEASE_EXPIRED/); }
      finally { await db.exec('rollback'); }
      assert.deepEqual(await snapshot(f), before);
    });
    await t.test('service-only RPCs deny anon/authenticated and add no queue table grant', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec('begin');
        try { await db.exec('set local role ' + role); await assert.rejects(f.context(), /permission denied/); }
        finally { await db.exec('rollback'); }
        const argv = await f.args(); await db.exec('begin');
        try { await db.exec('set local role ' + role); await assert.rejects(f.retire(argv), /permission denied/); }
        finally { await db.exec('rollback'); }
      }
      await db.exec('begin');
      try { await db.exec('set local role service_role'); assert.equal((await f.context()).operation.id, f.op); }
      finally { await db.exec('rollback'); }
      assert.equal((await row(db, "select has_table_privilege('service_role','toptik_media_private.work_queue','SELECT') v")).v, false);
      const argv = await f.args(); await db.exec('begin');
      try { await db.exec('set local role service_role'); assert.equal((await f.retire(argv)).retiredBeforeTransport, true); }
      finally { await db.exec('rollback'); }
    });
  } finally { await db.close(); }
});
