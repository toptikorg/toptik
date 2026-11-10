import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWrapped, policy, staged, itemId, otherItemId, identity, uploadUrl, actorId } from './helpers/staged-media-harness.mjs';

const make = await loadWrapped('src/app/api/admin/shopify/media/staged-review/route.ts',
  ['NextResponse', 'authorizeGalleryAdmin', 'getCarouselPayload', 'createSupabaseServiceRoleClient', 'fetchShopifyMediaRead', 'VERIFIED_COPY_COLUMNS', 'assertVerifiedCopyApproval',
    'MAX_STAGED_NOTE', 'stageReviewedGalleryUpload', 'isShopifyOwnedVariant', 'Buffer'], ['POST']);

const eligibility = (patch = {}) => ({ product_gid: identity.productId, catalog_key: 'KF901003', carousel_item_id: itemId, variant_gid: identity.variantId,
  exact_gallery_sku: 'KF901003', exact_shopify_sku: 'KF901003', approved_product_handle: identity.productHandle, allowed_fields: ['title', 'description', 'seoTitle', 'seoDescription'],
  enabled: true, approval_id: 'published-shopify-v1:15453683548410', approved_source_updated_at: '2026-10-31T00:00:00Z', alias_evidence: {}, ...patch });
const item = (patch = {}) => ({ id: itemId, catalogNumber: 'KF901003', editorRevision: 7, shopifyLink: { variantId: '67936407388410', handle: identity.productHandle }, ...patch });

function fixture({ rows = [eligibility()], dbError = null, items = [item()], shopifyError = null, stageError = null, auth = { ok: true, actorId, authMethod: 'session' } } = {}) {
  const calls = [], stageInputs = [];
  const db = { from(table) { calls.push(['from', table]); const q = { select(cols) { calls.push(['select', cols]); return q; }, eq(k, v) { calls.push(['eq', k, v]); return q; },
    limit: async () => dbError ? { data: null, error: dbError } : { data: rows, error: null } }; return q; } };
  const deps = {
    NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) }, Buffer,
    authorizeGalleryAdmin: async () => auth.ok ? auth : { ok: false, response: { body: { error: 'Unauthorized' }, status: 401 } },
    getCarouselPayload: async () => { calls.push(['catalog']); return { items }; }, createSupabaseServiceRoleClient: () => db,
    fetchShopifyMediaRead: async id => { calls.push(['shopify', id]); if (shopifyError) throw new Error(shopifyError); return { images: [] }; },
    VERIFIED_COPY_COLUMNS: 'cols', assertVerifiedCopyApproval: a => { if (!a || a.enabled !== true || !a.approval_id) throw new Error('SYNC_COPY_NOT_APPROVED'); },
    MAX_STAGED_NOTE: staged.MAX_STAGED_NOTE, isShopifyOwnedVariant: policy.isShopifyOwnedVariant,
    stageReviewedGalleryUpload: async (client, stageInput) => { calls.push(['stage']); stageInputs.push(stageInput); if (stageError) throw new Error(stageError);
      return { stagedUrl: 'https://staged', stagedPath: 'p', sha256: 'a'.repeat(64), mime: 'image/jpeg', width: 1, height: 2, byteLength: 3, replayed: false }; },
  };
  const { POST } = make(deps);
  const post = (body, headers = { 'content-type': 'application/json' }) => POST({ headers: new Headers(headers),
    body: body === undefined ? null : new Response(typeof body === 'string' ? body : JSON.stringify(body)).body });
  return { calls, stageInputs, post };
}
// What the editor sends: the SKU printed next to the checkbox and the card version it had loaded.
const body = (patch = {}) => ({ itemId, uploadUrl, reviewedExactSkuColor: true, reviewedCatalogNumber: 'KF901003', expectedRevision: 7, ...patch });
const names = f => f.calls.map(c => c[0]);

test('an unauthenticated request touches nothing', async () => {
  const f = fixture({ auth: { ok: false } });
  const response = await f.post(body());
  assert.equal(response.status, 401);
  assert.deepEqual(f.calls, []);
});

