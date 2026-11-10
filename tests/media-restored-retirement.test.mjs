import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { loadWrapped, dataUrl, policy } from './helpers/owned-edit-harness.mjs';
import { fixture as planningFixture, id, owner, opId, now, core, gallery, ready } from './helpers/media-planning-fixture.mjs';

const pure = file => import(dataUrl(stripTypeScriptTypes(readFileSync(file, 'utf8'))));
const authCore = await pure('src/lib/admin/authz-core.ts');
const sessionPolicy = await pure('src/lib/admin/gallery-session-policy.ts');
const { assertVerifiedCopyApproval } = (await loadWrapped('src/lib/shopify/sync-rules.ts', ['normalizeCatalogKey'], ['assertVerifiedCopyApproval']))({ normalizeCatalogKey: () => { throw Error('unused'); } });
const { reviewIdentity } = (await loadWrapped('src/lib/shopify/reviewed-media-record.ts', ['createHash', 'createHmac', 'timingSafeEqual'], ['reviewIdentity']))({ createHash, timingSafeEqual });
const guard = (await loadWrapped('src/lib/shopify/reviewed-media-guard.ts', ['manifest'], ['assertNotDeniedMedia', 'requireReviewedMedia', 'isReviewedMediaProof', 'reviewedMediaRegistry']))({
  manifest: JSON.parse(readFileSync('src/lib/shopify/reviewed-media-manifest.json', 'utf8')),
});
const actualObservation = (await loadWrapped('src/lib/shopify/media-planning-observation.ts',
  ['createHash', 'mediaReadToSnapshot', 'galleryRawToSnapshot', 'assertNotDeniedMedia', 'requireReviewedMedia', 'isReviewedMediaProof', 'reviewedMediaRegistry', 'loadReviewedMedia'],
  ['captureMediaPlanningPair']))({ createHash, mediaReadToSnapshot: ready.mediaReadToSnapshot, galleryRawToSnapshot: gallery.galleryRawToSnapshot,
  ...guard, loadReviewedMedia: async () => [] });
