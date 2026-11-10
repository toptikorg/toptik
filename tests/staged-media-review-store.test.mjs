import test from 'node:test';
import assert from 'node:assert/strict';
import { staged, nativeRecord, store, storageFake, KEY, itemId, otherItemId, identity, sha, actorId, recordInput, record } from './helpers/staged-media-harness.mjs';

const deadline = () => Date.now() + 20000;
const signedFile = (r = record()) => ({ path: staged.stagedReviewPath(r), text: JSON.stringify(staged.signStagedReview(r, KEY)) });
const nativeFile = () => {
  const r = { version: 1, identity, mediaId: 'gid://shopify/MediaImage/1', imageUrl: 'https://cdn.shopify.com/s/files/1/0622/8082/7130/files/a.jpg', decodedSha256: 'e'.repeat(64),
    sourceUrl: 'https://www.toptik.co.il/products/x', evidence: 'native review', actorId, reviewedAt: '2026-11-09T06:00:00.000Z', reviewedExactSkuColor: true };
  return { path: nativeRecord.reviewPath(r), text: JSON.stringify(nativeRecord.signMediaReview(r, KEY)) };
};
const withFiles = (...files) => storageFake({ existing: Object.fromEntries(files.map(f => [f.path, f.text])) });

test('a staged receipt is loaded as one exact entry next to the native reviews of the same card', async () => {
  const fake = withFiles(signedFile(), nativeFile());
  const entries = await store(fake).loadReviewedMedia(identity, deadline());
  assert.equal(entries.length, 2);
  const stagedEntry = entries.find(e => e.imageUrl === record().imageUrl);
  assert.equal(stagedEntry.decodedSha256, sha);
  assert.equal(stagedEntry.galleryId, itemId);
  assert.equal(entries.filter(e => e.evidence === 'native review').length, 1);
  const prefixes = fake.calls.filter(c => c[0] === 'list').map(c => c[2]).sort();
  assert.deepEqual(prefixes, [`staged-v1/${itemId}`, `v1/${itemId}`]);
});

test('a receipt for another identity of the same card is never returned for this one', async () => {
  const sameCardOtherVariant = staged.stagedRecord(recordInput({ identity: { ...identity, variantId: 'gid://shopify/ProductVariant/9' } }));
  const fake = withFiles(signedFile(sameCardOtherVariant));
  assert.deepEqual(await store(fake).loadReviewedMedia(identity, deadline()), []);
  assert.equal((await store(fake).loadReviewedMedia({ ...identity, variantId: 'gid://shopify/ProductVariant/9' }, deadline())).length, 1);
});

test('no receipts, or no private bucket yet, grants zero approvals without failing the native lookup', async () => {
  assert.deepEqual(await store(storageFake()).loadReviewedMedia(identity, deadline()), []);
  const noBucket = storageFake(); noBucket.state.listError = { statusCode: '404', message: 'Bucket not found' };
  assert.deepEqual(await store(noBucket).loadReviewedMedia(identity, deadline()), []);
  assert.deepEqual(await store(noBucket).loadReviewedMediaForItems([itemId, otherItemId], deadline()), []);
  // A missing receipt folder alone leaves the native entries of the card exactly as they were.
  const nativeOnly = withFiles(nativeFile()); nativeOnly.state.listErrorPrefix = 'staged-v1'; nativeOnly.state.listError = { statusCode: '404', message: 'Bucket not found' };
  assert.equal((await store(nativeOnly).loadReviewedMedia(identity, deadline())).length, 1);
  assert.equal((await store(nativeOnly).loadReviewedMediaForItems([itemId], deadline())).length, 1);
});

test('storage failures, foreign files, wrong signatures and misplaced records are refused, never skipped', async () => {
  const failing = storageFake(); failing.state.listError = { statusCode: '500', message: 'boom' };
  await assert.rejects(store(failing).loadReviewedMedia(identity, deadline()), /MEDIA_REVIEW_STORAGE_READ_FAILED/);
  // A failure of the receipt folder alone is not "no receipts": the lookup stops instead of going on with the native entries.
  const stagedOnly = withFiles(nativeFile()); stagedOnly.state.listErrorPrefix = 'staged-v1'; stagedOnly.state.listError = { statusCode: '500', message: 'boom' };
  await assert.rejects(store(stagedOnly).loadReviewedMedia(identity, deadline()), /MEDIA_REVIEW_STORAGE_READ_FAILED/);
  await assert.rejects(store(stagedOnly).loadReviewedMediaForItems([itemId], deadline()), /MEDIA_REVIEW_STORAGE_READ_FAILED/);
  const good = signedFile();
  await assert.rejects(store(withFiles({ path: `staged-v1/${itemId}/notes.txt`, text: 'x' })).loadReviewedMedia(identity, deadline()), /MEDIA_REVIEW_RECORD_INVALID/);
  await assert.rejects(store(withFiles(good)).loadReviewedMedia(identity, deadline()).then(() => store(withFiles(good), 'z'.repeat(48)).loadReviewedMedia(identity, deadline())), /STAGED_MEDIA_RECORD_INVALID/);
  const tampered = JSON.parse(good.text); tampered.record.width = 5;
  await assert.rejects(store(withFiles({ path: good.path, text: JSON.stringify(tampered) })).loadReviewedMedia(identity, deadline()), /STAGED_MEDIA_RECORD_INVALID/);
  // A native review copied into the staged prefix verifies under the wrong domain.
  const native = nativeFile();
  await assert.rejects(store(withFiles({ path: `staged-v1/${itemId}/${native.path.split('/').at(-1)}`, text: native.text })).loadReviewedMedia(identity, deadline()), /STAGED_MEDIA_RECORD_INVALID/);
  // A valid receipt stored under a path that is not its content-addressed path.
  await assert.rejects(store(withFiles({ path: `staged-v1/${itemId}/${'f'.repeat(64)}.json`, text: good.text })).loadReviewedMedia(identity, deadline()), /MEDIA_REVIEW_RECORD_INVALID/);
  // A valid receipt of another card in this card's prefix.
  const foreign = staged.stagedRecord(recordInput({ identity: { ...identity, itemId: otherItemId },
    uploadPath: `items/${otherItemId}/angles/5a6e2a30-733b-4df9-be1d-7bfa056e4613.jpg`,
    stagedPath: staged.stagedStoragePath(otherItemId, sha, 'image/jpeg'), imageUrl: staged.stagedPublicUrl(staged.stagedStoragePath(otherItemId, sha, 'image/jpeg')) }));
  const f = signedFile(foreign);
  await assert.rejects(store(withFiles({ path: `staged-v1/${itemId}/${f.path.split('/').at(-1)}`, text: f.text })).loadReviewedMedia(identity, deadline()), /MEDIA_REVIEW_RECORD_INVALID/);
});

