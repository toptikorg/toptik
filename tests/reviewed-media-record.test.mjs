import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const source = read('src/lib/shopify/reviewed-media-record.ts').replace(/^import type[^\n]*;\r?\n/gm, '');
const api = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const identity = { productId: 'gid://shopify/Product/123', variantId: 'gid://shopify/ProductVariant/456', itemId: '01234567-0123-4123-8123-012345678901', exactGallerySku: 'P10FZT59001', exactShopifySku: 'P10FZT59001', productHandle: 'p10fzt59001' };
const record = { version: 1, identity, mediaId: 'gid://shopify/MediaImage/789', imageUrl: 'https://cdn.shopify.com/s/files/1/0001/photo.jpg?v=1', decodedSha256: 'a'.repeat(64), sourceUrl: 'https://manufacturer.example/exact-sku.jpg', evidence: 'visually reviewed exact SKU and color, batch09', actorId: '11111111-1111-4111-8111-111111111111', reviewedAt: '2026-10-07T08:00:00.000Z', reviewedExactSkuColor: true };
const key = 'test-only-secret-not-a-production-key';
test('exact signed record roundtrip and dynamic registry fields', () => {
  const signed = api.signMediaReview(record, key);
  assert.deepEqual(api.verifyMediaReview(signed, identity, key), record);
  const entry = api.reviewEntry(record);
  assert.equal(entry.sku, identity.exactGallerySku); assert.equal(entry.galleryId, identity.itemId);
  assert.equal(entry.variantId, identity.variantId); assert.equal(entry.decodedSha256, record.decodedSha256);
  assert.match(api.reviewPath(record), /^v1\/[a-f0-9-]{36}\/[a-f0-9]{64}\.json$/);
});
test('record tampering and wrong key fail closed', () => {
  const signed = api.signMediaReview(record, key);
  for (const changed of [{ decodedSha256: 'b'.repeat(64) }, { imageUrl: record.imageUrl + '&yellow=1' }, { mediaId: 'gid://shopify/MediaImage/999' }, { sourceUrl: 'https://elsewhere.example/file.jpg' }, { actorId: '22222222-2222-4222-8222-222222222222' }])
    assert.throws(() => api.verifyMediaReview({ ...signed, record: { ...record, ...changed } }, identity, key), /INVALID/);
  assert.throws(() => api.verifyMediaReview(signed, identity, key + 'rotated'), /INVALID/);
  assert.throws(() => api.signMediaReview(record, ''), /SIGNING_UNAVAILABLE/);
});
test('all identity components bound, including color and variant', () => {
  const signed = api.signMediaReview(record, key);
  for (const changed of [{ exactGallerySku: 'P10FZT5908U' }, { exactShopifySku: 'P10FZT5908U' }, { productId: 'gid://shopify/Product/9' }, { variantId: 'gid://shopify/ProductVariant/9' }, { itemId: '22222222-2222-4222-8222-222222222222' }, { productHandle: 'another' }])
    assert.throws(() => api.verifyMediaReview(signed, { ...identity, ...changed }, key), /INVALID/);
});
test('immutable path ignores review timestamp but binds bytes and identity', () => {
  assert.equal(api.reviewPath(record), api.reviewPath({ ...record, reviewedAt: '2026-10-07T09:00:00.000Z' }));
  assert.notEqual(api.reviewPath(record), api.reviewPath({ ...record, decodedSha256: 'b'.repeat(64) }));
  assert.notEqual(api.reviewPath(record), api.reviewPath({ ...record, identity: { ...identity, exactGallerySku: 'P10FZT5908U' } }));
});
test('untrusted malformed records, extra keys and unsafe URLs rejected', () => {
  for (const changed of [{ reviewedExactSkuColor: false }, { decodedSha256: 'x' }, { extra: true }, { evidence: '' }, { reviewedAt: 'yesterday' }, { imageUrl: 'http://cdn.shopify.com/s/files/a.jpg' }, { imageUrl: 'https://cdn.shopify.com.evil.test/s/files/a.jpg' }, { imageUrl: 'https://cdn.shopify.com/s/files/%2e%2e/a.jpg' }, { sourceUrl: 'https://user:password@manufacturer.example/a.jpg' }])
    assert.throws(() => api.reviewRecord({ ...record, ...changed }), /INVALID/);
  assert.throws(() => api.verifyMediaReview({ ...api.signMediaReview(record, key), extra: 1 }, identity, key), /INVALID/);
});
test('registration preserves existing authorization and validates server source before saving', () => {
  const route = read('src/app/api/admin/shopify/media/review/route.ts');
  assert.match(route, /authorizeGalleryAdmin\(req, \{ sessionMutation: true \}\)/);
  for (const check of ['item.catalogNumber !== identity.exactGallerySku', 'fetchShopifyMediaRead(identity', 'captureMediaSourceBytes(identity', 'bytes.sha256 !== record.decodedSha256', 'assertNotDeniedMedia(image.url, bytes.sha256)', 'before.fingerprint !== after.fingerprint'])
    assert.ok(route.indexOf(check) < route.indexOf('const result = await saveReviewedMedia'), check);
  assert.doesNotMatch(route, /set_toptik_media_enabled|bootstrapProductionMedia|saveCarousel|productUpdate|referencesTo/);
});
test('storage uses correct JSON MIME in private bucket, signed immutable data and readback', () => {
  const store = read('src/lib/shopify/reviewed-media-store.ts');
  assert.match(store, /public: false/); assert.match(store, /allowedMimeTypes: \["application\/json"\]/);
  assert.match(store, /contentType: "application\/json", upsert: false/);
  assert.match(store, /verifyMediaReview/); assert.match(store, /const stored = await readRecord/);
  assert.doesNotMatch(store, /getPublicUrl|createSignedUrl|updateBucket|\.remove\(/);
});

test('missing bucket is narrowly distinguished from permission and network failures', async () => {
  const source = read('src/lib/shopify/reviewed-media-store.ts').replace(/^import[^\n]*;\r?\n/gm, '') + '\nexport { missing };';
  const store = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
  assert.equal(store.missing({ statusCode: '400', message: 'Bucket not found' }), true);
  assert.equal(store.missing({ statusCode: 404 }), true);
  for (const e of [{ statusCode: 403, message: 'Bucket not found' }, { statusCode: 400, message: 'Forbidden' }, { statusCode: 500 }, null])
    assert.equal(store.missing(e), false);
});
test('status and wakeup expose no anonymous privileges or removal intent', () => {
  const sql = read('supabase/migrations/20261007_media_review_status.sql');
  assert.match(sql, /from public,anon,authenticated/);
  assert.match(sql, /to service_role/);
  assert.match(sql, /toptik_media_private\.enqueue\(p_product_gid,'\{\}'::jsonb\)/);
  assert.doesNotMatch(sql, /\b(?:delete|update|insert|drop|truncate)\b(?![^\n]*--)/i);
  const route = read('src/app/api/admin/shopify/media/status/route.ts');
  assert.match(route, /requireGalleryAdmin\(req\)/);
  assert.match(route, /verified: false/);
  assert.match(route, /scope: "media_only"/);
  const review = read('src/app/api/admin/shopify/media/review/route.ts');
  assert.ok(review.indexOf('await saveReviewedMedia') < review.indexOf('await enqueueReviewedMedia'));
});
