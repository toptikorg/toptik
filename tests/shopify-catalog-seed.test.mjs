import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { descriptionModuleUrl } from "./helpers/description-module.mjs";

const moduleFrom = source => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const schemaSource = readFileSync("src/lib/validation/carousel.ts", "utf8").replace('"zod"', JSON.stringify(import.meta.resolve("zod")));
const schemaUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(schemaSource)).toString("base64")}`;
const validatorSource = readFileSync("src/lib/shopify/catalog-seed.ts", "utf8")
  .replace('"@/lib/validation/carousel"', JSON.stringify(schemaUrl))
  .replace('"./description-document"', JSON.stringify(descriptionModuleUrl));
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-09-30T10:00:00Z";

function manifestFixture() {
  const rows = Array.from({ length: 57 }, (_, index) => {
    const sku = `SKU${index + 100}`, itemId = uuid(index + 1);
    const productGid = `gid://shopify/Product/${index + 100}`, variantGid = `gid://shopify/ProductVariant/${index + 100}`;
    const handle = `reviewed-${index}`, html = '<p>Reviewed <strong>product</strong></p>';
    const copy = { title: `Reviewed ${index}`, description: "Reviewed product", descriptionHtml: html, seoTitle: "SEO", seoDescription: "SEO description" };
    const media = Array.from({ length: index < 13 ? 7 : 6 }, (_, offset) => ({
      id: `gid://shopify/MediaImage/${index * 10 + offset}`, alt: "Image", mediaContentType: "IMAGE", status: "READY",
      image: { url: `https://cdn.shopify.com/p/${index}/${offset}.jpg`, altText: "Image", width: 1000, height: 1500 },
    }));
    return { sku, catalogKey: sku, persistedItemId: itemId,
      proposedItemInsert: { id: itemId, title: copy.title, description: copy.description, description_html: html,
        seo_title: copy.seoTitle, seo_description: copy.seoDescription, copy_updated_at: stamp, catalog_number: sku,
        source_url: `https://www.samsonite.com/${handle}`, cover_image_path: media[0].image.url, display_order: index + 26,
        is_active: true, color: null, dimensions: null, weight: null, sizes: null, available_colors: null,
        tech_specs: { specs: [], colors: [], category: "carryon" }, colors: [] },
      proposedAngleInserts: media.map((entry, offset) => ({ id: uuid(1000 + index * 10 + offset), item_id: itemId,
        angle_key: `angle-${offset + 1}`, image_path: entry.image.url, angle_order: offset + 1 })),
      proposedBinding: { catalog_key: sku, carousel_item_id: itemId, product_gid: productGid, variant_gid: variantGid,
        product_handle: handle, is_published: true, source_updated_at: stamp },
      proposedPublicLink: { catalog_key: sku, product_handle: handle, variant_id: String(index + 100), is_published: true },
      proposedBaseline: { catalog_key: sku, gallery_baseline_payload: { ...copy }, shopify_baseline_payload: { ...copy }, last_synced_payload: { ...copy } },
      shopifySnapshot: { productGid, variantGid, handle, title: copy.title, sourceUpdatedAt: stamp, status: "ACTIVE",
        publishedOnOnlineStore: true, rawDescriptionHtml: html, seo: { title: copy.seoTitle, description: copy.seoDescription }, media },
    };
  });
  return { rows, expectedExistingItems: Array.from({ length: 25 }, (_, i) => ({ id: uuid(10000 + i), catalog_number: `OLD${i}` })),
    counts: { proposedItemRows: 57, proposedAngleRows: 355, blockingRows: 0 }, errors: [] };
}

async function approvedFixture(manifest = manifestFixture()) {
  const raw = Buffer.from(JSON.stringify(manifest));
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = validatorSource.replace(/CATALOG_SEED_MANIFEST_SHA256 = "[a-f0-9]+"/, `CATALOG_SEED_MANIFEST_SHA256 = "${hash}"`);
  return { raw, manifest, api: await moduleFrom(source) };
}
function freshProduct(row) {
  const s = row.shopifySnapshot;
  return { id: s.productGid, handle: s.handle, title: s.title, descriptionHtml: s.rawDescriptionHtml,
    seoTitle: s.seo.title, seoDescription: s.seo.description, status: s.status, updatedAt: s.sourceUpdatedAt,
    publishedOnPublication: s.publishedOnOnlineStore, variants: [{ id: s.variantGid, sku: row.sku }], media: structuredClone(s.media) };
}

