import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

async function pureModule(path) {
  const code = stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), "utf8"));
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { projectStorefront, withoutVerifiedPurchases } = await pureModule("../src/lib/carousel/storefront-projection.ts");
const { purchaseUrlFor } = await pureModule("../src/lib/carousel/purchase-links.ts");
const checkedAt = "2026-09-28T16:00:00.000Z";
const collection = { id: "gid://shopify/Collection/11", handle: "bags", title: "תיקים" };
function product(sku = "P10ABC01465", variantId = "100", overrides = {}) {
  return { id: "gid://shopify/Product/10", handle: "bag", title: "תיק לדוגמה", description: "תיאור החנות", vendor: "Mandarina Duck", productType: "bag", onlineStoreUrl: "https://www.toptik.co.il/products/bag", availableForSale: true, updatedAt: checkedAt,
    images: [{ id: "1", url: "https://cdn.shopify.com/a.jpg" }, { id: "2", url: "https://cdn.shopify.com/b.jpg" }], collections: [collection],
    variants: [{ id: `gid://shopify/ProductVariant/${variantId}`, sku, title: "Default Title", availableForSale: true, image: { url: "https://cdn.shopify.com/a.jpg" }, selectedOptions: [], price: { amount: "100.0", currencyCode: "ILS" } }], ...overrides };
}
function item(overrides = {}) {
  return { id: "curated-1", title: "שם ידני", description: "תיאור ידני", catalogNumber: "P10ABC01-465-TU", coverImagePath: "/curated.jpg", displayOrder: 1, isActive: true, angles: [{ id: "angle1", itemId: "curated-1", angleKey: "front", imagePath: "/angle.jpg", angleOrder: 1 }], techSpecs: { category: "carryon", specs: [], colors: [] }, ...overrides };
}
const payload = items => ({ items, settings: { autoplayMs: 3500, transitionMode: "shatter-particle" } });
const snapshot = products => ({ products, fetchedAt: checkedAt });

