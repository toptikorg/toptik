import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { descriptionModuleUrl } from "./helpers/description-module.mjs";

const source = readFileSync("src/lib/shopify/admin-api.ts", "utf8")
  .replace(/^import "server-only";\s*/m, "")
  .replace(/^import \{ createShopifyClientCredentialsProvider \} from "\.\/client-credentials";\s*/m,
    'const createShopifyClientCredentialsProvider = () => async () => "test-token";\n')
  .replace('"./description-document"', JSON.stringify(descriptionModuleUrl));
const { writeShopifyVisibleCopy, visibleCopyFromProduct, fetchProductSnapshot } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`
);
const current = { id: "gid://shopify/Product/123", title: "Original", descriptionHtml: "<p>Details</p>",
  seoTitle: "SEO", seoDescription: "Snippet" };

function configure(t) {
  const environment = { SHOPIFY_SHOP_DOMAIN: "test-shop.myshopify.com", SHOPIFY_CLIENT_ID: "test-client",
    SHOPIFY_CLIENT_SECRET: "test-secret", SHOPIFY_ONLINE_STORE_PUBLICATION_ID: "gid://shopify/Publication/1",
    SHOPIFY_API_VERSION: "2026-07" };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}

test("productUpdate requests only supported UserError fields and preserves the minimal copy patch", async t => {
  configure(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    assert.match(request.query, /userErrors\s*\{\s*field\s+message\s*\}/);
    assert.doesNotMatch(request.query, /userErrors\s*\{[^}]*\bcode\b/);
    assert.deepEqual(request.variables, { product: { id: current.id, title: "Updated" } });
    return Response.json({ data: { productUpdate: { product: { id: current.id }, userErrors: [] } } });
  });
  await writeShopifyVisibleCopy(current.id, { ...visibleCopyFromProduct(current), title: "Updated" }, current);
  assert.equal(calls, 1);
});

test("GraphQL extension codes normalize to bounded worker-safe uppercase without exposing messages", async t => {
  configure(t);
  let responseCode;
  t.mock.method(globalThis, "fetch", async () => Response.json({ errors: [{
    message: "private provider message containing secrets", extensions: { code: responseCode },
  }] }));
  for (const [code, expected] of [
    ["undefinedField", "SHOPIFY_GRAPHQL_UNDEFINED_FIELD"],
    ["UndefinedField", "SHOPIFY_GRAPHQL_UNDEFINED_FIELD"],
    ["throttled", "SHOPIFY_GRAPHQL_THROTTLED"],
    ["ACCESS_DENIED", "SHOPIFY_GRAPHQL_ACCESS_DENIED"],
    ["HTTPServerError", "SHOPIFY_GRAPHQL_HTTP_SERVER_ERROR"],
    [null, "SHOPIFY_GRAPHQL_ERROR"], [42, "SHOPIFY_GRAPHQL_ERROR"],
    [{ code: "private" }, "SHOPIFY_GRAPHQL_ERROR"],
    ["private message\nsecret", "SHOPIFY_GRAPHQL_ERROR"],
    ["x".repeat(65), "SHOPIFY_GRAPHQL_ERROR"],
    ["aA".repeat(32), "SHOPIFY_GRAPHQL_ERROR"],
  ]) {
    responseCode = code;
    await assert.rejects(fetchProductSnapshot(current.id), error => {
      assert.equal(error.message, expected);
      assert.match(error.message, /^[A-Z0-9_]{1,80}$/);
      assert.doesNotMatch(error.message, /private|secret/i);
      return true;
    });
  }
});

test("productUpdate UserError messages remain private when the mutation is rejected", async t => {
  configure(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { productUpdate: {
    product: null, userErrors: [{ field: ["product", "title"], message: "private provider detail" }],
  } } }));
  await assert.rejects(writeShopifyVisibleCopy(current.id, { ...visibleCopyFromProduct(current), title: "Updated" }, current),
    { message: "SHOPIFY_PRODUCT_COPY_WRITE_REJECTED" });
});

test("present malformed errors reject even with valid product data", async t => {
  configure(t);
  let errors;
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { product: null }, errors }));
  for (const value of [{}, "", "private", 0, false, null]) {
    errors = value;
    await assert.rejects(fetchProductSnapshot(current.id), { message: "SHOPIFY_GRAPHQL_ERROR" });
  }
  errors = [];
  assert.equal(await fetchProductSnapshot(current.id), null);
});

test("GraphQL envelope and data must be objects", async t => {
  configure(t);
  let payload;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  for (const value of [null, [], "private", 1]) {
    payload = value;
    await assert.rejects(fetchProductSnapshot(current.id), { message: "SHOPIFY_GRAPHQL_RESPONSE_INVALID" });
  }
  for (const value of [null, [], "private", 1]) {
    payload = { data: value };
    await assert.rejects(fetchProductSnapshot(current.id), { message: "SHOPIFY_GRAPHQL_DATA_MISSING" });
  }
});
