import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("multi-brand gallery identifies TopTik and explains real viewing tools before checkout", async () => {
  const source = await readFile(new URL("../src/app/carousel/CarouselPageClient.tsx", import.meta.url), "utf8");
  assert.match(source, /className="brand-wordmark carousel-brand-current" aria-hidden="true">\{brandLabel\}<\/span>/);
  assert.match(source, /<span className="carousel-brand-label">בחרו מותג<\/span>/);
  assert.match(source, /value=\{activeBrand\}/);
  assert.match(source, /<option key=\{brand.key\} value=\{brand.key\}>\{brand.label\}<\/option>/);
  assert.doesNotMatch(source, /className="brand-wordmark">MANDARINA DUCK/);
  assert.match(source, /הגדילו את התמונות/);
  assert.match(source, /הפרטים והמידות הזמינים לכל דגם/);
  assert.match(source, /המחיר והשלמת הרכישה מחכים לכם בחנות TopTik/);
  assert.doesNotMatch(source, /השוואה אוטומטית|סרטוני הדגמה לכל/);
});
