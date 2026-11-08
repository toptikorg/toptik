import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCategorySeriesNavigation } from '../scripts/production-visual-smoke.mjs';

test('detects a missing series button or missing tagged series in a category', () => {
  const products = [{ tags: ['tt-series:mandarina-duck-zephyr', 'tt-series:mandarina-duck-md20'] }];
  const handles = ['mandarina-duck-zephyr', 'mandarina-duck-md20'];
  const html = '<details class="tt-series-nav"><summary>בחירה לפי סדרה</summary><a href="/collections/wallets-and-accessories/tt-series-mandarina-duck-zephyr">Zephyr</a><a href="/collections/wallets-and-accessories/tt-series-mandarina-duck-md20">MD20</a></details>';
  assert.doesNotThrow(() => assertCategorySeriesNavigation(html, 'wallets-and-accessories', products, handles));
  assert.throws(() => assertCategorySeriesNavigation('', 'wallets-and-accessories', products, handles), /series selection missing/);
  assert.throws(() => assertCategorySeriesNavigation(html.replace('tt-series-mandarina-duck-md20', 'wrong'), 'wallets-and-accessories', products, handles), /missing series/);
  assert.doesNotThrow(() => assertCategorySeriesNavigation('', 'empty', [{ tags: [] }], handles));
});

