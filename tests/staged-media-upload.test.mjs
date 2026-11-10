import test from 'node:test';
import assert from 'node:assert/strict';
import { staged, guard, loadWrapped, itemId, otherItemId, identity, sha, uploadUrl, uploadUrlFor, actorId } from './helpers/staged-media-harness.mjs';

const make = await loadWrapped('src/lib/shopify/staged-media-upload.ts',
  ['captureMediaSourceBytes', 'assertNotDeniedMedia', 'saveStagedReview', 'STAGED_UPLOAD_MIMES', 'stagedPublicUrl', 'stagedRecord', 'stagedStoragePath', 'stagedUploadPath'],
  ['stageReviewedGalleryUpload']);
const bytes = (patch = {}) => ({ bytes: new Uint8Array([1, 2, 3]), sha256: sha, mime: 'image/jpeg', width: 1698, height: 2000, byteLength: 3, visual: '0', ...patch });
const input = (patch = {}) => ({ identity, approvalId: 'published-shopify-v1:15453683548410', uploadUrl, note: 'נבדק: תיק גב כחול', actorId, ...patch });

function fixture({ uploadError = null, stored = {}, original = {}, denied = { deniedUrls: [], deniedSha256: [] }, saveError = null, replayed = false, captureFails = null } = {}) {
  const calls = [], saved = [];
  const db = { storage: { from: bucket => ({ upload: async (path, body, options) => { calls.push(['upload', bucket, path, options, body]); return { error: uploadError }; } }) } };
  const capture = async (id, url) => {
    calls.push(['capture', url]);
    if (captureFails?.staged && url.includes('/sync-staged/')) throw new Error(captureFails.staged);
    if (captureFails?.upload && !url.includes('/sync-staged/')) throw new Error(captureFails.upload);
    return url.includes('/sync-staged/') ? bytes(stored) : bytes(original);
  };
  const save = async record => { calls.push(['save']); if (saveError) throw new Error(saveError); saved.push(record); return { registered: true, replayed }; };
  const { stageReviewedGalleryUpload } = make({
    captureMediaSourceBytes: () => { throw new Error('unexpected network'); }, assertNotDeniedMedia: (url, hash) => guard.assertNotDeniedMedia(url, hash, { items: [], ...denied }),
    saveStagedReview: save, STAGED_UPLOAD_MIMES: staged.STAGED_UPLOAD_MIMES, stagedPublicUrl: staged.stagedPublicUrl, stagedRecord: staged.stagedRecord,
    stagedStoragePath: staged.stagedStoragePath, stagedUploadPath: staged.stagedUploadPath,
  });
  return { calls, saved, run: (patch = {}, deadline = Date.now() + 20000) => stageReviewedGalleryUpload(db, input(patch), deadline, { capture, save, now: () => Date.parse('2026-11-10T06:00:00.000Z') }) };
}

