import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const copy = JSON.parse(await read("src/lib/carousel/reviewed-copy.json"));
const source = (await read("src/lib/carousel/reviewed-copy.ts"))
  .replace('import copyData from "./reviewed-copy.json";', `const copyData = ${JSON.stringify(copy)};`);
const moduleFrom = source => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const { applyReviewedCopy, reviewedCopyFor } = await moduleFrom(source);

test("all 25 reviewed exact SKUs replace audited legacy copy without touching commerce or media", () => {
  assert.equal(Object.keys(copy).length, 25);
  for (const [sku, entry] of Object.entries(copy)) {
    const original = {catalogNumber:sku, title:entry.expectedLegacyTitle,
      description:entry.expectedLegacyDescription, id:"unchanged", coverImagePath:"same.jpg",
      angles:[{imagePath:"side.jpg"}], isActive:true, displayOrder:3, sourceUrl:"https://example.com"};
    const actual = applyReviewedCopy(original);
    assert.deepEqual(actual, {...original, title:entry.title, description:entry.description}, sku);
    assert.equal(original.description, entry.expectedLegacyDescription, "input is not mutated");
    assert.deepEqual(applyReviewedCopy(actual), actual, "idempotent");
    assert.ok(entry.sourceUrls.length > 0);
    assert.ok(entry.title && entry.description);
    assert.doesNotMatch(entry.description, /מתכווננת אינסופית|כיסי תיקון|נגד התעסקות|עגלת מחשב|Cabin Exarry|Practical interior/);
  }
});

test("new manual edits and unknown or changed SKUs are preserved", () => {
  for (const sku of Object.keys(copy)) {
    const manual = {catalogNumber:sku, title:"כותרת חדשה", description:"תיאור חדש שנערך ידנית"};
    assert.deepEqual(applyReviewedCopy(manual), manual);
    const changed = {...manual, catalogNumber:sku+"-OTHER"};
    assert.equal(reviewedCopyFor(changed.catalogNumber), null);
    assert.deepEqual(applyReviewedCopy(changed), changed);
  }
  assert.equal(reviewedCopyFor("__proto__"), null);
  assert.equal(reviewedCopyFor(null), null);
  assert.equal(reviewedCopyFor("P10SZV24/A83/TU"), null);
  assert.equal(reviewedCopyFor("P10SZV24 A83 TU"), null);
});

test("production read/save and import paths actually use reviewed copy", async () => {
  const repository = await read("src/lib/carousel/repository.ts");
  assert.match(repository, /\.map\(\(item\) => applyReviewedCopy\(\{/);
  assert.match(repository, /\.\.\.applyReviewedCopy\(item\)/);
  const importer = await read("src/lib/import/import-handler.ts");
  assert.match(importer, /reviewedCopyFor\(sourceProduct\.catalogNumber \|\| catalogNumber\)/);
  assert.match(importer, /reviewedCopy\?\.description/);
});

test("translation cannot make network requests or reintroduce machine copy", async () => {
  const source = await read("src/lib/catalog-source/translate.ts");
  assert.doesNotMatch(source, /fetch\(|translate\.googleapis/);
  const {translateToHebrew} = await moduleFrom(source);
  assert.equal(await translateToHebrew("Manufacturer original"), "Manufacturer original");
  assert.equal(await translateToHebrew(null), null);
  const route = await read("src/app/api/admin/translate/route.ts");
  assert.match(route, /isAuthorized\(req\)/);
  assert.match(route, /status: 410/);
});

test("only card text/actions opt out of swiping, preserving image gestures", async () => {
  const grid = await read("src/components/carousel/CarouselGrid.tsx");
  assert.match(grid, /className="catalog-card-body swiper-no-swiping"/);
  assert.match(grid, /noSwiping=\{true\}/);
  assert.match(grid, /noSwipingClass="swiper-no-swiping"/);
  assert.match(grid, /className="catalog-card-visual"/);
  assert.doesNotMatch(grid, /simulateTouch=\{false\}|allowTouchMove=\{false\}/);
});
