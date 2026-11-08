import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoUnavailableVariants, assertHomeGalleryLink, assertColorSelector, productsWithMultipleColors } from "../scripts/production-visual-smoke.mjs";

test("detects an unavailable variant without treating zero inventory as evidence", () => {
  assert.throws(() => assertNoUnavailableVariants([{ handle: "bag", variants: [{ sku: "BLUE", available: false }] }]), /bag \(BLUE\)/);
  assert.doesNotThrow(() => assertNoUnavailableVariants([{ handle: "bag", variants: [{ sku: "BLACK", available: true, inventory_quantity: 0 }] }]));
});

test("does not silently pass missing availability data", () => {
  assert.throws(() => assertNoUnavailableVariants([{ handle: "bag", variants: [{ id: 1 }] }]), /Missing availability/);
});

test("requires a gallery link in homepage content, not just the footer", () => {
  assertHomeGalleryLink('<main><a href="https://landing.toptik.co.il/carousel">לגלריית המוצרים</a></main><footer></footer>');
  assert.throws(() => assertHomeGalleryLink('<main></main><footer><a href="https://landing.toptik.co.il/carousel">לגלריית המוצרים</a></footer>'), /prominent gallery/);
});

test("requires each color control on the representative product", () => {
  assertColorSelector('<a data-color-sku="BLACK"></a><a data-color-sku="BLUE"></a>', ["BLACK", "BLUE"]);
  assert.throws(() => assertColorSelector('<a data-color-sku="BLACK"></a>', ["BLACK", "BLUE"]), /BLUE/);
});

test("identifies all products with multiple color choices", () => {
  const products = [{ handle: "colors", options: [{ name: "צבע", values: ["שחור", "כחול"] }] }, { handle: "size", options: [{ name: "מידה", values: ["S", "L"] }] }, { handle: "single", options: [{ name: "Color", values: ["Red"] }] }];
  assert.deepEqual(productsWithMultipleColors(products).map((product) => product.handle), ["colors"]);
});
