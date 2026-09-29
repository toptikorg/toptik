import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const grid = readFileSync("src/components/carousel/CarouselGrid.tsx", "utf8");
const page = readFileSync("src/app/carousel/CarouselPageClient.tsx", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");

test("gallery never moves by itself", () => {
  assert.ok(!/Autoplay/.test(grid), "Autoplay module must not be imported or used");
  assert.ok(!/autoplay\s*=\s*\{\{/.test(grid));
  assert.ok(!/\.autoplay\?/.test(grid));
});

test("position indicator shows range and total, with list edges", () => {
  assert.match(grid, /מוצרים \$\{first\}–\$\{last\} מתוך \$\{total\}/);
  assert.match(grid, /תחילת הרשימה/);
  assert.match(grid, /סוף הרשימה/);
  assert.match(grid, /aria-live="polite"/);
});

test("product arrows have their own accessible names, distinct from the modal angle arrows", () => {
  assert.match(grid, /aria-label="מוצרים קודמים"/);
  assert.match(grid, /aria-label="מוצרים הבאים"/);
  assert.ok(!/aria-label="עמוד קודם"/.test(grid));
  const modal = readFileSync("src/components/carousel/ProductModal.tsx", "utf8");
  assert.match(modal, /דפדף לזווית הבאה/);
});

test("both placement options exist and the default keeps the side arrows", () => {
  assert.match(page, /searchParams\.get\("nav"\) === "bar" \? "bar" : "side"/);
  assert.match(grid, /navVariant = "side"/);
  assert.match(css, /\.carousel-controls-btn/);
  assert.match(css, /min-height: 48px/);
});

test("brand default is untouched", () => {
  const brands = readFileSync("src/lib/carousel/brands.ts", "utf8");
  assert.match(brands, /"mandarina-duck"\) \? "mandarina-duck" : "all"/);
});

import { stripTypeScriptTypes } from "node:module";
const src = p => stripTypeScriptTypes(readFileSync(p, "utf8"));
const cats = src("src/lib/carousel/categories.ts").replace(/^import .*$/gm, "");
const sum = src("src/lib/carousel/selection-summary.ts").replace(/^import .*$/gm, "").replace(/^export /gm, "");
const { selectionSummary } = await import(`data:text/javascript;base64,${Buffer.from(cats + "\n" + sum + "\nexport { selectionSummary };").toString("base64")}`);

test("selection summary names brand, category and count for every combination", () => {
  const a = selectionSummary({ brandLabel: "Mandarina Duck", allBrands: false, category: "all", total: 12 });
  assert.equal(a.selection, "מותג: Mandarina Duck · קטגוריה: כל המוצרים · 12 מוצרים");
  assert.match(a.help, /"כל המוצרים" מציג את כל 12 מוצרי Mandarina Duck, בכל הקטגוריות/);
  const b = selectionSummary({ brandLabel: "Bric's", allBrands: false, category: "suitcase", total: 7 });
  assert.match(b.selection, /קטגוריה: מזוודה · 7 מוצרים/);
  assert.match(b.help, /רק מוצרי Bric's בקטגוריה "מזוודה"/);
  const c = selectionSummary({ brandLabel: "כל המותגים", allBrands: true, category: "all", total: 80 });
  assert.match(c.selection, /מותג: כל המותגים/);
  assert.match(c.help, /כל 80 המוצרים של כל המותגים, בכל הקטגוריות/);
  const d = selectionSummary({ brandLabel: "כל המותגים", allBrands: true, category: "carryon", total: 31 });
  assert.match(d.help, /כל המותגים, אך רק בקטגוריה "טרולי \/ Carry-on"/);
});

test("counter shows range, total and slide number and resets with the filter", () => {
  assert.match(grid, /שקופית \$\{Math\.min\(activeIndex \+ 1, pages\.length\)\} מתוך \$\{pages\.length\}/);
  // The Swiper is keyed by perPage + item ids, so a filter change remounts it at slide 0 and onSwiper resyncs the counter.
  assert.match(grid, /key=\{swiperKey\}/);
  assert.match(grid, /onSwiper=\{\(s\) => \{[^\n]*setActiveIndex\(s\.activeIndex\)/);
  assert.match(page, /carousel-selection/);
});
