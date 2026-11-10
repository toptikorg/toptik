import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { loadWrapped, dataUrl, policy } from './helpers/owned-edit-harness.mjs';

const pure = file => import(dataUrl(stripTypeScriptTypes(readFileSync(file, 'utf8'))));
const authCore = await pure('src/lib/admin/authz-core.ts');
const sessionPolicy = await pure('src/lib/admin/gallery-session-policy.ts');
const { assertVerifiedCopyApproval } = (await loadWrapped('src/lib/shopify/sync-rules.ts', ['normalizeCatalogKey'], ['assertVerifiedCopyApproval']))({
  normalizeCatalogKey: () => { throw new Error('not used by approval validation'); },
});
const { reviewIdentity } = (await loadWrapped('src/lib/shopify/reviewed-media-record.ts',
  ['createHash', 'createHmac', 'timingSafeEqual'], ['reviewIdentity']))({ createHash, timingSafeEqual });
const guardSource = readFileSync('src/lib/shopify/reviewed-media-guard.ts', 'utf8').replace(/^import[^\n]*;\r?\n/gm, '');
const guard = await import(dataUrl(stripTypeScriptTypes('const manifest={items:[],deniedUrls:[],deniedSha256:[]};' + guardSource)));

const makeService = await loadWrapped('src/lib/shopify/media-diagnostic.ts',
  ['sharp', 'fetchShopifyMediaRead', 'VERIFIED_COPY_COLUMNS', 'assertVerifiedCopyApproval', 'reviewIdentity', 'assertNotDeniedMedia',
    'isShopifyOwnedVariant', 'captureMediaSourceBytes', 'readMediaStatus', 'process', 'AbortSignal'], ['readMediaDiagnostic', 'parseMediaDiagnosticInput']);
const versions = { node: '22.synthetic', sharp: 'synthetic-sharp', vips: 'synthetic-vips' };
const service = makeService({ sharp: { versions }, process: { versions }, AbortSignal,
  VERIFIED_COPY_COLUMNS: 'product_gid,catalog_key,carousel_item_id,variant_gid,exact_gallery_sku,exact_shopify_sku,approved_product_handle,allowed_fields,enabled,approval_id,approved_source_updated_at,alias_evidence',
  assertVerifiedCopyApproval, reviewIdentity, assertNotDeniedMedia: guard.assertNotDeniedMedia, isShopifyOwnedVariant: policy.isShopifyOwnedVariant,
  fetchShopifyMediaRead: () => { throw new Error('native network must be injected'); },
  captureMediaSourceBytes: () => { throw new Error('static network must be injected'); },
  readMediaStatus: () => { throw new Error('status read must be injected'); },
});
const itemId = 'c26842d5-7b67-4349-a2a8-b051189b86dd', mediaId = 'gid://shopify/MediaImage/100';
const identity = { productId: 'gid://shopify/Product/15402565665018', variantId: 'gid://shopify/ProductVariant/67616634798330', itemId,
  exactGallerySku: 'P10FZP61A28', exactShopifySku: 'P10FZP61A28', productHandle: 'synthetic-wallet-taupe' };
const url = 'https://cdn.shopify.com/s/files/1/0622/8082/7130/files/synthetic-exact-image.jpg?v=1';
const command = () => ({ itemId, mediaId });
const approval = () => ({ product_gid: identity.productId, catalog_key: identity.exactGallerySku, carousel_item_id: itemId,
  variant_gid: identity.variantId, exact_gallery_sku: identity.exactGallerySku, exact_shopify_sku: identity.exactShopifySku,
  approved_product_handle: identity.productHandle, allowed_fields: ['title', 'description', 'seoTitle', 'seoDescription'], enabled: true,
  approval_id: 'synthetic-approved-binding', approved_source_updated_at: '2026-11-10T00:00:00Z', alias_evidence: {} });
const card = () => ({ id: itemId, catalog_number: identity.exactGallerySku, is_active: true, editor_revision: 7 });
const binding = () => ({ catalog_key: identity.exactGallerySku, carousel_item_id: itemId, product_gid: identity.productId,
  variant_gid: identity.variantId, product_handle: identity.productHandle, is_published: true });
