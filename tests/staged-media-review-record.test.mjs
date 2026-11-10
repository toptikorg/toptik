import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { staged, nativeRecord, guard, KEY, itemId, otherItemId, identity, sha, uploadUrl, uploadUrlFor, recordInput, record, actorId } from './helpers/staged-media-harness.mjs';

test('the staged path and URL are fixed by the item, the SHA-256 and the type', () => {
  assert.equal(staged.stagedStoragePath(itemId, sha, 'image/jpeg'), `sync-staged/${itemId}/${sha}.jpg`);
  assert.equal(staged.stagedStoragePath(itemId, sha, 'image/png'), `sync-staged/${itemId}/${sha}.png`);
  assert.equal(staged.stagedStoragePath(itemId, sha, 'image/webp'), `sync-staged/${itemId}/${sha}.webp`);
  assert.equal(staged.stagedPublicUrl(`sync-staged/${itemId}/${sha}.jpg`), `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/sync-staged/${itemId}/${sha}.jpg`);
  for (const bad of [['x', sha, 'image/jpeg'], [itemId, 'abc', 'image/jpeg'], [itemId, sha, 'image/gif'], [itemId, sha, 'image/avif'], [itemId, sha, undefined]]) {
    assert.throws(() => staged.stagedStoragePath(...bad), /STAGED_MEDIA_RECORD_INVALID/);
  }
});

test('only an upload made by the editor for exactly this card is an accepted source', () => {
  assert.equal(staged.stagedUploadPath(itemId, uploadUrl), `items/${itemId}/angles/5a6e2a30-733b-4df9-be1d-7bfa056e4613.jpg`);
  assert.equal(staged.stagedUploadPath(itemId, uploadUrlFor(itemId, 'cover', '5a6e2a30-733b-4df9-be1d-7bfa056e4613.webp')), `items/${itemId}/cover/5a6e2a30-733b-4df9-be1d-7bfa056e4613.webp`);
  const base = uploadUrl;
  const rejected = [
    uploadUrlFor(otherItemId),                                    // another card's upload
    uploadUrlFor(itemId, 'owned-drafts'),                         // the shared-product draft folder has its own route
    uploadUrlFor(itemId, 'imports'),                              // scraped imports are not uploads
    uploadUrlFor(itemId, 'angles', 'photo.jpg'),                  // not the server-generated UUID name
    uploadUrlFor(itemId, 'angles', '5a6e2a30-733b-4df9-be1d-7bfa056e4613.jpeg2000x'),
    uploadUrlFor(itemId, 'angles/extra'),
    base + '?x=1', base + '#frag', base.replace('https://', 'https://user:pw@'), base.replace('.co/', '.co:8443/'),
    base.replace('/angles/', '/%61ngles/'), base.replace('/angles/', '/%2e%2e/angles/'),
    base.replace('https://', 'http://'), base.replace('ekgpaoavsavrtbhlbwdg', 'evil'),
    'https://cdn.shopify.com/s/files/1/0622/8082/7130/files/x.jpg',
    base.replace('/carousel-media/', '/other-bucket/'),
    ' ' + base, base + ' ', 42, null, undefined, '',
  ];
  for (const bad of rejected) assert.equal(staged.stagedUploadPath(itemId, bad), null, String(bad));
  assert.equal(staged.stagedUploadPath('not-a-uuid', base), null);
});

