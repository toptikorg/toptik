import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { descriptionModuleUrl, descriptionHelpers } from "./helpers/description-module.mjs";

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const policyUrl = moduleUrl(stripTypeScriptTypes(readFileSync("src/lib/shopify/sync-policy.ts", "utf8")
  .replace('"./description-document"', JSON.stringify(descriptionModuleUrl))));
const vendorUrl = moduleUrl(stripTypeScriptTypes(readFileSync("src/lib/catalog-source/vendor-detect.ts", "utf8")));
const rulesUrl = moduleUrl(stripTypeScriptTypes(readFileSync("src/lib/shopify/sync-rules.ts", "utf8")
  .replace('"@/lib/catalog-source/vendor-detect"', JSON.stringify(vendorUrl))));
// Exercise the real queue processor with a database fake that enforces the
// checked-in table schema; Shopify/network dependencies are unused in this test.
const workerSource = stripTypeScriptTypes(readFileSync("src/lib/shopify/sync-worker.ts", "utf8"))
  .replace(/^import[\s\S]*?;\r?\n/gm, "");
const { processQueue, withProductReconciliationLease, reconcileOutboxRow, mergeAndPersist, setProduct, getWrites } = await import(moduleUrl(
  `import { createHash, randomUUID } from "node:crypto";
   import { isSyncReviewCode, mergeVisibleProductCopy, visibleCopiesEquivalent } from "${policyUrl}";
   import { normalizeSyncSku } from "${rulesUrl}";
   let product;
   let writes = 0;
   export function setProduct(value) { product = value; writes = 0; }
   export function getWrites() { return writes; }
   async function fetchProductSnapshot() { return Array.isArray(product) ? product.shift() : product; }
   function visibleCopyFromProduct(product) { return product.copy; }
   async function writeShopifyVisibleCopy() { writes++; }
   ${workerSource}
   export { processQueue, withProductReconciliationLease, reconcileOutboxRow, mergeAndPersist };`,
));
const migration = readFileSync("supabase/migrations/20260930_shopify_gallery_sync_inbox.sql", "utf8");