const link = () => ({ catalog_key: identity.exactGallerySku, product_handle: identity.productHandle, variant_id: '67616634798330', is_published: true });
const snapshot = () => ({ identity: structuredClone(identity), updatedAt: '2026-11-10T00:00:00Z', fingerprint: 'a'.repeat(64),
  images: [{ mediaId, imageId: 'gid://shopify/ImageSource/100', url, width: 1698, height: 2000, alt: 'Synthetic taupe wallet', updatedAt: '2026-11-10T00:00:00Z', variantAssigned: true }],
  variantMediaIds: [mediaId], variantImageId: 'gid://shopify/ProductImage/100', variantImageUrl: url });

function fixture() {
  const calls = [], state = { now: 1000, deadline: 40000, approval: [approval()], binding: [binding()], card: [card()], link: [link()], native: snapshot(),
    status: { product: { identity: structuredClone(identity), catalogKey: identity.exactGallerySku, copyEnabled: true, mediaEnabled: true, baselineVersion: 1 } },
    onQuery: null, onNative: null, onCapture: null, error: null, deniedUrls: [], deniedSha256: [] };
  const db = { from(table) {
    const q = { select(columns) { calls.push({ kind: 'select', table, columns }); return q; },
      eq(key, value) { calls.push({ kind: 'eq', table, key, value }); return q; },
      limit(value) { assert.equal(value, 2); return q; },
      async abortSignal(signal) { assert.equal(signal.aborted, false); state.onQuery?.(table);
        return { data: structuredClone(table === 'shopify_gallery_copy_eligibility' ? state.approval : table === 'shopify_gallery_bindings' ? state.binding : table === 'carousel_items' ? state.card : state.link), error: state.error }; },
    };
    assert.ok(['shopify_gallery_copy_eligibility', 'shopify_gallery_bindings', 'carousel_items', 'shopify_gallery_public_links'].includes(table));
    // There is intentionally no RPC, insert, update, upsert, delete, storage or lease capability in this fixture.
    return q;
  } };
  const dependencies = {
    now: () => state.now,
    status: async (id, deadline) => { assert.equal(id, identity.productId); assert.equal(deadline, state.deadline); calls.push({ kind: 'status' }); return structuredClone(state.status); },
    readNative: async (id, timeout, deadline) => { assert.deepEqual(id, identity); assert.equal(timeout, 8000); assert.equal(deadline, state.deadline);
      calls.push({ kind: 'native' }); state.onNative?.(); return structuredClone(state.native); },
    capture: async (id, source, deadline) => { assert.deepEqual(id, identity); assert.equal(source, url); assert.equal(deadline, state.deadline);
      calls.push({ kind: 'capture' }); state.onCapture?.(); return { bytes: Buffer.from('must never leave the service'), visual: 'private-pixel-signature',
        sha256: 'b'.repeat(64), mime: 'image/jpeg', width: 1698, height: 2000, byteLength: 123456 }; },
    deny: (source, sha) => { calls.push({ kind: 'deny', source, sha }); guard.assertNotDeniedMedia(source, sha,
      { items: [], deniedUrls: state.deniedUrls, deniedSha256: state.deniedSha256 }); },
  };
  return { db, calls, state, dependencies, run: (input = command()) => service.readMediaDiagnostic(db, input, state.deadline, dependencies) };
}

test('strict command accepts only one card and one native media ID, never caller URLs or proofs', () => {
  for (const input of [null, [], {}, { itemId }, { ...command(), extra: true }, { ...command(), imageUrl: url },
    { ...command(), productId: identity.productId }, { ...command(), expectedSha256: 'b'.repeat(64) },
    { itemId: [itemId], mediaId }, { itemId: itemId + ' ', mediaId }, { itemId, mediaId: url },
    { itemId, mediaId: 'gid://shopify/Product/100' }, { itemId, mediaId: 'gid://shopify/MediaImage/0' },
    { itemId, mediaId: 'gid://shopify/MediaImage/' + '1'.repeat(100) },
  ]) assert.throws(() => service.parseMediaDiagnosticInput(input), /MEDIA_DIAGNOSTIC_INPUT_INVALID/);
  assert.deepEqual(service.parseMediaDiagnosticInput(command()), command());
});

