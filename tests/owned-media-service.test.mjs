import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { load, policy, phases, binding, product, snapshot, restamp, operationId, owner } from './helpers/group-media-fixture.mjs';
const variants = binding.variants.map(v => ({ itemId: v.itemId, sku: v.sku, variantId: v.variantGid.split('/').at(-1), color: v.sku }));
const planner = (await load('src/lib/shopify/owned-media-plan.ts',
  ['createHash', 'assertGroupMediaBinding', 'assertGroupMediaReady', 'groupMediaFingerprint', 'FZT73_PRODUCT_GID', 'FZT73_PRODUCT_HANDLE', 'FZT73_VARIANTS', 'MD20_PRODUCT_GID', 'MD20_PRODUCT_HANDLE', 'MD20_VARIANTS'],
  ['ownedMediaBinding', 'ownedMediaHash', 'assertOwnedMediaManifest', 'planOwnedMediaChange', 'planOwnedMediaObservation', 'resolveOwnedMediaPlan']))({
  createHash, ...policy, FZT73_PRODUCT_GID: product, FZT73_PRODUCT_HANDLE: binding.handle, FZT73_VARIANTS: variants,
  MD20_PRODUCT_GID: 'gid://shopify/Product/999', MD20_PRODUCT_HANDLE: 'other', MD20_VARIANTS: [],
});
const exports = ['readOwnedMediaEditor', 'readOwnedMediaAdoptionSource', 'applyOwnedMediaEdit', 'resumeOwnedMediaEdit'];
const makeService = await load('src/lib/shopify/owned-media-service.ts',
  ['ownedFamilyForItem', 'readGroupMediaSnapshot', 'buildOwnedMediaPhaseSpecs', 'runOwnedMediaOperationPhases',
    'assertOwnedMediaManifest', 'ownedMediaBinding', 'ownedMediaHash', 'planOwnedMediaChange', 'planOwnedMediaObservation', 'resolveOwnedMediaPlan',
    'readOwnedMediaRegistry', 'readOwnedMediaReceipt', 'prepareOwnedMediaOperation', 'readOwnedMediaOperation', 'recordOwnedMediaPhase',
    'commitOwnedMediaOperation', 'readOwnedMediaProjectionEntries', 'stageOwnedMediaUpload'], exports);
