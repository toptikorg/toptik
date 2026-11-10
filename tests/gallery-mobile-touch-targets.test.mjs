import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Phone-width touch targets of the Gallery (QA at 390 and 360 px). Source-level guard: these rules must stay
// scoped to phones, must not touch the locked carousel image rules, and must not change the colour pill's box.
const read = path => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const globals = read('src/app/globals.css');
const marker = globals.indexOf('Mobile touch targets and readable text');
const block = marker < 0 ? '' : globals.slice(marker);
const phone = block.slice(block.indexOf('@media (max-width: 767px) {'));

test('the touch-target block exists and applies to phones only', () => {
  assert.ok(marker > 0, 'block missing');
  assert.ok(phone.startsWith('@media (max-width: 767px) {'));
  // Everything after the marker sits inside that one media query: no rule outside it.
  const outside = phone.replace(/@media \(max-width: 767px\) \{[\s\S]*\n\}\s*$/, '').trim();
  assert.equal(outside, '');
});

test('colour dots gain a tap area through ::after and keep their own size, so the pill and the image clearance do not change', () => {
  assert.match(phone, /\.catalog-card-color-dot\.is-actionable:not\(\.is-color-name\)::after\s*\{[^}]*content:\s*"";[^}]*position:\s*absolute;[^}]*inset-block:\s*-9px;[^}]*inset-inline:\s*-7px;[^}]*\}/);
  assert.match(phone, /\.catalog-card-color-dot\.is-actionable:not\(\.is-color-name\)\s*\{\s*position:\s*relative;\s*\}/);
  assert.doesNotMatch(phone, /\.catalog-card-color-dot\.is-actionable(?!:not\(\.is-color-name\))(?:::after)?\s*\{/, 'name chips (already 24px tall) get no extra hit area');
  assert.doesNotMatch(phone, /\.catalog-card-color-dot(?:\.is-actionable)?\s*\{[^}]*\b(?:width|height|padding|margin|border)\b/, 'the visible dot is not resized');
  assert.doesNotMatch(phone, /\.catalog-card-colors\s*\{/, 'the pill box is untouched');
});

test('dot spacing widens only for plain-colour rows of up to six dots; seven or more keep the original gap so no row overflows its pill more than before', () => {
  const gaps = [...phone.matchAll(/\.catalog-card-colors-dots:not\(:has\(\.is-color-name\)\)((?::has\(> :nth-child\(\d+\)\))?)\s*\{\s*gap:\s*(\d+)px;\s*\}/g)].map(m => [m[1], Number(m[2])]);
  assert.deepEqual(gaps, [['', 15], [':has(> :nth-child(6))', 9], [':has(> :nth-child(7))', 3]]);
  // The seven-dot tier restores the stylesheet's own phone gap, so the two values must stay equal.
  assert.match(globals.slice(0, marker), /\.catalog-card-colors-dots\s*\{\s*gap:\s*3px;\s*\}/, 'original phone gap is 3px');
  assert.doesNotMatch(phone, /\.is-color-name\s*\{/, 'name chips keep their own layout');
});

test('small text and the two card buttons grow on phones, downward only', () => {
  assert.match(phone, /\.catalog-card-colors:not\(:has\(\.is-color-name\)\) \.catalog-card-colors-label\s*\{\s*font-size:\s*11px;\s*line-height:\s*11px;\s*\}/, 'larger label, same line box, plain pills only');
  assert.doesNotMatch(phone, /^\s*\.catalog-card-colors-label\s*\{/m, 'pills that hold name chips keep the 9px label, so they do not wrap onto another row');
  assert.match(phone, /\.catalog-card-catalog\s*\{\s*font-size:\s*12px;\s*\}/);
  assert.match(phone, /\.catalog-card-tech-btn,\s*\.catalog-card-buy-btn\s*\{[^}]*font-size:\s*12px;[^}]*height:\s*auto;[^}]*min-height:\s*36px;/);
  assert.match(phone, /\.catalog-card-tech-btn\s*\{\s*white-space:\s*normal;\s*\}/);
});

test('the locked carousel image rules are not touched by this block and are still present', () => {
  assert.doesNotMatch(block, /\.catalog-card-image(?:-wrap)?\s*\{/);
  assert.doesNotMatch(block, /transform:\s*scale|\bscale\s*:/);
  const before = globals.slice(0, marker);
  assert.ok(before.includes('padding: 52px 12px 44px;'), 'desktop image wrap padding');
  assert.ok(before.includes('padding: 36px 8px 30px;'), 'mobile image wrap padding');
  assert.ok(before.includes('mix-blend-mode: multiply;'), 'image blend');
});

test('the Videos header links and the Journal store links get a comfortable tap height on phones', () => {
  const videos = read('src/components/video-gallery/VideoGallery.module.css');
  const media720 = videos.slice(videos.indexOf('@media (max-width: 720px) {'));
  assert.match(media720.slice(0, media720.indexOf('\n}')), /\.quickLinks a\s*\{\s*display:\s*inline-flex;\s*align-items:\s*center;\s*min-height:\s*44px;\s*\}/);
  const journal = read('src/components/editorial/Journal.module.css');
  const media767 = journal.slice(journal.lastIndexOf('@media (max-width: 767px) {'));
  assert.match(media767, /\.storeGuides ul\s*\{\s*gap:\s*0;\s*\}/);
  assert.match(media767, /\.storeGuides a\s*\{\s*display:\s*inline-flex;\s*align-items:\s*center;\s*min-height:\s*40px;\s*\}/);
});
