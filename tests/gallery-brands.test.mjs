import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const load = async path => import(`data:text/javascript;base64,${Buffer.from(
  stripTypeScriptTypes(await read(path)),
).toString("base64")}`);
const { brandForItem, availableBrands, defaultBrand, parseBrandParam, filterByBrand, urlWithBrand } =
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
  assert.deepEqual(availableBrands(items).map(brand => brand.key), ["mandarina-duck", "brics", "porsche-design"]);
  assert.ok(!availableBrands(items).some(brand => brand.key === "samsonite"));
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
  assert.equal(parseBrandParam("porsche-design", brands), "porsche-design");
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
  for (const brand of ["all", "brics", "mandarina-duck", "porsche-design"]) {
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

test("page wires the native labeled select, URL restoration, combined filtering and meaningful empty state", async () => {
  const source = await read("src/app/carousel/CarouselPageClient.tsx");
  assert.match(source, /<label className="carousel-brand-picker">/);
  assert.match(source, /בחרו מותג/);
  assert.match(source, /<select[\s\S]*?value=\{activeBrand\}[\s\S]*?onChange=\{event => onChangeBrand\(event.target.value\)\}/);
  assert.match(source, /aria-controls="carousel-brand-results"/);
  assert.match(source, /filterByCategory\(filterByBrand\(activeItems, activeBrand\), activeCategory\)/);
  assert.match(source, /window\.addEventListener\("popstate", onPopState\)/);
  assert.match(source, /window\.removeEventListener\("popstate", onPopState\)/);
  assert.match(source, /visibleItems\.length > 0 \? \(/);
  assert.match(source, /לא נמצאו מוצרים/);
  assert.match(source, /onClick=\{\(\) => onChangeCategory\("all"\)\}/);
  assert.doesNotMatch(source, /<option[^>]*value="samsonite"/);
  const css = await read("src/app/globals.css");
  assert.match(css, /\.carousel-brand-picker:focus-within \.carousel-brand-current/);
  assert.match(css, /\.carousel-brand-select\s*\{[^}]*height: 44px/s);
  assert.match(css, /\.carousel-brand-select\s*\{[^}]*opacity: 0/s);
  assert.match(css, /\.brand-wordmark\s*\{[^}]*letter-spacing: 5px[^}]*font-size: 13px[^}]*color: #caa46e[^}]*margin-bottom: 8px/s);
});