test('malformed, oversized and over-specified requests are refused before any lookup', async () => {
  const bad = [
    [undefined], ['not json'], ['[]'], ['null'], [body({ reviewedExactSkuColor: false })], [{ itemId, uploadUrl }], [body({ itemId: 'nope' })], [body({ uploadUrl: 7 })],
    [body({ uploadUrl: 'https://x/' + 'a'.repeat(2100) })], [body({ note: 'a\nb' })], [body({ note: 'א'.repeat(301) })], [body({ note: 5 })],
    [body({ identity: { productId: 'gid://shopify/Product/1' } })], [body({ productId: identity.productId })], [body({ extra: true })],
    [body(), { 'content-type': 'text/plain' }], [body(), {}], [JSON.stringify({ ...body(), note: 'x'.repeat(5000) })],
    // A valid request padded past the size limit is refused for its size alone.
    [JSON.stringify(body()) + ' '.repeat(5000)],
    // The confirmation must name the SKU and the card version that were on screen.
    [{ itemId, uploadUrl, reviewedExactSkuColor: true }], [{ ...body(), reviewedCatalogNumber: undefined }], [{ ...body(), expectedRevision: undefined }],
    [body({ reviewedCatalogNumber: '' })], [body({ reviewedCatalogNumber: 7 })], [body({ reviewedCatalogNumber: 'K'.repeat(81) })],
    [body({ expectedRevision: '7' })], [body({ expectedRevision: 7.5 })], [body({ expectedRevision: -1 })], [body({ expectedRevision: null })],
    [body({ expectedRevision: 9007199254740992 })],
  ];
  for (const [payload, headers] of bad) {
    const f = fixture();
    const response = await f.post(payload, headers);
    assert.equal(response.status, 400, JSON.stringify(payload)?.slice(0, 60));
    assert.equal(response.body.error, 'STAGED_MEDIA_INPUT_INVALID');
    assert.deepEqual(f.calls, []);
  }
});

test('shared multi-color products are sent to their own route, not staged here', async () => {
  const f = fixture();
  const response = await f.post(body({ itemId: policy.FZT73_VARIANTS[0].itemId }));
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'STAGED_MEDIA_OWNED_GROUP');
  assert.deepEqual(f.calls, []);
});

test('only an enabled, uniquely approved binding can stage, and the catalog must still agree with it', async () => {
  const cases = [
    [{ rows: [] }, 'STAGED_MEDIA_NOT_ELIGIBLE'], [{ rows: [eligibility(), eligibility()] }, 'STAGED_MEDIA_NOT_ELIGIBLE'], [{ rows: [eligibility({ enabled: false })] }, 'STAGED_MEDIA_NOT_ELIGIBLE'],
    [{ dbError: { message: 'db down' } }, 'STAGED_MEDIA_BINDING_READ_FAILED'],
    [{ items: [] }, 'STAGED_MEDIA_IDENTITY_CHANGED'], [{ items: [item({ catalogNumber: 'KF901004' })] }, 'STAGED_MEDIA_IDENTITY_CHANGED'],
    [{ items: [item({ shopifyLink: { variantId: '1', handle: 'x' } })] }, 'STAGED_MEDIA_IDENTITY_CHANGED'], [{ items: [item({ shopifyLink: undefined })] }, 'STAGED_MEDIA_IDENTITY_CHANGED'],
    [{ rows: [eligibility({ carousel_item_id: otherItemId })] }, 'STAGED_MEDIA_IDENTITY_CHANGED'],
    [{ shopifyError: 'MEDIA_READ_FAILED' }, 'STAGED_MEDIA_IDENTITY_CHANGED'],
  ];
  for (const [options, code] of cases) {
    const f = fixture(options);
    const response = await f.post(body());
    assert.equal(response.status, 409, code);
    assert.equal(response.body.error, code);
    assert.ok(!names(f).includes('stage'), code);
  }
});

