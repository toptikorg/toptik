import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dataUrl, loadWrapped } from './helpers/owned-edit-harness.mjs';
const { verifyKlDiagnosticDownload: verify } = await import(dataUrl(stripTypeScriptTypes(readFileSync('src/lib/shopify/media-diagnostic-download.ts', 'utf8'))));
const bytes = new Uint8Array([1, 2, 3, 4]), sha = createHash('sha256').update(bytes).digest('hex');
function response(patch = {}, body = bytes, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.length),
    'x-content-sha256': sha, 'x-toptik-media-id': 'gid://shopify/MediaImage/40701188604154',
    'x-toptik-product-id': 'gid://shopify/Product/9382883918074', 'x-toptik-variant-id': 'gid://shopify/ProductVariant/50148815929594',
    'x-toptik-observation': 'new-capture-not-historical-recovery', 'x-toptik-image-width': '2000', 'x-toptik-image-height': '2400',
    date: 'Wed, 11 Nov 2026 15:00:00 GMT', 'x-vercel-id': 'synthetic', 'set-cookie': 'must-not-enter-receipt', ...patch } });
}
test('download verifies exact bytes and fixed identity and excludes credentials from receipt', async () => {
  const result = await verify(response(), webcrypto);
  assert.deepEqual(result.bytes, bytes); assert.equal(result.receipt.sha256, sha);
  assert.equal(result.filename, `KL966005-image3-${sha.slice(0,12)}.jpg`);
  assert.equal(result.receipt.width, 2000); assert.equal(result.receipt.headers['x-vercel-id'], 'synthetic');
  assert.equal(JSON.stringify(result.receipt).includes('must-not-enter-receipt'), false);
});
test('wrong scope, dimensions, format, length and checksum cannot become a download', async () => {
  for (const patch of [{ 'x-toptik-media-id': 'wrong' }, { 'x-toptik-variant-id': 'wrong' },
    { 'content-type': 'text/html' }, { 'x-content-sha256': '0'.repeat(64) }, { 'content-length': '3' },
    { 'content-length': '5' }, { 'content-length': '8388609' }, { 'x-toptik-image-width': '0' },
    { 'x-toptik-image-width': '16000', 'x-toptik-image-height': '16000' }, { 'x-toptik-observation': 'historical' }]) {
    await assert.rejects(verify(response(patch), webcrypto), /MEDIA_DIAGNOSTIC_DOWNLOAD_INVALID/);
  }
  await assert.rejects(verify(response({}, bytes, 401), webcrypto), /MEDIA_DIAGNOSTIC_DOWNLOAD_INVALID/);
});
test('oversized streamed body is cancelled before copying it into a download', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } });
  const r = response(); const headers = new Headers(r.headers); await r.body.cancel();
  await assert.rejects(verify(new Response(stream, { headers }), webcrypto), /DOWNLOAD_INVALID/);
  assert.equal(cancelled, true);
});
test('download page requires existing admin role and never offers registration', () => {
  const page = readFileSync('src/app/(panel)/dashboard/media-diagnostic/page.tsx', 'utf8');
  assert.ok(page.indexOf('await requireAdminPage()') < page.indexOf('return <main'));
  const client = readFileSync('src/components/admin/MediaDiagnosticDownload.tsx', 'utf8');
  assert.match(client, /credentials: "same-origin"/); assert.match(client, /if \(attempted.current\) return/);
  assert.doesNotMatch(client, /\/media\/review|localStorage|x-admin-token|setInterval/);
});

test('authenticated missing-server configuration has an actionable safe error, auth still runs first', async () => {
  const make = await loadWrapped('src/app/api/admin/carousel/route.ts',
    ['NextResponse','getCarouselPayload','saveCarouselPayload','requireGalleryAdmin','authorizeGalleryAdmin',
      'CAROUSEL_UNAVAILABLE_MESSAGE','isUnavailableCarouselPayload','scheduleMediaSyncWakeup','scheduleShopifySync',
      'prepareExistingCatalogSave','visibleAdminCatalog','mediaReviewMessage','assertReviewedCatalogSave','console'], ['GET']);
  let calls = 0;
  const denied = { status: 401 };
  for (const authorized of [false, true]) {
    const api = make({ NextResponse: { json: (body, init) => ({ body, ...init }) }, console: { error() {} },
      requireGalleryAdmin: async () => authorized ? null : denied,
      getCarouselPayload: async () => { calls++; throw new Error('Missing Supabase admin env vars. secret never exposed'); } });
    const result = await api.GET({});
    if (!authorized) { assert.strictEqual(result, denied); assert.equal(calls, 0); }
    else { assert.equal(result.status, 503); assert.equal(result.body.code, 'GALLERY_ADMIN_CONFIGURATION_MISSING');
      assert.equal(JSON.stringify(result).includes('secret'), false); }
  }
});
