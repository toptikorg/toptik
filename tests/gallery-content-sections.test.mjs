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
  // Base Upscape (143108): expanded-volume only; Easy Access weight is the one live-verified figure.
  assert.match(component, /volume: "45 ל׳ בהרחבה"/);
  assert.match(component, /<td>3 ק״ג<\/td>/);
  assert.ok(!/ק״ג/.test(component.replace("3 ק״ג", "")), "no other weights without a verified source");
  assert.match(component, /81×54×33/);
});

test("section stays out of the catalogue mechanics and out of robots directives", () => {
  assert.ok(!/robots/.test(component));
  assert.ok(!/useState|useEffect|swiper/i.test(component));
  assert.match(component, /STORE_ORIGIN/);
  assert.ok(!/https:\/\/(?!www\.toptik)/.test(component.replace(/samsonite\.(fi|co\.uk|com\.au)/g, "")), "no external links besides the store");
});

test("tables are readable on phones: horizontal scroll region, accessible names", () => {
  assert.match(css, /\.gallery-info-tablewrap \{ overflow-x: auto/);
  assert.match(component, /role="region" aria-label="טבלת מידות לפי מק״ט" tabIndex=\{0\}/);
  assert.match(component, /caption/);
});
