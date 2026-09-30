import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { descriptionModuleUrl } from "./helpers/description-module.mjs";

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
const vendorUrl = moduleUrl(readFileSync("src/lib/catalog-source/vendor-detect.ts", "utf8"));
const rulesUrl = moduleUrl(readFileSync("src/lib/shopify/sync-rules.ts", "utf8")
  .replace('"@/lib/catalog-source/vendor-detect"', JSON.stringify(vendorUrl)));
const validatorSource = readFileSync("src/lib/shopify/catalog-copy-activation.ts", "utf8")
  .replace('"./description-document"', JSON.stringify(descriptionModuleUrl))
  .replace('"./sync-rules"', JSON.stringify(rulesUrl));
const stamp = "2026-09-30T10:00:00.000Z";
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function manifestFixture() {
  const rows = Array.from({ length: 78 }, (_, index) => {
    const gallerySku = index === 0 ? "P10SZV24-05J-TU" : `SKU${index + 100}`;
    const shopifySku = index === 0 ? "P10SZV2405J" : gallerySku;
    const catalogKey = shopifySku, galleryItemId = uuid(index + 1);
    const productGid = `gid://shopify/Product/${index + 1000}`;
    const variantGid = `gid://shopify/ProductVariant/${index + 2000}`;
    const handle = index === 0 ? "logoduck-טרולי" : `reviewed-${index}`;
    const galleryCopy = { title: `Gallery ${index}`, description: `תיאור ${index}`,
      descriptionHtml: index < 20 ? null : `<p>תיאור ${index}</p>`, seoTitle: null, seoDescription: null };
    const shopifyCopy = { title: `Shopify ${index}`, description: `Shop ${index}`,
      descriptionHtml: `<p>Shop ${index}</p>`, seoTitle: `SEO ${index}`, seoDescription: "Store SEO" };
    const binding = { catalog_key: catalogKey, carousel_item_id: galleryItemId, product_gid: productGid,
      variant_gid: variantGid, product_handle: handle, is_published: true, source_updated_at: stamp };
    const link = { catalog_key: catalogKey, product_handle: handle, variant_id: String(index + 2000), is_published: true };
    const baseline = { catalog_key: catalogKey, last_synced_payload: shopifyCopy,
      gallery_baseline_payload: galleryCopy, shopify_baseline_payload: shopifyCopy };
    return { catalogKey, galleryItemId, gallerySku, shopifySku,
      eligibility: { catalog_key: catalogKey, carousel_item_id: galleryItemId, product_gid: productGid,
        variant_gid: variantGid, exact_gallery_sku: gallerySku, exact_shopify_sku: shopifySku,
        approved_product_handle: handle, approved_source_updated_at: stamp,
        allowed_fields: ["title", "description", "seoTitle", "seoDescription"],
        alias_evidence: { exactGallerySku: gallerySku, exactShopifySku: shopifySku, verifiedVariantGid: variantGid } },
      galleryCopy, galleryCopyUpdatedAt: stamp,
      shopifySnapshot: { id: productGid, handle, title: shopifyCopy.title, descriptionHtml: shopifyCopy.descriptionHtml,
        seoTitle: shopifyCopy.seoTitle, seoDescription: shopifyCopy.seoDescription,
        status: "ACTIVE", updatedAt: stamp, publishedOnPublication: true, variants: [{ id: variantGid, sku: shopifySku }] },
      expectedBinding: index < 20 ? null : binding, expectedState: index < 20 ? null : baseline,
      expectedPublicLink: index < 20 ? null : link,
      ...(index < 20 ? { proposedBinding: binding, proposedPublicLink: link, proposedBaseline: baseline } : {}),
    };
  });
  return { rows, expectedGallery: [
    ...rows.map(row => ({ id: row.galleryItemId, catalog_number: row.gallerySku, copy_updated_at: stamp, copy: row.galleryCopy })),
    ...Array.from({ length: 4 }, (_, index) => ({ id: uuid(1000 + index), catalog_number: `EXCLUDED${index}`,
      copy_updated_at: stamp, copy: { title: "Excluded", description: "Retained", descriptionHtml: null, seoTitle: null, seoDescription: null } })),
  ], counts: { selectedRows: 78, readyRows: 78, blockedRows: 0, missingBaselineInserts: 20, existingBaselineVerificationOnly: 58 } };
}

async function approvedFixture(manifest = manifestFixture()) {
  const raw = Buffer.from(JSON.stringify(manifest));
  const sha = createHash("sha256").update(raw).digest("hex");
  const source = validatorSource.replace(/COPY_ACTIVATION_MANIFEST_SHA256 = "[a-f0-9]+"/, `COPY_ACTIVATION_MANIFEST_SHA256 = "${sha}"`);
  return { manifest, raw, api: await import(moduleUrl(source)) };
}

