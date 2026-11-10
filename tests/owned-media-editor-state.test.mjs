import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const lib = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(readFileSync('src/lib/shopify/owned-media-editor-state.ts', 'utf8'))).toString('base64'));
const images = () => [1, 2, 3].map(n => ({ key: `m${n}`, mediaId: `gid://shopify/MediaImage/${n}`, url: `https://cdn.shopify.com/${n}.jpg`, alt: `תמונה ${n}` }));
const data = () => ({ itemId: 'color1', mapVersion: 3, sourceFingerprint: 'f'.repeat(64), enabled: true, images: images(), variants: [{ itemId: 'color1', sku: 'SKU1', label: 'שחור' }], unassigned: [{ mediaId: 'new', url: 'https://cdn/new.jpg', alt: 'תמונה' }], pending: null });
test('reordering is immutable, first image is deliberate cover and no identity is lost', () => {
  const original = images(), ordered = lib.moveOwnedEditorImage(original, 'm3', 'cover');
  assert.deepEqual(ordered.map(i => i.key), ['m3', 'm1', 'm2']);
  assert.deepEqual(original.map(i => i.key), ['m1', 'm2', 'm3']);
  assert.deepEqual(lib.moveOwnedEditorImage(original, 'm1', -1), original);
});
test('removing final color image is refused and removing cover promotes the next image', () => {
  assert.throws(() => lib.removeOwnedEditorImage([images()[0]], 'm1'), /האחרונה/);
  assert.equal(lib.removeOwnedEditorImage(images(), 'm1')[0].key, 'm2');
});
test('a command contains minimal desired identities and an immutable request ID for recovery', () => {
  const snapshot = data(), ordered = lib.moveOwnedEditorImage(snapshot.images, 'm2', 'cover');
  const command = lib.ownedMediaEditorCommand(snapshot, ordered, { new: ['color1'] }, 'request1');
  assert.equal(command.requestId, 'request1');
  assert.equal(command.expectedMapVersion, 3);
  assert.deepEqual(command.desiredImages[0], { mediaId: 'gid://shopify/MediaImage/2', alt: 'תמונה 2' });
  assert.deepEqual(command.assignments, [{ mediaId: 'new', itemIds: ['color1'] }]);
  assert.equal(lib.ownedMediaDraftChanged(snapshot, ordered, {}), true);
  assert.equal(lib.ownedMediaDraftChanged(snapshot, snapshot.images, {}), false);
});
test('pending and disabled snapshots cannot create a fresh operation', () => {
  assert.throws(() => lib.ownedMediaEditorCommand({ ...data(), enabled: false }, images(), {}, 'id'));
  assert.throws(() => lib.ownedMediaEditorCommand({ ...data(), pending: { requestId: 'old', status: 'pending', message: 'wait' } }, images(), {}, 'id'));
});
test('a new upload is an untrusted source URL, never a fabricated Shopify ID', () => {
  const uploaded = { key: 'upload', mediaId: null, url: 'https://example/upload', alt: 'תיק שחור מאחור' };
  const command = lib.ownedMediaEditorCommand(data(), [...images(), uploaded], {}, 'id');
  assert.deepEqual(command.desiredImages.at(-1), { mediaId: null, uploadUrl: uploaded.url, alt: uploaded.alt });
});
test('unknown assignments, duplicate images, empty alt and foreign colors are refused', () => {
  assert.throws(() => lib.ownedMediaEditorCommand(data(), images(), { missing: ['color1'] }, 'id'));
  assert.throws(() => lib.ownedMediaEditorCommand(data(), images(), { new: ['foreign'] }, 'id'));
  assert.throws(() => lib.ownedMediaEditorCommand(data(), [...images(), images()[0]], {}, 'id'));
  assert.throws(() => lib.ownedMediaEditorCommand(data(), [{ ...images()[0], alt: ' ' }], {}, 'id'));
});