const api = (await loadWrapped('src/lib/shopify/media-restored-retirement.ts',
  ['VERIFIED_COPY_COLUMNS', 'assertVerifiedCopyApproval', 'reviewIdentity', 'isShopifyOwnedVariant', 'createMediaTransportRpc', 'captureMediaPlanningPair', 'parseGalleryMediaRaw', 'mediaSnapshotFingerprint', 'process'],
  ['parseRestoredRetirementCommand', 'assertRestoredMediaPair', 'retireRestoredMediaOperation']))({
  VERIFIED_COPY_COLUMNS: 'verified-columns', assertVerifiedCopyApproval, reviewIdentity,
  isShopifyOwnedVariant: policy.isShopifyOwnedVariant, parseGalleryMediaRaw: gallery.parseGalleryMediaRaw, mediaSnapshotFingerprint: core.mediaSnapshotFingerprint,
  process: { env: {} }, createMediaTransportRpc: () => { throw Error('transport must be injected'); }, captureMediaPlanningPair: () => { throw Error('capture must be injected'); },
});
const requestId = 'a0000000-0000-4000-8000-000000000005';
const actor = { actorId: 'a0000000-0000-4000-8000-000000000006', authMethod: 'session_admin' };
const command = () => ({ itemId: id.itemId, operationId: opId, requestId, approval: 'RESTORED_BEFORE_TRANSPORT' });
function fixture() {
  const base = planningFixture(), calls = [], state = { now, contextReads: 0, onRead: null, onCapture: null, finalError: null, finalResult: null,
    environment: { VERCEL_ENV: 'production', SHOPIFY_MEDIA_SYNC: 'enabled_v1' } };
  const operation = { id: opId, product_gid: id.productId, state_version: 1, version: 2, next_step: 0, status: 'running', request_hash: 'a'.repeat(64) };
  const queue = { product_gid: id.productId, generation: 57, status: 'review', claim_id: null, claimed_generation: null, claimed_at: null, evidence: { source: 'preserved' } };
  const context = { planningContext: base.context, operation, queueFence: queue, priorReceipt: null };
  base.context.operations = [operation];
  const approval = { product_gid: id.productId, variant_gid: id.variantId, carousel_item_id: id.itemId, catalog_key: 'ABC01',
    exact_gallery_sku: id.exactGallerySku, exact_shopify_sku: id.exactShopifySku, approved_product_handle: id.productHandle,
    enabled: true, approval_id: 'approved', allowed_fields: ['title', 'description', 'seoTitle', 'seoDescription'], alias_evidence: { reviewed: true } };
  const success = () => ({ status: 'conflict', code: 'MEDIA_RESTORED_BEFORE_TRANSPORT', retiredBeforeTransport: true,
    mayExecute: false, operationId: opId, requestId, stateVersion: 1, operationVersion: 3, queueStatus: 'pending' });
  const db = { from(table) {
    assert.equal(table, 'shopify_gallery_copy_eligibility'); const q = {
      select(columns) { assert.equal(columns, 'verified-columns'); return q; }, eq(key, value) { assert.equal(key, 'carousel_item_id'); assert.equal(value, id.itemId); return q; },
      limit(value) { assert.equal(value, 2); return q; }, async abortSignal() { calls.push(['eligibility']); return { data: [approval], error: null }; },
    }; return q;
  }, rpc(name, args) {
    return { async abortSignal(signal) {
      assert.equal(signal.aborted, false); calls.push([name, structuredClone(args)]);
      if (name === 'read_toptik_media_retirement_context') { state.onRead?.(++state.contextReads); return { data: structuredClone(context), error: null }; }
      assert.equal(name, 'retire_restored_toptik_media_operation');
      if (state.finalError) return { data: null, error: state.finalError };
      return { data: state.finalResult ?? success(), error: null };
    } };
  } };
  const dependencies = { now: () => state.now, environment: state.environment,
    transport: (productId, options) => { assert.equal(productId, id.productId); assert.equal(options.client, db); return {
      acquire: async () => { calls.push(['acquire']); return { owner, expiresAt: now + 100000 }; },
      release: async (leaseOwner) => { assert.equal(leaseOwner, owner); calls.push(['release']); },
    }; },
    capture: async (c, leaseOwner, deadline) => { calls.push(['capture']); state.onCapture?.();
      return actualObservation.captureMediaPlanningPair(c, leaseOwner, deadline, { now: () => state.now,
        capture: async () => base.bytes, shopify: async () => base.read, gallery: () => ({ read: async () => base.raw }) }); },
  };
  return { base, calls, state, context, approval, db, dependencies,
    run: (c = command(), a = actor) => api.retireRestoredMediaOperation(db, c, a, state.now + 55000, dependencies) };
}

test('retirement input accepts only explicit exact operation decision and never client proofs or URLs', () => {
  assert.deepEqual(api.parseRestoredRetirementCommand(command()), command());
  for (const input of [null, [], {}, { ...command(), approval: true }, { ...command(), pair: {} }, { ...command(), url: 'https://x.test' },
    { ...command(), operationId: 'all' }, { ...command(), itemId: [id.itemId] }]) assert.throws(() => api.parseRestoredRetirementCommand(input), /MEDIA_RETIREMENT_INPUT_INVALID/);
});

test('actual planning capture, fresh fences and final RPC retain conflict/pending truth without a native or baseline write', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.status, 'conflict'); assert.equal(result.queueStatus, 'pending'); assert.equal(result.mayExecute, false);
  assert.deepEqual(f.calls.map(c => c[0]), ['eligibility', 'acquire', 'read_toptik_media_retirement_context', 'capture', 'read_toptik_media_retirement_context', 'retire_restored_toptik_media_operation', 'release']);
  const sent = f.calls.find(c => c[0] === 'retire_restored_toptik_media_operation')[1];
  assert.deepEqual(sent.p_current_pair, f.base.pair); assert.deepEqual(sent.p_gallery_raw, f.base.raw); assert.deepEqual(sent.p_gallery_refs, f.base.refs);
  assert.equal(sent.p_expected_state_version, 1); assert.equal(sent.p_expected_operation_version, 2); assert.equal(sent.p_expected_operation_hash, 'a'.repeat(64));
  assert.equal(sent.p_actor_id, actor.actorId); assert.equal(sent.p_auth_method, 'session_admin'); assert.deepEqual(sent.p_queue_fence, f.context.queueFence);
  assert.equal(f.context.operation.status, 'running', 'runtime never mutates the operation object');
});

