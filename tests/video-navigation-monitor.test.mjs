import test from 'node:test';
import assert from 'node:assert/strict';
import { assertVideoNavigation } from '../scripts/production-visual-smoke.mjs';

const valid = '<img src="/_next/image?url=%2Ftoptiklogo.png" alt="TopTik"><nav>מזוודות וטרולי תיקים ארנקים ואביזרים מותגים מבצעים סרטוני מוצרים שירות ומידע</nav><link rel="canonical" href="https://landing.toptik.co.il/videos"><a href="https://www.toptik.co.il/products/example">קנייה</a>';
test('monitor detects missing navigation, logo, indexing and purchase links', () => {
  assert.doesNotThrow(() => assertVideoNavigation(valid));
  assert.throws(() => assertVideoNavigation(valid.replace('toptiklogo.png', 'other.png')), /logo/);
  assert.throws(() => assertVideoNavigation(valid.replace('שירות ומידע', '')), /שירות ומידע/);
  assert.throws(() => assertVideoNavigation(valid + '<meta name="robots" content="noindex, follow">'), /noindex/);
  assert.throws(() => assertVideoNavigation(valid.replace('rel="canonical"', 'rel="alternate"')), /canonical/);
  assert.throws(() => assertVideoNavigation(valid.replace('https://www.toptik.co.il/products/', 'https://example.com/')), /purchase/);
});
