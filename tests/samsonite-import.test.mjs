import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const parserSource = (await read("src/lib/catalog-source/samsonite-parsing.ts"))
  .replace(/^import type .*;\r?\n/m, "");
const parser = await import(
  "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(parserSource)).toString("base64"),
);

const vendorSource = (await read("src/lib/catalog-source/vendor-detect.ts"))
  .replace(/^import type .*;\r?\n/m, "");
const vendor = await import(
  "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(vendorSource)).toString("base64"),
);

test("Samsonite manufacturer SKU accepts separators and rejects unrelated SKU formats", () => {
  assert.equal(parser.normalizeSamsoniteSku("150700-9199"), "150700-9199");
  assert.equal(parser.normalizeSamsoniteSku("1507009199"), "150700-9199");
  assert.equal(parser.normalizeSamsoniteSku(" 150700 A807 "), "150700-A807");
  assert.equal(parser.normalizeSamsoniteSku("KJ114007"), null);
  assert.equal(parser.normalizeSamsoniteSku("15070-9199"), null);
});

test("catalog detection routes recognized formats and respects the selected section fallback", () => {
  assert.equal(vendor.detectVendorFromCatalog("P10QMC01-465-TU"), "mandarina");
  assert.equal(vendor.detectVendorFromCatalog("150700-9199"), "samsonite");
  assert.equal(vendor.detectVendorFromCatalog("1507009199"), "samsonite");
  assert.equal(vendor.detectVendorFromCatalog("BOE58117.050"), "brics");
  assert.equal(vendor.detectVendorFromCatalog("KJ114007", "samsonite"), "samsonite");
});

test("manufacturer search links must be same-host and end in the exact requested SKU", () => {
  const html = `
    <a href="/upscape/150700-9199.html">exact</a>
    <a href="/upscape/150700-1041.html">other colour</a>
    <a href="https://evil.example/150700-9199.html">external</a>
    <a href="https://www.samsonite.co.uk/150700-9199.html">same host</a>
  `;
  assert.deepEqual(
    parser.extractSamsoniteSearchLinks(html, "https://www.samsonite.co.uk/search/?q=150700-9199", "150700-9199"),
    [
      "https://www.samsonite.co.uk/upscape/150700-9199.html",
      "https://www.samsonite.co.uk/150700-9199.html",
    ],
  );
});

test("product extraction requires matching structured SKU and only keeps same-host product-catalog images", () => {
  const pageUrl = "https://www.samsonite.co.uk/upscape/150700-9199.html";
  const html = `
    <h1>Upscape Spinner 55cm Climbing Ivy</h1>
    <meta name="description" content="Official product description">
    <script type="application/ld+json">{"@type":"Product","sku":"150700-9199","name":"Upscape Spinner 55cm"}</script>
    <img src="https://www.samsonite.co.uk/dw/image/v2/AATF_PRD/on/demandware.static/-/Sites-samsonite-product-catalog/default/a.jpg?sw=600&amp;sh=900">
    <img data-src="https://www.samsonite.co.uk/dw/image/v2/AATF_PRD/on/demandware.static/-/Sites-samsonite-product-catalog/default/b.webp?sw=600">
    <img src="https://www.samsonite.co.uk/assets/menu-banner.jpg">
    <img src="https://cdn.example.com/Sites-samsonite-product-catalog/c.jpg">
  `;
  const product = parser.parseSamsoniteProductPage(html, pageUrl, "1507009199");
  assert.equal(product.catalogNumber, "150700-9199");
  assert.equal(product.title, "Upscape Spinner 55cm Climbing Ivy");
  assert.equal(product.description, "Official product description");
  assert.deepEqual(product.imageUrls, [
    "https://www.samsonite.co.uk/dw/image/v2/AATF_PRD/on/demandware.static/-/Sites-samsonite-product-catalog/default/a.jpg?sw=600&sh=900",
    "https://www.samsonite.co.uk/dw/image/v2/AATF_PRD/on/demandware.static/-/Sites-samsonite-product-catalog/default/b.webp?sw=600",
  ]);
});

test("a page for another colour or a page without product images cannot be imported", () => {
  const base = '<h1>Upscape</h1><img src="https://www.samsonite.co.uk/dw/image/v2/AATF_PRD/on/demandware.static/-/Sites-samsonite-product-catalog/default/a.jpg">';
  assert.throws(
    () => parser.parseSamsoniteProductPage(`${base}<script type="application/ld+json">{"@type":"Product","sku":"150700-1041"}</script>`, "https://www.samsonite.co.uk/upscape/150700-9199.html", "150700-9199"),
    /did not confirm the exact SKU/,
  );
  assert.throws(
    () => parser.parseSamsoniteProductPage('<h1>Upscape</h1><script type="application/ld+json">{"@type":"Product","sku":"150700-9199"}</script>', "https://www.samsonite.co.uk/upscape/150700-9199.html", "150700-9199"),
    /No exact-product images/,
  );
  assert.throws(
    () => parser.parseSamsoniteProductPage(
      `${base}<script type="application/ld+json">{"@type":"Product","sku":"150700-9199","mpn":"150700-1041"}</script>`,
      "https://www.samsonite.co.uk/upscape/150700-9199.html",
      "150700-9199",
    ),
    /did not confirm the exact SKU/,
  );
});

test("admin SKU and URL routes wire Samsonite through the existing protected import flow", async () => {
  const route = await read("src/app/api/admin/import/samsonite/route.ts");
  const byUrl = await read("src/app/api/admin/import/by-url/route.ts");
  const admin = await read("src/app/admin/page.tsx");
  const importer = await read("src/lib/import/import-handler.ts");
  assert.match(route, /createImportRouteHandler\("samsonite"\)/);
  assert.match(byUrl, /fetchSamsoniteByUrl/);
  assert.match(byUrl, /vendor: "samsonite"/);
  assert.match(admin, /value: "samsonite"/);
  assert.match(admin, /150700-9199/);
  assert.match(importer, /newItemsActive: false/);
  assert.match(importer, /isActive: targetItemId \? true : vendorConfig\.newItemsActive \?\? true/);
  assert.match(importer, /const imageReferer = vendor === "samsonite"/);
});