function columnNames(table) {
  const body = migration.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`))?.[1];
  assert.ok(body, `Missing checked-in schema for ${table}`);
  return new Set([...body.matchAll(/^\s{2}([a-z_]+)\s/gm)].map((match) => match[1]));
}

test("overlapping inbox/outbox reconciliation cannot write the same product concurrently", async () => {
  const leases = new Map();
  const database = {
    async rpc(name, input) {
      if (name === "acquire_shopify_reconciliation_lease") {
        if (leases.has(input.p_product_gid)) return { data: false, error: null };
        leases.set(input.p_product_gid, input.p_owner);
        return { data: true, error: null };
      }
      assert.equal(name, "release_shopify_reconciliation_lease");
      assert.equal(leases.get(input.p_product_gid), input.p_owner);
      leases.delete(input.p_product_gid);
      return { data: null, error: null };
    },
  };
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const first = withProductReconciliationLease(database, "product-1", async () => {
    markStarted();
    await new Promise((resolve) => { releaseFirst = resolve; });
    throw new Error("processing failed");
  });
  await started;
  let duplicateWrites = 0;
  await assert.rejects(withProductReconciliationLease(database, "product-1", async () => { duplicateWrites++; }), /SYNC_RECONCILIATION_BUSY/);
  assert.equal(duplicateWrites, 0);
  assert.equal(await withProductReconciliationLease(database, "product-2", async () => "other product"), "other product");
  releaseFirst();
  await assert.rejects(first, /processing failed/);
  assert.equal(leases.size, 0, "lease released even when reconciliation failed");
  assert.equal(await withProductReconciliationLease(database, "product-1", async () => "retry"), "retry");
});

test("single-SKU canary rejects product-level writes shared with another variant", async () => {
  setProduct({ variants: [{ id: "one", sku: "CANARY" }, { id: "two", sku: "OTHER" }] });
  const database = { from() { throw new Error("must not read or write after multi-variant rejection"); } };
  await assert.rejects(reconcileOutboxRow(database, { catalog_key: "CANARY" }, { product_gid: "product-1" }), /SYNC_CANARY_PRODUCT_HAS_MULTIPLE_VARIANTS/);
});

test("final Shopify reread rejects changed variant identity even if product copy is unchanged", async () => {
  const base = { title: "Original", description: "Description", seoTitle: null, seoDescription: null };
  const binding = { product_gid: "product-1", variant_gid: "variant-1", catalog_key: "CANARY", carousel_item_id: "item-1" };
  const initial = { id: "product-1", variants: [{ id: "variant-1", sku: "CANARY" }], copy: base, updatedAt: "2026-09-30T10:00:00Z" };
  const gallery = { id: "item-1", title: "Gallery edit", description: "Description", seo_title: null, seo_description: null, copy_updated_at: "2026-09-30T10:01:00Z" };
  const database = {
    from(table) {
      assert.equal(table, "shopify_gallery_sync_state");
      return { select() { return { eq() { return { async maybeSingle() { return { data: { last_synced_payload: base }, error: null }; } }; } }; } };
    },
  };
  for (const variants of [
    [{ id: "variant-2", sku: "CANARY" }],
    [{ id: "variant-1", sku: "OTHER" }],
    [{ id: "variant-1", sku: "CANARY" }, { id: "variant-2", sku: "OTHER" }],
  ]) {
    setProduct({ ...initial, variants });
    await assert.rejects(mergeAndPersist(database, binding, initial, gallery), /SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT/);
    assert.equal(getWrites(), 0);
  }
});

test("rich Shopify readback accepts equivalent serialization and baselines returned raw HTML", async () => {
  const makeCopy = html => ({ title: "Bag", description: descriptionHelpers.descriptionTextFromHtml(html), descriptionHtml: html, seoTitle: null, seoDescription: null });
  const baseline = makeCopy('<p><a href="/old" title="Info">Bag</a></p>');
  const galleryCopy = makeCopy('<p><a title="Info" href="/new">Bag</a></p>');
  const returnedCopy = makeCopy('<p><a href="/new" title="Info">Bag</a></p>');
  const binding = { product_gid: "product-1", variant_gid: "variant-1", catalog_key: "CANARY", carousel_item_id: "item-1" };
  const initial = { id: "product-1", variants: [{ id: "variant-1", sku: "CANARY" }], copy: baseline, updatedAt: "2026-09-30T10:00:00Z" };
  const gallery = { id: "item-1", catalog_number: "CANARY", title: galleryCopy.title, description: galleryCopy.description,
    description_html: galleryCopy.descriptionHtml, seo_title: null, seo_description: null, copy_updated_at: "2026-09-30T10:01:00Z" };
  let stateSaved;
  const database = {
    from(table) {
      if (table === "shopify_gallery_sync_state") return {
        select() { return { eq() { return { async maybeSingle() { return { data: { last_synced_payload: baseline }, error: null }; } }; } }; },
        async upsert(value) { stateSaved = value; return { error: null }; },
      };
      assert.equal(table, "carousel_items");
      return { select() { return { eq() { return { async maybeSingle() { return { data: gallery, error: null }; } }; } }; } };
    },
  };
  setProduct([initial, { ...initial, copy: returnedCopy, updatedAt: "2026-09-30T10:02:00Z" }]);
  await mergeAndPersist(database, binding, initial, gallery);
  assert.equal(getWrites(), 1);
  assert.equal(stateSaved.shopify_baseline_payload.descriptionHtml, returnedCopy.descriptionHtml);
  assert.equal(stateSaved.gallery_baseline_payload.descriptionHtml, galleryCopy.descriptionHtml);
});

for (const scenario of [
  { rpc: "claim_shopify_gallery_outbox", table: "shopify_gallery_content_outbox", code: "SYNC_BINDING_MISSING_OR_CONFLICTED", status: "review" },
  { rpc: "claim_shopify_gallery_outbox", table: "shopify_gallery_content_outbox", code: "SHOPIFY_API_HTTP_429", status: "failed" },
  { rpc: "claim_shopify_webhook_events", table: "shopify_webhook_events", code: "SYNC_CANARY_DELETE_DISABLED", status: "review" },
  { rpc: "claim_shopify_gallery_outbox", table: "shopify_gallery_content_outbox", code: "SYNC_RECONCILIATION_BUSY", status: "pending" },
]) {
  test(`${scenario.rpc} records ${scenario.status} and continues after a row failure`, async () => {
    const columns = columnNames(scenario.table);
    const writes = [];
    const visited = [];
    const database = {
      async rpc(name) {
        assert.equal(name, scenario.rpc);
        return { data: [{ id: "bad", attempts: 3 }, { id: "next", attempts: 1 }], error: null };
      },
      from(table) {
        assert.equal(table, scenario.table);
        return {
          update(patch) {
            return {
              async eq(key, id) {
                assert.equal(key, "id");
                const invalidColumn = Object.keys(patch).find((column) => !columns.has(column));
                if (invalidColumn) return { error: { message: `Column ${invalidColumn} does not exist` } };
                writes.push({ id, patch });
                return { error: null };
              },
            };
          },
        };
      },
    };
    const result = await processQueue(database, scenario.rpc, async (row) => {
      visited.push(row.id);
      if (row.id === "bad") throw new Error(scenario.code);
      return "synced";
    });
    assert.deepEqual(visited, ["bad", "next"]);
    assert.equal(result.processed, 1);
    assert.equal(result.reviewed, scenario.status === "review" ? 1 : 0);
    assert.equal(result.failed, scenario.status !== "review" ? 1 : 0);
    assert.equal(writes[0].id, "bad");
    assert.equal(writes[0].patch.status, scenario.status);
    assert.equal(writes[0].patch.last_error, scenario.code);
    if (scenario.status === "pending") {
      assert.equal(writes[0].patch.attempts, 2, "lock contention does not consume a failure attempt");
      assert.equal(writes[0].patch.claimed_at, null);
    }
    if (scenario.table === "shopify_gallery_content_outbox") {
      assert.equal(Object.hasOwn(writes[0].patch, "processed_at"), false);
    } else {
      assert.ok(Number.isFinite(Date.parse(writes[0].patch.processed_at)));
    }
  });
}
