import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync("src/app/api/admin/shopify/sync/route.ts", "utf8");
const body = source.slice(source.indexOf("export async function GET")).replace(/^export /gm, "");
const moduleSource = stripTypeScriptTypes(`export function makeGet(deps) {
  const { requireAdminToken, createSupabaseServiceRoleClient, hasSupabaseAdminEnv,
    configuredSyncCanarySku, configuredShopifySyncMode, shopifyProductGid, drainShopifySyncQueues, isShopifySyncConfigured,
    readVerifiedCopyEligibility, assertVerifiedCopyApproval } = deps;
  const NextResponse = { json: (body, options = {}) => ({ body, status: options.status ?? 200, headers: options.headers }) };
  ${body}
  return GET;
}`);
const { makeGet } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`);
const productId = "gid://shopify/Product/9375026544890";
const productGid = value => /^\d+$/.test(String(value)) ? `gid://shopify/Product/${value}`
  : /^gid:\/\/shopify\/Product\/\d+$/.test(String(value)) ? value : null;
const request = { nextUrl: new URL("https://example.com/api/admin/shopify/sync") };

function fixture({ denied = false, configured = true, bound = true, deliveryError = false, mode = "canary", approved = true, mismatched = false } = {}) {
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
        if (table === "shopify_gallery_copy_eligibility") return Promise.resolve({data:[{product_gid:productId,enabled:true}],error:null}).then(resolve);
        if (table === "shopify_gallery_bindings") return Promise.resolve({data:[{product_gid:productId,catalog_key:"KEY",carousel_item_id:"item",variant_gid:mismatched?"wrong":"variant",product_handle:"handle"}],error:null}).then(resolve);
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
    configuredShopifySyncMode: () => mode,
    readVerifiedCopyEligibility: async () => approved ? { product_gid:productId,catalog_key:"KEY",carousel_item_id:"item",variant_gid:"variant",approved_product_handle:"handle" } : null,
    assertVerifiedCopyApproval: value => { if(!value) throw new Error("SYNC_COPY_NOT_APPROVED"); },
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

test("private status distinguishes configured public admission from ordinary copy synchronization", async () => {
  const old = process.env.SHOPIFY_SYNC_AUTOCREATE;
  try {
    for (const [flag,mode,enabled] of [[undefined,"verified_catalog",false],["all","verified_catalog",false],["published_shopify","canary",false],["published_shopify","verified_catalog",true]]) {
      if (flag === undefined) delete process.env.SHOPIFY_SYNC_AUTOCREATE; else process.env.SHOPIFY_SYNC_AUTOCREATE=flag;
      const f=fixture({mode,configured:false});
      const result=await f.get(request);
      assert.equal(result.status,200);
      assert.equal(result.body.publicProductAdmissionEnabled,enabled);
      assert.equal(f.counts().drains,0);
    }
  } finally { if(old===undefined) delete process.env.SHOPIFY_SYNC_AUTOCREATE; else process.env.SHOPIFY_SYNC_AUTOCREATE=old; }
});

test("failed ledger reads fail closed without returning provider errors or success evidence", async () => {
  const f = fixture({ deliveryError: true });
  const result = await f.get(request);
  assert.equal(result.status, 503);
  assert.ok(!Object.hasOwn(result.body, "canaryEvents"));
  assert.doesNotMatch(JSON.stringify(result.body), /private database detail|must not escape/);
});

test("selected product ledger requires enabled reviewed identity and exposes bounded metadata only",async()=>{
  const selected={nextUrl:new URL(`https://example.com/api/admin/shopify/sync?productId=${encodeURIComponent(productId)}`)};
  const f=fixture({mode:"verified_catalog",configured:false});
  const result=await f.get(selected);
  assert.equal(result.status,200);assert.equal(result.body.selectedProductId,productId);
  assert.equal(result.body.productEvents.length,1);assert.equal(result.body.productEvents[0].product_id,productId);
  assert.deepEqual(result.body.verifiedCatalog,{approved:1,enabled:1});
  assert.doesNotMatch(JSON.stringify(result.body),/must not escape|private\.example|alias_evidence/);
  const ledger=f.queries.find(q=>q.fields.includes("delivery_id"));assert.equal(ledger.limit,25);
  for(const options of [{mode:"canary"},{mode:"verified_catalog",approved:false},{mode:"verified_catalog",mismatched:true}]){
    const rejected=fixture({...options,configured:false});const response=await rejected.get(selected);
    assert.notEqual(response.status,200);assert.ok(rejected.queries.every(q=>!q.fields.includes("delivery_id")));
  }
  assert.equal((await f.get({nextUrl:new URL("https://example.com/api/admin/shopify/sync?productId=https://evil.invalid")})).status,400);
});
