import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRelevantCategoryLinks } from '../scripts/production-visual-smoke.mjs';

const html = (paths) => `<div class="tt-side__list">${paths.map((path) => `<a href="${path}">category</a>`).join('')}</div>`;
const bags = ['/collections/fashion-bags', '/collections/backpacks', '/collections/תיקי-נסיעות', '/collections/תיקי-גב-למחשב'];
const samsonite = ['/collections/מזוודות-סמסונייט', '/collections/טרולי-carry-on/samsonite', '/collections/תיקי-נסיעות/samsonite', '/collections/תיקי-גב-למחשב/samsonite'];

test('detects an unrelated wallet link in bags', () => {
  assert.doesNotThrow(() => assertRelevantCategoryLinks(html(bags), 'all-bags'));
  assert.throws(() => assertRelevantCategoryLinks(html([...bags, '/collections/wallets']), 'all-bags'), /unrelated/);
});
test('detects missing brand category links', () => {
  assert.doesNotThrow(() => assertRelevantCategoryLinks(html(samsonite), 'samsonite'));
  assert.throws(() => assertRelevantCategoryLinks(html(['/collections/samsonite']), 'samsonite'), /missing/);
});
test('detects wrong category or missing sidebar', () => {
  assert.throws(() => assertRelevantCategoryLinks(html(['/collections/wallets']), 'wallets-and-accessories'), /missing/);
  assert.throws(() => assertRelevantCategoryLinks('<main></main>', 'all-bags'), /missing/);
});
test('detects the missing parent category on Mellow Urban', () => {
  assert.throws(() => assertRelevantCategoryLinks(html([]), 'mandarina-duck-mellow-urban'), /missing/);
  assert.doesNotThrow(() => assertRelevantCategoryLinks(html(['/collections/all-bags/mandarinaduck']), 'mandarina-duck-mellow-urban'));
});

