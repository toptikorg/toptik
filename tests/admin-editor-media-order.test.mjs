import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(readFileSync('src/lib/carousel/editor-media-order.ts', 'utf8'));
const { removeEditorAngle, moveEditorAngle, promoteEditorAngle } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const angle = (id, n) => ({ id, itemId: 'item', angleKey: id, imagePath: `https://cdn/${id}`, imageAlt: id, angleOrder: n });
const item = () => ({ id: 'item', title: 'מוצר', coverImagePath: 'https://cdn/a', coverImageAlt: 'a', angles: [angle('a', 1), angle('b', 2), angle('c', 3)] });

test('removing the cover alias really removes that image and promotes the next image', () => {
  const original = item();
  const after = removeEditorAngle(original, 'a');
  assert.equal(after.coverImagePath, 'https://cdn/b');
  assert.equal(after.coverImageAlt, 'b');
  assert.deepEqual(after.angles.map(a => [a.id, a.angleOrder]), [['b', 1], ['c', 2]]);
  assert.equal(original.angles.length, 3);
  assert.equal(original.coverImagePath, 'https://cdn/a');
});
test('a separately stored cover is preserved when removing the last non-cover angle', () => {
  const after = removeEditorAngle({ ...item(), angles: [angle('b', 1)] }, 'b');
  assert.equal(after.coverImagePath, 'https://cdn/a');
  assert.equal(after.angles.length, 0);
});
test('the last image cannot be removed', () => {
  assert.throws(() => removeEditorAngle({ ...item(), angles: [angle('a', 1)] }, 'a'), /האחרונה/);
});
test('ordering changes the cover only to the explicit first image and keeps stable identities', () => {
  const original = item();
  const after = moveEditorAngle(original, 'b', -1);
  assert.deepEqual(after.angles.map(a => [a.id, a.angleOrder]), [['b', 1], ['a', 2], ['c', 3]]);
  assert.equal(after.coverImagePath, 'https://cdn/b');
  assert.equal(after.angles[0].angleKey, 'b');
  assert.equal(original.angles[0].id, 'a');
  assert.equal(moveEditorAngle(original, 'a', -1), original);
  assert.equal(moveEditorAngle(original, 'missing', 1), original);
});
test('choose cover makes its image first without duplicating or dropping any angle', () => {
  const after = promoteEditorAngle(item(), 'c');
  assert.equal(after.coverImagePath, 'https://cdn/c');
  assert.deepEqual(after.angles.map(a => a.id), ['c', 'a', 'b']);
  assert.deepEqual(after.angles.map(a => a.angleOrder), [1, 2, 3]);
});