test('successful observation is one capture between two native reads and exact bounded binding SELECTs', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.readOnly, true); assert.equal(result.scope, 'ordinary_current_native_image');
  assert.equal(result.baselineComparison, 'unavailable'); assert.equal(result.baselineComparisonReason, 'READ_ONLY_PROOF_ACCESS_NOT_EXPOSED');
  assert.deepEqual(result.observation, { sha256: 'b'.repeat(64), mime: 'image/jpeg', width: 1698, height: 2000, byteLength: 123456 });
  assert.equal(result.native.mediaId, mediaId); assert.deepEqual(result.identity, identity);
  assert.equal(f.calls.filter(c => c.kind === 'capture').length, 1);
  assert.deepEqual(f.calls.filter(c => ['native', 'capture'].includes(c.kind)).map(c => c.kind), ['native', 'capture', 'native']);
  assert.equal(f.calls.filter(c => c.kind === 'select').length, 8); assert.equal(f.calls.filter(c => c.kind === 'status').length, 2);
  assert.deepEqual(f.calls.filter(c => c.kind === 'eq').map(c => c.value), [itemId, identity.productId, itemId, identity.exactGallerySku, itemId, identity.productId, itemId, identity.exactGallerySku]);
  const encoded = JSON.stringify(result);
  for (const hidden of ['must never leave the service', 'private-pixel-signature', 'bytes', 'visual', 'approval_id', 'alias_evidence']) assert.equal(encoded.includes(hidden), false, hidden);
});

test('all known shared-family cards are refused without any database or network read', async () => {
  for (const variant of [...policy.FZT73_VARIANTS, ...policy.MD20_VARIANTS]) {
    const f = fixture(); await assert.rejects(f.run({ itemId: variant.itemId, mediaId }), /MEDIA_DIAGNOSTIC_OWNED_GROUP_UNSUPPORTED/);
    assert.deepEqual(f.calls, []);
  }
});

test('only an enabled, unique, approved exact binding with an active card and published link can reach native read', async () => {
  const cases = [
    s => { s.approval = []; }, s => { s.approval.push(approval()); }, s => { s.approval[0].enabled = false; },
    s => { s.approval[0].approval_id = ''; }, s => { s.approval[0].allowed_fields.pop(); },
    s => { s.approval[0].exact_shopify_sku = 'other'; }, s => { s.approval[0].carousel_item_id = '11111111-1111-4111-8111-111111111111'; },
    s => { s.binding = []; }, s => { s.binding.push(binding()); }, s => { s.binding[0].is_published = false; },
    s => { s.binding[0].carousel_item_id = '11111111-1111-4111-8111-111111111111'; }, s => { s.binding[0].variant_gid = 'gid://shopify/ProductVariant/1'; },
    s => { s.binding[0].product_gid = 'gid://shopify/Product/1'; }, s => { s.binding[0].product_handle = 'changed'; },
    s => { s.card = []; }, s => { s.card.push(card()); }, s => { s.card[0].is_active = false; },
    s => { s.card[0].catalog_number = 'another-color'; }, s => { s.card[0].editor_revision = null; },
    s => { s.link = []; }, s => { s.link.push(link()); }, s => { s.link[0].is_published = false; },
    s => { s.link[0].variant_id = '1'; }, s => { s.link[0].product_handle = 'other'; }, s => { s.error = { message: 'private DB detail' }; },
    s => { s.status.product.mediaEnabled = false; }, s => { s.status.product.copyEnabled = false; }, s => { s.status.product = null; },
    s => { s.status.product.identity.productId = 'gid://shopify/Product/1'; }, s => { s.status.product.catalogKey = 'foreign'; },
  ];
  for (const alter of cases) { const f = fixture(); alter(f.state); await assert.rejects(f.run(), /^Error: MEDIA_DIAGNOSTIC_/);
    assert.equal(f.calls.some(c => c.kind === 'native' || c.kind === 'capture'), false); }
});