test('the confirmation applies only to the SKU that was on screen and the card version that was loaded', async () => {
  const cases = [
    // The administrator looked at another SKU (the card was re-bound or a different card was shown).
    [body({ reviewedCatalogNumber: 'KF901004' }), {}, 'STAGED_MEDIA_IDENTITY_CHANGED'], [body({ reviewedCatalogNumber: 'kf901003' }), {}, 'STAGED_MEDIA_IDENTITY_CHANGED'],
    [body({ reviewedCatalogNumber: ' KF901003' }), {}, 'STAGED_MEDIA_IDENTITY_CHANGED'],
    // The card was saved elsewhere since the editor loaded it, or it carries no version at all.
    [body({ expectedRevision: 6 }), {}, 'STAGED_MEDIA_STALE_ITEM'], [body({ expectedRevision: 8 }), {}, 'STAGED_MEDIA_STALE_ITEM'],
    [body(), { items: [item({ editorRevision: 8 })] }, 'STAGED_MEDIA_STALE_ITEM'], [body(), { items: [item({ editorRevision: undefined })] }, 'STAGED_MEDIA_STALE_ITEM'],
    [body(), { items: [item({ editorRevision: null })] }, 'STAGED_MEDIA_STALE_ITEM'], [body(), { items: [item({ editorRevision: '7' })] }, 'STAGED_MEDIA_STALE_ITEM'],
  ];
  for (const [payload, options, code] of cases) {
    const f = fixture(options);
    const response = await f.post(payload);
    assert.equal(response.status, 409, code);
    assert.equal(response.body.error, code);
    // Refused before the store is asked anything and before a single byte is copied.
    assert.ok(!names(f).includes('shopify') && !names(f).includes('stage'), code);
  }
  const ok = fixture();
  assert.equal((await ok.post(body())).status, 200);
});

test('the identity is derived on the server from the approved binding; nothing identity-like is taken from the request', async () => {
  const f = fixture();
  const response = await f.post(body({ note: '  נבדק מול התמונות באתר  ' }));
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true); assert.equal(response.body.stagedUrl, 'https://staged');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(f.stageInputs, [{ identity, approvalId: 'published-shopify-v1:15453683548410', uploadUrl, note: 'נבדק מול התמונות באתר', actorId }]);
  assert.deepEqual(names(f), ['from', 'select', 'eq', 'catalog', 'shopify', 'stage']);
  assert.deepEqual(f.calls.find(c => c[0] === 'eq'), ['eq', 'carousel_item_id', itemId]);
  assert.deepEqual(f.calls.find(c => c[0] === 'shopify')[1], identity);
});

test('the reviewing administrator is the verified actor, for both the signed-in editor and the automation token', async () => {
  const automation = fixture({ auth: { ok: true, actorId: '9c1d7e52-0a4b-4c7e-8b36-1f2e3d4c5b6a', authMethod: 'token' } });
  await automation.post(body());
  assert.equal(automation.stageInputs[0].actorId, '9c1d7e52-0a4b-4c7e-8b36-1f2e3d4c5b6a');
  const session = fixture();
  await session.post(body());
  assert.equal(session.stageInputs[0].actorId, actorId);
  const none = fixture();
  await none.post(body({ note: undefined }));
  assert.equal(none.stageInputs[0].note, '');
});

test('only safe, bounded error codes reach the browser', async () => {
  for (const [error, status, code] of [['MEDIA_REVIEW_REJECTED', 409, 'MEDIA_REVIEW_REJECTED'], ['STAGED_MEDIA_UPLOAD_INVALID', 400, 'STAGED_MEDIA_UPLOAD_INVALID'],
    ['STAGED_MEDIA_READBACK_MISMATCH', 409, 'STAGED_MEDIA_READBACK_MISMATCH'], ['STAGED_MEDIA_FORMAT_INVALID', 400, 'STAGED_MEDIA_FORMAT_INVALID'],
    ['select * from secrets', 409, 'STAGED_MEDIA_FAILED'], ['Error: token=abc', 409, 'STAGED_MEDIA_FAILED'], ['lowercase_code', 409, 'STAGED_MEDIA_FAILED']]) {
    const f = fixture({ stageError: error });
    const response = await f.post(body());
    assert.equal(response.status, status, error);
    assert.deepEqual(response.body, { error: code });
  }
});
