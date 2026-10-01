import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const src = name => readFileSync(new URL(`../src/lib/shopify/${name}.ts`, import.meta.url), 'utf8');
const mod = text => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(resolveImageLimits(text))).toString('base64');
const coreUrl = mod(src('media-sync-core')), core = await import(coreUrl);
const readUrl = mod(src('media-transport-read').replaceAll('from "./media-sync-core";', `from "${coreUrl}";`));
const read = await import(readUrl);
const source = src('media-transport-rpc');
const api = await import(mod(source.replace('import "server-only";', '').replace('import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";',
  'const createSupabaseServiceRoleClient = () => { throw new Error("factory secret never expose"); };').replaceAll('from "./media-sync-core";', `from "${coreUrl}";`).replaceAll('from "./media-transport-read";', `from "${readUrl}";`)));
const id = { productId: 'gid://shopify/Product/7550812619002', variantId: 'gid://shopify/ProductVariant/42465754808570', itemId: '6f887176-e70a-44ba-b252-238f994b66ad', exactGallerySku: 'P10SZV24-05J-TU', exactShopifySku: 'P10SZV2405J', productHandle: 'logoduck-i-טרולי' };
const ref = { operationId: '10000000-0000-4000-8000-000000000001', step: 0, phaseIndex: 0 };
const owner = '20000000-0000-4000-8000-000000000001', attempt = '30000000-0000-4000-8000-000000000001', request = '40000000-0000-4000-8000-000000000001';
const now = Date.now(), stamp = new Date(now).toISOString(), hash = 'a'.repeat(64), intent = { mutationSha256: hash, mediaGids: ['gid://shopify/MediaImage/1'] };
const gallery = { identity: id, side: 'gallery', complete: true, revision: 'gallery-v1', assets: [{ key: 'a', contentId: hash, alt: 'עברית', evidenceId: 'g-a' }] };
const shopify = { ...structuredClone(gallery), side: 'shopify', revision: 'shop-v1' }, pair = { gallery, shopify };
const conn = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
const raw = read.parseMediaTransportResponse({ data: { product: { id: id.productId, handle: id.productHandle, status: 'ACTIVE', publishedOnPublication: true, updatedAt: stamp,
  mediaCount: { count: 1, precision: 'EXACT' }, media: conn([{ id: 'gid://shopify/MediaImage/1', mediaContentType: 'IMAGE', status: 'READY', fileStatus: 'READY', updatedAt: stamp, alt: 'עברית', image: { id: 'gid://shopify/ImageSource/2', url: 'https://cdn.shopify.com/s/files/1/x.png', width: 10, height: 10 } }]),
  variants: conn([{ id: id.variantId, sku: id.exactShopifySku, image: { id: 'gid://shopify/ProductImage/3', url: 'https://cdn.shopify.com/s/files/1/x.png' }, media: conn([{ id: 'gid://shopify/MediaImage/1' }]) }]) } } }, id);
const guard = { sourceFingerprint: hash, target: raw, observedAt: stamp };
function fixture(handler) {
  const calls = [], signals = [];
  const client = { rpc(name, args) { calls.push({ name, args }); return { abortSignal(signal) { signals.push(signal); return Promise.resolve().then(() => handler(name, args, signal)); } }; } };
  return { calls, signals, options: { client, now: () => now }, rpc: api.createMediaTransportRpc(id.productId, { client, now: () => now }) };
}
const ok = data => ({ data, error: null });
const permit = args => ok({ mayExecute: true, phase: 'reorder', attemptId: args.p_attempt_id, requestHash: hash, request: args.p_request, replayed: false });
const journal = () => ({ chain: null, attempts: [], artifacts: [], desiredSemanticSha256: hash });
const discovery = () => ({ identity: id, enabled: true, operation: { id: ref.operationId, product_gid: id.productId, status: 'running', observed_pair: pair },
  step: { operation_id: ref.operationId, step_index: 0, status: 'started', expected_pair: pair }, transport: journal(), provenance: [], desiredSemanticSha256: hash });

