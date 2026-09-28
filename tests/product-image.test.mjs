import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const asModule = (source) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const trimSource = await readFile(new URL('../src/lib/carousel/trim-src.ts', import.meta.url), 'utf8');
const helperSource = await readFile(new URL('../src/lib/carousel/product-image.ts', import.meta.url), 'utf8');
const helpers = await import(asModule(helperSource.replace('"./trim-src"', JSON.stringify(asModule(trimSource)))));
const { ownProductImagePaths, productImageIdentity, productImageCandidates, firstDecodedProductImage, decodeProductImage } = helpers;
const { trimmedProductSrc } = await import(asModule(trimSource));
const cover = 'https://test.supabase.co/storage/v1/object/public/catalog/BXL58145.050/cover.jpg';
const angle = 'https://test.supabase.co/storage/v1/object/public/catalog/BXL58145.050/angle.jpg';
const sibling = 'https://test.supabase.co/storage/v1/object/public/catalog/BXL58145.078/cover.jpg';
const item = {
  id: 'navy-item', catalogNumber: 'BXL58145.050', coverImagePath: cover,
  angles: [{ imagePath: angle, angleOrder: 1 }, { imagePath: cover, angleOrder: 0 }],
  colors: [{ catalogNumber: 'BXL58145.078', imagePath: sibling, angles: [sibling] }],
};

test('candidate order is exact trimmed source, exact raw source, then only own cover/angles', () => {
  const before = structuredClone(item);
  assert.deepEqual(ownProductImagePaths(item), [cover, angle]);
  assert.deepEqual(productImageCandidates(item, angle, 720), [
    { src: trimmedProductSrc(angle, 720), originalSrc: angle },
    { src: angle, originalSrc: angle },
    { src: trimmedProductSrc(cover, 720), originalSrc: cover },
    { src: cover, originalSrc: cover },
  ]);
  assert.deepEqual(item, before, 'candidate calculation does not mutate assets or angle order');
});

test('a sibling SKU preferred URL is ignored; no colors, generic image, URL rewrite, or duplicate requests', () => {
  const candidates = productImageCandidates(item, sibling, 720);
  assert.deepEqual(candidates.map((candidate) => candidate.originalSrc), [cover, cover, angle, angle]);
  assert.ok(candidates.every(({ src }) => !src.includes('.078')));
  const manual = { id: 'manual', catalogNumber: 'CUSTOM / 1', coverImagePath: '/manual-cover.jpg', angles: [{ imagePath: '/manual-cover.jpg' }] };
  assert.deepEqual(productImageCandidates(manual, '/other-product.jpg', 720), [
    { src: '/manual-cover.jpg', originalSrc: '/manual-cover.jpg' },
  ]);
  assert.deepEqual(productImageCandidates({ ...manual, coverImagePath: '', angles: [] }, sibling, 720), []);
});

test('exact SKU or image changes invalidate readiness and failure identities, but copy edits do not', () => {
  assert.notEqual(productImageIdentity(item), productImageIdentity({ ...item, catalogNumber: 'BXL58145.078' }));
  assert.notEqual(productImageIdentity(item), productImageIdentity({ ...item, coverImagePath: '/corrected.jpg' }));
  assert.notEqual(productImageIdentity(item), productImageIdentity({ ...item, angles: [] }));
  assert.equal(productImageIdentity(item), productImageIdentity({ ...item, title: 'Edited by owner' }));
});

test('trim failure falls back to exact raw URL and stops after the first decoded candidate', async () => {
  const candidates = productImageCandidates(item, cover, 720);
  const attempts = [];
  const result = await firstDecodedProductImage(candidates, async (src) => {
    attempts.push(src);
    if (src !== cover) throw new Error('502');
  }, new AbortController().signal);
  assert.deepEqual(attempts, [trimmedProductSrc(cover, 720), cover]);
  assert.deepEqual(result, { src: cover, originalSrc: cover });
});

test('all failures exhaust each candidate once with no infinite retries or other product fallback', async () => {
  const candidates = productImageCandidates(item, cover, 720);
  const attempts = [];
  const result = await firstDecodedProductImage(candidates, async (src) => {
    attempts.push(src);
    throw new Error('offline');
  }, new AbortController().signal);
  assert.equal(result, null);
  assert.deepEqual(attempts, candidates.map(({ src }) => src));
  assert.equal(new Set(attempts).size, attempts.length);
});