test('restoration compares the committed baseline, never an operation initial pair containing an extra native photo', async () => {
  const f = fixture(); f.context.operation.initial_pair = structuredClone(f.base.pair);
  f.context.operation.initial_pair.shopify.assets.push({ ...f.base.pair.shopify.assets[0], key: 'temporary', evidenceId: 's-temporary' });
  assert.equal((await f.run()).retiredBeforeTransport, true);
});

test('only read revisions may differ; every asset field, order and identity remains exact', () => {
  const f = fixture(), current = structuredClone(f.base.pair); current.gallery.revision = 'fresh-gallery'; current.shopify.revision = 'fresh-shopify';
  api.assertRestoredMediaPair(current, f.base.pair, id);
  for (const mutate of [p => { p.gallery.assets[0].alt += ' changed'; }, p => { p.shopify.assets[0].contentId = 'c'.repeat(64); },
    p => { p.gallery.assets[0].evidenceId = 'unapproved'; }, p => { p.shopify.assets[0].key = 'different'; },
    p => { p.gallery.identity.itemId = requestId; }, p => { p.gallery.complete = false; },
    p => { p.gallery.assets.push({ ...p.gallery.assets[0], key: 'another' }); }]) {
    const p = structuredClone(current); mutate(p); assert.throws(() => api.assertRestoredMediaPair(p, f.base.pair, id), /MEDIA_/);
  }
  const baseline = structuredClone(f.base.pair); for (const side of ['gallery', 'shopify']) baseline[side].assets.push({ ...baseline[side].assets[0], key: 'second' });
  const reversed = structuredClone(baseline); reversed.gallery.assets.reverse(); assert.throws(() => api.assertRestoredMediaPair(reversed, baseline, id), /NOT_RESTORED/);
});