test('anything but this card\'s own editor upload never reaches the network, the storage or the receipt store', async () => {
  for (const url of [uploadUrlFor(otherItemId), uploadUrlFor(itemId, 'owned-drafts'), uploadUrl + '?x=1', uploadUrl + '#f', 'https://127.0.0.1/secret.jpg',
    'https://cdn.shopify.com/s/files/1/0622/8082/7130/files/x.jpg', staged.stagedPublicUrl(`sync-staged/${itemId}/${sha}.jpg`), uploadUrl.replace('/angles/', '/%2e%2e/')]) {
    const f = fixture();
    await assert.rejects(f.run({ uploadUrl: url }), /STAGED_MEDIA_UPLOAD_INVALID/, url);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  await assert.rejects(f.run({}, Date.now() - 1), /STAGED_MEDIA_UPLOAD_INVALID/);
  assert.deepEqual(f.calls, []);
});

test('decoded bytes are copied without upsert to the content-addressed path, read back, then one receipt is saved', async () => {
  const f = fixture(), result = await f.run();
  assert.deepEqual(f.calls.map(c => c[0]), ['capture', 'upload', 'capture', 'save']);
  const [first, upload, second] = f.calls;
  assert.equal(first[1], uploadUrl);
  assert.equal(upload[1], 'carousel-media'); assert.equal(upload[2], `sync-staged/${itemId}/${sha}.jpg`);
  assert.equal(upload[3].upsert, false); assert.equal(upload[3].contentType, 'image/jpeg'); assert.deepEqual([...upload[4]], [1, 2, 3]);
  assert.equal(second[1], staged.stagedPublicUrl(`sync-staged/${itemId}/${sha}.jpg`));
  assert.deepEqual(result, { stagedUrl: second[1], stagedPath: `sync-staged/${itemId}/${sha}.jpg`, sha256: sha, mime: 'image/jpeg', width: 1698, height: 2000, byteLength: 3, replayed: false });
  const [record] = f.saved;
  assert.deepEqual({ imageUrl: record.imageUrl, decodedSha256: record.decodedSha256, identity: record.identity, actorId: record.actorId, note: record.note,
    reviewedAt: record.reviewedAt, uploadPath: record.uploadPath, approvalId: record.approvalId, reviewedExactSkuColor: record.reviewedExactSkuColor },
  { imageUrl: second[1], decodedSha256: sha, identity, actorId, note: 'נבדק: תיק גב כחול', reviewedAt: '2026-11-10T06:00:00.000Z',
    uploadPath: `items/${itemId}/angles/5a6e2a30-733b-4df9-be1d-7bfa056e4613.jpg`, approvalId: 'published-shopify-v1:15453683548410', reviewedExactSkuColor: true });
});

test('the staged name comes from the bytes that were actually decoded, not from the name or type the browser sent', async () => {
  const f = fixture({ original: { sha256: 'c'.repeat(64), mime: 'image/png' }, stored: { sha256: 'c'.repeat(64), mime: 'image/png' } });
  const result = await f.run({ uploadUrl: uploadUrlFor(itemId, 'angles', '5a6e2a30-733b-4df9-be1d-7bfa056e4613.jpg') });
  assert.equal(result.stagedPath, `sync-staged/${itemId}/${'c'.repeat(64)}.png`);
  assert.equal(f.saved[0].mime, 'image/png');
});

test('formats the pipeline does not stage, and renditions on the deny list, stop before anything is written', async () => {
  for (const mime of ['image/avif', 'image/gif', 'image/heic']) {
    const f = fixture({ original: { mime } });
    await assert.rejects(f.run(), /STAGED_MEDIA_FORMAT_INVALID/, mime);
    assert.deepEqual(f.calls.map(c => c[0]), ['capture']);
  }
  const copyUrl = staged.stagedPublicUrl(staged.stagedStoragePath(itemId, sha, 'image/jpeg'));
  for (const denied of [{ deniedUrls: [uploadUrl], deniedSha256: [] }, { deniedUrls: [], deniedSha256: [sha] }, { deniedUrls: [copyUrl], deniedSha256: [] }]) {
    const f = fixture({ denied });
    await assert.rejects(f.run(), /MEDIA_REVIEW_REJECTED/);
    assert.deepEqual(f.calls.map(c => c[0]), ['capture']);
  }
});

test('a decode or read failure of the upload is terminal: nothing is uploaded or saved', async () => {
  for (const code of ['MEDIA_SOURCE_DECODE_FAILED', 'MEDIA_SOURCE_READ_FAILED', 'MEDIA_SOURCE_BYTE_LIMIT', 'MEDIA_SOURCE_DNS_UNSAFE']) {
    const f = fixture({ captureFails: { upload: code } });
    await assert.rejects(f.run(), new RegExp(code));
    assert.deepEqual(f.calls.map(c => c[0]), ['capture']);
  }
});

test('an object that already exists is reused only after an exact content readback', async () => {
  const replay = fixture({ uploadError: { statusCode: '409', error: 'Duplicate' }, replayed: true });
  const result = await replay.run();
  assert.equal(result.sha256, sha); assert.equal(result.replayed, true);
  for (const stored of [{ sha256: 'b'.repeat(64) }, { byteLength: 4 }, { mime: 'image/png' }, { width: 1 }, { height: 1 }]) {
    const bad = fixture({ uploadError: { statusCode: '409' }, stored });
    await assert.rejects(bad.run(), /STAGED_MEDIA_READBACK_MISMATCH/, JSON.stringify(stored));
    assert.equal(bad.saved.length, 0);
  }
});

test('a failed readback distinguishes a storage failure from a mismatch and never saves a receipt', async () => {
  const unwritten = fixture({ uploadError: { statusCode: '500' }, captureFails: { staged: 'MEDIA_SOURCE_READ_FAILED' } });
  await assert.rejects(unwritten.run(), /STAGED_MEDIA_STORAGE_FAILED/);
  const unread = fixture({ captureFails: { staged: 'MEDIA_SOURCE_READ_FAILED' } });
  await assert.rejects(unread.run(), /STAGED_MEDIA_READBACK_MISMATCH/);
  assert.equal(unwritten.saved.length + unread.saved.length, 0);
});

test('a receipt-store failure surfaces after the immutable copy, and the copy can only ever hold the same bytes', async () => {
  const f = fixture({ saveError: 'MEDIA_REVIEW_STORAGE_READ_FAILED' });
  await assert.rejects(f.run(), /MEDIA_REVIEW_STORAGE_READ_FAILED/);
  assert.equal(f.calls.filter(c => c[0] === 'upload').length, 1);
  const retry = fixture({ uploadError: { statusCode: '409' } });
  assert.equal((await retry.run()).sha256, sha);
});

test('a storage call that never answers ends with the time-budget error and no receipt', async () => {
  const calls = [];
  const db = { storage: { from: () => ({ upload: () => new Promise(() => {}) }) } };
  const { stageReviewedGalleryUpload } = make({ captureMediaSourceBytes: () => {}, assertNotDeniedMedia: () => {}, saveStagedReview: async () => { calls.push('save'); return { replayed: false }; },
    STAGED_UPLOAD_MIMES: staged.STAGED_UPLOAD_MIMES, stagedPublicUrl: staged.stagedPublicUrl, stagedRecord: staged.stagedRecord, stagedStoragePath: staged.stagedStoragePath, stagedUploadPath: staged.stagedUploadPath });
  await assert.rejects(stageReviewedGalleryUpload(db, input(), Date.now() + 120, { capture: async () => bytes() }), /STAGED_MEDIA_TIME_BUDGET/);
  assert.deepEqual(calls, []);
});
