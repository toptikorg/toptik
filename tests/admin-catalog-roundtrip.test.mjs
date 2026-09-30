import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { descriptionHelpers } from "./helpers/description-module.mjs";

const read = name => readFileSync(name, "utf8");
const moduleFrom = source => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const repairs = JSON.parse(read("src/lib/carousel/reviewed-copy.json"));
const { applyReviewedCopy } = await moduleFrom(read("src/lib/carousel/reviewed-copy.ts")
  .replace('import copyData from "./reviewed-copy.json";', `const copyData = ${JSON.stringify(repairs)};`));
const { adminCarouselPayloadSchema } = await moduleFrom(read("src/lib/validation/carousel.ts")
  .replace('from "zod"', `from ${JSON.stringify(import.meta.resolve("zod"))}`));
const repository = read("src/lib/carousel/repository.ts");
const saver = read("src/lib/carousel/repository-admin.ts");
const samsonite = JSON.parse(read("src/lib/carousel/samsonite-reviewed.json"));
const { appendSamsoniteItems } = await moduleFrom(read("src/lib/carousel/samsonite-catalog.ts")
  .replace('import reviewed from "./samsonite-reviewed.json";', `const reviewed = ${JSON.stringify(samsonite)};`)
  .replace('import variants from "./samsonite-variants.json";', `const variants = ${read("src/lib/carousel/samsonite-variants.json")};`));
const publicRepository = read("src/lib/carousel/public-payload.ts");
const { createPublicReader } = await moduleFrom(`export function createPublicReader(deps) {
  const { getCarouselPayload, appendSamsoniteItems } = deps;
  const isUnavailableCarouselPayload = () => false;
  ${publicRepository.slice(publicRepository.indexOf("export async function getPublicCarouselPayload")).replace(/^export /gm, "")}
  return getPublicCarouselPayload;
}`);
const { createReader } = await moduleFrom(`export function createReader(deps) {
  const { createSupabaseServerClient, applyReviewedCopy } = deps;
  const hasSupabasePublicEnv = () => true;
  const normalizeSyncSku = value => value?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? null;
  const fallbackCarouselPayload = { items: [], settings: { autoplayMs: 3000, transitionMode: "curtain-fade" } };
  ${repository.slice(repository.indexOf("export async function getCarouselPayload")).replace(/^export /gm, "")}
  return getCarouselPayload;
}`);
const { createSaver } = await moduleFrom(`export function createSaver(deps) {
  const { createSupabaseServiceRoleClient, adminCarouselPayloadSchema,
    plainDescriptionToHtml, descriptionTextFromHtml, assertSafeDescriptionHtml } = deps;
  const isUnavailableCarouselPayload = () => false;
  ${saver.slice(saver.indexOf("export async function saveCarouselPayload")).replace(/^export /gm, "")}
  return saveCarouselPayload;
}`);
const uuid = index => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
const stamp = "2026-09-30T10:00:00.000Z";