test('a changed Gallery or native asset during server capture never reaches the retirement RPC', async () => {
  for (const mutate of [f => { f.base.read.images[0].alt = 'changed'; f.base.read.fingerprint = 'c'.repeat(64); },
    f => { f.base.raw.item.cover_image_alt = 'changed'; f.base.raw.angles[0].image_alt = 'changed'; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.run(), /MEDIA_/);
    assert.equal(f.calls.some(c => c[0] === 'retire_restored_toptik_media_operation'), false); assert.equal(f.calls.at(-1)[0], 'release');
  }
});

test('state, operation, queue and raw Gallery drift after capture stops before SQL mutation', async () => {
  for (const mutate of [f => { f.context.planningContext.stateVersion++; }, f => { f.context.operation.version++; },
    f => { f.context.operation.request_hash = 'b'.repeat(64); }, f => { f.context.queueFence.generation++; },
    f => { f.context.queueFence.claim_id = requestId; }, f => { f.context.planningContext.galleryRaw.item.title += ' changed'; }]) {
    const f = fixture(); f.state.onRead = n => { if (n === 2) mutate(f); };
    await assert.rejects(f.run(), /MEDIA_RETIREMENT_/); assert.equal(f.calls.some(c => c[0] === 'retire_restored_toptik_media_operation'), false);
    assert.equal(f.calls.at(-1)[0], 'release');
  }
});

test('uncertain operations, foreign identity, source-owned colors and disabled environment never gain a fallback', async () => {
  for (const mutate of [f => { f.context.operation.status = 'uncertain'; }, f => { f.context.operation.product_gid = 'gid://shopify/Product/999'; },
    f => { f.context.planningContext.identity.productHandle = 'changed'; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.run(), /MEDIA_RETIREMENT_/); assert.equal(f.calls.some(c => c[0] === 'capture'), false);
  }
  for (const v of [...policy.FZT73_VARIANTS, ...policy.MD20_VARIANTS]) {
    const f = fixture(); await assert.rejects(f.run({ ...command(), itemId: v.itemId }), /OWNED_GROUP_UNSUPPORTED/); assert.deepEqual(f.calls, []);
  }
  const disabled = fixture(); disabled.state.environment.VERCEL_ENV = 'preview'; await assert.rejects(disabled.run(), /DISABLED/); assert.deepEqual(disabled.calls, []);
});

test('SQL guards rejecting any transport history propagate and still release the lease', async () => {
  for (const code of ['MEDIA_RETIREMENT_TRANSPORT_ATTEMPTED', 'MEDIA_RETIREMENT_ARTIFACT_EXISTS', 'MEDIA_RETIREMENT_STATE_CHANGED',
    'MEDIA_RETIREMENT_QUEUE_BUSY', 'MEDIA_RETIREMENT_LEASE_LOST', 'MEDIA_RETIREMENT_REQUEST_REUSED']) {
    const f = fixture(); f.state.finalError = { code: 'P0001', message: code }; await assert.rejects(f.run(), new RegExp(code));
    assert.equal(f.calls.at(-1)[0], 'release');
  }
});

test('lost final RPC response is explicitly uncertain; retry captures fresh and uses the same approval/request', async () => {
  const f = fixture(); f.state.finalError = { message: 'gateway response lost' };
  await assert.rejects(f.run(), /MEDIA_RETIREMENT_RESULT_UNCERTAIN/);
  f.state.finalError = null; f.context.operation.status = 'conflict'; f.context.operation.version = 3;
  f.context.queueFence.status = 'pending'; f.context.queueFence.generation++;
  f.context.priorReceipt = { request_id: requestId, operation_id: opId, event_kind: 'restored_before_transport' };
  f.state.now += 1000; f.state.finalResult = { status: 'conflict', code: 'MEDIA_RESTORED_BEFORE_TRANSPORT', retiredBeforeTransport: true,
    mayExecute: false, operationId: opId, requestId, stateVersion: 1, operationVersion: 3, queueStatus: 'pending', replayed: true };
  assert.equal((await f.run()).replayed, true);
  const sent = f.calls.filter(c => c[0] === 'retire_restored_toptik_media_operation').map(c => c[1]);
  assert.equal(f.calls.filter(c => c[0] === 'capture').length, 2); assert.equal(sent[0].p_request_id, sent[1].p_request_id);
  assert.notEqual(sent[0].p_observed_at, sent[1].p_observed_at); assert.equal(sent[1].p_expected_operation_version, 3);
  assert.equal(sent[1].p_queue_fence.generation, sent[0].p_queue_fence.generation + 1);
});

test('false verified/done or malformed final receipts are never exposed as completed sync', async () => {
  for (const result of [[], { status: 'verified', queueStatus: 'done', retiredBeforeTransport: true }, { status: 'conflict', mayExecute: true }]) {
    const f = fixture(); f.state.finalResult = result; await assert.rejects(f.run(), /RESULT_UNCERTAIN/);
  }
});

test('actual runtime and planning capture retire through the real PGlite RPC boundary with zero transport and unchanged baselines', { timeout: 60000 }, async () => {
  const { createRestoredRetirementDatabase, seedRestoredRetirement } = await import('./helpers/media-restored-retirement-sql-fixture.mjs');
  const dbf = await createRestoredRetirementDatabase();
  try {
    const f = await seedRestoredRetirement(dbf), initial = await f.context(), calls = [];
    let capturedPair;
    const baselineBefore = (await f.db.query('select to_jsonb(s) v from toptik_media_private.state s where product_gid=$1', [f.product])).rows[0].v;
    const proofFor = key => initial.planningContext.provenance.find(p => p.side === 'shopify' && p.asset_key === key);
    const connection = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
    const native = ready.parseMediaReadResponse({ data: { product: {
      id: f.product, handle: f.identity.productHandle, status: 'ACTIVE', publishedOnPublication: true, updatedAt: '2026-11-10T06:00:00Z',
      mediaCount: { count: f.base.shopify.assets.length, precision: 'EXACT' },
      media: connection(f.base.shopify.assets.map(asset => { const p = proofFor(asset.key); return {
        id: p.proof.platformRef, mediaContentType: 'IMAGE', status: 'READY', fileStatus: 'READY', alt: asset.alt, updatedAt: '2026-11-10T06:00:00Z',
        image: { id: `gid://shopify/ImageSource/${p.proof.platformRef.split('/').at(-1)}`, url: p.proof.url, width: p.proof.width, height: p.proof.height },
      }; })), variants: connection([{ id: f.identity.variantId, sku: f.identity.exactShopifySku, image: null, media: connection([]) }]),
    } } }, f.identity);
    const sdk = {
      from(table) {
        assert.equal(table, 'shopify_gallery_copy_eligibility'); let itemId;
        const q = { select() { return q; }, eq(key, value) { assert.equal(key, 'carousel_item_id'); itemId = value; return q; },
          limit(n) { assert.equal(n, 2); return q; }, async abortSignal() {
            const rows = (await f.db.query('select * from public.shopify_gallery_copy_eligibility where carousel_item_id=$1', [itemId])).rows;
            const approved = (await f.db.query('select approval_id from toptik_media_private.products where product_gid=$1', [f.product])).rows[0];
            return { data: rows.map(row => ({ ...row, approval_id: approved.approval_id,
              allowed_fields: ['title', 'description', 'seoTitle', 'seoDescription'], alias_evidence: { fixtureApproved: true } })), error: null };
          } }; return q;
      },
      rpc(name, args) { return { async abortSignal() {
        assert.ok(['read_toptik_media_retirement_context', 'retire_restored_toptik_media_operation'].includes(name)); calls.push(name);
        try { return { data: await f.rpc(name, Object.values(args)), error: null }; }
        catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
      } }; },
    };
    let captureProvider;
    const result = await api.retireRestoredMediaOperation(sdk, { itemId: f.identity.itemId, operationId: f.op, requestId: f.request, approval: 'RESTORED_BEFORE_TRANSPORT' },
      { actorId: f.actor, authMethod: 'session_admin' }, Date.now() + 55000, {
        environment: { VERCEL_ENV: 'production', SHOPIFY_MEDIA_SYNC: 'enabled_v1' },
        transport: () => ({ acquire: async () => ({ owner: f.owner, expiresAt: Date.now() + 120000 }), release: async () => { calls.push('release'); } }),
        capture: (captureProvider = async (c, leaseOwner, deadline) => {
          calls.push('actual-capture'); const observation = await actualObservation.captureMediaPlanningPair(c, leaseOwner, deadline, {
            shopify: async () => native, gallery: () => ({ read: async () => f.rpc('read_toptik_gallery_media', [f.product, f.owner]) }),
            capture: async (_identity, imageUrl) => {
              const p = c.provenance.find(p => p.proof.url === imageUrl); assert.ok(p);
              return { sha256: p.proof.decodedSha256, mime: p.proof.mime, width: p.proof.width, height: p.proof.height,
                byteLength: p.proof.byteLength, bytes: new Uint8Array(p.proof.byteLength), visual: '11'.repeat(9216) };
            },
          });
          capturedPair = observation.pair;
          return observation;
        }),
      });
    assert.equal(result.status, 'conflict'); assert.equal(result.queueStatus, 'pending'); assert.equal(result.operationVersion, 3);
    assert.deepEqual(calls, ['read_toptik_media_retirement_context', 'actual-capture', 'read_toptik_media_retirement_context', 'retire_restored_toptik_media_operation', 'release']);
    assert.deepEqual((await f.db.query('select to_jsonb(s) v from toptik_media_private.state s where product_gid=$1', [f.product])).rows[0].v, baselineBefore);
    assert.equal((await f.db.query('select count(*)::int n from toptik_media_private.transport_attempts where operation_id=$1', [f.op])).rows[0].n, 0);
    assert.deepEqual((await f.db.query('select status from toptik_media_private.steps where operation_id=$1 order by step_index', [f.op])).rows.map(x => x.status), ['started', 'ready']);
    // The preserved old step/chain must not keep the ordinary worker lane blocked.
    const nextContext = await f.rpc('read_toptik_media_planning_context', [f.product, f.owner]);
    assert.equal(nextContext.operations.filter(o => ['reserved', 'running', 'uncertain'].includes(o.status)).length, 0);
    assert.equal(nextContext.operations[0].id, f.op); assert.equal(nextContext.operations[0].status, 'conflict');
    const freshAfterRetirement = await captureProvider(nextContext, f.owner, Date.now() + 30000);
    capturedPair = freshAfterRetirement.pair;
    const plan = f.core.reconcileMedia(nextContext.baselines, capturedPair);
    assert.deepEqual(plan.conflicts, []); assert.deepEqual(plan.patches, []); assert.deepEqual(plan.orders, []);
    assert.notDeepEqual(capturedPair, nextContext.baselines, 'fresh restoration revisions require a metadata-only commit');
    const claim = await f.rpc('claim_toptik_media_work', [randomUUID()]);
    assert.equal(claim.productId, f.product);
    const nextOperation = randomUUID();
    const reserved = await f.rpc('reserve_toptik_media_operation', [f.product, f.owner, nextOperation, nextContext.stateVersion, capturedPair, plan]);
    assert.equal(reserved.steps, 0);
    const committed = await f.rpc('commit_toptik_media_operation', [f.product, f.owner, nextOperation, randomUUID(), capturedPair]);
    assert.equal(committed.status, 'verified'); assert.equal(committed.stateVersion, 16);
    const after = (await f.db.query('select baselines from toptik_media_private.state where product_gid=$1', [f.product])).rows[0].baselines;
    for (const side of ['gallery', 'shopify']) assert.deepEqual({ ...after[side], revision: baselineBefore.baselines[side].revision }, baselineBefore.baselines[side]);
    assert.equal(await f.rpc('finish_toptik_media_work', [f.product, claim.claimId, claim.generation, 'done', null]), true);
    const queue = (await f.db.query('select status,last_error from toptik_media_private.work_queue where product_gid=$1', [f.product])).rows[0];
    assert.deepEqual(queue, { status: 'done', last_error: null });
    assert.equal((await f.db.query('select status from toptik_media_private.operations where id=$1', [f.op])).rows[0].status, 'conflict');
    assert.equal((await f.db.query('select count(*)::int n from toptik_media_private.transport_attempts where operation_id in($1,$2)', [f.op, nextOperation])).rows[0].n, 0);
  } finally { await dbf.db.close(); }
});

const makeRoute = await loadWrapped('src/app/api/admin/shopify/media/retire-restored/route.ts',
  ['NextResponse', 'authorizeGalleryAdmin', 'createSupabaseServiceRoleClient', 'parseRestoredRetirementCommand', 'retireRestoredMediaOperation', 'Buffer'], ['POST']);
const makeToken = await loadWrapped('src/lib/admin/admin-token.ts', ['createHash', 'timingSafeEqual', 'NextResponse', 'supabaseEnv', 'process'], ['requireAdminToken']);
const makeAuth = await loadWrapped('src/lib/admin/authz.ts', ['NextResponse', 'redirect', 'getPanelUser', 'authorizePanelUser'], ['requireAdminUser']);
const makeAccess = await loadWrapped('src/lib/admin/gallery-access.ts', ['NextResponse', 'requireAdminToken', 'requireAdminUser', 'allowsGallerySessionRequest'], ['authorizeGalleryAdmin']);
const NextResponse = { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers }) };
const user = role => ({ id: actor.actorId, email: 'synthetic@example.test', email_confirmed_at: '2026-11-10T00:00:00Z', app_metadata: { role, provider: 'email' }, user_metadata: {} });
function routeFixture(principal = user('admin')) {
  const calls = [], auth = makeAuth({ NextResponse, redirect: () => { throw Error('unexpected redirect'); }, getPanelUser: async () => principal, authorizePanelUser: authCore.authorizePanelUser });
  const token = makeToken({ createHash, timingSafeEqual, NextResponse, supabaseEnv: { adminToken: 'synthetic-token' }, process: { env: {} } });
  const access = makeAccess({ NextResponse, requireAdminToken: token.requireAdminToken, requireAdminUser: auth.requireAdminUser, allowsGallerySessionRequest: sessionPolicy.allowsGallerySessionRequest });
  const route = makeRoute({ NextResponse, authorizeGalleryAdmin: access.authorizeGalleryAdmin, Buffer,
    parseRestoredRetirementCommand: api.parseRestoredRetirementCommand, createSupabaseServiceRoleClient: () => { calls.push('client'); return {}; },
    retireRestoredMediaOperation: async (_db, c, actorValue) => { calls.push(['retire', c, actorValue]); return { status: 'conflict', queueStatus: 'pending', mayExecute: false }; },
  });
  return { calls, post: (body = command(), headers = {}) => route.POST({ method: 'POST', nextUrl: new URL('https://landing.toptik.co.il/api/admin/shopify/media/retire-restored?token=synthetic-token'),
    headers: new Headers({ 'content-type': 'application/json', origin: 'https://landing.toptik.co.il', 'sec-fetch-site': 'same-origin', ...headers }),
    get body() { calls.push('body'); return new Response(typeof body === 'string' ? body : JSON.stringify(body)).body; } }) };
}

