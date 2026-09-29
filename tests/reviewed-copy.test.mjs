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
      angles:[{imagePath:"side.jpg"}], isActive:true, displayOrder:3, sourceUrl:"https://example.com",
      techSpecs:structuredClone(entry.expectedLegacyTechSpecs)};
    const actual = applyReviewedCopy(original);
    assert.deepEqual(actual, {...original, title:entry.title, description:entry.description,
      techSpecs:{...original.techSpecs, colors:original.techSpecs?.colors ?? [],
        specs:[{heading:"פרטי מוצר",items:entry.specs}]}}, sku);
    assert.equal(original.description, entry.expectedLegacyDescription, "input is not mutated");
    assert.deepEqual(original.techSpecs, entry.expectedLegacyTechSpecs, "legacy specs are not mutated");
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

test("spec repair ignores JSON key order but preserves every new manual change", () => {
  const reorderKeys = value => Array.isArray(value) ? value.map(reorderKeys) :
    value && typeof value === "object" ? Object.fromEntries(
      Object.entries(value).reverse().map(([key, child]) => [key, reorderKeys(child)])) : value;
  for (const [sku, entry] of Object.entries(copy)) {
    const item = {catalogNumber:sku, title:"כותרת ידנית חדשה", description:"תיאור ידני חדש",
      techSpecs:reorderKeys(entry.expectedLegacyTechSpecs)};
    const repaired = applyReviewedCopy(item);
    assert.equal(repaired.title, item.title);
    assert.equal(repaired.description, item.description);
    assert.deepEqual(repaired.techSpecs.specs, [{heading:"פרטי מוצר",items:entry.specs}], sku);
    assert.deepEqual(repaired.techSpecs.colors, item.techSpecs?.colors ?? []);
    assert.equal(repaired.techSpecs.category, item.techSpecs?.category);
    for (const techSpecs of [
      {...item.techSpecs, specs:[{heading:"עריכה ידנית",items:[{label:"מידה",value:"נבדק ידנית"}]}]},
      {...item.techSpecs, colors:[{name:"צבע חדש",hex:null,swatchUrl:null}]},
      {...item.techSpecs, category:"manual-category"},
      null,
    ]) {
      const manual = {...item, techSpecs};
      assert.deepEqual(applyReviewedCopy(manual), manual, `${sku}: manual specs/colors/category preserved`);
    }
    const unknown = {...item, catalogNumber:sku+"-OTHER"};
    assert.deepEqual(applyReviewedCopy(unknown), unknown);
  }
  const sku = "BAH08453.001";
  const legacy = structuredClone(copy[sku].expectedLegacyTechSpecs);
  assert.ok(legacy.specs.length > 1);
  legacy.specs.reverse();
  const reordered = {catalogNumber:sku,title:"manual",description:"manual",techSpecs:legacy};
  assert.deepEqual(applyReviewedCopy(reordered), reordered, "section order is a meaningful change");
});