const service = makeService({ ...planner, ...phases, ownedFamilyForItem: id => variants.some(v => v.itemId === id) ? { productGid: product, variants } : null });
const itemId = binding.variants[0].itemId;
const img = n => `gid://shopify/MediaImage/${n}`;
function fixture() {
  const f = { live: snapshot(), events: [], receipt: null, runStatus: 'pending', registered: true, failCommit: false };
  f.manifest = { schemaVersion: 1, productGid: product, handle: binding.handle, globalOrder: f.live.media.map(m => m.mediaId),
    variants: binding.variants.map((v, i) => ({ ...v, orderedMediaIds: i ? [img(3)] : [img(1), img(2)], coverMediaId: i ? img(3) : img(1) })), ignoredMediaIds: [img(4)] };
  f.context = { registered: true, binding, mapVersion: 3, sourceFingerprint: f.live.fingerprint, manifest: f.manifest,
    snapshot: structuredClone(f.live), cards: binding.variants.map(v => ({ itemId: v.itemId, catalogKey: v.sku, isActive: true, expectedVersion: '2026-11-09T10:00:00Z', expectedRevision: 3, projection: {} })), operation: null };
  f.execution = { owner, actor: { actorType: 'supabase_user', actorId: owner }, deadline: Date.now() + 60000 };
  f.command = { requestId: operationId, itemId, expectedMapVersion: 3, expectedSourceFingerprint: f.live.fingerprint,
    desiredImages: [1, 2].map(n => ({ mediaId: img(n), alt: `photo ${n}` })) };
  f.deps = { environment: { VERCEL_ENV: 'production', SHOPIFY_MEDIA_SYNC: 'enabled_v1' }, journal: () => ({}),
    registry: async () => { f.events.push('registry'); return { ...f.context, registered: f.registered }; },
    receipt: async () => { f.events.push('receipt'); return { binding, operation: f.receipt }; },
    read: async () => { f.events.push('read'); return structuredClone(f.live); },
    stage: async () => { f.events.push('stage'); throw new Error('TEST_STAGE_REFUSED'); },
    prepare: async (_db, input) => { f.events.push('prepare'); f.prepared = input;
      f.receipt = { id: input.requestId, productGid: product, status: 'prepared', mapVersion: 3, sourceFingerprint: input.source.fingerprint,
        command: input.command, plan: input.plan, phases: input.phases, nextPhase: 0, cursor: input.source, attempts: [], artifacts: [], expectedCards: f.context.cards };
      return f.receipt;
    },
    run: async op => { f.events.push('run'); if (f.runStatus === 'phases_verified') {
      const wanted = op.plan.desiredManifest;
      f.live.media = wanted.globalOrder.map(id => f.live.media.find(m => m.mediaId === id));
      for (const variant of wanted.variants) f.live.variants.find(v => v.variantGid === variant.variantGid).image = {
        id: 'gid://shopify/ProductImage/999', url: f.live.media.find(m => m.mediaId === variant.coverMediaId).image.url };
      restamp(f.live);
    }
      return { status: f.runStatus, cursor: structuredClone(f.live), artifacts: [], createdMediaIdsByUploadKey: {}, nextPhase: op.phases.length, executed: true };
    },
    entries: async (_db, _binding, _source, _manifest, cards) => { f.events.push('entries'); return cards.map(card => ({ ...card, variantGid: binding.variants.find(v => v.itemId === card.itemId).variantGid })); },
    commit: async (_db, input) => { f.events.push('commit'); if (f.failCommit) throw new Error('TEST_CAS_CONFLICT');
      return { ...f.context, mapVersion: 4, manifest: input.manifest, sourceFingerprint: input.source.fingerprint, snapshot: input.source };
    },
  };
  return f;
}
test('read is lazy and reports unadopted maps as disabled without granting mutation authority', async () => {
  const f = fixture(); f.registered = false;
  const data = await service.readOwnedMediaEditor({}, itemId, f.execution.deadline, f.deps);
  assert.equal(data.enabled, false); assert.equal(data.pending, null);
  assert.deepEqual(f.events, ['registry', 'read']);
});

