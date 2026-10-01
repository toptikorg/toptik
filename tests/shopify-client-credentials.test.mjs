import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { descriptionModuleUrl } from "./helpers/description-module.mjs";

const source = await readFile("src/lib/shopify/client-credentials.ts", "utf8");
const providerUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
const { createShopifyClientCredentialsProvider } = await import(providerUrl);
const config = { shopDomain: "test-shop.myshopify.com", clientId: "test-client", clientSecret: "test-secret" };
const success = token => Response.json({ access_token: token, expires_in: 86400, scope: "read_products,write_products" });

test("exchanges once and refreshes before expiry without caching credentials in an HTTP cache", async () => {
  let time = 0;
  let requests = 0;
  const provider = createShopifyClientCredentialsProvider({ ...config, now: () => time, fetchImpl: async (url, init) => {
    requests++;
    assert.equal(url, "https://test-shop.myshopify.com/admin/oauth/access_token");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(init.cache, "no-store");
    assert.equal(init.body.get("grant_type"), "client_credentials");
    assert.equal(init.body.get("client_id"), config.clientId);
    assert.equal(init.body.get("client_secret"), config.clientSecret);
    return success(`token-${requests}`);
  } });
  assert.equal(await provider(), "token-1");
  time = 86400_000 - 300_001;
  assert.equal(await provider(), "token-1");
  time++;
  assert.equal(await provider(), "token-2");
  assert.equal(requests, 2);
});

test("concurrent API operations share a single pending token exchange", async () => {
  let requests = 0;
  let release;
  const provider = createShopifyClientCredentialsProvider({ ...config, fetchImpl: async () => {
    requests++;
    await new Promise(resolve => { release = resolve; });
    return success("shared");
  } });
  const first = provider();
  const second = provider();
  release();
  assert.deepEqual(await Promise.all([first, second]), ["shared", "shared"]);
  assert.equal(requests, 1);
});

test("a failed exchange can retry and never exposes the provider response body", async () => {
  let requests = 0;
  const provider = createShopifyClientCredentialsProvider({ ...config, fetchImpl: async () => {
    return ++requests === 1 ? new Response("private provider data", { status: 401 }) : success("recovered");
  } });
  await assert.rejects(provider(), { message: "SHOPIFY_TOKEN_HTTP_401" });
  assert.equal(await provider(), "recovered");
  assert.equal(requests, 2);
});

test("redirects, missing write scope and malformed tokens cannot authorize Shopify writes", async () => {
  for (const [response, expected] of [
    [new Response(null, { status: 302, headers: { location: "https://untrusted.invalid" } }), "SHOPIFY_TOKEN_REDIRECT_REJECTED"],
    [Response.json({ access_token: "value", expires_in: 86400, scope: "read_products" }), "SHOPIFY_TOKEN_WRITE_PRODUCTS_SCOPE_MISSING"],
    [Response.json({ access_token: "value", expires_in: 0, scope: "write_products" }), "SHOPIFY_TOKEN_RESPONSE_INVALID"],
    [new Response("invalid json"), "SHOPIFY_TOKEN_RESPONSE_INVALID"],
  ]) {
    const provider = createShopifyClientCredentialsProvider({ ...config, fetchImpl: async () => response });
    await assert.rejects(provider(), { message: expected });
  }
  assert.throws(() => createShopifyClientCredentialsProvider({ ...config, shopDomain: "evil.example" }),
    /SHOPIFY_CONFIG_CLIENT_CREDENTIALS_INVALID/);
});

test("separate GraphQL calls reuse the provider and credential rotation creates a new one", async t => {
  let apiSource = await readFile("src/lib/shopify/admin-api.ts", "utf8");
  apiSource = apiSource.replace(/^import "server-only";\s*/m, "")
    .replace('from "./client-credentials"', `from "${providerUrl}"`)
    .replace('from "./description-document"', `from "${descriptionModuleUrl}"`);
  const { fetchShopifyBootstrapProducts } = await import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(apiSource)).toString("base64")}`
  );
  const environment = {
    SHOPIFY_SHOP_DOMAIN: config.shopDomain, SHOPIFY_CLIENT_ID: config.clientId,
    SHOPIFY_CLIENT_SECRET: config.clientSecret, SHOPIFY_ONLINE_STORE_PUBLICATION_ID: "gid://shopify/Publication/1",
    SHOPIFY_API_VERSION: "2026-07",
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  let exchanges = 0;
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === "https://test-shop.myshopify.com/admin/oauth/access_token") return success(`token-${++exchanges}`);
    assert.equal(url, "https://test-shop.myshopify.com/admin/api/2026-07/graphql.json");
    assert.equal(init.headers["x-shopify-access-token"], `token-${exchanges}`);
    reads++;
    return Response.json({ data: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
  });
  await fetchShopifyBootstrapProducts();
  await fetchShopifyBootstrapProducts();
  assert.equal(exchanges, 1);
  process.env.SHOPIFY_CLIENT_SECRET = "rotated-test-secret";
  await fetchShopifyBootstrapProducts();
  assert.equal(exchanges, 2);
  assert.equal(reads, 3);
});

test("absolute creation deadline expiring during OAuth never starts the Shopify mutation", async t => {
  const apiSource=(await readFile("src/lib/shopify/admin-api.ts","utf8")).replace(/^import "server-only";\s*/m, "")
    .replace('from "./client-credentials"', `from "${providerUrl}"`)
    .replace('from "./description-document"', `from "${descriptionModuleUrl}"`);
  const api=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(apiSource)).toString("base64")}`);
  const environment={SHOPIFY_SHOP_DOMAIN:config.shopDomain,SHOPIFY_CLIENT_ID:config.clientId,SHOPIFY_CLIENT_SECRET:'isolated-deadline-fixture',
    SHOPIFY_ONLINE_STORE_PUBLICATION_ID:'gid://shopify/Publication/1',SHOPIFY_API_VERSION:'2026-07'};
  const previous=Object.fromEntries(Object.keys(environment).map(key=>[key,process.env[key]]));Object.assign(process.env,environment);
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  let clock=1_800_000_000_000,exchanges=0,mutations=0;const deadline=clock+1000;
  t.mock.method(Date,'now',()=>clock);
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).includes('/oauth/')){exchanges++;clock=deadline+1;return success('deadline-fixture-token');}
    mutations++;return Response.json({data:{unexpected:true}});
  });
  await assert.rejects(api.shopifyAdminGraphql('mutation NeverAfterDeadline { productCreate }',{},10000,deadline),/SPEC_TIME_BUDGET/);
  assert.equal(exchanges,1);assert.equal(mutations,0);
});