test('real admin session gate rejects anonymous, non-admin, forged and unconfirmed users before body/client', async () => {
  for (const principal of [null, user('member'), { ...user('admin'), app_metadata: {}, user_metadata: { role: 'owner' } }, { ...user('owner'), email_confirmed_at: null }]) {
    const f = routeFixture(principal), response = await f.post(); assert.ok([401, 403].includes(response.status)); assert.deepEqual(f.calls, []);
  }
});
test('real session CSRF checks reject missing/null/foreign origin and cross-site requests', async () => {
  for (const headers of [{ origin: '' }, { origin: 'null' }, { origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    const f = routeFixture(); assert.equal((await f.post(command(), headers)).status, 403); assert.deepEqual(f.calls, []);
  }
});
test('owner/admin and exact automation token authorize server-bound actor metadata only', async () => {
  for (const principal of [user('owner'), user('admin'), null]) {
    const f = routeFixture(principal), response = await f.post(command(), principal === null ? { 'x-admin-token': 'synthetic-token' } : {});
    assert.equal(response.status, 200); assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(f.calls[2][2].authMethod, principal ? 'session_admin' : 'admin_token');
    assert.equal(f.calls[2][2].actorId, principal ? actor.actorId : 'f4a10335-5d41-4b70-9e16-93bb74a52eba');
  }
});
test('malformed, arbitrary-proof, spoofed-actor and oversized bodies cannot create service clients', async () => {
  for (const [body, headers, status] of [['{', {}, 400], [null, {}, 400], [{ ...command(), pair: {} }, {}, 400],
    [{ ...command(), actorId: actor.actorId }, {}, 400], [command(), { 'content-length': '1025' }, 413],
    [' '.repeat(1025), {}, 413], [command(), { 'content-type': 'text/plain' }, 415]]) {
    const f = routeFixture(); assert.equal((await f.post(body, headers)).status, status); assert.equal(f.calls.includes('client'), false);
  }
});
test('runtime exposes no native/storage/baseline mutator or provenance registration path', () => {
  const source = readFileSync('src/lib/shopify/media-restored-retirement.ts', 'utf8');
  assert.doesNotMatch(source, /\.(?:insert|update|upsert|delete|upload|remove|register|observe|commit|phase)\s*\(/);
  assert.doesNotMatch(source, /(?:writeShopify|runPersistedMediaPhase|scheduleMedia|enqueueReviewedMedia)\s*\(/);
});