test('server-only fixed factory, no direct table writes or arbitrary exported RPC', () => {
  assert.match(source, /^import "server-only"/); assert.match(source, /createSupabaseServiceRoleClient/);
  assert.doesNotMatch(source, /\.from\(|\.schema\(|console\.|fetch\(/);
  assert.deepEqual(Object.keys(api).sort(), ['createMediaTransportRpc', 'discoverMediaTransportOperation']);
});
test('exact discovery args and paired alias survive trusted server read', async () => {
  const f = fixture(() => ok(discovery())); const d = await api.discoverMediaTransportOperation(ref, now + 1000, f.options);
  assert.deepEqual(d.identity, id); assert.equal(f.calls[0].name, 'read_toptik_media_operation');
  assert.deepEqual(f.calls[0].args, { p_operation_id: ref.operationId, p_step_index: 0, p_phase_index: 0 });
});
for (const [name, mutate] of [['wrong operation', d => d.operation.id = owner], ['wrong product', d => d.operation.product_gid += '1'], ['wrong step', d => d.step.step_index = 9],
  ['foreign provenance', d => d.provenance = [{ product_gid: id.productId + '1', evidence_id: 'x', proof: {} }]], ['nonboolean enable', d => d.enabled = 'true']]) {
  test(`discovery rejects ${name}`, async () => { const d = discovery(); mutate(d); const f = fixture(() => ok(d)); await assert.rejects(api.discoverMediaTransportOperation(ref, now + 1000, f.options), /MEDIA_RPC_DISCOVERY_INVALID/); });
}
test('lease reads actual DB expiry and release uses owner-bound RPC', async () => {
  const f = fixture((name, args) => ok(name === 'acquire_shopify_reconciliation_lease' ? true : name === 'read_toptik_media_lease' ? { owner: args.p_owner, expiresAt: now + 300000 } : null));
  const l = await f.rpc.acquire(now + 1000); assert.equal(l.expiresAt, now + 300000); await f.rpc.release(l.owner, now + 1000);
  assert.deepEqual(f.calls.map(c => c.name), ['acquire_shopify_reconciliation_lease', 'read_toptik_media_lease', 'release_shopify_reconciliation_lease']);
  assert.ok(f.signals.every(s => s instanceof AbortSignal));
});
test('busy lease never reads expiry or retries', async () => { const f = fixture(() => ok(false)); assert.equal(await f.rpc.acquire(now + 1000), null); assert.equal(f.calls.length, 1); });
test('expired or foreign lease reply grants nothing', async () => {
  for (const lease of [{ owner, expiresAt: now + 300000 }, { owner: null, expiresAt: now - 1 }]) { const f = fixture(name => ok(name === 'acquire_shopify_reconciliation_lease' ? true : lease)); await assert.rejects(f.rpc.acquire(now + 1000), /LEASE_INVALID/); }
});
test('prepare/begin/read use exact SQL names and bounded args', async () => {
  const f = fixture((name, args) => name === 'begin_toptik_media_transport' ? permit(args) : ok(name === 'read_toptik_media_transport' ? journal() : { status: 'ready', mayExecute: false }));
  await f.rpc.prepare(ref, owner, request, ['reorder'], guard, now + 1000); const p = await f.rpc.begin(ref, owner, attempt, intent, guard, now + 1000); assert.equal(p.mayExecute, true);
  await f.rpc.read(ref, owner, now + 1000); assert.equal(f.calls[1].args.p_attempt_id, attempt); assert.deepEqual(f.calls[1].args.p_request, intent);
  assert.deepEqual(Object.keys(f.calls[1].args).sort(), ['p_product_gid', 'p_lease_owner', 'p_operation_id', 'p_step_index', 'p_phase_index', 'p_attempt_id', 'p_request', 'p_fresh_guard'].sort());
});
for (const [name, edit] of [['replayed true', p => p.replayed = true], ['foreign attempt', p => p.attemptId = owner], ['changed payload', p => p.request.mediaGids = []], ['invalid hash', p => p.requestHash = 'bad']]) {
  test(`permit rejects ${name}`, async () => { const f = fixture((_, args) => { const p = structuredClone(permit(args)); edit(p.data); return p; }); await assert.rejects(f.rpc.begin(ref, owner, attempt, intent, guard, now + 1000), /PERMIT_INVALID/); });
}
test('verified no-op preserves mayExecute false', async () => { const f = fixture(() => ok({ mayExecute: false, status: 'verified', verifiedNoop: true })); assert.equal((await f.rpc.begin(ref, owner, attempt, intent, guard, now + 1000)).mayExecute, false); });
test('uncertain accepts opaque UUID Job and never forwards full response', async () => {
  const f = fixture(() => ok({ status: 'uncertain', mayExecute: false })); await f.rpc.uncertain(ref, owner, { outcome: 'accepted', jobId: 'gid://shopify/Job/6dfa599a-a426-4030-8f10-6564abc465f9' }, now + 1000, request);
  assert.equal(f.calls[0].args.p_request_id, request);
  await assert.rejects(f.rpc.uncertain(ref, owner, { outcome: 'accepted', secret: 'x' }, now + 1000), /RECEIPT_INVALID/); assert.equal(f.calls.length, 1);
});
test('accept computes raw Shopify and core Gallery hashes itself', async () => {
  const f = fixture(() => ok({ status: 'verified', mayExecute: false }));
  await f.rpc.accept(ref, owner, request, hash, guard, null, now + 1000); assert.equal(f.calls[0].args.p_receipt.readbackSha256, raw.revision);
  await f.rpc.accept(ref, owner, request, hash, { ...guard, target: gallery }, null, now + 1000); assert.equal(f.calls[1].args.p_receipt.readbackSha256, core.mediaSnapshotFingerprint(gallery));
});
test('hold only matches locally granted, still-unsent permit and stores exact guard', async () => {
  const f = fixture((name, args) => name === 'begin_toptik_media_transport' ? permit(args) : ok({ status: 'conflict', mayExecute: false, notSent: true }));
  await assert.rejects(f.rpc.conflict(ref, owner, 'MEDIA_TRANSPORT_CHANGED_BEFORE_CALL', guard, now + 1000), /HOLD_WITHOUT_PERMIT/);
  await f.rpc.begin(ref, owner, attempt, intent, guard, now + 1000); await f.rpc.conflict(ref, owner, 'MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET', guard, now + 1000, request);
  assert.equal(f.calls[1].name, 'hold_toptik_media_transport'); assert.equal(f.calls[1].args.p_attempt_id, attempt); assert.deepEqual(f.calls[1].args.p_guard, guard);
  await assert.rejects(f.rpc.conflict(ref, owner, 'MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET', guard, now + 1000), /HOLD_WITHOUT_PERMIT/);
});
test('uncertain attempt cannot later be claimed not-sent even if uncertain RPC times out', async () => {
  const f = fixture((name, args) => name === 'begin_toptik_media_transport' ? permit(args) : Promise.reject(new Error('secret transport token')));
  await f.rpc.begin(ref, owner, attempt, intent, guard, now + 1000); await assert.rejects(f.rpc.uncertain(ref, owner, { outcome: 'unknown' }, now + 1000), /^Error: MEDIA_RPC_FAILED$/);
  await assert.rejects(f.rpc.conflict(ref, owner, 'MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET', guard, now + 1000), /HOLD_WITHOUT_PERMIT/);
});
test('planner conflict sends actual pair and version, no inferred proof', async () => {
  const f = fixture(() => ok({ status: 'conflict', mayExecute: false })); const conflicts = [{ key: 'a', field: 'alt', code: 'MEDIA_CONCURRENT_FIELD_CONFLICT' }];
  await f.rpc.recordPlannerConflict(owner, request, 2, pair, conflicts, now + 1000); assert.deepEqual(f.calls[0].args.p_current, pair); assert.equal(f.calls[0].args.p_expected_version, 2);
});
test('bad reference, stale guard and tampered snapshot fail before network', async () => {
  const f = fixture(() => { throw Error('must not call'); });
  await assert.rejects(f.rpc.read({ ...ref, operationId: 'not UUID' }, owner, now + 1000), /ID_INVALID/);
  await assert.rejects(f.rpc.begin(ref, owner, attempt, intent, { ...guard, observedAt: new Date(now - 301000).toISOString() }, now + 1000), /GUARD_INVALID/);
  const changed = structuredClone(guard); changed.target.media[0].alt = 'tampered'; await assert.rejects(f.rpc.begin(ref, owner, attempt, intent, changed, now + 1000), /READ_CHANGED/); assert.equal(f.calls.length, 0);
});
test('all raw error text is masked, only exact known code prefixes survive', async () => {
  for (const [message, expected] of [['token=secret https://private', 'MEDIA_RPC_FAILED'], ['MEDIA_TRANSPORT_SOURCE_CHANGED', 'MEDIA_TRANSPORT_SOURCE_CHANGED'], ['MEDIA_SECRET https://secret', 'MEDIA_RPC_FAILED'], ['OTHER_STATIC', 'MEDIA_RPC_FAILED']]) {
    const f = fixture(() => ({ data: null, error: { message } })); await assert.rejects(f.rpc.read(ref, owner, now + 1000), new RegExp(`^Error: ${expected}$`)); assert.equal(f.calls.length, 1);
  }
});
test('expired deadline cannot initialize service factory or make network call', async () => {
  const f = fixture(() => { throw Error('must not call'); }); await assert.rejects(f.rpc.acquire(now - 1), /TIME_BUDGET/); assert.equal(f.calls.length, 0);
  const def = api.createMediaTransportRpc(id.productId); await assert.rejects(def.acquire(Date.now() - 1), /TIME_BUDGET/);
});
test('hanging RPC is aborted and bounded once, no retry', async () => {
  const f = fixture(() => new Promise(() => {})); const rpc = api.createMediaTransportRpc(id.productId, { ...f.options, maxRpcMs: 15 });
  await assert.rejects(rpc.read(ref, owner, now + 1000), /TIME_BUDGET/); assert.equal(f.calls.length, 1); assert.equal(f.signals[0].aborted, true);
});