test('a requested media ID outside the current complete native graph is refused before capture', async () => {
  const f = fixture(); await assert.rejects(f.run({ itemId, mediaId: 'gid://shopify/MediaImage/999' }), /MEDIA_DIAGNOSTIC_MEDIA_NOT_CURRENT/);
  assert.equal(f.calls.some(c => c.kind === 'capture'), false);
});

test('identity/publication/multi-variant failures from the existing native reader cannot fall back to a URL', async () => {
  for (const code of ['MEDIA_IDENTITY_OR_PUBLICATION_CHANGED', 'MEDIA_VARIANT_CHANGED', 'MEDIA_RESPONSE_INCOMPLETE', 'MEDIA_ASSET_NOT_READY']) {
    const f = fixture(); f.dependencies.readNative = async () => { throw new Error(code); };
    await assert.rejects(f.run(), new RegExp(code)); assert.equal(f.calls.some(c => c.kind === 'capture'), false);
  }
});

test('URL denylist stops before capture; checksum denylist stops after exactly one capture', async () => {
  const before = fixture(); before.state.deniedUrls = [url];
  await assert.rejects(before.run(), /MEDIA_REVIEW_REJECTED/); assert.equal(before.calls.some(c => c.kind === 'capture'), false);
  const after = fixture(); after.state.deniedSha256 = ['b'.repeat(64)];
  await assert.rejects(after.run(), /MEDIA_REVIEW_REJECTED/); assert.equal(after.calls.filter(c => c.kind === 'capture').length, 1);
  assert.equal(after.calls.filter(c => c.kind === 'native').length, 1);
});

test('any native graph change during capture refuses the result and is never retried', async () => {
  const f = fixture(); f.state.onCapture = () => { f.state.native.fingerprint = 'c'.repeat(64); };
  await assert.rejects(f.run(), /MEDIA_DIAGNOSTIC_SOURCE_CHANGED/);
  assert.equal(f.calls.filter(c => c.kind === 'capture').length, 1); assert.equal(f.calls.filter(c => c.kind === 'native').length, 2);
});

test('a stale identity is refused even if an adapter supplied an unchanged fingerprint', async () => {
  const f = fixture(); f.state.onCapture = () => { f.state.native.identity.exactShopifySku = 'foreign'; };
  await assert.rejects(f.run(), /MEDIA_DIAGNOSTIC_SOURCE_CHANGED/);
});

test('revocation, visibility or binding revision changes during capture refuse an otherwise unchanged native result', async () => {
  for (const change of [s => { s.approval[0].enabled = false; }, s => { s.card[0].is_active = false; },
    s => { s.link[0].is_published = false; }, s => { s.card[0].editor_revision++; }, s => { s.approval[0].approval_id = 'new-approval'; }]) {
    const f = fixture(); f.state.onCapture = () => change(f.state);
    await assert.rejects(f.run(), /^Error: MEDIA_DIAGNOSTIC_/);
    assert.equal(f.calls.filter(c => c.kind === 'capture').length, 1);
  }
});

test('authoritative binding and private media-lane revocation are rechecked after capture without a lease', async () => {
  for (const change of [s => { s.binding = []; }, s => { s.binding[0].variant_gid = 'gid://shopify/ProductVariant/1'; },
    s => { s.status.product.mediaEnabled = false; }, s => { s.status.product.baselineVersion++; }]) {
    const f = fixture(); f.state.onCapture = () => change(f.state);
    await assert.rejects(f.run(), /^Error: MEDIA_DIAGNOSTIC_/); assert.equal(f.calls.filter(c => c.kind === 'capture').length, 1);
  }
});