function probe(options = {}) {
  return {
    src: '', decoding: '', onload: null, onerror: null, complete: false,
    naturalWidth: 320, naturalHeight: 640, decode: async () => {},
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    ...options,
  };
}

test('load alone cannot reveal a card; decoded pixels with positive dimensions are required', async () => {
  let finishDecode;
  const image = probe({ decode: () => new Promise((resolve) => { finishDecode = resolve; }) });
  let ready = false;
  const pending = decodeProductImage(cover, new AbortController().signal, () => image).then(() => { ready = true; });
  const onLoad = image.onload;
  void onLoad();
  await Promise.resolve();
  assert.equal(ready, false);
  finishDecode();
  await pending;
  assert.equal(ready, true);
  assert.equal(image.onload, null);
  assert.equal(image.onerror, null);
});

test('decode rejection, zero dimensions, and load errors all reject and release the failed source', async () => {
  for (const options of [
    { decode: async () => { throw new Error('corrupt'); } },
    { naturalWidth: 0 },
    { naturalHeight: 0 },
  ]) {
    const image = probe(options);
    const pending = decodeProductImage(cover, new AbortController().signal, () => image);
    void image.onload();
    await assert.rejects(pending, /decode failed/);
    assert.equal(image.src, '');
  }
  const image = probe();
  const pending = decodeProductImage(cover, new AbortController().signal, () => image);
  image.onerror();
  await assert.rejects(pending, /load failed/);
  assert.equal(image.onload, null);
});

test('cached complete images still wait for decode and image timeouts are bounded', async () => {
  let decoded = 0;
  const cached = probe({ complete: true, decode: async () => { decoded += 1; } });
  await decodeProductImage(cover, new AbortController().signal, () => cached);
  assert.equal(decoded, 1);
  const hanging = probe();
  await assert.rejects(decodeProductImage(cover, new AbortController().signal, () => hanging, 5), /timed out/);
  assert.equal(hanging.src, '');
  assert.equal(hanging.onload, null);
});

test('aborting a stale item/angle load neither reveals the stale result nor exhausts the next candidates', async () => {
  const controller = new AbortController();
  let finishDecode;
  const image = probe({ decode: () => new Promise((resolve) => { finishDecode = resolve; }) });
  const attempts = [];
  const result = firstDecodedProductImage(productImageCandidates(item, cover, 720), (src, signal) => {
    attempts.push(src);
    return decodeProductImage(src, signal, () => image);
  }, controller.signal);
  void image.onload();
  controller.abort();
  finishDecode();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(attempts.length, 1);
  assert.equal(image.src, '');
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(decodeProductImage(cover, alreadyAborted.signal, () => { throw new Error('must not create'); }), { name: 'AbortError' });
});

test('view integration gates card contents, filters exhausted media without writes, and preserves modal frame ownership', async () => {
  const grid = await readFile(new URL('../src/components/carousel/CarouselGrid.tsx', import.meta.url), 'utf8');
  const modal = await readFile(new URL('../src/components/carousel/ProductModal.tsx', import.meta.url), 'utf8');
  const image = await readFile(new URL('../src/components/carousel/ReliableProductImage.tsx', import.meta.url), 'utf8');
  assert.match(grid, /<article[\s\S]*?visibility: imageReady \? undefined : "hidden"/);
  assert.match(grid, /items\.filter\(\(item\) => !unavailableImages\.has\(productImageIdentity\(item\)\)\)/);
  assert.match(grid, /key=\{productImageIdentity\(item\)\}/);
  assert.match(grid, /autoHeight=\{true\}/);
  assert.match(grid, /className="catalog-card-body swiper-no-swiping"/);
  assert.match(grid, /state === "unavailable"\) onImageUnavailable/);
  assert.match(image, /frame\?\.owner === owner \? frame : null/);
  assert.match(image, /lastDecoded\.current\?\.owner === request\.owner \? "ready" : "unavailable"/);
  assert.match(image, /loading="eager"/);
  assert.match(image, /return \(\) => controller\.abort\(\)/);
  assert.match(image, /onError=\{/);
  assert.match(modal, /onResolved=\{setResolvedPath\}/);
  assert.match(modal, /gallery\.indexOf\(resolvedPath\)/);
  assert.doesNotMatch(modal, /currentSwatch\.angles/);
  for (const source of [grid, modal, image]) assert.doesNotMatch(source, /supabase|\.delete\(|\.update\(|\.upsert\(|fetch\(/);
});
