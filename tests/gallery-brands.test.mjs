import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const load = async path => import(`data:text/javascript;base64,${Buffer.from(
  stripTypeScriptTypes(await read(path)),
).toString("base64")}`);
const { brandForItem, availableBrands, publicCollectionItems, defaultBrand, parseBrandParam, filterByBrand, urlWithBrand } =
  await load("src/lib/carousel/brands.ts");
const { filterByCategory } = await load("src/lib/carousel/categories.ts");
const copy = JSON.parse(await read("src/lib/carousel/reviewed-copy.json"));
const items = Object.entries(copy).map(([sku, entry], index) => ({
  id: String(index), catalogNumber: sku, title: entry.title, description: entry.description,
  coverImagePath: `${sku}.jpg`, angles: [], isActive: true, displayOrder: index,
  techSpecs: { specs: [{ heading: "פרטי מוצר", items: entry.specs }], colors: [] },
}));

test("all 25 curated SKUs have exact brand evidence, including when legacy specs lack a brand", () => {
  assert.equal(items.length, 25);
  const counts = new Map();
  for (const item of items) {
    const declared = copy[item.catalogNumber].specs.find(spec => spec.label === "מותג").value;
    assert.equal(brandForItem(item).label, declared, item.catalogNumber);
    assert.deepEqual(brandForItem({ ...item, techSpecs: null }), brandForItem(item), item.catalogNumber);
    assert.deepEqual(brandForItem({ ...item, catalogNumber: `  ${item.catalogNumber.toLowerCase()}  `,
      techSpecs: null }), brandForItem(item), "only SKU trim and case normalization");
    counts.set(declared, (counts.get(declared) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(counts), { "Mandarina Duck": 12, "Bric's": 11, "Porsche Design": 2 });
  assert.deepEqual(availableBrands(items).map(brand => brand.key), ["mandarina-duck", "brics"]);
  assert.ok(!availableBrands(items).some(brand => brand.key === "samsonite"));
  assert.equal(publicCollectionItems(items).length, 23);
  assert.equal(items.length, 25, "public selection never deletes original records");
});

test("unknown and conflicting identities never silently become Mandarina products", () => {
  for (const sku of [null, "P10NEW", "P10JNV05465-OTHER", "P10SZV24/A83/TU", "BAH08453001", "__proto__"]) {
    assert.equal(brandForItem({ ...items[0], catalogNumber: sku, techSpecs: null }), null, String(sku));
  }
  const explicit = value => ({ ...items[0], techSpecs: {
    specs: [{ heading: "פרטים", items: [{ label: " מותג : ", value }] }], colors: [],
  } });
  assert.deepEqual(brandForItem(explicit("  BRIC’S  ")), { key: "brics", label: "Bric's" });
  assert.deepEqual(brandForItem(explicit("Porsche   Design")), { key: "porsche-design", label: "Porsche Design" });
  assert.deepEqual(brandForItem(explicit("סמסונייט")), { key: "samsonite", label: "Samsonite" }, "explicit current specs win");
  assert.deepEqual(brandForItem(explicit("Delsey")), { key: "brand:delsey", label: "Delsey" }, "a new explicitly named brand is not discarded");
  const conflict = explicit("Mandarina Duck");
  conflict.techSpecs.specs[0].items.push({ label: "Brand", value: "Bric's" });
  assert.equal(brandForItem(conflict), null);
  assert.equal(availableBrands([{ ...explicit("Samsonite"), isActive: false }]).length, 0);
});

test("default and URL selections use only available brands", () => {
  const brands = availableBrands(items);
  for (const raw of [null, undefined, "", "unknown", "samsonite", "__proto__"]) {
    assert.equal(parseBrandParam(raw, brands), "mandarina-duck");
  }
  assert.equal(defaultBrand(brands), "mandarina-duck");
  assert.equal(parseBrandParam(" BRICS ", brands), "brics");
  assert.equal(parseBrandParam("porsche-design", brands), "mandarina-duck");
  assert.equal(parseBrandParam("all", brands), "all");
  assert.equal(defaultBrand(availableBrands(items.filter(item => brandForItem(item).key === "brics"))), "all");
  assert.equal(parseBrandParam("mandarina-duck", []), "all");
});

test("brand then category filtering preserves each item's identity, order, images and other fields", () => {
  const mixed = items.map((item, index) => ({ ...item, techSpecs: {
    ...item.techSpecs, category: index % 2 ? "carryon" : "suitcase",
  } }));
  const before = structuredClone(mixed);
  assert.equal(filterByBrand(mixed, "all"), mixed);
  for (const brand of availableBrands(mixed)) {
    for (const category of ["all", "carryon", "suitcase"]) {
      const result = filterByCategory(filterByBrand(mixed, brand.key), category);
      const expected = mixed.filter(item => brandForItem(item).key === brand.key &&
        (category === "all" || item.techSpecs.category === category));
      assert.deepEqual(result, expected);
      result.forEach(item => assert.equal(item, mixed.find(candidate => candidate.id === item.id)));
    }
  }
  assert.deepEqual(mixed, before, "filtering does not mutate catalogue data");
  assert.deepEqual(filterByCategory(filterByBrand(mixed, "missing-brand"), "carryon"), []);
});

test("brand URLs retain category, arbitrary query parameters and hash, including explicit all", () => {
  for (const brand of ["all", "brics", "mandarina-duck"]) {
    const original = "https://landing.toptik.co.il/carousel?category=carryon&utm_source=test&brand=old&x=1&x=2#details";
    const url = new URL(urlWithBrand(original, brand));
    assert.equal(url.origin, "https://landing.toptik.co.il");
    assert.equal(url.pathname, "/carousel");
    assert.equal(url.searchParams.get("brand"), brand);
    assert.equal(url.searchParams.get("category"), "carryon");
    assert.equal(url.searchParams.get("utm_source"), "test");
    assert.deepEqual(url.searchParams.getAll("x"), ["1", "2"]);
    assert.equal(url.hash, "#details");
    assert.equal(parseBrandParam(url.searchParams.get("brand"), availableBrands(items)), brand);
  }
});

test("page wires the labeled brand control, URL restoration, combined filtering and meaningful empty state", async () => {
  const source = await read("src/app/carousel/CarouselPageClient.tsx");
  assert.match(source, /<BrandPicker/);
  assert.match(source, /onChange=\{onChangeBrand\}/);
  assert.match(source, /id="carousel-brand-help"/);
  assert.match(source, /לחצו על שם המותג מעל הקולקציה/);
  assert.match(source, /publicCollectionItems\(/);
  assert.match(source, /filterByBrand\(activeItems, activeBrand\)/);
  assert.match(source, /filterBySeries\(brandItems, activeSeries\)/);
  assert.match(source, /filterByCategory\(seriesItems, activeCategory\)/);
  assert.match(source, /window\.addEventListener\("popstate", onPopState\)/);
  assert.match(source, /window\.removeEventListener\("popstate", onPopState\)/);
  assert.match(source, /visibleItems\.length > 0 \? \(/);
  assert.match(source, /לא נמצאו מוצרים/);
  assert.match(source, /onClick=\{\(\) => onChangeCategory\("all"\)\}/);
  assert.doesNotMatch(source, /<option[^>]*value="samsonite"/);
  const css = await read("src/app/globals.css");
  assert.match(css, /\.brand-wordmark\s*\{[^}]*letter-spacing: 5px[^}]*font-size: 13px[^}]*color: #caa46e[^}]*margin-bottom: 8px/s);
});


test("seven exact published products with legacy missing brand specs remain publicly discoverable", () => {
  const verified = { BAH08450001: "brics", BAH08450006: "brics", BAH08451006: "brics",
    BAH08454006: "brics", BAH08454078: "brics", BXL43756101: "brics", P10FZT8208Q: "mandarina-duck" };
  const rows = Object.keys(verified).map(sku => ({ ...items[0], id: sku, catalogNumber: sku, techSpecs: null }));
  const before = structuredClone(rows);
  assert.equal(publicCollectionItems(rows).length, 7);
  for (const row of rows) {
    assert.equal(brandForItem(row).key, verified[row.catalogNumber]);
    assert.deepEqual(filterByBrand(rows, verified[row.catalogNumber]).find(i => i.id === row.id), row);
    assert.equal(publicCollectionItems([{ ...row, isActive: false }]).length, 0);
    assert.equal(brandForItem({ ...row, catalogNumber: row.catalogNumber + "OTHER" }), null);
  }
  assert.deepEqual(rows, before, "brand fallback preserves all product fields and appearance");
  assert.equal(publicCollectionItems([{ ...items[0], catalogNumber: "ORI05500.909", techSpecs: null }]).length, 0);
  const conflict = { ...rows[0], techSpecs: { specs: [{ items: [{ label: "brand", value: "Bric's" }, { label: "brand", value: "Mandarina Duck" }] }] } };
  assert.equal(publicCollectionItems([conflict]).length, 0);
});
