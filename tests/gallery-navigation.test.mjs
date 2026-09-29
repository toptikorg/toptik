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

test("one short status line above the products: brand › category · range of total", () => {
  assert.match(grid, /statusLine\(\{ brandLabel, category, first, last, total \}\)/);
  assert.match(grid, /aria-live="polite"/);
  const sum = readFileSync("src/lib/carousel/selection-summary.ts", "utf8");
  assert.ok(!/help/.test(sum), "no explanation sentences");
});

test("prev/next sit in their own row above the products, with accessible names, and only move the carousel", () => {
  assert.match(grid, /aria-label="הקודם"/);
  assert.match(grid, /aria-label="הבא"/);
  assert.match(grid, /className="carousel-navrow"/);
  assert.match(grid, /swiperInstance\?\.slidePrev\(\)/);
  assert.match(grid, /swiperInstance\?\.slideNext\(\)/);
  assert.ok(!/history\.(back|forward|go)/.test(grid), "arrows must not touch browser history");
  assert.ok(!/carousel-nav\b/.test(grid), "no arrows overlaid on the product cards");
  // The row is rendered before the Swiper, i.e. above the photos.
  assert.ok(grid.indexOf("carousel-navrow") < grid.indexOf("<Swiper\n"));
  assert.match(css, /\.carousel-navrow-btn/);
  assert.match(css, /min-height: 44px/);
  const modal = readFileSync("src/components/carousel/ProductModal.tsx", "utf8");
  assert.match(modal, /דפדף לזווית הבאה/);
});

test("brand default is untouched", () => {
  const brands = readFileSync("src/lib/carousel/brands.ts", "utf8");
  assert.match(brands, /"mandarina-duck"\) \? "mandarina-duck" : "all"/);
});

import { stripTypeScriptTypes } from "node:module";
const src = p => stripTypeScriptTypes(readFileSync(p, "utf8"));
const cats = src("src/lib/carousel/categories.ts").replace(/^import .*$/gm, "");
const sum = src("src/lib/carousel/selection-summary.ts").replace(/^import .*$/gm, "").replace(/^export /gm, "");
const { statusLine } = await import(`data:text/javascript;base64,${Buffer.from(cats + "\n" + sum + "\nexport { statusLine };").toString("base64")}`);

test("status line: brand \u203a category \u00b7 first\u2013last of total, for every shape", () => {
  const a = statusLine({ brandLabel: "Mandarina Duck", category: "all", first: 1, last: 2, total: 12 });
  assert.equal(a, "Mandarina Duck \u203a \u05db\u05dc \u05d4\u05de\u05d5\u05e6\u05e8\u05d9\u05dd \u00b7 1\u20132 \u05de\u05ea\u05d5\u05da 12");
  const b = statusLine({ brandLabel: "Bric's", category: "carryon", first: 3, last: 4, total: 4 });
  assert.equal(b, "Bric's \u203a \u05d8\u05e8\u05d5\u05dc\u05d9 / Carry-on \u00b7 3\u20134 \u05de\u05ea\u05d5\u05da 4");
  const c = statusLine({ brandLabel: "Mandarina Duck", category: "suitcase", first: 1, last: 1, total: 1 });
  assert.equal(c, "Mandarina Duck \u203a \u05de\u05d6\u05d5\u05d5\u05d3\u05d4 \u00b7 1 \u05de\u05ea\u05d5\u05da 1");
  const d = statusLine({ brandLabel: "\u05db\u05dc \u05d4\u05de\u05d5\u05ea\u05d2\u05d9\u05dd", category: "all", first: 0, last: 0, total: 0 });
  assert.match(d, /0 \u05de\u05d5\u05e6\u05e8\u05d9\u05dd/);
});

test("status line updates with every filter change and slide move", () => {
  // The Swiper is keyed by perPage + item ids, so a filter change remounts it at slide 0 and onSwiper resyncs the counter.
  assert.match(grid, /key=\{swiperKey\}/);
  assert.match(grid, /onSwiper=\{\(s\) => \{[^\n]*setActiveIndex\(s\.activeIndex\)/);
  assert.match(grid, /onSlideChange=\{\(s\) => \{[^\n]*setActiveIndex\(s\.activeIndex\)/);
  assert.ok(!/carousel-selection/.test(page), "old chips/help block removed");
});