test('a valid record normalizes to a fixed shape and every field is checked', () => {
  const r = record();
  assert.deepEqual(Object.keys(r), ['version', 'kind', 'identity', 'approvalId', 'uploadPath', 'stagedPath', 'imageUrl', 'decodedSha256', 'mime', 'width',
    'height', 'byteLength', 'note', 'actorId', 'reviewedAt', 'reviewedExactSkuColor']);
  assert.equal(r.imageUrl, staged.stagedPublicUrl(r.stagedPath));
  const bad = {
    'extra key': { extra: 1 }, version: { version: 2 }, kind: { kind: 'native' }, 'not reviewed': { reviewedExactSkuColor: false },
    'bad sha': { decodedSha256: 'xyz' }, 'bad mime': { mime: 'image/gif' }, 'avif is not staged': { mime: 'image/avif' },
    'staged path not content-addressed': { stagedPath: `sync-staged/${itemId}/${'b'.repeat(64)}.jpg` },
    'image url for another path': { imageUrl: staged.stagedPublicUrl(`sync-staged/${itemId}/${'b'.repeat(64)}.jpg`) },
    'image url is the upload': { imageUrl: uploadUrl },
    'upload of another card': { uploadPath: `items/${otherItemId}/angles/5a6e2a30-733b-4df9-be1d-7bfa056e4613.jpg` },
    'upload outside items': { uploadPath: `sync-media/${itemId}/${sha}.jpg` },
    'width zero': { width: 0 }, 'height huge': { height: 16001 }, 'fractional width': { width: 10.5 }, 'zero bytes': { byteLength: 0 }, 'over 8MB': { byteLength: 8 * 1024 * 1024 + 1 },
    'padded note': { note: ' x' }, 'control char note': { note: 'a\nb' }, 'long note': { note: 'א'.repeat(301) },
    'bad actor': { actorId: 'someone' }, 'bad time': { reviewedAt: '2026-11-10 06:00:00' }, 'empty approval': { approvalId: '' },
    'identity extra key': { identity: { ...identity, extra: 1 } }, 'identity bad product': { identity: { ...identity, productId: 'gid://shopify/Product/x' } },
    'identity bad item': { identity: { ...identity, itemId: 'nope' } },
  };
  for (const [name, patch] of Object.entries(bad)) assert.throws(() => staged.stagedRecord(recordInput(patch)), /STAGED_MEDIA_RECORD_INVALID|MEDIA_REVIEW_RECORD_INVALID/, name);
  for (const input of [null, [], 'text', 7]) assert.throws(() => staged.stagedRecord(input), /STAGED_MEDIA_RECORD_INVALID/);
  assert.equal(staged.stagedRecord(recordInput({ note: '' })).note, '');
});

test('signing round-trips, fails on any change, and is domain-separated from the native Shopify review', () => {
  const signed = staged.signStagedReview(record(), KEY);
  assert.match(signed.signature, /^[a-f0-9]{64}$/);
  assert.deepEqual(staged.verifyStagedReview(JSON.parse(JSON.stringify(signed)), KEY), record());
  assert.throws(() => staged.verifyStagedReview(signed, 'z'.repeat(48)), /STAGED_MEDIA_RECORD_INVALID/);
  assert.throws(() => staged.signStagedReview(record(), 'short'), /STAGED_MEDIA_SIGNING_UNAVAILABLE/);
  for (const patch of [{ decodedSha256: 'c'.repeat(64) }, { width: 1 }, { note: 'אחר' }, { actorId: otherItemId }]) {
    const tampered = JSON.parse(JSON.stringify(signed));
    Object.assign(tampered.record, patch);
    assert.throws(() => staged.verifyStagedReview(tampered, KEY), /STAGED_MEDIA_RECORD_INVALID/);
  }
  assert.throws(() => staged.verifyStagedReview({ record: signed.record, signature: signed.signature, extra: 1 }, KEY), /STAGED_MEDIA_RECORD_INVALID/);
  assert.throws(() => staged.verifyStagedReview({ record: signed.record, signature: '0'.repeat(64) }, KEY), /STAGED_MEDIA_RECORD_INVALID/);
  // A native review can never verify as a staged one, and the other way round.
  const nativeSigned = nativeRecord.signMediaReview({ version: 1, identity, mediaId: 'gid://shopify/MediaImage/1', imageUrl: 'https://cdn.shopify.com/s/files/1/0622/8082/7130/files/a.jpg',
    decodedSha256: sha, sourceUrl: 'https://www.toptik.co.il/products/x', evidence: 'native', actorId, reviewedAt: '2026-11-10T06:00:00.000Z', reviewedExactSkuColor: true }, KEY);
  assert.throws(() => staged.verifyStagedReview(nativeSigned, KEY), /STAGED_MEDIA_RECORD_INVALID/);
  assert.throws(() => nativeRecord.verifyMediaReview(signed, identity, KEY), /MEDIA_REVIEW_RECORD_INVALID/);
  // The signature itself is bound to the staged domain: the same record signed under the native domain is not accepted,
  // so the separation does not depend on the two record shapes happening to differ.
  const under = domain => createHmac('sha256', KEY).update(domain + JSON.stringify(signed.record)).digest('hex');
  assert.equal(signed.signature, under('toptik:staged-gallery-media-review:v1\n'));
  assert.notEqual(signed.signature, under('toptik:exact-product-media-review:v1\n'));
  assert.throws(() => staged.verifyStagedReview({ record: signed.record, signature: under('toptik:exact-product-media-review:v1\n') }, KEY), /STAGED_MEDIA_RECORD_INVALID/);
});

