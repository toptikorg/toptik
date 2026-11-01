import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCarouselTitleTypography,
  compareStoreGalleryProductHandles,
  decodeHtmlAttribute,
  extractAttributeValues,
  retainPublicMissingHandles,
} from "../scripts/production-visual-smoke.mjs";

test("visual monitor extracts direct image and article URLs from rendered HTML", () => {
  const html = '<article><a href="/journal/example"><img src="https://www.toptik.co.il/a.jpg?v=1&amp;width=1200" alt="דוגמה"></a></article>';

  assert.deepEqual(extractAttributeValues(html, "img", "src"), ["https://www.toptik.co.il/a.jpg?v=1&width=1200"]);
  assert.deepEqual(extractAttributeValues(html, "a", "href"), ["/journal/example"]);
});

test("visual monitor decodes URL-safe HTML entities", () => {
  assert.equal(decodeHtmlAttribute("a&amp;b&#x27;c&quot;d"), "a&b'c\"d");
});

test("visual monitor extracts Shopify collection and product links", () => {
  const html = [
    '<a href="/collections/samsonite">סמסונייט</a>',
    '<a href="/products/example">מוצר</a>',
    '<a href="https://www.toptik.co.il/products/example-two">מוצר נוסף</a>',
  ].join("");

  assert.deepEqual(extractAttributeValues(html, "a", "href"), [
    "/collections/samsonite",
    "/products/example",
    "https://www.toptik.co.il/products/example-two",
  ]);
});

test("visual monitor rejects synthetic title weights that merge adjacent Hebrew glyphs", () => {
  const valid = ".catalog-card-title{font-size:19px;font-weight:700}.product-modal-title { font-weight: 700; }";
  assert.doesNotThrow(() => assertCarouselTitleTypography(valid));

  const synthetic = ".catalog-card-title{font-weight:800}.product-modal-title{font-weight:700}";
  assert.throws(
    () => assertCarouselTitleTypography(synthetic),
    /catalog-card-title requests unsupported synthetic font weight 800/,
  );

  const missing = ".catalog-card-title{font-weight:700}";
  assert.throws(() => assertCarouselTitleTypography(missing), /missing \.product-modal-title/);
});

test("visual monitor compares every live Shopify product handle with gallery purchase links", () => {
  const urls = [
    "https://www.toptik.co.il/products/first-product",
    "https://www.toptik.co.il/products/%D7%9E%D7%95%D7%A6%D7%A8-%D7%A9%D7%A0%D7%99",
  ];
  const complete = [
    { shopifyLink: { handle: "first-product", isPublished: true } },
    { shopifyLink: { handle: "מוצר-שני", isPublished: true } },
    { shopifyLink: { handle: "gallery-only", isPublished: true } },
  ];
  assert.deepEqual(compareStoreGalleryProductHandles(urls, complete), {
    storeCount: 2, galleryLinkedCount: 3, missing: [],
  });
  assert.deepEqual(compareStoreGalleryProductHandles(urls, complete.slice(0, 1)).missing, ["מוצר-שני"]);
  assert.deepEqual(compareStoreGalleryProductHandles(urls, [
    complete[0], { shopifyLink: { handle: "מוצר-שני", isPublished: false } },
  ]).missing, ["מוצר-שני"]);
});

test("visual monitor ignores stale sitemap entries for archived or redirected products", () => {
  const missing = ["archived", "redirected", "live", "unknown"];
  const statuses = new Map([
    ["archived", 404],
    ["redirected", 301],
    ["live", 200],
  ]);

  assert.deepEqual(retainPublicMissingHandles(missing, statuses), ["live", "unknown"]);
});
