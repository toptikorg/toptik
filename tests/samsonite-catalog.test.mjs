import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const reviewed = JSON.parse(await read("src/lib/carousel/samsonite-reviewed.json"));
const variants = JSON.parse(await read("src/lib/carousel/samsonite-variants.json"));
const source = (await read("src/lib/carousel/samsonite-catalog.ts"))
  .replace('import reviewed from "./samsonite-reviewed.json";', "const reviewed = " + JSON.stringify(reviewed) + ";")
  .replace('import variants from "./samsonite-variants.json";', "const variants = " + JSON.stringify(variants) + ";");
const { appendSamsoniteItems, SAMSONITE_SNAPSHOT_AT, SAMSONITE_VARIANT_IDS } =
  await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64"));

// Fixed evidence from the read-only public Shopify audit on 2026-09-29.
// This fixture must change only after the exact public variants are reverified.
const EXPECTED_VARIANTS = {
  "KJ114007": "50223213150458",
  "KJ114001": "50223212790010",
  "KJ111001": "50223210692858",
  "KJ109001": "50223209677050",
  "KJ106007": "50223208595706",
  "KL974005": "50223208005882",
  "KL974004": "50223207547130",
  "KL974003": "50223206400250",
  "KL974002": "50223206072570",
  "KL974001": "50223205056762",
  "KT009004": "50149301584122",
  "KO704007": "50148832903418",
  "KO701007": "50148832313594",
  "KO776007": "50148831887610",
  "KO709007": "50148831789306",
  "KO704006": "50148831363322",
  "KO701006": "50148829266170",
  "KO776006": "50148829036794",
  "KO709006": "50148827693306",
  "KO704005": "50148827332858",
  "KO701005": "50148826611962",
  "KO776005": "50148826317050",
  "KO709005": "50148825989370",
  "KO704011": "50148825759994",
  "KO701011": "50148825530618",
  "KO709011": "50148825497850",
  "KJ17176004": "50148820910330",
  "KJ106001": "50148820517114",
  "KJ344007": "50148820320506",
  "KL924004": "50148820025594",
  "KL966004": "50148819796218",
  "KL901004": "50148819665146",
  "KL909004": "50148819599610",
  "KL924003": "50148818583802",
  "KL966003": "50148818551034",
  "KL901003": "50148818419962",
  "KL909003": "50148818092282",
  "KL924002": "50148817633530",
  "KL966002": "50148817142010",
  "KL901002": "50148816879866",
  "KL909002": "50148816486650",
  "KL924001": "50148816388346",
  "KL924005": "50148816027898",
  "KL966005": "50148815929594",
  "KL901005": "50148815700218",
  "KL909005": "50148815536378",
  "KL966001": "50148815339770",
  "KL901001": "50148815208698",
  "KL909001": "50148815044858",
  "S281006": "50148814749946",
  "S209004": "50148812325114",
  "KI100005": "50148812062970",
  "KI106005": "50148798071034",
  "KI139005": "50148797808890",
  "KI104005": "50148797645050",
  "KI101004": "50148797350138",
  "KI109005": "50148797251834"
};
const CARRYON_SKUS = new Set(["KJ114007","KJ114001","KJ111001","KJ109001","KJ106007","KL974005","KL974001","KO704005","KO701005","KO776005","KO709005","KJ106001","KL924001","KL924005","KL966005","KL901005","KL909005","KL966001","KL901001","KL909001"]);
const SUITCASE_SKUS = new Set(["KL974004","KL974003","KL974002","KO704007","KO701007","KO776007","KO709007","KO704006","KO701006","KO776006","KO709006","KJ17176004","KJ344007","KL924004","KL966004","KL901004","KL909004","KL924003","KL966003","KL901003","KL909003","KL924002","KL966002","KL901002","KL909002","S281006","S209004"]);
const EXPECTED_IMAGE_SHA256 = "29ea4e9f426eb5b5ce7fc6c754dfa89361408762883106da01f245b3ad65e1b5";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test("snapshot has all 57 audited exact SKU/variant mappings and no commercial or SEO metadata", () => {
  assert.equal(SAMSONITE_SNAPSHOT_AT, "2026-09-29T05:49:48.245Z");
  assert.equal(reviewed.publicSource, "https://www.toptik.co.il/products.json?limit=250");
  assert.equal(reviewed.records.length, 57);
  assert.deepEqual(variants, EXPECTED_VARIANTS);
  assert.deepEqual(SAMSONITE_VARIANT_IDS, EXPECTED_VARIANTS);
  assert.deepEqual(Object.fromEntries(reviewed.records.map(record => [record.sku, record.variantId])), EXPECTED_VARIANTS);
  assert.equal(new Set(reviewed.records.map(record => record.sku)).size, 57);
  assert.equal(new Set(reviewed.records.map(record => record.variantId)).size, 57);
  for (const record of reviewed.records) {
    assert.ok(!record.title.includes(record.sku), record.sku);
    assert.ok(!record.description.includes(record.sku), record.sku);
    assert.ok(record.description.length > 150 && record.description.length <= 320, record.sku);
    const sentences = record.description.match(/[.!?](?=\s|$)/g) ?? [];
    assert.ok(sentences.length >= 2 && sentences.length <= 3, record.sku);
    assert.ok(record.description.endsWith("."), record.sku);
    for (const forbidden of ["price", "currency", "available", "indexable", "pageTitle", "metaDescription"]) {
      assert.ok(!Object.hasOwn(record, forbidden), record.sku + ": " + forbidden);
    }
  }
});

