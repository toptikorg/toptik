import test from 'node:test';
import assert from 'node:assert/strict';
import { assertVideoNavigation, assertVideoNavigationMatchesStore } from '../scripts/production-visual-smoke.mjs';

const valid = '<title>סרטוני TopTik</title><meta name="description" content="מדריכי וידאו לבחירת מזוודה"><a aria-label="טופ תיק, לדף הבית"><b>TOPTIK</b><i>Move in Style. Travel with Purpose.</i></a><nav>מזוודות וטרולי תיקים ארנקים ואביזרים מותגים מבצעים סרטוני מוצרים שירות ומידע</nav><h1>סרטוני מזוודות</h1><article><h2 data-video-live-title="true">טרולי Intuo 55</h2><p data-video-live-copy="true">איך בוחרים מזוודה?</p><video></video></article><link rel="canonical" href="https://landing.toptik.co.il/videos"><a href="https://www.toptik.co.il/products/example">קנייה</a>';
test('monitor detects missing navigation, logo, indexing and purchase links', () => {
  assert.doesNotThrow(() => assertVideoNavigation(valid));
  assert.throws(() => assertVideoNavigation(valid.replace('<b>TOPTIK</b>', '<img alt="TOPTIK">')), /logo/);
  assert.throws(() => assertVideoNavigation(valid.replace('<title>סרטוני TopTik</title>', '')), /title/);
  assert.throws(() => assertVideoNavigation(valid.replace('content="מדריכי וידאו לבחירת מזוודה"', 'content=""')), /description/);
  assert.throws(() => assertVideoNavigation(valid.replace('<video></video>', '')), /player/);
  assert.throws(() => assertVideoNavigation(valid.replace('data-video-live-title="true"', '')), /live title/);
  assert.throws(() => assertVideoNavigation(valid.replace('data-video-live-copy="true"', '')), /live copy/);
  assert.throws(() => assertVideoNavigation(valid.replace('</article>', '</article><article><video></video></article>')), /live title/);
  assert.throws(() => assertVideoNavigation(valid.replace('/videos"', '/videos/example"')), /structured data/);
  assert.throws(() => assertVideoNavigation(valid.replace('שירות ומידע', '')), /שירות ומידע/);
  assert.throws(() => assertVideoNavigation(valid + '<meta name="robots" content="noindex, follow">'), /noindex/);
  assert.throws(() => assertVideoNavigation(valid.replace('rel="canonical"', 'rel="alternate"')), /canonical/);
  assert.throws(() => assertVideoNavigation(valid.replace('https://www.toptik.co.il/products/', 'https://example.com/')), /purchase/);
});

test('monitor detects additions and destination changes in live store navigation', () => {
  const shop = '<nav id="tt-main-nav"><a href="/collections/samsonite">מותג</a><a href="https://landing.toptik.co.il/videos">וידאו</a><div class="tt-mobile-groups"><a href="/collections/all">נייד</a></div></nav>';
  const video = '<nav aria-label="תפריט ראשי"><a href="https://www.toptik.co.il/collections/samsonite">מותג</a><a href="/videos">וידאו</a></nav>';
  const check = (s, v) => assertVideoNavigationMatchesStore(s, v, 'https://www.toptik.co.il', 'https://landing.toptik.co.il');
  assert.doesNotThrow(() => check(shop, video));
  assert.throws(() => check(shop.replace('/collections/samsonite', '/collections/brics'), video), /differ/);
  assert.throws(() => check(shop.replace('מותג</a>', 'מותג חדש</a>'), video), /differ/);
  assert.throws(() => check(shop.replace('</nav>', '<a href="/pages/contact">צור קשר</a></nav>').replace('<div class="tt-mobile-groups">', '<div>'), video), /differ/);
  assert.throws(() => check('', video), /missing/);
});