test("copy activation validates all78 and preserves20 independent null-rich baselines without filling", async () => {
  const f = await approvedFixture();
  const before = structuredClone(f.manifest);
  const parsed = f.api.parseReviewedCopyActivation(f.raw);
  assert.deepEqual(parsed, before);
  const newRows = parsed.rows.filter(row => row.expectedBinding === null);
  assert.equal(newRows.length, 20);
  for (const row of newRows) {
    assert.equal(row.galleryCopy.descriptionHtml, null);
    assert.equal(row.proposedBaseline.gallery_baseline_payload.descriptionHtml, null);
    assert.equal(row.proposedBaseline.gallery_baseline_payload.seoTitle, null);
    assert.notEqual(row.galleryCopy.description, row.proposedBaseline.shopify_baseline_payload.description);
  }
  assert.equal(parsed.rows[0].gallerySku, "P10SZV24-05J-TU");
  assert.equal(parsed.rows[0].shopifySku, "P10SZV2405J");
});

test("raw artifact hash rejects changed bytes even when parsed JSON is unchanged", async () => {
  const f = await approvedFixture();
  assert.throws(() => f.api.parseReviewedCopyActivation(Buffer.concat([f.raw, Buffer.from(" ")])), /NOT_APPROVED/);
  const production = await import(moduleUrl(validatorSource));
  assert.equal(production.COPY_ACTIVATION_MANIFEST_SHA256, "73dc8b7b0946266ab647c214126f9e23619f674188989e24fe0811a6200bae10");
  assert.throws(() => production.parseReviewedCopyActivation(f.raw), /NOT_APPROVED/);
});

test("approved schema still rejects changed count, duplicate identity, copy/version drift, unsafe handle and missing alias proof", async () => {
  for (const mutate of [
    m => { m.rows.pop(); },
    m => { m.expectedGallery[1].id = m.expectedGallery[0].id; },
    m => { m.expectedGallery[1].catalog_number = m.expectedGallery[0].catalog_number; },
    m => { m.rows[1].eligibility.product_gid = m.rows[0].eligibility.product_gid; },
    m => { m.rows[0].galleryCopy = { ...m.rows[0].galleryCopy, title: "Changed" }; },
    m => { m.rows[0].galleryCopyUpdatedAt = "2026-09-30T11:00:00Z"; },
    m => { m.rows[0].eligibility.alias_evidence = {}; },
    m => { m.rows[0].eligibility.allowed_fields = ["title", "description", "price", "seoDescription"]; },
    m => { m.rows[0].shopifySnapshot.handle = m.rows[0].eligibility.approved_product_handle = "../other"; },
    m => { delete m.rows[0].proposedBaseline; },
    m => { m.rows[20].proposedBinding = { prohibited: true }; },
    m => { m.rows[0].galleryCopy.descriptionHtml = "<p>Different text</p>"; },
  ]) {
    const fixture = manifestFixture(); mutate(fixture);
    const f = await approvedFixture(fixture);
    assert.throws(() => f.api.parseReviewedCopyActivation(f.raw));
  }
});

test("bounded reader rejects missing, invalid declared, declared-large and streamed-large bodies", async () => {
  const { api, raw } = await approvedFixture();
  const request = (body, headers) => new Request("https://example.test/activation", { method: "POST", body, headers });
  assert.deepEqual(Buffer.from(await api.readCopyActivationBody(request(raw))), raw);
  await assert.rejects(() => api.readCopyActivationBody(request(undefined)), /BODY_MISSING/);
  for (const length of ["-1", "no", "2000001"]) {
    await assert.rejects(() => api.readCopyActivationBody(request("{}", { "content-length": length })), /BODY_TOO_LARGE/);
  }
  await assert.rejects(() => api.readCopyActivationBody(request(new Uint8Array(2_000_001))), /BODY_TOO_LARGE/);
});

test("fresh Shopify proof uses exact alias identity and refuses product, variant, publication and copy drift", async () => {
  const { api, manifest } = await approvedFixture(); const row = manifest.rows[0];
  assert.doesNotThrow(() => api.assertCopyActivationProduct(row, structuredClone(row.shopifySnapshot)));
  assert.throws(() => api.assertCopyActivationProduct(row, null), /SHOPIFY_CHANGED/);
  for (const mutate of [
    p => { p.id += "9"; }, p => { p.handle += "-changed"; },
    p => { p.variants[0].id += "9"; }, p => { p.variants[0].sku = row.gallerySku; },
    p => { p.variants.push({ ...p.variants[0] }); }, p => { p.status = "DRAFT"; },
    p => { p.publishedOnPublication = false; }, p => { p.updatedAt = "2026-10-01T00:00:00Z"; },
    p => { p.title += "changed"; }, p => { p.descriptionHtml += " "; },
    p => { p.seoTitle = null; }, p => { p.seoDescription += "changed"; },
  ]) {
    const changed = structuredClone(row.shopifySnapshot); mutate(changed);
    assert.throws(() => api.assertCopyActivationProduct(row, changed), /SHOPIFY_CHANGED/);
  }
});

