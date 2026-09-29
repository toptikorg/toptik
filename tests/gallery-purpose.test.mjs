import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("multi-brand gallery identifies TopTik; explanations are a11y-only, replaced by the status line", async () => {
  const source = await readFile(new URL("../src/app/carousel/CarouselPageClient.tsx", import.meta.url), "utf8");
  assert.match(source, /<BrandPicker/);
  assert.match(source, /id="carousel-brand-help"/);
  assert.match(source, /value=\{activeBrand\}/);
  assert.match(source, /brands=\{brands\}/);
  assert.doesNotMatch(source, /className="brand-wordmark">MANDARINA DUCK/);
  // 2026-09-30: the visible explanation paragraph was removed by request; one dynamic
  // status line (brand › category · range of total) in CarouselGrid replaces it.
  assert.doesNotMatch(source, /carousel-showroom-note/);
  assert.match(source, /carousel-a11y-hidden/);
  assert.match(source, /brandLabel=\{brandLabel\}/);
  assert.match(source, /category=\{activeCategory\}/);
  assert.doesNotMatch(source, /השוואה אוטומטית|סרטוני הדגמה לכל/);
});
