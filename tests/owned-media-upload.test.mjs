import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadWrapped } from './helpers/owned-edit-harness.mjs';
const make = await loadWrapped('src/lib/shopify/owned-media-upload.ts', ['randomUUID', 'captureMediaSourceBytes'], ['stageOwnedMediaUpload']);
const { stageOwnedMediaUpload } = make({ randomUUID, captureMediaSourceBytes: () => { throw new Error('unexpected network'); } });
const itemId = '341df0c7-7a31-4e77-87c0-a683082c3cd7';
const binding = { productGid: 'gid://shopify/Product/1', handle: 'p', variants: [{ itemId, variantGid: 'gid://shopify/ProductVariant/2', sku: 'SKU' }] };
const uploadUrl = `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/items/${itemId}/owned-drafts/file.jpg`;
const bytes = () => ({ bytes: new Uint8Array([1, 2, 3]), sha256: 'a'.repeat(64), mime: 'image/jpeg', width: 10, height: 20, byteLength: 3, visual: '0' });
function fixture({ error = null, mismatch = false } = {}) {
  const calls = [], db = { storage: { from: bucket => ({ upload: async (path, body, options) => { calls.push({ bucket, path, body, options }); return { error }; } }) } };
  const capture = async (_identity, url) => { calls.push(url); return { ...bytes(), ...(mismatch && url.includes('/sync-owned/') ? { sha256: 'b'.repeat(64) } : {}) }; };
  return { calls, db, capture };
}
test('unknown item, foreign URL, another card upload and URL tricks never trigger image fetch or storage', async () => {
  for (const url of ['https://127.0.0.1/secret', uploadUrl.replace(itemId, 'another'), uploadUrl + '?x=1', uploadUrl + '#fragment', uploadUrl.replace('/file.jpg', '/%2e%2e/file.jpg')]) {
    const f = fixture();
    await assert.rejects(stageOwnedMediaUpload(f.db, binding, itemId, url, Date.now() + 1000, { capture: f.capture }), /OWNED_MEDIA_UPLOAD_INVALID/);
    assert.equal(f.calls.length, 0);
  }
});
test('decoded bytes are uploaded without upsert, read back and recorded under exact content-addressed provenance', async () => {
  const f = fixture(), result = await stageOwnedMediaUpload(f.db, binding, itemId, uploadUrl, Date.now() + 2000, { capture: f.capture });
  const write = f.calls.find(call => typeof call === 'object');
  assert.equal(write.options.upsert, false); assert.equal(write.bucket, 'carousel-media');
  assert.equal(write.path, `sync-owned/${itemId}/${'a'.repeat(64)}.jpg`);
  assert.equal(f.calls.length, 3); assert.equal(f.calls.at(-1), result.url);
  assert.equal(result.sha256, 'a'.repeat(64)); assert.match(result.receiptId, /^[a-f0-9-]{36}$/);
});
test('an already existing immutable object is reusable only after exact content readback', async () => {
  const f = fixture({ error: { statusCode: '400', error: 'Duplicate' } });
  const result = await stageOwnedMediaUpload(f.db, binding, itemId, uploadUrl, Date.now() + 2000, { capture: f.capture });
  assert.equal(result.sha256, 'a'.repeat(64));
  const bad = fixture({ error: { statusCode: '409' }, mismatch: true });
  await assert.rejects(stageOwnedMediaUpload(bad.db, binding, itemId, uploadUrl, Date.now() + 2000, { capture: bad.capture }), /READBACK_MISMATCH/);
});
test('decode rejection is terminal for this request and never uploads or converts the source', async () => {
  const f = fixture();
  await assert.rejects(stageOwnedMediaUpload(f.db, binding, itemId, uploadUrl, Date.now() + 2000, { capture: async () => { throw new Error('MEDIA_SOURCE_DECODE_FAILED'); } }), /DECODE_FAILED/);
  assert.equal(f.calls.length, 0);
});