test("fresh78 reads run with at most four concurrent requests and stop subsequent batches on drift", async () => {
  const { api, manifest } = await approvedFixture();
  const products = new Map(manifest.rows.map(row => [row.shopifySnapshot.id, row.shopifySnapshot]));
  let active = 0, highest = 0; const visited = [];
  await api.revalidateCopyActivation(manifest, async id => {
    active++; highest = Math.max(highest, active); visited.push(id);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return structuredClone(products.get(id));
  });
  assert.equal(highest, 4); assert.equal(visited.length, 78); assert.equal(new Set(visited).size, 78);
  let calls = 0;
  await assert.rejects(() => api.revalidateCopyActivation(manifest, async () => { calls++; return null; }), /SHOPIFY_CHANGED/);
  assert.equal(calls, 4);
});

test("fresh-read deadline prevents further work when the bounded window expires", async t => {
  const { api, manifest } = await approvedFixture(); let now = 0, calls = 0;
  t.mock.method(Date, "now", () => now);
  await assert.rejects(() => api.revalidateCopyActivation(manifest, async id => {
    calls++; now = 40_001;
    return manifest.rows.find(row => row.shopifySnapshot.id === id).shopifySnapshot;
  }), /REVALIDATION_TIMEOUT/);
  assert.equal(calls, 4);
});

const routeSource = readFileSync("src/app/api/admin/shopify/catalog-copy-activation/route.ts", "utf8");
const routeBody = routeSource.slice(routeSource.indexOf("export async function POST")).replace(/^export /gm, "");
const { createRoute } = await import(moduleUrl(`export function createRoute(deps) {
  const { requireAdminToken, createSupabaseServiceRoleClient, hasSupabaseAdminEnv, configuredShopifyDomain,
    fetchProductSnapshot, isShopifySyncConfigured, COPY_ACTIVATION_MANIFEST_SHA256,
    parseReviewedCopyActivation, readCopyActivationBody, revalidateCopyActivation } = deps;
  const NextResponse = { json: (value, init) => Response.json(value, init) };
  ${routeBody}
  return POST;
}`));
function request(raw, search = "") {
  const url = new URL("https://example.test/activation" + search);
  const req = new Request(url, { method: "POST", body: raw });
  Object.defineProperty(req, "nextUrl", { value: url });
  return req;
}
async function routeFixture(options = {}) {
  const f = await approvedFixture(), reads = [], rpcs = [];
  const route = createRoute({ ...f.api,
    requireAdminToken: () => options.denied ? Response.json({}, { status: 401 }) : null,
    hasSupabaseAdminEnv: () => options.configured !== false, isShopifySyncConfigured: () => true,
    configuredShopifyDomain: () => options.shop ?? "toptikcoil.myshopify.com",
    fetchProductSnapshot: async id => { reads.push(id); return options.drift ? null : f.manifest.rows.find(row => row.shopifySnapshot.id === id).shopifySnapshot; },
    createSupabaseServiceRoleClient: () => ({ async rpc(name, args) { rpcs.push({ name, args }); return { data: {}, error: options.rpcError ?? null }; } }),
  });
  return { ...f, route, reads, rpcs };
}

test("activation endpoint defaults disabled and enables only explicit enable=1 after all fresh reads", async () => {
  for (const [search, enabled] of [["", false], ["?enable=0", false], ["?enable=1", true]]) {
    const f = await routeFixture(); const response = await f.route(request(f.raw, search));
    assert.equal(response.status, 200); assert.equal(f.reads.length, 78); assert.equal(f.rpcs.length, 1);
    assert.deepEqual(f.rpcs[0], { name: "activate_shopify_verified_catalog", args: { p_manifest: f.manifest, p_enable: enabled } });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.doesNotMatch(routeSource, /writeShopify|scheduleShopifySync|\.from\(|productUpdate|content_outbox/);
});

test("endpoint blocks anonymous, wrong configuration, implicit enable and changed body before reads or SQL", async () => {
  for (const [options, search, altered, expected] of [
    [{ denied: true }, "?enable=1", false, 401], [{ configured: false }, "", false, 503],
    [{ shop: "other.myshopify.com" }, "", false, 409], [{}, "?enable=true", false, 409],
    [{}, "?enable=", false, 409], [{}, "", true, 409],
  ]) {
    const f = await routeFixture(options);
    const response = await f.route(request(altered ? Buffer.concat([f.raw, Buffer.from(" ")]) : f.raw, search));
    assert.equal(response.status, expected); assert.equal(f.reads.length, 0); assert.equal(f.rpcs.length, 0);
  }
});

test("endpoint never activates after Shopify drift and redacts provider error details", async () => {
  const drift = await routeFixture({ drift: true });
  assert.equal((await drift.route(request(drift.raw, "?enable=1"))).status, 409);
  assert.equal(drift.rpcs.length, 0);
  const failure = await routeFixture({ rpcError: { message: "private provider details and credentials" } });
  const response = await failure.route(request(failure.raw));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "COPY_ACTIVATION_TRANSACTION_FAILED" });
});