test("preserves curated media, order, copy and specifications; adds verified commerce", () => {
  const original = payload([item()]);
  const result = projectStorefront(original, snapshot([product()]), { P10ABC01465: "100" });
  assert.equal(result.items.length, 1);
  assert.deepEqual({ ...result.items[0], commerce: undefined }, { ...original.items[0], commerce: undefined });
  assert.equal(purchaseUrlFor(result.items[0]), "https://www.toptik.co.il/cart/100:1");
  assert.equal(result.items[0].commerce.productUrl, "https://www.toptik.co.il/products/bag?variant=100");
  assert.equal(original.items[0].commerce, undefined);
});
test("preserves gallery-only products without purchase, including an empty successful storefront", () => {
  const result = projectStorefront(payload([item()]), snapshot([]), { P10ABC01465: "100" });
  assert.equal(result.items.length, 1);
  assert.equal(purchaseUrlFor(result.items[0]), null);
  assert.equal(result.sync.status, "current");
});
test("does not re-add a deliberately hidden curated match", () => {
  const result = projectStorefront(payload([item({ isActive: false })]), snapshot([product()]));
  assert.equal(result.items.length, 0);
  assert.equal(result.sync.addedCount, 0);
});
test("a hidden curated SKU suppresses every ambiguous normalized match without purchase mapping", () => {
  const result = projectStorefront(payload([item({ isActive: false })]), snapshot([
    product("P10ABC01465", "100"),
    product("P10ABC01-465-TU", "101"),
  ]));
  assert.equal(result.items.length, 0);
  assert.equal(result.sync.matchedCount, 0);
  assert.equal(result.sync.addedCount, 0);
});
test("a hidden row with mismatched legacy ID suppresses both pinned and SKU candidates", () => {
  const result = projectStorefront(payload([item({ isActive: false })]), snapshot([
    product("OTHER", "100"),
    product("P10ABC01465", "200"),
  ]), { P10ABC01465: "100" });
  assert.equal(result.items.length, 0);
  assert.equal(result.sync.matchedCount, 0);
  assert.equal(result.sync.addedCount, 0);
});
test("a hidden pinned variant stays hidden after its SKU changes without hiding unrelated products", () => {
  const result = projectStorefront(payload([item({ isActive: false })]), snapshot([
    product("RENAMED-SKU", "100"),
    product("UNRELATED", "300"),
  ]), { P10ABC01465: "100" });
  assert.deepEqual(result.items.map(entry => entry.id), ["shopify-300"]);
  assert.equal(result.sync.matchedCount, 0);
  assert.equal(result.sync.addedCount, 1);
  assert.equal(purchaseUrlFor(result.items[0]), "https://www.toptik.co.il/cart/300:1");
});
test("imports new public products, images, selected variants and collection membership", () => {
  const result = projectStorefront(payload([]), snapshot([product()]));
  assert.equal(result.items[0].id, "shopify-100");
  assert.equal(result.items[0].angles.length, 2);
  assert.deepEqual(result.items[0].commerce.collectionIds, [collection.id]);
  assert.equal(result.sync.productCount, 1);
  assert.deepEqual(result.collections, [collection]);
});
test("public sold-out products remain visible during trial but receive no cart link", () => {
  const p = product(); p.variants[0].availableForSale = false;
  const result = projectStorefront(payload([item()]), snapshot([p]));
  assert.equal(result.items.length, 1);
  assert.equal(purchaseUrlFor(result.items[0]), null);
  assert.match(result.items[0].commerce.productUrl, /variant=100$/);
});
test("null public URL never imports an unpublished product", () => {
  assert.equal(projectStorefront(payload([]), snapshot([product("A", "100", { onlineStoreUrl: null })])).items.length, 0);
});
test("wrong legacy ID cannot assign a different SKU's purchase action", () => {
  const result = projectStorefront(payload([item()]), snapshot([product("OTHER", "100"), product("P10ABC01465", "200")]), { P10ABC01465: "100" });
  assert.equal(result.items.find(x => x.id === "curated-1").commerce, null);
});
test("ambiguous normalized SKUs do not get silently matched to a curated row", () => {
  const result = projectStorefront(payload([item()]), snapshot([product(), product("P10ABC01-465-TU", "101")]));
  assert.equal(result.items[0].commerce, null);
  assert.equal(result.items.length, 3);
});
test("missing SKU is retained as its own immutable variant identity", () => {
  const result = projectStorefront(payload([]), snapshot([product(null, "100"), product(null, "101")]));
  assert.equal(result.items.length, 2);
  assert.notEqual(result.items[0].id, result.items[1].id);
});
test("rejects external product URLs and foreign image hosts", () => {
  assert.equal(projectStorefront(payload([]), snapshot([product("A", "100", { onlineStoreUrl: "https://evil.example/products/bag" })])).items.length, 0);
  const p = product(); p.variants[0].image.url = "https://evil.example/img.jpg"; p.images = [];
  assert.equal(projectStorefront(payload([]), snapshot([p])).items[0].coverImagePath, "");
});
test("different colour variants do not inherit each other's galleries", () => {
  const p = product();
  p.variants[0].selectedOptions = [{ name: "Color", value: "red" }];
  p.variants.push({ ...p.variants[0], id: "gid://shopify/ProductVariant/101", sku: "blue", image: { url: "https://cdn.shopify.com/blue.jpg" }, selectedOptions: [{ name: "Color", value: "blue" }] });
  const result = projectStorefront(payload([]), snapshot([p]));
  assert.deepEqual(result.items[1].angles.map(a => a.imagePath), ["https://cdn.shopify.com/blue.jpg"]);
});
test("a refresh failure disables purchase and never fabricates demonstration products", () => {
  const original = projectStorefront(payload([item()]), snapshot([product()]));
  const failed = withoutVerifiedPurchases(original);
  assert.equal(failed.items.length, 1);
  assert.equal(purchaseUrlFor(failed.items[0]), null);
  assert.equal(failed.sync.status, "unavailable");
});
test("repeated projection is deterministic and does not mutate source arrays", () => {
  const p = product(); const c = payload([item()]);
  assert.deepEqual(projectStorefront(c, snapshot([p])), projectStorefront(c, snapshot([p])));
  assert.equal(c.items.length, 1); assert.equal(p.images.length, 2);
});
