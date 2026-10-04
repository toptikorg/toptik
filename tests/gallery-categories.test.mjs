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
test("verified October 3 Bric's additions appear in their exact product categories", () => {
  const additions = {
    BOO05956003: "backpacks", BXL43756101: "backpacks",
    BXL44649050: "backpacks", BXL44649001: "backpacks",
    BXG45072078: "fashion-bags", BXG45072101: "fashion-bags",
    BAH08450001: "carryon", BAH08450006: "carryon",
    BAH08451006: "carryon", BAH08451078: "carryon",
    BAH08454006: "suitcase", BAH08454078: "suitcase",
  };
  for (const [catalogNumber, category] of Object.entries(additions)) {
    const item = { catalogNumber, techSpecs: { category: null } };
    assert.equal(categorizeItem(item), category, catalogNumber);
    assert.equal(filterByCategory([item], category).length, 1);
    assert.equal(categorizeItem({ ...item, techSpecs: { category: "wallets" } }), "wallets");
  }
  for (const catalogNumber of ["BXL30599050", "BXL30599078", "BXG45283910"]) {
    assert.equal(categorizeItem({ catalogNumber }), null, "unverified identity stays unassigned");
  }
});
const expected = {
  P10JNV05465: null, P10GXV24A32: null, P10JNV0508Q: null,
  BXL38124078: "carryon", "BAH08453.001": "suitcase", "BAH08453.006": "suitcase",
  "BAH08451.001": "carryon", "BAH08454.001": "suitcase", "BAH08453.078": "suitcase",
  "BXL58117.101": "carryon", BXL38124101: "carryon", "BXL58145.101": "suitcase",
  "BXL58145.050": "suitcase", "BXL58145.078": "suitcase", "P10SZV24-05J-TU": "carryon",
  "P10SZV24-A83-TU": "carryon", "P10UJV24-A92-TU": "carryon", "P10SZV24-A81-TU": "carryon",
  "P10OUV24-A89-TU": "carryon", "P10OUN01-A89-TU": "pouches", "P10UJN01-A92-TU": "pouches",
  "ORI05500.909": "carryon", "ORI05500.024": "carryon", "P10OSV04-05J-TU": "suitcase",
  "P10ZJT06-24U-TU": "fashion-bags",
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
  const counts = { carryon: 0, suitcase: 0, pouches: 0, "fashion-bags": 0 };
  for (const item of items) counts[categorizeItem(item) ?? "unassigned"]++;
  assert.deepEqual(counts, { carryon: 14, suitcase: 8, pouches: 2, "fashion-bags": 1 });
  assert.deepEqual(filterByCategory(filterByBrand(items, "porsche-design"), "carryon")
    .map(item => item.catalogNumber), ["ORI05500.909", "ORI05500.024"]);
  assert.equal(filterByCategory(filterByBrand(items, "brics"), "carryon").length, 4);
  assert.equal(filterByCategory(filterByBrand(items, "mandarina-duck"), "carryon").length, 8);
});

test("explicit future admin choices win over exact SKU evidence without mutating specs", () => {
  for (const item of items) {
    for (const { key: category } of PRODUCT_CATEGORIES) {
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

test("accessories have their own category; unknown models are never guessed from title or prefixes", () => {
  for (const sku of ["P10OUN01-A89-TU", "P10UJN01-A92-TU", "P10ZJT06-24U-TU"]) {
    const item = items.find(item => item.catalogNumber === sku);
    assert.equal(categorizeItem(item), expected[sku], sku);
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
  for (const { key: category } of PRODUCT_CATEGORIES) {
    const result = filterByCategory(items, category);
    assert.deepEqual(result, items.filter(item => categorizeItem(item) === category));
    result.forEach(item => assert.equal(item, items.find(candidate => candidate.id === item.id)));
  }
  assert.deepEqual(items, before);
  assert.deepEqual(CATEGORIES.map(category => category.key), ["all", "suitcase", "carryon", "fashion-bags", "backpacks", "laptop-bags", "travel-bags", "wallets", "pouches"]);
  assert.deepEqual(PRODUCT_CATEGORIES.map(category => category.key), ["suitcase", "carryon", "fashion-bags", "backpacks", "laptop-bags", "travel-bags", "wallets", "pouches"]);
  for (const raw of [null, undefined, "accessories", "", "unknown"]) assert.equal(parseCategoryParam(raw), "all");
});

test("admin and Excel consumers handle unassigned products without persisting a false default", async () => {
  const admin = await read("src/app/admin/page.tsx");
  const newEditor = await read("src/components/admin/NewProductEditor.tsx");
  assert.match(newEditor, /brand: null, category: null/);
  const add = admin.slice(admin.indexOf("function addItem()"), admin.indexOf("function removeItem("));
  assert.match(add, /setCreationSelection/);
  assert.doesNotMatch(add, /setPayload|isActive: true/);
  assert.match(admin, /function getItemCategory\([^\n]+\): ProductCategory \| null/);
  assert.match(admin, /checked=\{getItemCategory\(item\) === c.key\}/);
  const exporter = await read("src/lib/carousel/shopify-export.ts");
  assert.match(exporter, /const category = categorizeItem\(item\);\s*const type = category \? TYPE_LABEL\[category\] \?\? "" : "";/);
});

test("all 257 audited live records have a product type, with no omissions", async () => {
  const records = JSON.parse(await read("tests/fixtures/gallery-category-coverage-20261002.json"));
  assert.equal(records.length, 257);
  for (const row of records) assert.equal(categorizeItem(row), row.expected, row.catalogNumber);
  const results = PRODUCT_CATEGORIES.flatMap(c => filterByCategory(records, c.key));
  assert.equal(results.length, records.length);
  assert.equal(new Set(results.map(i => i.catalogNumber)).size, records.length);
  for (const c of PRODUCT_CATEGORIES) assert.equal(parseCategoryParam(c.key), c.key);
});

test("compact filters have platform layouts, accessible choices and an explicit apply action", async () => {
  const css = await read("src/components/carousel/CompactFilters.module.css");
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /min-height: 48px/);
  assert.match(css, /max-height: 85dvh/);
  assert.match(css, /overflow-y: auto/);
  const nav = await read("src/components/carousel/CategoryNav.tsx");
  assert.match(nav, /draftItems.map\(categorizeItem\)/);
  assert.match(nav, /aria-haspopup="dialog"/);
  assert.match(nav, /aria-expanded=\{panel === "series"\}/);
  assert.match(nav, /type="radio"/);
  assert.match(nav, /element.showModal\(\)/);
  assert.match(nav, /onApply\(draftSeries, draftCategory\)/);
  assert.match(nav, /filterByCategory\(filterBySeries\(items, key\), draftCategory\).length/);
  assert.match(nav, /opener.current\?\.focus\(/);
  assert.match(nav, /window.addEventListener\("resize", reposition\)/);
  assert.match(nav, /onKeyDown=\{event => event.stopPropagation\(\)\}/);
});
