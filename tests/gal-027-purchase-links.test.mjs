import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// GAL-027 acceptance: the purchase button opens the exact Shopify PRODUCT page
// of the item (right variant), in the same tab — never the cart/checkout
// permalink, never a new tab — and the gallery keeps its state for Back.

const pages = JSON.parse(readFileSync("src/lib/carousel/store-product-pages.json", "utf8"));
const samsonite = JSON.parse(readFileSync("src/lib/carousel/samsonite-variants.json", "utf8"));
const linksSource = readFileSync("src/lib/carousel/purchase-links.ts", "utf8");
const grid = readFileSync("src/components/carousel/CarouselGrid.tsx", "utf8");
const modal = readFileSync("src/components/carousel/ProductModal.tsx", "utf8");
const page = readFileSync("src/app/carousel/CarouselPageClient.tsx", "utf8");

// Run the real purchaseUrlFor with its real data, without a bundler.
const inlined = linksSource
  .replace('import { normalizeCatalogKey } from "@/lib/catalog-source/vendor-detect";',
    'const normalizeCatalogKey = (v) => (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");')
  .replace('import samsoniteVariantIds from "./samsonite-variants.json";',
    `const samsoniteVariantIds = ${JSON.stringify(samsonite)};`)
  .replace('import storeProductPages from "./store-product-pages.json";',
    `const storeProductPages = ${JSON.stringify(pages)};`);
const { purchaseUrlFor } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(inlined)).toString("base64")}`);

test("every mapped SKU resolves to its exact product page with its exact variant", () => {
  const variantIds = linksSource.match(/"\d{11,}"/g).map(v => v.replaceAll('"', ""));
  const keys = Object.keys(pages);
  assert.ok(keys.length >= 80, "all mapped SKUs must have a verified product page");
  for (const key of keys) {
    const url = purchaseUrlFor(key);
    assert.ok(url, `${key} must produce a URL`);
    assert.match(url, /^https:\/\/www\.toptik\.co\.il\/products\/[^?]+\?variant=\d+$/, url);
    assert.ok(url.endsWith(`?variant=${pages[key].variant}`), `${key} must carry its own variant`);
    assert.ok(!url.includes("/cart/") && !url.includes("checkout"), "never cart or checkout");
  }
  // Cross-check: page variants are exactly the known mapping values, unchanged.
  for (const [key, entry] of Object.entries(pages)) {
    if (key in samsonite) assert.equal(String(samsonite[key]), entry.variant, `${key} variant must be untouched`);
  }
  assert.ok(variantIds.length > 0);
});

test("unmapped or unknown SKUs get no purchase URL (no guessing)", () => {
  assert.equal(purchaseUrlFor("NOSUCHSKU1"), null);
  assert.equal(purchaseUrlFor(""), null);
  assert.equal(purchaseUrlFor(null), null);
});

test("live Shopify binding updates exact handle and variant, only while published", () => {
  assert.equal(
    purchaseUrlFor("SKU-NEW", { handle: "new-product-handle", variantId: "1234567890123", isPublished: true }),
    "https://www.toptik.co.il/products/new-product-handle?variant=1234567890123",
  );
  assert.equal(
    purchaseUrlFor("SKU-NEW", { handle: "new-product-handle", variantId: "1234567890123", isPublished: false }),
    null,
  );
  assert.equal(
    purchaseUrlFor("SKU-NEW", { handle: "https://attacker.example/path", variantId: "1234567890123", isPublished: true }),
    null,
  );
  assert.equal(
    purchaseUrlFor("SKU-NEW", { handle: "new-product-handle", variantId: "123x", isPublished: true }),
    null,
  );
});

test("purchase buttons open in the same tab, in the card and in the product modal", () => {
  for (const [name, source] of [["card", grid], ["modal", modal]]) {
    const buy = source.match(/href=\{purchaseUrl\}[^>]*>/s);
    assert.ok(buy, `${name} must keep the purchase link`);
    assert.ok(!/target=/.test(buy[0]), `${name} purchase link must not open a new tab`);
  }
  assert.ok(!/purchaseUrl[\s\S]{0,300}target="_blank"/.test(grid));
  assert.ok(!/purchaseUrl[\s\S]{0,300}target="_blank"/.test(modal));
});

test("gallery state survives Back: brand/category in the URL, scroll saved and restored", () => {
  assert.match(page, /urlWithBrand\(window\.location\.href, key\)/);
  assert.match(page, /url\.searchParams\.set\("category", key\)/);
  assert.match(page, /carousel-scroll:/);
  assert.match(page, /back_forward/);
  assert.match(page, /addEventListener\("pagehide", save\)/);
});