test("reviewed seed accepts 57 schema-valid paired items and rejects any unapproved bytes", async () => {
  const f = await approvedFixture();
  assert.deepEqual(f.api.parseReviewedCatalogSeed(f.raw), f.manifest);
  assert.throws(() => f.api.parseReviewedCatalogSeed(Buffer.concat([f.raw, Buffer.from(" ")])), /MANIFEST_NOT_APPROVED/);
  const production = await moduleFrom(validatorSource);
  assert.equal(production.CATALOG_SEED_MANIFEST_SHA256, "20fe79f0ce7af46ccc923b5ad1d99cd5dd58e814bd5cc54cfbe4f3cf21d56cf0");
  assert.throws(() => production.parseReviewedCatalogSeed(f.raw), /MANIFEST_NOT_APPROVED/);
});

test("seed validation rejects zero-based angles, unsafe HTML and inconsistent raw baseline pairs", async () => {
  for (const mutate of [
    m => { m.rows[0].proposedAngleInserts[0].angle_order = 0; },
    m => { m.rows[0].proposedItemInsert.description_html = '<script>alert(1)</script>'; },
    m => { m.rows[0].proposedBaseline.gallery_baseline_payload.description = "Unrelated description"; },
    m => { m.rows[0].proposedBinding.variant_gid = "gid://shopify/ProductVariant/999"; },
    m => { m.rows[1].persistedItemId = m.rows[0].persistedItemId; },
  ]) {
    const manifest = manifestFixture(); mutate(manifest);
    const f = await approvedFixture(manifest);
    assert.throws(() => f.api.parseReviewedCatalogSeed(f.raw));
  }
});

test("body limit rejects declared and streamed oversize before parsing", async () => {
  const { api, raw } = await approvedFixture();
  const request = body => new Request("https://example.test/seed", { method: "POST", body });
  assert.deepEqual(Buffer.from(await api.readCatalogSeedBody(request(raw))), raw);
  await assert.rejects(() => api.readCatalogSeedBody(new Request("https://example.test/seed", { method: "POST", body: "{}", headers: { "content-length": "2000001" } })), /BODY_TOO_LARGE/);
  await assert.rejects(() => api.readCatalogSeedBody(request(new Uint8Array(2_000_001))), /BODY_TOO_LARGE/);
});

test("fresh product proof rejects exact identity, version, publication, HTML, SEO and media drift", async () => {
  const { api, manifest } = await approvedFixture(); const row = manifest.rows[0];
  assert.doesNotThrow(() => api.assertCatalogSeedProduct(row, freshProduct(row)));
  for (const mutate of [
    p => { p.variants[0].sku = row.sku + "-TU"; },
    p => { p.variants.push({ ...p.variants[0] }); },
    p => { p.updatedAt = "2026-09-30T11:00:00Z"; },
    p => { p.publishedOnPublication = false; },
    p => { p.status = "DRAFT"; },
    p => { p.descriptionHtml += " "; },
    p => { p.seoTitle += " change"; },
    p => { p.media[0].image.url += "?v=new"; },
    p => { p.media[0].status = "PROCESSING"; },
  ]) {
    const changed = freshProduct(row); mutate(changed);
    assert.throws(() => api.assertCatalogSeedProduct(row, changed), /SNAPSHOT_CHANGED/);
  }
});

test("fresh validation reads every approved product with at most four calls in flight", async () => {
  const { api, manifest } = await approvedFixture();
  let active = 0, highest = 0; const visited = [];
  await api.revalidateCatalogSeedProducts(manifest, async id => {
    active++; highest = Math.max(highest, active); visited.push(id);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return freshProduct(manifest.rows.find(row => row.shopifySnapshot.productGid === id));
  });
  assert.equal(highest, 4); assert.equal(new Set(visited).size, 57);
});

test("fresh validation aborts before remaining batches after a changed product", async () => {
  const { api, manifest } = await approvedFixture(); let calls = 0;
  await assert.rejects(() => api.revalidateCatalogSeedProducts(manifest, async () => { calls++; return null; }), /SNAPSHOT_CHANGED/);
  assert.equal(calls, 4);
});

