import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// Owner decision 2026-09-29: the 14 American Tourister products that are in the
// Shopify store but not in the gallery get a package for the Vercel PREVIEW
// only — never Production, no Shopify or Supabase writes, no test product, no
// machine translation, real photos of the same SKU and colour, exact variants.
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const moduleFrom = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

const packageJson = await read("src/lib/carousel/american-tourister-preview.json");
const pkg = JSON.parse(packageJson);
const { appendPreviewPackageItems, isPreviewDeployment } = await moduleFrom(
  (await read("src/lib/carousel/preview-packages.ts"))
    .replace('import americanTourister from "./american-tourister-preview.json";', `const americanTourister = ${packageJson};`),
);
const brands = await moduleFrom(await read("src/lib/carousel/brands.ts"));
const { categorizeItem } = await moduleFrom(await read("src/lib/carousel/categories.ts"));

const STORE_IMAGES = "https://cdn.shopify.com/s/files/1/0622/8082/7130/files/";
const existing = [{ id: "a", catalogNumber: "P10JNV05465", title: "x", isActive: true, displayOrder: 3, angles: [], coverImagePath: "/a.jpg",
  techSpecs: { specs: [{ heading: "h", items: [{ label: "מותג", value: "Mandarina Duck" }] }], colors: [] } }];

test("the package is appended on a Vercel Preview only — never on Production", () => {
  for (const env of ["production", "development", undefined, "", "Preview", "preview "]) {
    assert.equal(isPreviewDeployment(env), false, String(env));
    assert.deepEqual(appendPreviewPackageItems(existing, env), existing, String(env));
  }
  assert.equal(isPreviewDeployment("preview"), true);
  const items = appendPreviewPackageItems(existing, "preview");
  assert.equal(items.length, existing.length + pkg.records.length);
  assert.deepEqual(items[0], existing[0], "existing records are untouched");
  assert.deepEqual(items.slice(1).map((item) => item.displayOrder), pkg.records.map((_, index) => 4 + index));
});

test("American Tourister joins the brand picker only where its items exist", () => {
  assert.deepEqual(brands.availableBrands(existing).map((brand) => brand.key), ["mandarina-duck"]);
  const preview = appendPreviewPackageItems(existing, "preview");
  assert.deepEqual(brands.availableBrands(preview).map((brand) => brand.key), ["mandarina-duck", "american-tourister"]);
  assert.deepEqual(brands.availableBrands(preview)[1], { key: "american-tourister", label: "American Tourister" });
  const added = preview.slice(1);
  assert.equal(brands.filterByBrand(preview, "american-tourister").length, added.length);
  assert.deepEqual(added.map(categorizeItem), pkg.records.map((record) => record.category));
});

test("existing or hidden records always win over the package", () => {
  const sku = pkg.records[0].sku;
  const hidden = { ...existing[0], id: "h", catalogNumber: ` ${sku.toLowerCase()} `, isActive: false };
  const items = appendPreviewPackageItems([hidden], "preview");
  assert.equal(items.filter((item) => item.catalogNumber?.trim().toUpperCase() === sku).length, 1);
  assert.equal(items[0], hidden);
});

test("every package record follows the content rules", () => {
  assert.ok(pkg.records.length > 0);
  const skus = new Set();
  for (const record of pkg.records) {
    assert.ok(!skus.has(record.sku), `${record.sku} is unique`);
    skus.add(record.sku);
    assert.match(record.variantId, /^\d{14}$/, record.sku);
    assert.match(record.productId, /^\d{13}$/, record.sku);
    assert.ok(record.imagePaths.length >= 1 && record.imagePaths[0] === record.coverImagePath, `${record.sku} has a real cover`);
    for (const image of record.imagePaths) assert.ok(image.startsWith(STORE_IMAGES), `${record.sku}: TopTik store photo only`);
    assert.match(record.sourceUrls[0], /^https:\/\/www\.americantourister\.(es|at|co\.uk)\//, `${record.sku}: maker specification source`);
    assert.match(record.sourceUrls[1], /^https:\/\/www\.toptik\.co\.il\/products\//, `${record.sku}: store source`);
    const spec = Object.fromEntries(record.specs.map(({ label, value }) => [label, value]));
    assert.equal(spec["מותג"], "American Tourister");
    assert.match(spec["מק״ט יצרן"], /^\d{6}-\d{4}$/, `${record.sku}: maker SKU`);
    assert.match(record.description, /[֐-׿]/, `${record.sku}: Hebrew description`);
    assert.doesNotMatch(record.description, /google|translate/i);
    assert.ok(["suitcase", "carryon", null].includes(record.category), record.sku);
  }
  // Excluded on purpose: the checkout test product and Porsche Design.
  assert.doesNotMatch(packageJson, /בדיקת סליקה|9399665819898|ORI05500/);
  assert.match(pkg.gate, /VERCEL_ENV=preview only/);
});

test("the carousel route appends the package after the Samsonite supplement and before the active filter", async () => {
  const route = await read("src/app/api/carousel/route.ts");
  assert.match(route, /appendPreviewPackageItems\(appendSamsoniteItems\(payload\.items\)\)\.filter\(item => item\.isActive\)/);
  // The default environment argument is the deployment's own VERCEL_ENV.
  assert.doesNotMatch(route, /appendPreviewPackageItems\([^)]*,/);
});

test("sizes of one colour are never shown as colour swatches", async () => {
  const drop = (source) => source.replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "");
  const colors = await moduleFrom([
    drop(await read("src/lib/carousel/color-names.ts")),
    drop(await read("src/lib/catalog-source/vendor-detect.ts")),
    drop(await read("src/lib/carousel/colors.ts")),
  ].join("\n"));
  for (const sku of ["4815-77TEAL LIME", "4815-55TEAL LIME", "2694-66NAVY BLUE", "1062-55BLACK"]) {
    assert.equal(colors.modelCodeFromCatalog(sku), null, sku);
  }
  for (const [sku, model] of [["BAH08453.001", "BAH08453"], ["P10SZV24-A83-TU", "SZV24"], ["KJ114001", "KJ114001"], ["ORI05500.024", "ORI05500"]]) {
    assert.equal(colors.modelCodeFromCatalog(sku), model, sku);
  }
  const preview = appendPreviewPackageItems([], "preview");
  const swatches = colors.buildModelSiblingSwatches(preview);
  assert.equal(swatches.size, 0);
});
