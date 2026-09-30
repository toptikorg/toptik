import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync("src/app/api/admin/shopify/sync/route.ts", "utf8");
const body = source.slice(source.indexOf("export async function GET")).replace(/^export /gm, "");
const moduleSource = stripTypeScriptTypes(`export function makeGet(deps) {
  const { requireAdminToken, createSupabaseServiceRoleClient, hasSupabaseAdminEnv,
    configuredSyncCanarySku, shopifyProductGid, drainShopifySyncQueues, isShopifySyncConfigured } = deps;
  const NextResponse = { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) };
  ${body}
  return GET;
}`);
const { makeGet } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`);
const productId = "gid://shopify/Product/9375026544890";
const productGid = value => /^\d+$/.test(String(value)) ? `gid://shopify/Product/${value}`
  : /^gid:\/\/shopify\/Product\/\d+$/.test(String(value)) ? value : null;
const request = { nextUrl: new URL("https://example.com/api/admin/shopify/sync") };

function fixture({ denied = false, configured = true, bound = true, deliveryError = false } = {}) {
  const queries = [];
  let drains = 0;
  let clients = 0;
  const db = { from(table) {
    const query = { table, fields: null, filters: [], limit: null };
    queries.push(query);
    const builder = {
      select(fields) { query.fields = fields; return builder; },
      eq(key, value) { query.filters.push([key, value]); return builder; },
      in(key, values) { query.filters.push([key, values]); return builder; },
      order(key, options) { query.order = [key, options]; return builder; },
      limit(value) { query.limit = value; return builder; },
      async maybeSingle() { return { data: bound ? { product_gid: productId } : null, error: null }; },
      then(resolve) {
        const ledger = query.fields.includes("delivery_id");
        const data = ledger ? [{ id: "event-new", delivery_id: "delivery-new", topic: "products/update",
          received_at: "2026-09-30T16:00:01Z", processed_at: "2026-09-30T16:00:02Z",
          status: "processed", product_id: "9375026544890", event_updated_at: "2026-09-30T16:00:00Z",
          payload: { secret: "must not escape" }, shop_domain: "private.example" },
          { id: "unrelated", delivery_id: "other", product_id: "42", status: "processed" }] : [];
        return Promise.resolve({ data, error: ledger && deliveryError ? { message: "private database detail" } : null }).then(resolve);
      },
    };
    return builder;
  } };
  const get = makeGet({
    requireAdminToken: (_request, options) => {
      assert.equal(options.allowCron, false, "read-only status requires the existing admin gate");
      return denied ? { status: 401 } : null;
    },
    hasSupabaseAdminEnv: () => true,
    configuredSyncCanarySku: () => configured ? "BAH08453001" : null,
    shopifyProductGid: productGid,
    createSupabaseServiceRoleClient: () => { clients++; return db; },
    drainShopifySyncQueues: () => { drains++; assert.fail("status must never run the worker"); },
    isShopifySyncConfigured: () => true,
  });
  return { get, queries, counts: () => ({ drains, clients }) };
}

test("private canary delivery status authenticates before accessing the database", async () => {
  const f = fixture({ denied: true });
  assert.equal((await f.get(request)).status, 401);
  assert.deepEqual(f.counts(), { drains: 0, clients: 0 });
  assert.equal(f.queries.length, 0);
});

test("canary ledger is product-scoped, bounded and exposes only delivery metadata", async () => {
  const f = fixture();
  const result = await f.get(request);
  assert.equal(result.status, 200);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.body.canaryProductId, productId);
  assert.deepEqual(result.body.canaryEvents, [{ id: "event-new", delivery_id: "delivery-new", topic: "products/update",
    received_at: "2026-09-30T16:00:01Z", processed_at: "2026-09-30T16:00:02Z", status: "processed", product_id: productId,
    event_updated_at: "2026-09-30T16:00:00Z" }]);
  const binding = f.queries.find(query => query.table === "shopify_gallery_bindings");
  assert.deepEqual(binding.filters, [["catalog_key", "BAH08453001"]]);
  const ledger = f.queries.find(query => query.fields.includes("delivery_id"));
  assert.equal(ledger.fields, "id,delivery_id,topic,received_at,processed_at,status,product_id:payload->>id,event_updated_at:payload->>updated_at");
  assert.deepEqual(ledger.filters, [["payload->>id", [productId, "9375026544890"]]]);
  assert.equal(ledger.limit, 25);
  assert.deepEqual(ledger.order, ["received_at", { ascending: false }]);
  assert.deepEqual(f.counts(), { drains: 0, clients: 1 });
});

test("unconfigured or unbound canaries never trigger a broad delivery query", async () => {
  for (const options of [{ configured: false }, { bound: false }]) {
    const f = fixture(options);
    const result = await f.get(request);
    assert.equal(result.status, 200);
    assert.equal(result.body.canaryProductId, null);
    assert.deepEqual(result.body.canaryEvents, []);
    assert.ok(f.queries.every(query => !query.fields.includes("delivery_id")));
    assert.equal(f.counts().drains, 0);
  }
});

test("failed ledger reads fail closed without returning provider errors or success evidence", async () => {
  const f = fixture({ deliveryError: true });
  const result = await f.get(request);
  assert.equal(result.status, 503);
  assert.ok(!Object.hasOwn(result.body, "canaryEvents"));
  assert.doesNotMatch(JSON.stringify(result.body), /private database detail|must not escape/);
});
