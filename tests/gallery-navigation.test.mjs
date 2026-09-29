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
