import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { z } from "zod";
import { descriptionHelpers } from "./helpers/description-module.mjs";

const source = readFileSync("src/app/api/admin/shopify/copy/route.ts", "utf8");
const body = source.slice(source.indexOf("const patchSchema")).replace(/^export /gm, "");
const wrapped = `export function createHandler(deps) {
  const { z, requireAdminToken, createSupabaseServiceRoleClient, fetchProductSnapshot,
    scheduleShopifySync, assertSafeDescriptionHtml, descriptionTextFromHtml, plainDescriptionToHtml } = deps;
  const NextResponse = { json: (value, init) => Response.json(value, init) };
  const hasSupabaseAdminEnv = () => true;
  const isShopifySyncConfigured = () => true;
  const configuredSyncCanarySku = () => 'BAH08453001';
  const normalizeSyncSku = value => value.replace(/[^A-Z0-9]/g, '');
  ${body}
  return PATCH;
}`;
const { createHandler } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(wrapped)).toString("base64")}`);
const id = "11111111-1111-4111-8111-111111111111";
const productId = "gid://shopify/Product/123";
const variantId = "gid://shopify/ProductVariant/456";
const stamp = "2026-09-30T10:00:00.000Z";
const raw = '<p>Bag <a href="/bags">details</a></p><table><tr><td>75 cm</td></tr></table>';
const stored = { id, catalog_number: "BAH08453.001", title: "Original", description: descriptionHelpers.descriptionTextFromHtml(raw),
  description_html: raw, seo_title: "Old SEO", seo_description: "Old description", copy_updated_at: stamp };

function fixture(options = {}) {
  const calls = [];
  let scheduled = 0;
  const binding = { catalog_key: "BAH08453001", carousel_item_id: id, product_gid: productId, variant_gid: variantId };
  const db = {
    from(table) {
      assert.ok(["carousel_items", "shopify_gallery_bindings"].includes(table));
      const query = {
        select() { return query; }, eq() { return query; },
        maybeSingle() { return Promise.resolve({ data: options.item ?? stored, error: null }); },
        then(resolve) { return Promise.resolve({ data: options.bindings ?? [binding], error: null }).then(resolve); },
      };
      return query;
    },
    async rpc(name, args) { calls.push({ name, args }); return { data: { changed: true, copyUpdatedAt: stamp }, error: options.rpcError ?? null }; },
  };
  const handle = createHandler({ z, ...descriptionHelpers,
    requireAdminToken: () => options.denied ? Response.json({ error: "Unauthorized" }, { status: 401 }) : null,
    createSupabaseServiceRoleClient: () => db,
    fetchProductSnapshot: async () => options.product ?? { id: productId, variants: [{ id: variantId, sku: "BAH08453.001" }] },
    scheduleShopifySync: () => { scheduled++; },
  });
  return { calls, scheduled: () => scheduled,
    async send(patch, changes = {}) {
      const request = new Request("https://example.com/api/admin/shopify/copy", { method: "PATCH", body: JSON.stringify({
        itemId: id, productId, sku: "BAH08453.001", copyUpdatedAt: stamp, patch, ...changes,
      }) });
      const response = await handle(request);
      return { status: response.status, body: await response.json() };
    },
  };
}

test("authenticated canary patch calls only atomic copy RPC and preserves untouched rich HTML", async () => {
  const f = fixture();
  assert.equal((await f.send({ seoTitle: "Corrected SEO" })).status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].name, "patch_shopify_canary_copy");
  assert.deepEqual(f.calls[0].args.p_copy, { title: stored.title, description: stored.description, descriptionHtml: raw,
    seoTitle: "Corrected SEO", seoDescription: stored.seo_description });
  assert.equal(f.calls[0].args.p_expected_version, stamp);
  assert.equal(f.scheduled(), 1);
  assert.doesNotMatch(source, /saveCarouselPayload|carousel_settings|carousel_item_angles/);
});

test("copy patch rejects anonymous, commerce keys, outside canary and stale versions before queueing", async () => {
  for (const [options, patch, changes, expected] of [
    [{ denied: true }, { seoTitle: "New" }, {}, 401],
    [{}, { price: "1" }, {}, 400],
    [{}, { seoTitle: "New" }, { sku: "OTHER" }, 409],
    [{}, { seoTitle: "New" }, { copyUpdatedAt: "2026-09-29T10:00:00.000Z" }, 409],
  ]) {
    const f = fixture(options);
    assert.equal((await f.send(patch, changes)).status, expected);
    assert.equal(f.calls.length, 0);
    assert.equal(f.scheduled(), 0);
  }
});

test("copy patch requires one binding and the exact single Shopify variant", async () => {
  for (const options of [
    { bindings: [] },
    { product: { id: productId, variants: [{ id: variantId, sku: "BAH08453.001" }, { id: "other", sku: "other" }] } },
    { product: { id: productId, variants: [{ id: "changed", sku: "BAH08453.001" }] } },
    { product: { id: productId, variants: [{ id: variantId, sku: "BAH08453.006" }] } },
  ]) {
    const f = fixture(options);
    assert.equal((await f.send({ title: "New" })).status, 409);
    assert.equal(f.calls.length, 0);
  }
});

test("copy patch preserves a complete rich pair and rejects unsafe or plain-only destructive edits", async () => {
  const edited = raw.replace('/bags', '/verified-bags');
  const f = fixture();
  assert.equal((await f.send({ descriptionHtml: edited })).status, 200);
  assert.equal(f.calls[0].args.p_copy.descriptionHtml, edited);
  assert.equal(f.calls[0].args.p_copy.description, stored.description);
  for (const patch of [{ description: "Flattened" }, { descriptionHtml: '<script>bad</script>' }, { descriptionHtml: edited, description: "Mismatch" }]) {
    const rejected = fixture();
    assert.equal((await rejected.send(patch)).status, 400);
    assert.equal(rejected.calls.length, 0);
  }
});

test("RPC stale or lease failure does not schedule a worker", async () => {
  const f = fixture({ rpcError: { message: "SYNC_COPY_BUSY_RETRY" } });
  const response = await f.send({ seoDescription: "New" });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, "SYNC_COPY_BUSY_RETRY");
  assert.equal(f.scheduled(), 0);
});