test('deadline checks prevent starting further reads after every expensive stage', async () => {
  for (const stage of ['initial', 'query', 'native', 'capture']) {
    const f = fixture();
    if (stage === 'initial') f.state.now = f.state.deadline;
    if (stage === 'query') f.state.onQuery = () => { f.state.now = f.state.deadline; };
    if (stage === 'native') f.state.onNative = () => { f.state.now = f.state.deadline; };
    if (stage === 'capture') f.state.onCapture = () => { f.state.now = f.state.deadline; };
    await assert.rejects(f.run(), /MEDIA_DIAGNOSTIC_TIME_BUDGET/);
    assert.equal(f.calls.filter(c => c.kind === 'capture').length, stage === 'capture' ? 1 : 0);
    assert.ok(f.calls.filter(c => c.kind === 'native').length <= 1);
  }
});

const makeRoute = await loadWrapped('src/app/api/admin/shopify/media/diagnostic/route.ts',
  ['NextResponse', 'authorizeGalleryAdmin', 'createSupabaseServiceRoleClient', 'parseMediaDiagnosticInput', 'readMediaDiagnostic', 'Buffer'], ['POST']);
const makeToken = await loadWrapped('src/lib/admin/admin-token.ts', ['createHash', 'timingSafeEqual', 'NextResponse', 'supabaseEnv', 'process'], ['requireAdminToken']);
const makeAuth = await loadWrapped('src/lib/admin/authz.ts', ['NextResponse', 'redirect', 'getPanelUser', 'authorizePanelUser'], ['requireAdminUser']);
const makeAccess = await loadWrapped('src/lib/admin/gallery-access.ts',
  ['NextResponse', 'requireAdminToken', 'requireAdminUser', 'allowsGallerySessionRequest'], ['authorizeGalleryAdmin']);
const NextResponse = { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers }) };
const adminUser = (role = 'admin') => ({ id: '11111111-1111-4111-8111-111111111111', email: 'synthetic@example.test',
  email_confirmed_at: '2026-11-10T00:00:00Z', app_metadata: { provider: 'email', role }, user_metadata: {} });
function routeFixture({ user = adminUser(), token = 'synthetic-admin-token', serviceError = null } = {}) {
  const calls = [], auth = makeAuth({ NextResponse, redirect: () => { throw new Error('unexpected redirect'); },
    getPanelUser: async () => user, authorizePanelUser: authCore.authorizePanelUser });
  const tokenGate = makeToken({ createHash, timingSafeEqual, NextResponse, supabaseEnv: { adminToken: token }, process: { env: {} } });
  const access = makeAccess({ NextResponse, requireAdminToken: tokenGate.requireAdminToken, requireAdminUser: auth.requireAdminUser,
    allowsGallerySessionRequest: sessionPolicy.allowsGallerySessionRequest });
  const api = makeRoute({ NextResponse, authorizeGalleryAdmin: access.authorizeGalleryAdmin, Buffer,
    parseMediaDiagnosticInput: service.parseMediaDiagnosticInput,
    createSupabaseServiceRoleClient: () => { calls.push('client'); return {}; },
    readMediaDiagnostic: async (_db, input, deadline) => { calls.push('diagnostic'); assert.deepEqual(input, command());
      assert.ok(deadline > Date.now() && deadline - Date.now() <= 35000); if (serviceError) throw new Error(serviceError);
      return { readOnly: true, baselineComparison: 'unavailable' }; },
  });
  const post = (body = command(), headers = {}, search = '') => {
    const req = { method: 'POST', nextUrl: new URL('https://landing.toptik.co.il/api/admin/shopify/media/diagnostic' + search),
      headers: new Headers({ 'content-type': 'application/json', origin: 'https://landing.toptik.co.il', 'sec-fetch-site': 'same-origin', ...headers }),
      get body() { calls.push('body'); return body === undefined ? null : new Response(typeof body === 'string' ? body : JSON.stringify(body)).body; } };
    return api.POST(req);
  };
  return { calls, post };
}

test('real auth gate refuses guests, roleless/forged users, unconfirmed admins and expired sessions before the body', async () => {
  for (const user of [null, adminUser('member'), { ...adminUser(), app_metadata: {}, user_metadata: { role: 'owner' } },
    { ...adminUser(), email_confirmed_at: null }, { ...adminUser(), is_anonymous: true }]) {
    const f = routeFixture({ user }); const result = await f.post();
    assert.ok([401, 403].includes(result.status)); assert.deepEqual(f.calls, []);
  }
});

