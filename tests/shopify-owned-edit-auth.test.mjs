import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { family, service, loadWrapped } from './helpers/owned-edit-harness.mjs';

// Execute the actual central token, role and session-origin gates, then the real route, service and
// projection against memory transports. Only the verified Supabase-user lookup and external I/O are
// fixtures. No always-allow authorization gate, real session, credential or network dependency.
const makeToken = await loadWrapped('src/lib/admin/admin-token.ts',
  ['createHash', 'timingSafeEqual', 'NextResponse', 'supabaseEnv', 'process'], ['requireAdminToken']);
const makeRole = await loadWrapped('src/lib/admin/authz-core.ts', [], ['authorizePanelUser']);
const { authorizePanelUser } = makeRole({});
const makeUser = await loadWrapped('src/lib/admin/authz.ts',
  ['NextResponse', 'redirect', 'getPanelUser', 'authorizePanelUser'], ['requireAdminUser']);
const makeSessionPolicy = await loadWrapped('src/lib/admin/gallery-session-policy.ts', [], ['allowsGallerySessionRequest']);
const { allowsGallerySessionRequest } = makeSessionPolicy({});
const makeGallery = await loadWrapped('src/lib/admin/gallery-access.ts',
  ['NextResponse', 'requireAdminToken', 'requireAdminUser', 'allowsGallerySessionRequest'], ['authorizeGalleryAdmin']);
const makeRoute = await loadWrapped('src/app/api/admin/shopify/owned/edit/route.ts',
  ['randomUUID', 'NextResponse', 'z', 'authorizeGalleryAdmin', 'createSupabaseServiceRoleClient', 'applyOwnedGalleryEdit', 'ownedFamilyForItem', 'Buffer', 'console'], ['POST']);
const origin = 'https://landing.toptik.co.il';
const token = 'owned-auth-integration-fixture-only';
const person = role => ({ id: '11111111-1111-4111-8111-111111111111', email: 'fixture@example.test',
  email_confirmed_at: '2026-11-09T10:00:00.000Z', app_metadata: { provider: 'email', ...(role ? { role } : {}) } });

async function fixture(user, key = 'fzt73') {
  const f = await family(key), s = service(f);
  const state = { user, userReads: 0, bodyReads: 0, clientCreations: 0, serviceCalls: 0 };
  const NextResponse = { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) };
  const { requireAdminToken } = makeToken({ createHash, timingSafeEqual, NextResponse,
    supabaseEnv: { adminToken: token }, process: { env: {} } });
  const { requireAdminUser } = makeUser({ NextResponse, authorizePanelUser,
    redirect: () => { throw new Error('unexpected page redirect'); },
    getPanelUser: async () => { state.userReads++; return state.user; } });
  const { authorizeGalleryAdmin } = makeGallery({ NextResponse, requireAdminToken, requireAdminUser, allowsGallerySessionRequest });
  const { POST } = makeRoute({ randomUUID, NextResponse, z, Buffer, console, authorizeGalleryAdmin,
    createSupabaseServiceRoleClient: () => { state.clientCreations++; return f.db; },
    ownedFamilyForItem: s.ownedFamilyForItem,
    applyOwnedGalleryEdit: async (...args) => { state.serviceCalls++; return s.applyOwnedGalleryEdit(...args); } });
  const variant = f.variants[0], row = f.tables.carousel_items.find(r => r.id === variant.itemId);
  const body = { itemId: variant.itemId, expectedVersion: row.copy_updated_at, expectedRevision: row.editor_revision,
    patch: { description: 'תיאור משותף שנשמר מחשבון מנהל', descriptionHtml: '<p>תיאור משותף שנשמר מחשבון מנהל</p>' } };
  const post = (headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, input = body) => POST({
    method: 'POST', nextUrl: new URL(origin + '/api/admin/shopify/owned/edit'), headers: new Headers(headers),
    text: async () => { state.bodyReads++; return typeof input === 'string' ? input : JSON.stringify(input); },
  });
  return { f, state, body, post };
}

