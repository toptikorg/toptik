import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("multi-brand gallery keeps one short visible note; status line carries the numbers", async () => {
  const source = await readFile(new URL("../src/app/carousel/CarouselPageClient.tsx", import.meta.url), "utf8");
  assert.match(source, /<BrandPicker/);
  assert.match(source, /id="carousel-brand-help"/);
  assert.match(source, /value=\{activeBrand\}/);
  assert.match(source, /brands=\{brands\}/);
  assert.doesNotMatch(source, /className="brand-wordmark">MANDARINA DUCK/);
  // 2026-09-30: the long explanation was replaced, per the owner, with this short note;
  // the dynamic status line (brand › category · range of total) in CarouselGrid carries the numbers.
  assert.match(source, /הגלריה של TopTik מאפשרת להכיר כל דגם, להשוות תמונות, זוויות ומידות, ולבחור בביטחון/);
  assert.match(source, /לבחירת מותג, לחצו על שם המותג מעל הקולקציה/);
  assert.match(source, /carousel-showroom-note/);
  assert.match(source, /brandLabel=\{brandLabel\}/);
  assert.match(source, /category=\{activeCategory\}/);
  assert.doesNotMatch(source, /השוואה אוטומטית|סרטוני הדגמה לכל/);
});