test('real session CSRF guard refuses cross-origin, missing/null Origin and foreign sec-fetch-site without reads', async () => {
  for (const headers of [{ origin: 'https://evil.test' }, { origin: '' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    const f = routeFixture(); assert.equal((await f.post(command(), headers)).status, 403); assert.deepEqual(f.calls, []);
  }
});

test('verified admin/owner sessions and exact header token work; query tokens and cron bearers do not gain access', async () => {
  for (const options of [{ user: adminUser() }, { user: adminUser('owner') }, { user: null }]) {
    const f = routeFixture(options), result = await f.post(command(), options.user === null ? { 'x-admin-token': 'synthetic-admin-token' } : {});
    assert.equal(result.status, 200); assert.deepEqual(f.calls, ['body', 'client', 'diagnostic']);
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
  for (const headers of [{ 'x-admin-token': 'wrong' }, { authorization: 'Bearer synthetic-admin-token' }]) {
    const f = routeFixture({ user: null }); assert.equal((await f.post(command(), headers)).status, 401); assert.deepEqual(f.calls, []);
  }
  const empty = routeFixture({ user: null, token: '' });
  assert.equal((await empty.post(command(), { 'x-admin-token': '' })).status, 401); assert.deepEqual(empty.calls, []);
  const query = routeFixture({ user: null });
  assert.equal((await query.post(command(), {}, '?token=synthetic-admin-token')).status, 401); assert.deepEqual(query.calls, []);
});

test('malformed, too large, unknown fields, arbitrary URLs and non-JSON bodies never create a service client', async () => {
  for (const [body, headers, status] of [
    ['{', {}, 400], ['null', {}, 400], ['[]', {}, 400], [command(), { 'content-type': 'application/jsonp' }, 415],
    [command(), { 'content-type': 'text/plain' }, 415], [command(), { 'content-length': '1025' }, 413],
    [command(), { 'content-length': '-1' }, 413], [' '.repeat(1025), {}, 413], [JSON.stringify(command()) + ' '.repeat(1024), {}, 413],
    [{ ...command(), imageUrl: 'https://evil.test/x' }, {}, 400], [{ ...command(), proof: { trusted: true } }, {}, 400],
    [{ ...command(), itemId: [itemId] }, {}, 400], [{ ...command(), mediaId: [mediaId] }, {}, 400],
  ]) { const f = routeFixture(); assert.equal((await f.post(body, headers)).status, status); assert.equal(f.calls.includes('client'), false); }
});

test('route returns only bounded safe error codes, never provider/SQL details', async () => {
  const safe = routeFixture({ serviceError: 'MEDIA_SOURCE_BYTE_LIMIT' });
  assert.deepEqual((await safe.post()).body, { error: 'MEDIA_SOURCE_BYTE_LIMIT' });
  const unsafe = routeFixture({ serviceError: 'https://private.test/secret select password from table' });
  const result = await unsafe.post(); assert.equal(result.status, 409); assert.deepEqual(result.body, { error: 'MEDIA_DIAGNOSTIC_READ_FAILED' });
});

test('diagnostic source surface contains no worker, queue, review-store, lease, registration or mutator invocation', () => {
  for (const file of ['src/lib/shopify/media-diagnostic.ts', 'src/app/api/admin/shopify/media/diagnostic/route.ts']) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\.(?:insert|update|upsert|delete|rpc|upload|remove)\s*\(/);
    assert.doesNotMatch(source, /(?:scheduleMedia|enqueue|acquire_.*lease|register_toptik|saveReviewed|saveStaged|runMediaProduct|bootstrapMedia)\s*\(/);
    assert.doesNotMatch(source, /(?:from|import\()\s*["'][^"']*(?:media-(?:schedule|runtime|planning-rpc|transport-rpc|work-queue)|reviewed-media-store)[^"']*["']/);
  }
});