test('the item lookup used by the catalog guard returns staged entries for every requested card', async () => {
  const other = staged.stagedRecord(recordInput({ identity: { ...identity, itemId: otherItemId, exactGallerySku: 'KM201008' },
    uploadPath: `items/${otherItemId}/cover/5a6e2a30-733b-4df9-be1d-7bfa056e4613.png`, mime: 'image/png',
    stagedPath: staged.stagedStoragePath(otherItemId, sha, 'image/png'), imageUrl: staged.stagedPublicUrl(staged.stagedStoragePath(otherItemId, sha, 'image/png')) }));
  const entries = await store(withFiles(signedFile(), signedFile(other))).loadReviewedMediaForItems([itemId, otherItemId, itemId], deadline());
  assert.deepEqual(entries.map(e => e.galleryId).sort(), [itemId, otherItemId].sort());
  assert.equal(entries.find(e => e.galleryId === otherItemId).sku, 'KM201008');
  await assert.rejects(store(storageFake()).loadReviewedMediaForItems(Array.from({ length: 501 }, (_, i) => `${i}`), deadline()), /MEDIA_REVIEW_RECORD_INVALID/);
});

test('saving creates a private JSON-only bucket, never overwrites, and reads the signed record back', async () => {
  const fake = storageFake({ bucket: null });
  const saved = await store(fake).saveStagedReview(record(), deadline());
  assert.deepEqual(saved, { registered: true, replayed: false, imageUrl: record().imageUrl, decodedSha256: sha });
  const create = fake.calls.find(c => c[0] === 'createBucket');
  assert.equal(create[1], 'toptik-media-reviews'); assert.equal(create[2].public, false); assert.deepEqual(create[2].allowedMimeTypes, ['application/json']);
  const upload = fake.calls.find(c => c[0] === 'upload');
  assert.equal(upload[2], staged.stagedReviewPath(record())); assert.equal(upload[3].upsert, false); assert.equal(upload[3].contentType, 'application/json');
  assert.deepEqual(staged.verifyStagedReview(JSON.parse(fake.files.get(upload[2])), KEY), record());
  assert.ok(fake.calls.findIndex(c => c[0] === 'download') > fake.calls.findIndex(c => c[0] === 'upload'), 'readback happens after the write');
});

test('confirming the same upload again is a replay that keeps the first receipt', async () => {
  const fake = storageFake(), s = store(fake);
  await s.saveStagedReview(record(), deadline());
  const first = fake.files.get(staged.stagedReviewPath(record()));
  const again = staged.stagedRecord(recordInput({ note: 'אישור נוסף', reviewedAt: '2026-11-10T07:00:00.000Z' }));
  const replay = await s.saveStagedReview(again, deadline());
  assert.equal(replay.replayed, true);
  assert.equal(fake.files.get(staged.stagedReviewPath(record())), first);
  assert.equal([...fake.files.keys()].length, 1);
});

test('a public bucket, an unreadable bucket, a bad key and a conflicting stored receipt all stop the save', async () => {
  await assert.rejects(store(storageFake({ bucket: { public: true } })).saveStagedReview(record(), deadline()), /MEDIA_REVIEW_STORAGE_NOT_PRIVATE/);
  await assert.rejects(store(storageFake()).saveStagedReview(record(), deadline()).then(() => store(storageFake(), 'short').saveStagedReview(record(), deadline())), /STAGED_MEDIA_SIGNING_UNAVAILABLE|MEDIA_REVIEW_SIGNING_UNAVAILABLE/);
  // A different receipt already occupies the content-addressed path: the readback must not accept it.
  const fake = storageFake();
  const other = staged.stagedRecord(recordInput({ identity: { ...identity, exactShopifySku: 'OTHER' } }));
  fake.files.set(staged.stagedReviewPath(record()), JSON.stringify(staged.signStagedReview(other, KEY)));
  await assert.rejects(store(fake).saveStagedReview(record(), deadline()), /MEDIA_REVIEW_RECORD_INVALID|STAGED_MEDIA_RECORD_INVALID/);
  await assert.rejects(store(storageFake()).saveStagedReview({ ...record(), extra: 1 }, deadline()), /STAGED_MEDIA_RECORD_INVALID/);
});
