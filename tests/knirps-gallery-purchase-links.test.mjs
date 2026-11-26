import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { compareStoreGalleryProductHandles } from "../scripts/production-visual-smoke.mjs";

const read = path => readFile(new URL("../" + path, import.meta.url), "utf8");
const moduleFrom = source => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const reviewed = JSON.parse(await read("src/lib/editorial/knirps-products.json"));
const { classificationIndex } = await moduleFrom((await read("src/lib/carousel/store-classification.ts"))
  .replace('import "server-only";', "")
  .replace('import { brandForItem } from "./brands";', 'const brandForItem = () => null;')
  .replace('import { REVIEWED_SERIES, type GallerySeries } from "./series";', 'const REVIEWED_SERIES = [];'));
const { appendKnirpsItems } = await moduleFrom((await read("src/lib/carousel/knirps-catalog.ts"))
  .replace('import reviewed from "../editorial/knirps-products.json";', `const reviewed = ${JSON.stringify(reviewed)};`));
const { brandForItem, publicCollectionItems, availableBrands } = await moduleFrom(await read("src/lib/carousel/brands.ts"));
const fixture = reviewed.map((record, i) => ({
  vendor: "Knirps", product_type: "מטרייה", tags: ["Knirps"], handle: new URL(record.purchaseUrl).pathname.split("/").pop(),
  variants: [{sku: record.sku, id: String(68366386299130 + i)}],
}));
const index = () => classificationIndex(fixture);
const key = sku => sku.toUpperCase().replace(/[^A-Z0-9]/g, "");
function frozen(value) { if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }

test("regression: all 11 reviewed umbrellas reach the public gallery with exact live product/variant links and both approved images", () => {
  const items = appendKnirpsItems([], index());
  const productUrls = reviewed.map(record => record.purchaseUrl);
  assert.equal(compareStoreGalleryProductHandles(productUrls, []).missing.length, 11);
  assert.deepEqual(compareStoreGalleryProductHandles(productUrls, items).missing, []);
  assert.equal(items.length, 11);
  assert.equal(publicCollectionItems(items).length, 11);
  assert.deepEqual(availableBrands(items).map(b => b.label), ["Knirps"]);
  for (const [i, item] of items.entries()) {
    assert.equal(item.catalogNumber, reviewed[i].sku);
    assert.equal(item.title, reviewed[i].title);
    assert.equal(item.shopifyLink.handle, fixture[i].handle);
    assert.equal(item.shopifyLink.variantId, fixture[i].variants[0].id);
    assert.equal(item.shopifyLink.isPublished, true);
    assert.equal(brandForItem(item).label, "Knirps");
    assert.deepEqual(item.angles.map(a => a.imagePath), reviewed[i].images.map(image => image.src));
    assert.equal(item.coverImageAlt, reviewed[i].images[0].alt);
    assert.equal(item.isActive, true);
    assert.ok(!Object.hasOwn(item, "price"), "prices remain live on Shopify");
  }
});

test("manual hides and curated records win, composition is immutable and idempotent", () => {
  const first = appendKnirpsItems([], index())[0];
  const curated = frozen({...first, id: "owner", isActive: false, catalogNumber: " 0050-1001 ", title: "עריכה ידנית", displayOrder: 99});
  const before = JSON.stringify(curated);
  const input = frozen([curated]);
  const result = appendKnirpsItems(input, index());
  assert.equal(result.length, 11);
  assert.equal(result[0], curated);
  assert.equal(result.filter(x => x.isActive).length, 10);
  assert.equal(JSON.stringify(curated), before);
  assert.deepEqual(appendKnirpsItems(result, index()), result);
  assert.equal(result[1].displayOrder, 100);
});

test("unpublished, ambiguous, unverified and unsafe bindings never revive a reviewed umbrella", () => {
  assert.deepEqual(appendKnirpsItems([], null), []);
  assert.deepEqual(appendKnirpsItems([], new Map()), []);
  const duplicate = classificationIndex([...fixture, fixture[0]]);
  assert.equal(appendKnirpsItems([], duplicate).length, 10);
  for (const patch of [
    {brand: "samsonite"}, {purchaseLink: null},
    {purchaseLink: {handle: "wrong-product", variantId: "123", isPublished: true}},
    {purchaseLink: {handle: fixture[0].handle, variantId: "123", isPublished: false}},
    {purchaseLink: {handle: fixture[0].handle, variantId: "javascript:alert(1)", isPublished: true}},
  ]) {
    const current = index();
    current.set(key(fixture[0].variants[0].sku), {...current.get(key(fixture[0].variants[0].sku)), ...patch});
    assert.equal(appendKnirpsItems([], current).length, 10);
  }
  const noLongerPublic = classificationIndex(fixture.slice(1));
  assert.equal(appendKnirpsItems([], noLongerPublic).length, 10);
});

test("same current product binding suppresses duplicate cards even if an editor changed its SKU", () => {
  const first = appendKnirpsItems([], index())[0];
  const existing = {...first, catalogNumber: "OWNER-ALIAS", isActive: false};
  const result = appendKnirpsItems([existing], index());
  assert.equal(result.length, 11);
  assert.equal(result[0], existing);
});

test("public payload composes reviewed umbrellas using the already loaded store index, and admin remains independent", async () => {
  const source = await read("src/lib/carousel/public-payload.ts");
  const body = source.slice(source.indexOf("export async function getPublicCarouselPayload")).replace(/^export /gm, "");
  const { makeReader } = await moduleFrom(`export function makeReader(deps) {
    const { getCarouselPayload, readStoreClassification } = deps;
    const process = {env:{}};
    const isUnavailableCarouselPayload = p => p.unavailable;
    const appendSamsoniteItems = items => items;
    const applyStoreClassification = items => items;
    const publicCollectionItems = items => items;
    const appendKnirpsItems = deps.appendKnirpsItems;
    ${body}
    return getPublicCarouselPayload;
  }`);
  let reads = 0;
  const get = makeReader({getCarouselPayload:async()=>({items:[],settings:{}}),readStoreClassification:async()=>{reads++;return index();},appendKnirpsItems});
  assert.equal((await get()).items.length, 11);
  assert.equal(reads, 1, "no extra store requests per umbrella");
  const admin = await read("src/lib/carousel/repository-admin.ts");
  assert.ok(!admin.includes("appendKnirpsItems"), "no sync, media approval or database mutation");
});

