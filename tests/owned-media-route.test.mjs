import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadWrapped } from './helpers/owned-edit-harness.mjs';

const make = await loadWrapped('src/app/api/admin/shopify/owned/media/route.ts',
  ['randomUUID', 'NextResponse', 'z', 'authorizeGalleryAdmin', 'createSupabaseServiceRoleClient', 'ownedFamilyForItem',
    'applyOwnedMediaEdit', 'readOwnedMediaEditor', 'readOwnedMediaAdoptionSource', 'resumeOwnedMediaEdit', 'scheduleMediaSyncWakeup', 'Buffer', 'console'], ['GET', 'POST']);
const itemId = '341df0c7-7a31-4e77-87c0-a683082c3cd7';
const input = () => ({ action: 'edit', requestId: randomUUID(), itemId, expectedMapVersion: 1,
  expectedSourceFingerprint: 'a'.repeat(64), desiredImages: [{ mediaId: 'gid://shopify/MediaImage/1', alt: 'פאוץ שחור' }] });
function fixture({ denied = false, leased = true, serviceError = false } = {}) {
  const events = [], NextResponse = { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers }) };
  const db = { rpc: async name => { events.push(name); return { data: name === 'acquire_shopify_reconciliation_lease' ? leased : true, error: null }; } };
  const calls = [], api = make({ randomUUID, NextResponse, z, Buffer, console, scheduleMediaSyncWakeup: () => { events.push('wakeup'); },
    authorizeGalleryAdmin: async (_request, options) => { events.push(['auth', options]); return denied ? { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) } : { ok: true, actorId: 'admin-id', authMethod: 'session' }; },
    createSupabaseServiceRoleClient: () => { events.push('db'); return db; },
    ownedFamilyForItem: id => id === itemId ? { productGid: 'gid://shopify/Product/1' } : null,
    readOwnedMediaEditor: async () => { events.push('read'); return { itemId, enabled: true }; },
    readOwnedMediaAdoptionSource: async id => { events.push('source-read'); return { itemId: id, readOnly: true }; },
    applyOwnedMediaEdit: async (_db, command, context) => {
      calls.push({ command, context }); events.push('apply'); if (serviceError) throw new Error('sensitive-internal-detail');
      return { status: 'pending', requestId: command.requestId, message: 'ממתין' };
    },
    resumeOwnedMediaEdit: async (_db, command) => { calls.push({ command }); events.push('resume'); return { status: 'done', requestId: command.requestId, message: 'אומת' }; },
  });
  const request = (body = input(), headers = { 'content-type': 'application/json' }) => ({ method: 'POST',
    nextUrl: new URL('https://admin.toptik.co.il/api/admin/shopify/owned/media?itemId=' + itemId), headers: new Headers(headers),
    text: async () => { events.push('body'); return typeof body === 'string' ? body : JSON.stringify(body); } });
  return { api, request, calls, events };
}
test('denied media requests do not read the body or create a service role client', async () => {
  const f = fixture({ denied: true });
  assert.equal((await f.api.POST(f.request())).status, 403);
  assert.equal((await f.api.GET(f.request())).status, 403);
  assert.equal(f.events.some(event => ['db', 'body', 'apply', 'read'].includes(event)), false);
});
test('media edits require JSON and reject invented proof, invalid IDs and oversized requests before DB access', async () => {
  for (const [body, headers, status] of [
    [input(), {}, 415], ['{', { 'content-type': 'application/json' }, 400],
    [{ ...input(), receipt: { trusted: true } }, { 'content-type': 'application/json' }, 400],
    [{ ...input(), desiredImages: [{ mediaId: 'gid://shopify/Product/1', alt: 'מוצר' }] }, { 'content-type': 'application/json' }, 400],
    [' '.repeat(120001), { 'content-type': 'application/json' }, 413],
  ]) {
    const f = fixture(); assert.equal((await f.api.POST(f.request(body, headers))).status, status);
    assert.equal(f.events.includes('db'), false);
  }
});
test('a busy product never executes a media operation', async () => {
  const f = fixture({ leased: false });
  assert.equal((await f.api.POST(f.request())).status, 409);
  assert.equal(f.calls.length, 0);
});
test('an authenticated valid edit acquires and releases the shared lease and remains pending until verified', async () => {
  const f = fixture(), body = input(), result = await f.api.POST(f.request(body));
  assert.equal(result.status, 202); assert.equal(result.body.status, 'pending');
  assert.equal(f.calls[0].command.requestId, body.requestId);
  assert.equal(f.calls[0].context.actor.actorType, 'supabase_user');
  assert.equal(f.calls[0].context.actor.actorId, 'admin-id');
  assert.deepEqual(f.events.filter(event => typeof event === 'string'), ['body', 'db', 'acquire_shopify_reconciliation_lease', 'apply', 'release_shopify_reconciliation_lease', 'wakeup']);
  assert.equal(f.events[0][1].sessionMutation, true);
});
test('resume carries only the same request identity, never an altered replacement intent', async () => {
  const f = fixture(), body = { action: 'resume', requestId: randomUUID(), itemId };
  assert.equal((await f.api.POST(f.request(body))).body.status, 'done');
  assert.equal(f.events.includes('apply'), false); assert.equal(f.events.includes('resume'), true);
});
test('exceptions release the product lease and never expose provider details to the browser', async () => {
  const f = fixture({ serviceError: true }), result = await f.api.POST(f.request());
  assert.equal(result.status, 409); assert.equal(result.body.error, 'OWNED_MEDIA_REQUEST_FAILED');
  assert.equal(JSON.stringify(result.body).includes('sensitive-internal-detail'), false);
  assert.ok(f.events.indexOf('release_shopify_reconciliation_lease') < f.events.indexOf('wakeup'));
});

test('the authenticated pinned source audit needs no service-role client, lease or mutation', async () => {
  const f = fixture(), request = f.request(); request.method = 'GET'; request.nextUrl.searchParams.set('view', 'source');
  const answer = await f.api.GET(request);
  assert.equal(answer.status, 200); assert.equal(answer.body.readOnly, true);
  assert.deepEqual(f.events.filter(event => typeof event === 'string'), ['source-read']);
});