test("every appended product has explicit Samsonite evidence and the audited category", () => {
  const items = appendSamsoniteItems([]);
  assert.equal(items.length, 57);
  const categories = { carryon: 0, suitcase: 0, other: 0 };
  for (const item of items) {
    const expectedCategory = CARRYON_SKUS.has(item.catalogNumber) ? "carryon" :
      SUITCASE_SKUS.has(item.catalogNumber) ? "suitcase" : null;
    assert.equal(item.techSpecs.category, expectedCategory, item.catalogNumber);
    assert.deepEqual(item.techSpecs.specs.flatMap(section => section.items)
      .filter(spec => spec.label === "מותג"), [{ label: "מותג", value: "Samsonite" }]);
    assert.equal(item.id, "shopify-" + EXPECTED_VARIANTS[item.catalogNumber]);
    assert.ok(item.isActive);
    assert.ok(new URL(item.sourceUrl).hostname.startsWith("www.samsonite."));
    assert.ok(item.techSpecs.specs[0].items.length >= 6, item.catalogNumber);
    categories[expectedCategory ?? "other"]++;
  }
  assert.deepEqual(categories, { carryon: 20, suitcase: 27, other: 10 });
});

test("every cover and all 355 angles preserve the exact audited product images", () => {
  const evidence = reviewed.records.map(record =>
    [record.sku, record.coverImagePath, record.imagePaths]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.equal(createHash("sha256").update(JSON.stringify(evidence)).digest("hex"), EXPECTED_IMAGE_SHA256);
  const items = appendSamsoniteItems([]);
  assert.equal(items.reduce((total, item) => total + item.angles.length, 0), 355);
  for (const item of items) {
    const record = reviewed.records.find(candidate => candidate.sku === item.catalogNumber);
    assert.equal(item.coverImagePath, record.coverImagePath);
    assert.deepEqual(item.angles.map(angle => angle.imagePath), record.imagePaths, item.catalogNumber);
    assert.equal(item.angles[0].imagePath, item.coverImagePath);
    assert.equal(new Set(item.angles.map(angle => angle.id)).size, item.angles.length);
    for (const [index, angle] of item.angles.entries()) {
      assert.equal(angle.itemId, item.id);
      assert.equal(angle.angleOrder, index);
      assert.equal(new URL(angle.imagePath).hostname, "cdn.shopify.com");
    }
  }
});

test("curated SKU precedence includes inactive records and normalizes only the comparison key", () => {
  const first = appendSamsoniteItems([])[0];
  const curated = deepFreeze({
    ...first, id: "curated-owner-id", catalogNumber: "  kj-114007  ",
    title: "כותרת שערך בעל החנות", description: "עריכה ידנית נשמרת",
    isActive: false, displayOrder: 42,
  });
  const other = deepFreeze({ ...first, id: "existing-other", catalogNumber: "OTHER", displayOrder: 3 });
  const input = Object.freeze([curated, other]);
  const before = structuredClone(input);
  const combined = appendSamsoniteItems(input);
  assert.equal(combined.length, 58);
  assert.equal(combined[0], curated);
  assert.equal(combined[1], other);
  assert.deepEqual(input, before);
  assert.ok(!combined.slice(2).some(item => item.catalogNumber === "KJ114007"));
  assert.equal(combined[2].displayOrder, 43);
  assert.ok(!combined[0].isActive, "the snapshot cannot reactivate a hidden curated product");
  assert.deepEqual(appendSamsoniteItems(combined), combined, "repeated composition is idempotent");
});

test("an existing item ID is never duplicated even if its current SKU differs", () => {
  const audited = appendSamsoniteItems([])[0];
  const existing = deepFreeze({ ...audited, catalogNumber: "OWNER-RENAMED", title: "עריכה קיימת" });
  const combined = appendSamsoniteItems(Object.freeze([existing]));
  assert.equal(combined.length, 57);
  assert.equal(combined[0], existing);
  assert.equal(combined.filter(item => item.id === existing.id).length, 1);
  assert.equal(new Set(combined.map(item => item.id)).size, 57);
});

test("supplement results have independent mutable arrays without mutating source data or input", () => {
  const first = appendSamsoniteItems(Object.freeze([]));
  const before = structuredClone(first);
  first[0].title = "temporary caller change";
  first[0].angles[0].imagePath = "invalid";
  first[0].techSpecs.specs[0].items[0].value = "another brand";
  first[0].techSpecs.colors.push({ name: "temporary", hex: null, swatchUrl: null });
  first[0].colors.push({ name: "temporary" });
  assert.deepEqual(appendSamsoniteItems([]), before);
  assert.equal(reviewed.records[0].specs[0].value, "Samsonite");
});