function fixture() {
  const rows = Object.entries(repairs).map(([sku, entry], index) => ({
    id: uuid(index + 1), title: entry.expectedLegacyTitle,
    description: entry.expectedLegacyDescription, description_html: null,
    catalog_number: sku, seo_title: "Preserved SEO", seo_description: "Preserved search description",
    copy_updated_at: stamp, source_url: "https://example.com/source",
    cover_image_path: `https://example.com/real-${index}.webp`, display_order: index + 1,
    is_active: index !== 24, color: `Color ${index}`, dimensions: "75 x 49 x 31 cm",
    weight: "4.1 kg", sizes: ["75 cm"], available_colors: ["Black", "Blue"],
    colors: [{ name: "Black", hex: "#000000", colorCode: "001", imagePath: "https://example.com/black.webp",
      angles: ["https://example.com/side.webp"], sourceUrl: null, catalogNumber: sku }],
    tech_specs: structuredClone(entry.expectedLegacyTechSpecs),
  }));
  const rich = rows[0];
  rich.description_html = descriptionHelpers.plainDescriptionToHtml(rich.description ?? "");
  rich.description = descriptionHelpers.descriptionTextFromHtml(rich.description_html);
  const angles = rows.map((row, index) => ({ id: uuid(100 + index), item_id: row.id,
    angle_key: "front", angle_order: 1, image_path: row.cover_image_path }));
  const settings = { id: 1, autoplay_ms: 3000, transition_mode: "curtain-fade" };
  const before = structuredClone({ rows, angles, settings });
  const rpcCalls = [];
  const db = {
    from(table) {
      let filters = [];
      const query = {
        select() { return query; }, order() { return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        in(key, values) { filters.push(row => values.includes(row[key])); return query; },
        maybeSingle() { return Promise.resolve({ data: settings, error: null }); },
        async upsert(data) {
          if (table === "carousel_settings") Object.assign(settings, data);
          else if (table === "carousel_item_angles") {
            for (const angle of data) Object.assign(angles.find(row => row.id === angle.id), angle);
          } else assert.fail("Product saves must use the atomic RPC");
          return { error: null };
        },
        delete() { assert.fail("A canary copy edit must not delete rows or angles"); },
        then(resolve) {
          const data = table === "carousel_items" ? rows : table === "carousel_item_angles" ? angles : [];
          return Promise.resolve({ data: structuredClone(data.filter(row => filters.every(filter => filter(row)))), error: null }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name, input) {
      assert.equal(name, "save_gallery_items_with_copy_cas");
      assert.equal(input.p_items.length, rows.length, "must not append the public Samsonite supplement");
      assert.deepEqual(input.p_expected_versions, Object.fromEntries(rows.map(row => [row.id, row.copy_updated_at])));
      rpcCalls.push(structuredClone(input));
      for (const row of input.p_items) Object.assign(rows.find(current => current.id === row.id), row);
      return { data: rows.map(row => ({ id: row.id })), error: null };
    },
  };
  return {
    rows, angles, settings, before, rpcCalls,
    read: createReader({ createSupabaseServerClient: () => db, applyReviewedCopy }),
    save: createSaver({ ...descriptionHelpers, createSupabaseServiceRoleClient: () => db, adminCarouselPayloadSchema }),
  };
}

test("authenticated catalog reads preserve raw copy and all editable metadata; public repair stays public", async () => {
  const f = fixture();
  const admin = await f.read({ includeInactive: true, rawAdmin: true });
  assert.equal(admin.items.length, 25);
  for (const [index, item] of admin.items.entries()) {
    const original = f.before.rows[index];
    assert.equal(item.title, original.title);
    assert.equal(item.description, original.description);
    assert.equal(item.descriptionHtml, original.description_html);
    for (const [api, stored] of Object.entries({ color: "color", dimensions: "dimensions", weight: "weight", sizes: "sizes", availableColors: "available_colors", colors: "colors", techSpecs: "tech_specs" })) {
      assert.deepEqual(item[api], original[stored], `${item.catalogNumber}: ${api}`);
    }
  }
  const publicPayload = await f.read();
  assert.equal(publicPayload.items.length, 24);
  assert.ok(publicPayload.items.some(item => item.title !== f.before.rows.find(row => row.id === item.id).title));
  assert.ok(publicPayload.items.every(item => !Object.hasOwn(item, "descriptionHtml")));
  assert.deepEqual(f.rows, f.before.rows, "reads must not persist display repairs");
});

test("production public wrapper retains reviewed copy, strips HTML and never revives a hidden supplement SKU", async () => {
  const f = fixture();
  const hidden = { ...structuredClone(f.rows[0]), id: uuid(999),
    catalog_number: samsonite.records[0].sku, is_active: false };
  f.rows.push(hidden);
  const calls = [];
  const readPublic = createPublicReader({
    appendSamsoniteItems,
    getCarouselPayload: options => { calls.push(options); return f.read(options); },
  });
  const payload = await readPublic();
  assert.deepEqual(calls, [{ includeInactive: true }], "exercise the actual production wrapper options");
  assert.ok(payload.items.every(item => item.isActive && !Object.hasOwn(item, "descriptionHtml")));
  assert.ok(!payload.items.some(item => item.catalogNumber === hidden.catalog_number), "inactive rows must block supplement reintroduction");
  assert.ok(payload.items.some(item => item.id.startsWith("shopify-")), "retain the public supplement");
  for (const original of f.before.rows.filter(row => row.is_active)) {
    const actual = payload.items.find(item => item.id === original.id);
    const reviewed = repairs[original.catalog_number];
    assert.equal(actual.title, reviewed.title, `${original.catalog_number}: reviewed public title`);
    assert.equal(actual.description, original.description_html === null ? reviewed.description : original.description,
      `${original.catalog_number}: reviewed plain copy or preserved rich pair`);
    assert.deepEqual(actual.techSpecs.specs, [{ heading: "פרטי מוצר", items: reviewed.specs }],
      `${original.catalog_number}: reviewed public specifications`);
  }
  assert.deepEqual(f.rows, [...f.before.rows, hidden], "public reads must not persist repairs");
});

test("full admin GET to PUT of one canary SEO edit leaves every other row, field, angle and setting unchanged", async () => {
  const f = fixture();
  const payload = await f.read({ includeInactive: true, rawAdmin: true });
  const target = payload.items.find(item => item.catalogNumber === "BAH08453.001");
  assert.ok(target);
  target.seoTitle = "Manufacturer-verified 75 cm";
  await f.save(payload);
  assert.equal(f.rpcCalls.length, 1);
  for (const row of f.rows) {
    const original = f.before.rows.find(item => item.id === row.id);
    if (row.id === target.id) {
      assert.equal(row.seo_title, target.seoTitle);
      assert.notEqual(row.copy_updated_at, stamp);
      assert.deepEqual({ ...row, seo_title: original.seo_title, copy_updated_at: original.copy_updated_at }, original);
    } else assert.deepEqual(row, original, `unrelated SKU ${row.catalog_number} must survive byte-for-byte`);
  }
  assert.deepEqual(f.angles, f.before.angles);
  assert.deepEqual(f.settings, f.before.settings);
});
