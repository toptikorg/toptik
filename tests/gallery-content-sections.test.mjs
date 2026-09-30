import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const component = readFileSync("src/components/carousel/GalleryContentSections.tsx", "utf8");
const page = readFileSync("src/app/carousel/page.tsx", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");

test("content sections render server-side after the products area", () => {
  assert.match(page, /<CarouselPageClient \/>\s*<GalleryContentSections \/>/);
  assert.ok(!/"use client"/.test(component), "must stay a server component so the text is in the initial HTML");
});

test("size table lists exactly the 20 verified Samsonite 55cm SKUs", () => {
  const skus = [...component.matchAll(/sku: "([A-Z0-9]+)"/g)].map(m => m[1]);
  assert.equal(skus.length, 20);
  assert.equal(new Set(skus).size, 20);
  for (const sku of ["KL909001","KL901001","KL924001","KL966001","KL974001","KL909005","KL901005","KL924005","KL966005","KL974005","KJ109001","KJ111001","KJ114001","KJ106001","KJ114007","KJ106007","KO709005","KO701005","KO704005","KO776005"]) {
    assert.ok(skus.includes(sku), `${sku} must be present`);
  }
  assert.ok(!/P10JNV|P10GXV/.test(component.split("Mandarina Duck")[0]), "unverified Mandarina SKUs must not be table rows");
});

test("only manufacturer-verified figures appear", () => {
  // Base Upscape (143108): expanded-volume only. Weights: only the two Intuo 55
  // figures live-verified on samsonite.fi (146913: 2.3 kg, 150720: 3 kg).
  assert.match(component, /volume: "45 ל׳ בהרחבה"/);
  assert.match(component, /<td>2\.3 ק״ג<\/td><td>3 ק״ג<\/td>/);
  const weights = component.match(/[\d.]+ ק״ג/g) ?? [];
  assert.deepEqual(weights, ["2.3 ק״ג", "3 ק״ג"], "no other weights without a verified source");
  assert.match(component, /81×54×33/);
});

test("section stays out of the catalogue mechanics and out of robots directives", () => {
  assert.ok(!/robots/.test(component));
  assert.ok(!/useState|useEffect|swiper/i.test(component));
  assert.match(component, /STORE_ORIGIN/);
  assert.ok(!/https:\/\/(?!www\.toptik)/.test(component.replace(/samsonite\.(fi|co\.uk|com\.au)/g, "")), "no external links besides the store");
});

test("products are featured through the gallery's own card, not body text links", () => {
  const card = readFileSync("src/components/carousel/ArticleProductCard.tsx", "utf8");
  // Exact-SKU lookup in the live payload; nothing rendered without a certain match.
  assert.match(card, /candidate\.isActive && candidate\.catalogNumber === sku/);
  assert.match(card, /if \(!item \|\| hidden\) return null;/);
  // The gallery's existing card and store button, with no dialogs/popups.
  assert.match(card, /interactive=\{false\}/);
  assert.ok(!/ProductModal|TechSpecsModal/.test(card), "no popups an extension could block");
  const grid = readFileSync("src/components/carousel/CarouselGrid.tsx", "utf8");
  assert.match(grid, /interactive && \(item\.sourceUrl/);
  // Cards placed next to the paragraphs that discuss those products.
  for (const sku of ["P10JNV05465", "KL909001", "KL909005", "KL974004"]) {
    assert.match(component, new RegExp(`<ArticleProductCard sku="${sku}" \\/>`), `${sku} card embedded`);
  }
  // No plain product text-links in the article body.
  assert.ok(!/products\/\$\{row/.test(component));
  // Verified handle mapping is retained as documentation on each row.
  const rows = [...component.matchAll(/sku: "([A-Z0-9]+)", storeHandle: "([a-z0-9-]+)"/g)];
  assert.equal(rows.length, 20);
  for (const [, sku, handle] of rows) {
    assert.ok(handle.endsWith("-" + sku.toLowerCase()), `${sku} handle must end with its SKU: ${handle}`);
  }
  assert.ok(!/לחץ כאן|לחצו כאן/.test(component));
});

test("tables are readable on phones: horizontal scroll region, accessible names", () => {
  assert.match(css, /\.gallery-info-tablewrap \{ overflow-x: auto/);
  assert.match(component, /role="region" aria-label="טבלת מידות לפי מק״ט" tabIndex=\{0\}/);
  assert.match(component, /caption/);
});