const routeSource = readFileSync("src/app/api/admin/shopify/catalog-seed/route.ts", "utf8");
const routeBody = routeSource.slice(routeSource.indexOf("export async function POST")).replace(/^export /gm, "");
const { createRoute } = await moduleFrom(`export function createRoute(deps) {
  const { requireAdminToken, createSupabaseServiceRoleClient, hasSupabaseAdminEnv, configuredShopifyDomain,
    fetchCatalogSeedProductSnapshot, isShopifySyncConfigured, CATALOG_SEED_MANIFEST_SHA256,
    parseReviewedCatalogSeed, readCatalogSeedBody, revalidateCatalogSeedProducts } = deps;
  const NextResponse = { json: (value, init) => Response.json(value, init) };
  ${routeBody}
  return POST;
}`);

test("authenticated endpoint commits only the pinned RPC after fresh validation", async () => {
  const { api, manifest, raw } = await approvedFixture(); const calls = [];
  const route = createRoute({ ...api, requireAdminToken: () => null, hasSupabaseAdminEnv: () => true,
    isShopifySyncConfigured: () => true, configuredShopifyDomain: () => "toptikcoil.myshopify.com",
    fetchCatalogSeedProductSnapshot: async id => freshProduct(manifest.rows.find(row => row.shopifySnapshot.productGid === id)),
    createSupabaseServiceRoleClient: () => ({ async rpc(name, args) { calls.push({ name, args }); return { data: { inserted_items: 57 }, error: null }; } }),
  });
  const response = await route(new Request("https://example.test/seed", { method: "POST", body: raw }));
  assert.equal(response.status, 200); assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "seed_samsonite_gallery_baselines");
  assert.deepEqual(calls[0].args, { p_manifest: manifest });
  assert.doesNotMatch(routeSource, /scheduleShopifySync|writeShopify|\.from\(/);
});

test("endpoint denies anonymous and altered manifests without Shopify reads or RPC", async () => {
  const { api, raw } = await approvedFixture();
  for (const anonymous of [true, false]) {
    const route = createRoute({ ...api, requireAdminToken: () => anonymous ? Response.json({}, { status: 401 }) : null,
      hasSupabaseAdminEnv: () => true, isShopifySyncConfigured: () => true, configuredShopifyDomain: () => "toptikcoil.myshopify.com",
      fetchCatalogSeedProductSnapshot: () => assert.fail("no Shopify read allowed"),
      createSupabaseServiceRoleClient: () => assert.fail("no SQL allowed"),
    });
    const response = await route(new Request("https://example.test/seed", { method: "POST", body: Buffer.concat([raw, Buffer.from(" ")]) }));
    assert.equal(response.status, anonymous ? 401 : 409);
  }
});

test("dedicated Shopify seed reader uses only bounded query and fails on pagination", async () => {
  const source = readFileSync("src/lib/shopify/admin-api.ts", "utf8");
  const body = source.slice(source.indexOf("export async function fetchCatalogSeedProductSnapshot"), source.indexOf("/** One-time, bounded scan"))
    .replace(/^export /gm, "");
  const { createReader } = await moduleFrom(`export function createReader(graphql) {
    const getConfig = () => ({publicationId:'gid://shopify/Publication/79538258170'});
    ${body}
    return fetchCatalogSeedProductSnapshot;
  }`);
  let queryRead;
  const read = createReader(async query => { queryRead = query; return { product: null }; });
  assert.equal(await read("gid://shopify/Product/1"), null);
  assert.match(queryRead, /query GalleryReviewedSeedProduct/); assert.doesNotMatch(queryRead, /mutation/);
  assert.match(queryRead, /variants\(first: 2\)/); assert.match(queryRead, /media\(first: 50\)/);
  await assert.rejects(() => read("not-a-product"), /PRODUCT_ID_INVALID/);
  const paginated = createReader(async () => ({ product: { variants: { pageInfo: { hasNextPage: true } }, media: { pageInfo: { hasNextPage: false } } } }));
  await assert.rejects(() => paginated("gid://shopify/Product/1"), /SNAPSHOT_LIMIT/);
});