test('the native review schema stays strict: it still refuses a Storage upload URL and a non-Shopify image', () => {
  const native = { version: 1, identity, mediaId: 'gid://shopify/MediaImage/1', imageUrl: record().imageUrl, decodedSha256: sha, sourceUrl: 'https://www.toptik.co.il/products/x',
    evidence: 'x', actorId, reviewedAt: '2026-11-10T06:00:00.000Z', reviewedExactSkuColor: true };
  assert.throws(() => nativeRecord.reviewRecord(native), /MEDIA_REVIEW_RECORD_INVALID/);
  assert.throws(() => nativeRecord.reviewRecord({ ...native, imageUrl: uploadUrl }), /MEDIA_REVIEW_RECORD_INVALID/);
});

test('the receipt path depends only on identity, URL and bytes, so a repeated confirmation resolves to the same record', () => {
  const a = staged.stagedReviewPath(record());
  assert.match(a, new RegExp(`^staged-v1/${itemId}/[a-f0-9]{64}\\.json$`));
  assert.equal(staged.stagedReviewPath(staged.stagedRecord(recordInput({ note: 'אחר', actorId: otherItemId, reviewedAt: '2026-11-11T00:00:00.000Z' }))), a);
  assert.notEqual(staged.stagedReviewPath(staged.stagedRecord(recordInput({ decodedSha256: 'b'.repeat(64), stagedPath: staged.stagedStoragePath(itemId, 'b'.repeat(64), 'image/jpeg'),
    imageUrl: staged.stagedPublicUrl(staged.stagedStoragePath(itemId, 'b'.repeat(64), 'image/jpeg')) }))), a);
  assert.notEqual(staged.stagedReviewPath(staged.stagedRecord(recordInput({ identity: { ...identity, variantId: 'gid://shopify/ProductVariant/9' } }))), a);
  assert.equal(staged.stagedReviewPrefix(itemId), 'staged-v1/' + itemId);
  assert.throws(() => staged.stagedReviewPrefix('nope'), /STAGED_MEDIA_RECORD_INVALID/);
});

// ---- the existing guards, driven with staged entries --------------------------------------------------------------
const entry = (patch = {}) => ({ ...staged.stagedReviewEntry(record()), ...patch });
const registry = entries => ({ items: entries, deniedUrls: [], deniedSha256: [] });
const card = (extra = {}) => ({ id: itemId, catalogNumber: 'KF901003', shopifyLink: { variantId: '67936407388410', handle: identity.productHandle }, coverImagePath: 'https://cdn.shopify.com/s/files/1/0622/8082/7130/files/cover.webp',
  colors: [], angles: [], ...extra });
const withAngle = url => ({ items: [card({ angles: [{ id: 'new-angle', imagePath: url }] })], settings: {} });
const current = () => ({ items: [card()], settings: {} });

test('the entry carries exactly the approval the guards compare', () => {
  const e = staged.stagedReviewEntry(record());
  assert.deepEqual({ sku: e.sku, shopifySku: e.shopifySku, productId: e.productId, variantId: e.variantId, galleryId: e.galleryId, imageUrl: e.imageUrl, decodedSha256: e.decodedSha256, sourceUrl: e.sourceUrl },
    { sku: 'KF901003', shopifySku: 'KF901003', productId: identity.productId, variantId: identity.variantId, galleryId: itemId, imageUrl: record().imageUrl, decodedSha256: sha, sourceUrl: null });
});