test('pinned source audit accepts only a known color and never reads or writes a database', async () => {
  const f = fixture();
  const answer = await service.readOwnedMediaAdoptionSource(itemId, f.execution.deadline, f.deps);
  assert.equal(answer.readOnly, true); assert.equal(answer.apiVersion, '2026-07');
  assert.equal(answer.source.fingerprint, f.live.fingerprint); assert.deepEqual(f.events, ['read']);
  await assert.rejects(service.readOwnedMediaAdoptionSource('unknown', f.execution.deadline, f.deps), /ITEM_UNKNOWN/);
});
test('hidden cards, stale map version and stale source refuse before preparation or any transport', async () => {
  for (const change of [f => { f.context.cards[0].isActive = false; }, f => { f.command.expectedMapVersion = 2; }, f => { f.command.expectedSourceFingerprint = '0'.repeat(64); }]) {
    const f = fixture(); change(f);
    await assert.rejects(service.applyOwnedMediaEdit({}, f.command, f.execution, f.deps), /OWNED_MEDIA_/);
    assert.equal(f.events.some(event => ['prepare', 'stage', 'run', 'commit'].includes(event)), false);
  }
});
test('pending phases are durable but never reported as a completed Gallery update', async () => {
  const f = fixture(), result = await service.applyOwnedMediaEdit({}, f.command, f.execution, f.deps);
  assert.equal(result.status, 'pending'); assert.equal(f.events.includes('commit'), false);
  assert.ok(f.events.indexOf('prepare') < f.events.indexOf('run'));
  assert.deepEqual(f.prepared.actor, { actorType: 'session_admin', actorId: owner });
});
test('success requires final native readback, every color projection and the atomic DB readback', async () => {
  const f = fixture(); f.runStatus = 'phases_verified'; f.command.desiredImages.reverse();
  const result = await service.applyOwnedMediaEdit({}, f.command, f.execution, f.deps);
  assert.equal(result.status, 'done'); assert.match(result.checkpoint, /:4:/);
  assert.ok(f.events.indexOf('run') < f.events.lastIndexOf('read'));
  assert.ok(f.events.indexOf('entries') < f.events.indexOf('commit'));
});
test('a completed receipt is replayed without upload, preparation or native mutation, even if the feature is now disabled', async () => {
  const f = fixture(); await service.applyOwnedMediaEdit({}, f.command, f.execution, f.deps);
  f.receipt.status = 'verified'; f.events = [];
  const result = await service.applyOwnedMediaEdit({}, f.command, f.execution, { ...f.deps, environment: {} });
  assert.equal(result.status, 'done'); assert.deepEqual(f.events, ['receipt', 'registry', 'read', 'entries']);
});
test('a request ID cannot be reused with changed order or another color', async () => {
  const f = fixture(); await service.applyOwnedMediaEdit({}, f.command, f.execution, f.deps); f.events = [];
  await assert.rejects(service.applyOwnedMediaEdit({}, { ...f.command, desiredImages: [...f.command.desiredImages].reverse() }, f.execution, f.deps), /REQUEST_CONFLICT/);
  assert.deepEqual(f.events, ['receipt']);
  await assert.rejects(service.resumeOwnedMediaEdit({}, { itemId: binding.variants[1].itemId, requestId: operationId }, f.execution, f.deps), /OPERATION_UNKNOWN/);
});
test('a projection CAS failure is not success and cannot submit a replacement native intent', async () => {
  const f = fixture(); f.runStatus = 'phases_verified'; f.failCommit = true;
  await assert.rejects(service.applyOwnedMediaEdit({}, f.command, f.execution, f.deps), /TEST_CAS_CONFLICT/);
  assert.equal(f.events.filter(event => event === 'prepare').length, 1);
});
test('upload decoding failure never reserves or executes a Shopify write', async () => {
  const f = fixture(); f.command.desiredImages.push({ mediaId: null, uploadUrl: `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/items/${itemId}/owned-drafts/new.jpg`, alt: 'photo' });
  await assert.rejects(service.applyOwnedMediaEdit({}, f.command, f.execution, f.deps), /TEST_STAGE_REFUSED/);
  assert.equal(f.events.includes('stage'), true); assert.equal(f.events.includes('prepare'), false); assert.equal(f.events.includes('run'), false);
});

test('withdrawing a native product stops a new edit without restoring visibility or touching media', async () => {
  const f = fixture(); f.live.product.status = 'UNLISTED'; restamp(f.live); f.command.expectedSourceFingerprint = f.live.fingerprint;
  await assert.rejects(service.applyOwnedMediaEdit({}, f.command, f.execution, f.deps), /SOURCE_UNPUBLISHED/);
  assert.equal(f.events.includes('prepare'), false); assert.equal(f.events.includes('run'), false);
});

test('native media drift during commit is detected after the DB readback without another native write', async () => {
  const f = fixture(); f.runStatus = 'phases_verified'; const commit = f.deps.commit;
  f.deps.commit = async (...args) => { const saved = await commit(...args); f.live.media[0].alt = 'changed during commit'; restamp(f.live); return saved; };
  const answer = await service.applyOwnedMediaEdit({}, f.command, f.execution, f.deps);
  assert.equal(answer.status, 'review'); assert.equal(f.events.filter(event => event === 'run').length, 1);
});
test('copy-only drift after commit is detected even when the media graph fingerprint is unchanged', async () => {
  const f = fixture(); f.runStatus = 'phases_verified'; const entries = f.deps.entries; let reads = 0;
  f.deps.entries = async (...args) => { const result = await entries(...args); reads++; return reads === 1 ? result : result.map(entry => ({ ...entry, projection: { title: 'new Shopify title' } })); };
  const answer = await service.applyOwnedMediaEdit({}, f.command, f.execution, f.deps);
  assert.equal(answer.status, 'review'); assert.equal(reads, 2); assert.equal(f.events.filter(event => event === 'run').length, 1);
});
