import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync("src/lib/shopify/sync-rules.ts", "utf8")
  .replace('import { normalizeCatalogKey } from "@/lib/catalog-source/vendor-detect";',
    'const normalizeCatalogKey = (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");');
const { matchExactSkus, normalizeSyncSku, shopifyProductGid, numericVariantId, staleBindingKeys } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`
);

test("normalizes punctuation and only the approved Mandarina Duck TU suffix", () => {
  assert.equal(normalizeSyncSku("P10SZV24-05J-TU"), "P10SZV2405J");
  assert.equal(normalizeSyncSku("P10SZV2405J"), "P10SZV2405J");
  assert.equal(normalizeSyncSku("BAH08453.001"), "BAH08453001");
  assert.equal(normalizeSyncSku("ABC-TU"), "ABCTU");
  assert.equal(normalizeSyncSku("  "), null);
});

test("creates matches only for unique exact normalized SKUs", () => {
  const result = matchExactSkus(
    [{ id: "g1", catalogNumber: "P10SZV24-05J-TU" }, { id: "g2", catalogNumber: "BAH08453.001" }],
    [{ id: "gid://shopify/ProductVariant/1", sku: "P10SZV2405J" }, { id: "gid://shopify/ProductVariant/2", sku: "BAH08453001" }],
  );
  assert.deepEqual(result.matches, [
    { catalogKey: "P10SZV2405J", galleryItemId: "g1", variantGid: "gid://shopify/ProductVariant/1" },
    { catalogKey: "BAH08453001", galleryItemId: "g2", variantGid: "gid://shopify/ProductVariant/2" },
  ]);
  assert.deepEqual(result.reviews, []);
});

test("duplicates, unknowns and missing SKUs are review-only and never guessed", () => {
  const result = matchExactSkus(
    [
      { id: "g1", catalogNumber: "X-1" }, { id: "g2", catalogNumber: "X1" },
      { id: "g3", catalogNumber: "ORPHAN" },
    ],
    [
      { id: "v1", sku: "X1" }, { id: "v2", sku: "X-1" },
      { id: "v3", sku: "UNKNOWN" }, { id: "v4", sku: null },
    ],
  );
  assert.deepEqual(result.matches, []);
  assert.ok(result.reviews.some(row => row.catalogKey === "X1" && row.reason === "duplicate_gallery_sku"));
  assert.ok(result.reviews.some(row => row.catalogKey === "UNKNOWN" && row.reason === "unmatched_shopify_variant"));
  assert.ok(result.reviews.some(row => row.catalogKey === null && row.reason === "missing_sku"));
  assert.ok(result.reviews.some(row => row.catalogKey === "ORPHAN" && row.reason === "unmatched_gallery_item"));
});

test("accepts only valid Shopify product and variant GIDs", () => {
  assert.equal(shopifyProductGid(123), "gid://shopify/Product/123");
  assert.equal(shopifyProductGid("gid://shopify/Product/123"), "gid://shopify/Product/123");
  assert.equal(shopifyProductGid("https://attacker.example/123"), null);
  assert.equal(numericVariantId("gid://shopify/ProductVariant/456"), "456");
  assert.equal(numericVariantId("gid://shopify/Product/456"), null);
});

test("stale deactivation excludes active and ambiguous bindings", () => {
  assert.deepEqual(
    staleBindingKeys(["ACTIVE", "AMBIGUOUS", "REMOVED"], new Set(["ACTIVE"]), new Set(["AMBIGUOUS"])),
    ["REMOVED"],
  );
});