test('catalog save: the staged URL is approved only for its own card, SKU, variant and exact URL', () => {
  const url = record().imageUrl;
  assert.throws(() => guard.assertReviewedCatalogMedia(withAngle(url), current(), registry([])), /MEDIA_REVIEW_REQUIRED/);
  guard.assertReviewedCatalogMedia(withAngle(url), current(), registry([entry()]));
  const wrong = [{ galleryId: otherItemId }, { sku: 'KF901004' }, { variantId: 'gid://shopify/ProductVariant/1' }, { imageUrl: url + '?v=2' }];
  for (const patch of wrong) assert.throws(() => guard.assertReviewedCatalogMedia(withAngle(url), current(), registry([entry(patch)])), /MEDIA_REVIEW_REQUIRED/, JSON.stringify(patch));
  // Another card in the same catalog cannot borrow the receipt either.
  const other = { items: [card({ id: otherItemId, angles: [{ id: 'n', imagePath: url }] })], settings: {} };
  assert.throws(() => guard.assertReviewedCatalogMedia(other, { items: [card({ id: otherItemId })], settings: {} }, registry([entry()])), /MEDIA_REVIEW_REQUIRED/);
  // The cover can use it as well, exactly once approved.
  guard.assertReviewedCatalogMedia({ items: [card({ coverImagePath: url })], settings: {} }, current(), registry([entry()]));
});

test('a staged receipt cannot approve changed bytes under the same URL, and the deny list still wins', () => {
  const url = record().imageUrl, identityForGuard = { ...identity, productHandle: identity.productHandle };
  guard.requireReviewedMedia(identityForGuard, url, sha, registry([entry()]));
  assert.throws(() => guard.requireReviewedMedia(identityForGuard, url, 'd'.repeat(64), registry([entry()])), /MEDIA_REVIEW_REQUIRED/);
  assert.throws(() => guard.requireReviewedMedia({ ...identityForGuard, exactShopifySku: 'OTHER' }, url, sha, registry([entry()])), /MEDIA_REVIEW_REQUIRED/);
  assert.throws(() => guard.requireReviewedMedia(identityForGuard, url, sha, { items: [entry()], deniedUrls: [url], deniedSha256: [] }), /MEDIA_REVIEW_REJECTED/);
  assert.throws(() => guard.requireReviewedMedia(identityForGuard, url, sha, { items: [entry()], deniedUrls: [], deniedSha256: [sha] }), /MEDIA_REVIEW_REJECTED/);
  assert.throws(() => guard.assertReviewedCatalogMedia(withAngle(url), current(), { items: [entry()], deniedUrls: [url], deniedSha256: [] }), /MEDIA_REVIEW_REJECTED/);
});

test('runtime lineage: a Gallery proof of the staged image is reviewed by the receipt, a proof for any other bytes is not', () => {
  const url = record().imageUrl;
  const proof = patch => ({ product_gid: identity.productId, evidence_id: 'g:1', asset_key: 'g-angle:1', content_id: sha, side: 'gallery',
    proof: { platformRef: 'angle:1', url, decodedSha256: sha, mime: 'image/jpeg', width: 1698, height: 2000, byteLength: 260000, ownership: 'owned_storage', ...patch } });
  const p = proof();
  assert.equal(guard.isReviewedMediaProof(identity, p, [p], registry([entry()])), true);
  assert.equal(guard.isReviewedMediaProof(identity, p, [p], registry([])), false);
  const replaced = proof({ decodedSha256: 'd'.repeat(64) });
  assert.equal(guard.isReviewedMediaProof(identity, replaced, [replaced], registry([entry()])), false);
  const elsewhere = proof({ url: record().imageUrl + '?other=1' });
  assert.equal(guard.isReviewedMediaProof(identity, elsewhere, [elsewhere], registry([entry()])), false);
  assert.equal(guard.isReviewedMediaProof({ ...identity, itemId: otherItemId }, p, [p], registry([entry()])), false);
  // A queued attach step is guarded the same way.
  const step = { body: { kind: 'attach', target: 'shopify', key: 'g-angle:1' }, expected_pair: { shopify: { assets: [{ key: 'g-angle:1', evidenceId: 'g:1', contentId: sha }] } } };
  guard.assertReviewedMediaOperation({ identity, step, provenance: [p] }, registry([entry()]));
  assert.throws(() => guard.assertReviewedMediaOperation({ identity, step, provenance: [p] }, registry([])), /MEDIA_REVIEW_REQUIRED/);
});
