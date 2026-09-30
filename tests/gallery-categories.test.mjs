import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const load = async path => import(`data:text/javascript;base64,${Buffer.from(
  stripTypeScriptTypes(await read(path)),
).toString("base64")}`);
const { categorizeItem, filterByCategory, CATEGORIES, PRODUCT_CATEGORIES, parseCategoryParam } =
  await load("src/lib/carousel/categories.ts");
const { filterByBrand } = await load("src/lib/carousel/brands.ts");
const copy = JSON.parse(await read("src/lib/carousel/reviewed-copy.json"));
const expected = {
  P10JNV05465: null, P10GXV24A32: null, P10JNV0508Q: null,
  BXL38124078: "carryon", "BAH08453.001": "suitcase", "BAH08453.006": "suitcase",
  "BAH08451.001": "carryon", "BAH08454.001": "suitcase", "BAH08453.078": "suitcase",
  "BXL58117.101": "carryon", BXL38124101: "carryon", "BXL58145.101": "suitcase",
  "BXL58145.050": "suitcase", "BXL58145.078": "suitcase", "P10SZV24-05J-TU": "carryon",
  "P10SZV24-A83-TU": "carryon", "P10UJV24-A92-TU": "carryon", "P10SZV24-A81-TU": "carryon",
  "P10OUV24-A89-TU": "carryon", "P10OUN01-A89-TU": null, "P10UJN01-A92-TU": null,
  "ORI05500.909": "carryon", "ORI05500.024": "carryon", "P10OSV04-05J-TU": "suitcase",
  "P10ZJT06-24U-TU": null,
};
const items = Object.entries(copy).map(([catalogNumber, entry], index) => ({
  id: String(index), catalogNumber, title: entry.title, description: entry.description,
  coverImagePath: `${catalogNumber}.jpg`, displayOrder: index, isActive: true, angles: [],
  techSpecs: { specs: [{ heading: "פרטי מוצר", items: entry.specs }], colors: [],
    category: entry.expectedLegacyTechSpecs?.category ?? null },
}));

test("all 25 exact identities have reviewed fallback categories independent of translated titles", () => {
  assert.equal(items.length, 25);
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(expected).sort());
  for (const item of items) {
    const unassigned = { ...item, techSpecs: { ...item.techSpecs, category: null } };
    assert.equal(categorizeItem(unassigned), expected[item.catalogNumber], item.catalogNumber);
    assert.equal(categorizeItem({ ...unassigned, title: "כותרת עברית חדשה" }), expected[item.catalogNumber]);
    assert.equal(categorizeItem({ ...unassigned, title: "Unrelated English title" }), expected[item.catalogNumber]);
    assert.equal(categorizeItem({ ...unassigned, catalogNumber: ` ${item.catalogNumber.toLowerCase()} ` }),
      expected[item.catalogNumber], "trim and case normalization only");
  }
});

test("the current catalogue preserves three explicit assignments and fixes verified carry-ons", () => {
  const originalExplicit = items.filter(item => item.techSpecs.category);
  assert.deepEqual(originalExplicit.map(item => item.catalogNumber), ["P10JNV05465", "P10GXV24A32", "P10JNV0508Q"]);
  const counts = { carryon: 0, suitcase: 0, unassigned: 0 };
  for (const item of items) counts[categorizeItem(item) ?? "unassigned"]++;
  assert.deepEqual(counts, { carryon: 14, suitcase: 8, unassigned: 3 });
  assert.deepEqual(filterByCategory(filterByBrand(items, "porsche-design"), "carryon")
    .map(item => item.catalogNumber), ["ORI05500.909", "ORI05500.024"]);
  assert.equal(filterByCategory(filterByBrand(items, "brics"), "carryon").length, 4);
  assert.equal(filterByCategory(filterByBrand(items, "mandarina-duck"), "carryon").length, 8);
});

test("explicit future admin choices win over exact SKU evidence without mutating specs", () => {
  for (const item of items) {
    for (const category of ["carryon", "suitcase"]) {
      const assigned = { ...item, techSpecs: { ...item.techSpecs, category } };
      const before = structuredClone(assigned);
      assert.equal(categorizeItem(assigned), category);
      assert.deepEqual(assigned, before);
    }
  }
  assert.equal(categorizeItem({ ...items[0], catalogNumber: "NEW-SKU", techSpecs: {
    specs: [], colors: [], category: "carryon",
  } }), "carryon");
});

test("accessories and unverified models are all-only, never guessed from title, prefixes or punctuation", () => {
  for (const sku of ["P10OUN01-A89-TU", "P10UJN01-A92-TU", "P10ZJT06-24U-TU"]) {
    const item = items.find(item => item.catalogNumber === sku);
    assert.equal(categorizeItem(item), null, sku);
    assert.equal(filterByCategory([item], "all").length, 1);
    assert.equal(filterByCategory([item], "suitcase").length, 0);
    assert.equal(filterByCategory([item], "carryon").length, 0);
  }
  for (const catalogNumber of [undefined, null, "", "NEW", "ORI05500.909-OTHER", "ORI05500909", "P10SZV24/A83/TU", "__proto__"]) {
    assert.equal(categorizeItem({ ...items[0], catalogNumber, title: "Cabin carry-on trolley case", techSpecs: null }),
      null, String(catalogNumber));
  }
});

test("filtering keeps identities, all products, display order and existing navigation unchanged", () => {
  const before = structuredClone(items);
  assert.equal(filterByCategory(items, "all"), items);
  for (const category of ["suitcase", "carryon"]) {
    const result = filterByCategory(items, category);
    assert.deepEqual(result, items.filter(item => categorizeItem(item) === category));
    result.forEach(item => assert.equal(item, items.find(candidate => candidate.id === item.id)));
  }
  assert.deepEqual(items, before);
  assert.deepEqual(CATEGORIES.map(category => category.key), ["all", "suitcase", "carryon"]);
  assert.deepEqual(PRODUCT_CATEGORIES.map(category => category.key), ["suitcase", "carryon"]);
  for (const raw of [null, undefined, "accessories", "", "unknown"]) assert.equal(parseCategoryParam(raw), "all");
});

test("admin and Excel consumers handle unassigned products without persisting a false default", async () => {
  const admin = await read("src/app/admin/page.tsx");
  assert.match(admin, /techSpecs: \{ specs: \[\], colors: \[\], category: null \}/);
  assert.match(admin, /function getItemCategory\([^\n]+\): ProductCategory \| null/);
  assert.match(admin, /checked=\{getItemCategory\(item\) === c.key\}/);
  const exporter = await read("src/lib/carousel/shopify-export.ts");
  assert.match(exporter, /const category = categorizeItem\(item\);\s*const type = category \? TYPE_LABEL\[category\] \?\? "" : "";/);
});
