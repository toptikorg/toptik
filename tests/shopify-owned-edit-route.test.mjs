import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { loadWrapped, policy } from './helpers/owned-edit-harness.mjs';

const makeRoute = await loadWrapped('src/app/api/admin/shopify/owned/edit/route.ts',
  ['randomUUID', 'NextResponse', 'z', 'requireAdminToken', 'createSupabaseServiceRoleClient', 'applyOwnedGalleryEdit', 'ownedFamilyForItem', 'Buffer', 'console'],
  ['POST']);
const fzt73 = policy.FZT73_VARIANTS[0], md20 = policy.MD20_VARIANTS[1];
const owner = '11111111-1111-4111-8111-111111111111';
const valid = (itemId = fzt73.itemId) => ({ itemId, expectedVersion: '2026-11-09T10:00:00.000Z', expectedRevision: 1, patch: { title: 'שם' } });

function fixture() {
  const state = { denied: false, busy: false, releaseFails: false, serviceError: null, serviceCalls: [], rpcCalls: [], errors: [] };
  const db = {
    async rpc(name, args) {
      state.rpcCalls.push({ name, args });
      if (name === 'acquire_shopify_reconciliation_lease') return { data: !state.busy, error: null };
      if (name === 'release_shopify_reconciliation_lease') return state.releaseFails ? { data: null, error: { message: 'boom' } } : { data: true, error: null };
      throw new Error('unexpected ' + name);
    },
  };
  const familyOf = itemId => policy.FZT73_VARIANTS.some(v => v.itemId === itemId) ? { productGid: policy.FZT73_PRODUCT_GID }
    : policy.MD20_VARIANTS.some(v => v.itemId === itemId) ? { productGid: policy.MD20_PRODUCT_GID } : null;
  const deps = {
    randomUUID: () => owner, z, Buffer, console: { error: (...a) => state.errors.push(a) },
    NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) },
    requireAdminToken: () => state.denied ? { body: { error: 'Unauthorized' }, status: 401 } : null,
    createSupabaseServiceRoleClient: () => db, ownedFamilyForItem: familyOf,
    applyOwnedGalleryEdit: async (client, input, leaseOwner, deadline) => {
      state.serviceCalls.push({ client, input, leaseOwner, deadline });
      if (state.serviceError) throw new Error(state.serviceError);
      return { ok: true, itemId: input.itemId, changed: true };
    },
  };
  const { POST } = makeRoute(deps);
  return { state, post: body => POST({ text: async () => typeof body === 'string' ? body : JSON.stringify(body) }) };
}

test('requires the administrator token before reading the body or touching anything', async () => {
  const f = fixture();
  f.state.denied = true;
  const response = await f.post(valid());
  assert.equal(response.status, 401);
  assert.equal(f.state.rpcCalls.length + f.state.serviceCalls.length, 0);
});

test('rejects malformed, oversized, unknown-field and empty requests without taking the lease', async () => {
  const f = fixture();
  for (const body of ['not json', '{}', JSON.stringify({ ...valid(), extra: 1 }), JSON.stringify({ ...valid(), patch: {} }),
    JSON.stringify({ ...valid(), patch: { title: 'x', price: 1 } }), JSON.stringify({ ...valid(), itemId: 'nope' }),
    JSON.stringify({ ...valid(), expectedRevision: 0 }), JSON.stringify({ ...valid(), expectedVersion: 'yesterday' }),
    JSON.stringify({ ...valid(), patch: { angles: [{ id: 'bad', imageAlt: 'x' }] } }), JSON.stringify({ ...valid(), patch: { title: '' } })]) {
    const response = await f.post(body);
    assert.equal(response.status, 400, body);
    assert.equal(response.body.error, 'SYNC_OWNED_REQUEST_INVALID');
  }
  const large = await f.post(JSON.stringify({ ...valid(), patch: { descriptionHtml: 'x'.repeat(700000) } }));
  assert.equal(large.status, 413);
  assert.equal(f.state.rpcCalls.length + f.state.serviceCalls.length, 0);
});

test('an item outside the two reviewed families is not found and takes no lease', async () => {
  const f = fixture();
  const response = await f.post(valid('660aea87-5082-438d-86f0-bd982ac43a68'));
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'SYNC_OWNED_ITEM_UNKNOWN');
  assert.equal(f.state.rpcCalls.length, 0);
});

test('a busy product lease answers 409 and never reaches Shopify', async () => {
  const f = fixture();
  f.state.busy = true;
  const response = await f.post(valid());
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'SYNC_RECONCILIATION_BUSY');
  assert.equal(f.state.serviceCalls.length, 0);
  assert.ok(!f.state.rpcCalls.some(call => call.name === 'release_shopify_reconciliation_lease'));
});

test('the edit runs under the product lease of its own family and the lease is always released', async () => {
  for (const [variant, gid] of [[fzt73, policy.FZT73_PRODUCT_GID], [md20, policy.MD20_PRODUCT_GID]]) {
    const f = fixture();
    const response = await f.post(valid(variant.itemId));
    assert.equal(response.status, 200);
    assert.equal(response.body.changed, true);
    assert.equal(f.state.serviceCalls[0].leaseOwner, owner);
    assert.ok(f.state.serviceCalls[0].deadline - Date.now() <= 55000);
    assert.deepEqual(f.state.rpcCalls.map(call => [call.name, call.args.p_product_gid, call.args.p_owner]), [
      ['acquire_shopify_reconciliation_lease', gid, owner], ['release_shopify_reconciliation_lease', gid, owner]]);
  }
});

test('safe error codes are returned, anything else is hidden, and the lease is released after a failure', async () => {
  const f = fixture();
  f.state.serviceError = 'SYNC_OWNED_COPY_CONFLICT';
  const conflict = await f.post(valid());
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'SYNC_OWNED_COPY_CONFLICT');
  assert.ok(f.state.rpcCalls.some(call => call.name === 'release_shopify_reconciliation_lease'));
  f.state.serviceError = 'select * from carousel_items where token = abc';
  const hidden = await f.post(valid());
  assert.equal(hidden.body.error, 'SYNC_OWNED_EDIT_FAILED');
});

test('a failed lease release is logged without masking the result', async () => {
  const f = fixture();
  f.state.releaseFails = true;
  const response = await f.post(valid());
  assert.equal(response.status, 200);
  assert.equal(f.state.errors.length, 1);
});