test("unverified products expose only identity specs and suppress stale modal fallback", async () => {
  for (const sku of ["P10JNV05465", "P10JNV0508Q", "P10GXV24A32", "P10UJV24-A92-TU"]) {
    const entry = copy[sku];
    assert.deepEqual(entry.specs.map(spec => spec.label), ["מותג", "מק״ט"]);
    assert.equal(entry.specs[1].value, sku);
    const item = applyReviewedCopy({catalogNumber:sku,title:entry.title,
      techSpecs:structuredClone(entry.expectedLegacyTechSpecs)});
    assert.ok(item.techSpecs, "non-null reviewed data takes precedence over the scrape/session cache");
    assert.deepEqual(item.techSpecs.specs, [{heading:"פרטי מוצר",items:entry.specs}]);
  }
  const modal = await read("src/components/carousel/TechSpecsModal.tsx");
  assert.match(modal, /const synchronousDetails = cachedTechSpecs \?\? sessionHit/);
  assert.match(modal, /if \(!url \|\| synchronousDetails\) return/);
  const displayBranch = modal.match(/let displayState: FetchState;[\s\S]*?(?=\n  return \()/)?.[0];
  assert.ok(displayBranch, "modal display-state selection must be present");
  const { chooseDisplay } = await moduleFrom(`export function chooseDisplay(details, url) {
    const fetchFailed = false;
    const fetchedUrl = null;
    ${displayBranch}
    return {displayState, displayDetails};
  }`);
  const identityDetails = {specs:[{heading:"פרטי מוצר",items:copy.P10JNV05465.specs}],colors:[]};
  assert.deepEqual(chooseDisplay(identityDetails, null), {
    displayState:"done",displayDetails:identityDetails,
  }, "reviewed cached specs render even when the original source URL is absent");
});

test("production read/save and import paths actually use reviewed copy", async () => {
  const repository = await read("src/lib/carousel/repository.ts");
  const repositoryAdmin = await read("src/lib/carousel/repository-admin.ts");
  assert.match(repository, /\.map\(\(item\) => applyReviewedCopy\(\{/);
  assert.match(repositoryAdmin, /\.\.\.applyReviewedCopy\(item\)/);
  assert.match(repository, /techSpecs: item\.tech_specs \?\? null/);
  assert.match(repositoryAdmin, /tech_specs: item\.techSpecs \?\? null/);
  const importer = await read("src/lib/import/import-handler.ts");
  assert.match(importer, /reviewedCopyFor\(productCatalogNumber\)/);
  assert.match(importer, /reviewedCopy\?\.description/);
});

test("import through save preserves raw SKU identity while storage paths stay safe", async () => {
  // Execute the production import/save bodies with only their collaborators
  // injected. No credentials, network requests or real database writes occur.
  const importerSource = await read("src/lib/import/import-handler.ts");
  const importStart = importerSource.indexOf("function angleKeyByIndex");
  const importEnd = importerSource.indexOf("export function createImportRouteHandler");
  assert.ok(importStart >= 0 && importEnd > importStart);
  const importBody = importerSource.slice(importStart, importEnd).replace(/^export /gm, "");
  const { createImporter } = await moduleFrom(`export function createImporter(deps) {
    const { VENDOR_CONFIG, uploadRemoteImageToStorage, uploadVariantGalleries,
      fetchProductDetails, translateToHebrew, reviewedCopyFor,
      createSupabaseServiceRoleClient } = deps;
    ${importBody}
    return importSourceProduct;
  }`);
  const repositorySource = await read("src/lib/carousel/repository-admin.ts");
  const saveStart = repositorySource.indexOf("export async function saveCarouselPayload");
  assert.ok(saveStart >= 0);
  const saveBody = repositorySource.slice(saveStart).replace(/^export /gm, "");
  const { createSaver } = await moduleFrom(`export function createSaver(deps) {
    const { adminCarouselPayloadSchema, createSupabaseServiceRoleClient, applyReviewedCopy } = deps;
    const isUnavailableCarouselPayload = (input) => input?.unavailable === true;
    ${saveBody}
    return saveCarouselPayload;
  }`);
  const { translateToHebrew } = await moduleFrom(await read("src/lib/catalog-source/translate.ts"));
  const exactSku = "P10SZV24-A83-TU";
  const entry = copy[exactSku];
  for (const rawSku of [exactSku, "P10SZV24/A83/TU", "P10SZV24 A83 TU"]) {
    for (const sourceSku of [rawSku, null]) {
      const storagePaths = [];
      const sourceProduct = {
        catalogNumber: sourceSku, title: entry.expectedLegacyTitle,
        description: entry.expectedLegacyDescription,
        sourceUrl: "https://example.com/product", imageUrls: ["https://example.com/image.jpg"],
      };
      const importProduct = createImporter({
        VENDOR_CONFIG: { mandarina: {
          label: "Mandarina Duck", storageFolder: "mandarina",
          enumerateVariants: async () => [{}], mapColors: () => [],
        } },
        uploadRemoteImageToStorage: async folder => {
          storagePaths.push(folder);
          return "https://example.com/stored.jpg";
        },
        uploadVariantGalleries: async folder => { storagePaths.push(folder); return new Map(); },
        fetchProductDetails: async () => ({ specs: [], colors: [] }),
        translateToHebrew, reviewedCopyFor,
        createSupabaseServiceRoleClient: () => { throw new Error("Import must not persist a new item"); },
      });
      const imported = await importProduct("mandarina", sourceProduct, undefined, rawSku);
      assert.equal(imported.item.catalogNumber, rawSku);
      assert.equal(imported.source.catalogNumber, rawSku);
      assert.deepEqual(storagePaths, [
        `imports/mandarina/${exactSku}`, `imports/mandarina/${exactSku}/colors`,
      ]);

      let savedRows;
      const db = { from(table) { return {
        upsert(rows) {
          if (table === "carousel_items") {
            savedRows = rows;
            return { select: async () => ({ data: rows.map(row => ({ id: row.id })), error: null }) };
          }
          return Promise.resolve({ error: null });
        },
        select: async () => ({ data: [], error: null }),
      }; } };
      const save = createSaver({
        // This test isolates identity propagation, not the unchanged Zod schema.
        adminCarouselPayloadSchema: { parse: input => structuredClone(input) },
        createSupabaseServiceRoleClient: () => db, applyReviewedCopy,
      });
      await save({ items: [imported.item], settings: {
        autoplayMs: 3000, transitionMode: "curtain-fade",
      } });
      assert.equal(savedRows[0].catalog_number, rawSku);
      assert.equal(savedRows[0].title, rawSku === exactSku ? entry.title : entry.expectedLegacyTitle);
      assert.equal(savedRows[0].description,
        rawSku === exactSku ? entry.description : entry.expectedLegacyDescription);
      if (rawSku === exactSku) {
        for (const [sku, reviewed] of Object.entries(copy)) {
          const legacy = {...imported.item, catalogNumber:sku,
            techSpecs:structuredClone(reviewed.expectedLegacyTechSpecs)};
          await save({items:[legacy],settings:{autoplayMs:3000,transitionMode:"curtain-fade"}});
          assert.deepEqual(savedRows[0].tech_specs,
            {...legacy.techSpecs,colors:legacy.techSpecs?.colors ?? [],
              specs:[{heading:"פרטי מוצר",items:reviewed.specs}]}, `${sku}: persisted in tech_specs`);
        }
      }
    }
  }
});

test("translation cannot make network requests or reintroduce machine copy", async () => {
  const source = await read("src/lib/catalog-source/translate.ts");
  assert.doesNotMatch(source, /fetch\(|translate\.googleapis/);
  const {translateToHebrew} = await moduleFrom(source);
  assert.equal(await translateToHebrew("Manufacturer original"), "Manufacturer original");
  assert.equal(await translateToHebrew(null), null);
  const route = await read("src/app/api/admin/translate/route.ts");
  assert.match(route, /requireAdminToken\(req\)/);
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