function untouched(g) {
  assert.equal(g.state.bodyReads, 0, 'authorization must precede even the body read');
  assert.equal(g.state.clientCreations, 0, 'denied requests cannot create a service-role client');
  assert.equal(g.state.serviceCalls, 0);
  assert.equal(g.f.calls.length, 0, 'denied requests cannot acquire a lease or reconcile');
}

test('verified owner and admin sessions save through the real owned route, service and projection for both families', async () => {
  for (const role of ['owner', 'admin']) for (const key of ['fzt73', 'md20']) {
    const g = await fixture(person(role), key);
    const response = await g.post({ origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json; charset=utf-8' });
    assert.equal(response.status, 200, `${role}/${key}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.ok, true);
    assert.equal(g.state.userReads, 1);
    assert.equal(g.state.bodyReads, 1);
    assert.equal(g.state.clientCreations, 1);
    assert.equal(g.state.serviceCalls, 1);
    assert.equal(g.f.state.product.descriptionHtml, g.body.patch.descriptionHtml);
    for (const variant of g.f.variants) assert.equal(g.f.cardOf(variant.itemId).description_html, g.body.patch.descriptionHtml);
    assert.ok(g.f.calls.some(call => call.name === 'release_shopify_reconciliation_lease'));
  }
});

test('anonymous and invalid-token requests return 401 before body, service role or lease access', async () => {
  for (const headers of [{ origin }, { origin, 'x-admin-token': 'wrong-fixture-token' }]) {
    const g = await fixture(null);
    assert.equal((await g.post(headers, 'not even JSON')).status, 401);
    untouched(g);
  }
});

test('a signed-in user without a verified admin role cannot mutate owned products', async () => {
  for (const user of [person(), { ...person(), user_metadata: { role: 'owner' } }, person('customer'),
    { ...person('owner'), email_confirmed_at: null }, { ...person('owner'), is_anonymous: true }]) {
    const g = await fixture(user);
    assert.equal((await g.post(undefined, 'malformed body')).status, 403);
    untouched(g);
  }
});

test('the real session policy rejects missing, null, cross-site and different-subdomain origins before privileged access', async () => {
  for (const headers of [{ 'content-type': 'application/json' }, { origin: 'null', 'content-type': 'application/json' },
    { origin: 'https://evil.example', 'content-type': 'application/json' },
    { origin: 'https://admin.toptik.co.il', 'content-type': 'application/json' },
    { origin: origin + '.evil.example', 'content-type': 'application/json' },
    { origin, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    { origin, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }]) {
    const g = await fixture(person('owner'));
    assert.equal((await g.post(headers)).status, 403, JSON.stringify(headers));
    untouched(g);
  }
});

test('a same-origin session mutation still requires the JSON content type before body and service role access', async () => {
  for (const type of [null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/json-not-really']) {
    const g = await fixture(person('admin'));
    const response = await g.post({ origin, ...(type ? { 'content-type': type } : {}) });
    assert.equal(response.status, 415, String(type));
    untouched(g);
  }
});

test('a valid automation token retains its existing cookie-free and origin-free write path', async () => {
  const g = await fixture(null, 'md20');
  const response = await g.post({ 'x-admin-token': token });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(g.state.userReads, 0, 'the valid token path does not read a user session');
  assert.equal(g.state.serviceCalls, 1);
  assert.equal(g.f.state.product.descriptionHtml, g.body.patch.descriptionHtml);
});

test('an invalid legacy token cannot override a verified same-origin admin session or grant a non-admin access', async () => {
  for (const role of ['owner', undefined]) {
    const g = await fixture(person(role));
    const response = await g.post({ origin, 'content-type': 'application/json', 'x-admin-token': 'old-invalid-token' });
    assert.equal(response.status, role ? 200 : 403);
    if (!role) untouched(g);
  }
});
