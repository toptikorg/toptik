// Run with Node 24: node --test tests/storefront-reader.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = await readFile(new URL("../src/lib/carousel/storefront-reader.ts", import.meta.url), "utf8");
assert.match(source, /^import "server-only";/);
// Next enforces this sentinel in production. Remove only the sentinel to run
// the dependency-free core offline, not to weaken the application's boundary.
const javascript = stripTypeScriptTypes(source.replace('import "server-only";', ""));
const {
  STOREFRONT_ENDPOINT,
  STOREFRONT_PRODUCTS_QUERY,
  readStorefrontSnapshot,
  createStorefrontReader,
} = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

const page = (nodes, hasNextPage = false, endCursor = null) => ({
  nodes, pageInfo: { hasNextPage, endCursor },
});
const image = (n) => ({ id: `image-${n}`, url: `https://cdn.shopify.com/${n}.jpg`, altText: null, width: 800, height: 600 });
const collection = (n) => ({ id: `collection-${n}`, handle: `collection-${n}`, title: `Collection ${n}` });
const variant = (n) => ({
  id: `variant-${n}`, sku: `SKU-${n}`, title: `Variant ${n}`, availableForSale: false,
  price: { amount: "99.90", currencyCode: "ILS" }, image: image(n),
  selectedOptions: [{ name: "Color", value: "Black" }],
});
const product = (n, overrides = {}) => ({
  id: `product-${n}`, handle: `product-${n}`, title: `Product ${n}`,
  description: "Plain description", productType: "Bag", vendor: "Brand",
  onlineStoreUrl: `https://www.toptik.co.il/products/product-${n}`,
  availableForSale: false, updatedAt: "2026-09-28T10:00:00Z",
  images: page([image(n)]), collections: page([collection(n)]), variants: page([variant(n)]),
  ...overrides,
});
const response = (data, extra = {}) => new Response(JSON.stringify({ data, ...extra }), {
  status: 200, headers: { "Content-Type": "application/json" },
});
const fakeFetch = (handler) => async (url, options) => {
  assert.equal(url, STOREFRONT_ENDPOINT);
  assert.equal(url, "https://toptikcoil.myshopify.com/api/2026-07/graphql.json");
  assert.equal(options.method, "POST");
  assert.equal(options.cache, "no-store");
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.deepEqual(options.headers, { "Content-Type": "application/json" });
  assert.ok(options.signal instanceof AbortSignal);
  return handler(JSON.parse(options.body), options);
};
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test("public query is read-only and bounded, without credentials or quantity filters", () => {
  assert.match(STOREFRONT_PRODUCTS_QUERY, /products\(first: 10,/);
  for (const name of ["images", "collections", "variants"]) {
    assert.match(STOREFRONT_PRODUCTS_QUERY, new RegExp(`${name}\\(first: 30\\)`));
  }
  assert.doesNotMatch(STOREFRONT_PRODUCTS_QUERY, /mutation|quantityAvailable|orders|customers|available_for_sale/);
});

test("paginates all products and preserves unavailable, unpublished and collection data", async () => {
  const calls = [];
  const result = await readStorefrontSnapshot({ fetchImpl: fakeFetch(({ query, variables }) => {
    assert.equal(query, STOREFRONT_PRODUCTS_QUERY);
    calls.push(variables.after);
    return variables.after === null
      ? response({ products: page([product(1)], true, "products-1") })
      : response({ products: page([product(2, { onlineStoreUrl: null })]) });
  }) });
  assert.deepEqual(calls, [null, "products-1"]);
  assert.equal(result.products.length, 2);
  assert.equal(result.products[0].availableForSale, false);
  assert.equal(result.products[0].variants[0].availableForSale, false);
  assert.equal(result.products[1].onlineStoreUrl, null);
  assert.deepEqual(result.products[0].collections, [collection(1)]);
  assert.deepEqual(result.products[0].variants, [variant(1)]);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});

test("fully paginates each child connection, including lists beyond 30", async () => {
  const entries = Array.from({ length: 30 }, (_, index) => index + 1);
  const initial = product(1, {
    images: page(entries.map(image), true, "images-30"),
    collections: page(entries.map(collection), true, "collections-30"),
    variants: page(entries.map(variant), true, "variants-30"),
  });
  const seen = [];
  const result = await readStorefrontSnapshot({ fetchImpl: fakeFetch(({ query, variables }) => {
    if (query === STOREFRONT_PRODUCTS_QUERY) return response({ products: page([initial]) });
    assert.equal(variables.id, initial.id);
    const name = ["images", "collections", "variants"].find((name) => query.includes(`${name}(first:`));
    seen.push(name);
    assert.equal(variables.after, `${name}-30`);
    const parse = { images: image, collections: collection, variants: variant }[name];
    return response({ product: { id: initial.id, [name]: page([parse(31)]) } });
  }) });
  assert.deepEqual(seen, ["images", "collections", "variants"]);
  for (const name of seen) assert.equal(result.products[0][name].length, 31);
});

test("empty successful catalog is a complete snapshot, not a failure", async () => {
  const result = await readStorefrontSnapshot({ fetchImpl: fakeFetch(() => response({ products: page([]) })) });
  assert.deepEqual(result.products, []);
});

test("nullable image IDs use image URLs for pagination identity", async () => {
  const first = { ...image(1), id: null };
  const second = { ...image(2), id: null };
  const result = await readStorefrontSnapshot({ fetchImpl: fakeFetch(() => response({ products: page([
    product(1, { images: page([first, second]) }),
  ]) })) });
  assert.deepEqual(result.products[0].images, [first, second]);
});

test("HTTP failure or GraphQL partial data never produces a snapshot", async () => {
  await rejectsCode(readStorefrontSnapshot({ fetchImpl: fakeFetch(() => new Response("throttled", { status: 430 })) }), "HTTP_ERROR");
  await rejectsCode(readStorefrontSnapshot({ fetchImpl: fakeFetch(() => response({
    products: page([product(1)]),
  }, { errors: [{ message: "partial error" }] })) }), "GRAPHQL_ERROR");
  await rejectsCode(readStorefrontSnapshot({ fetchImpl: fakeFetch(() => { throw new Error("offline"); }) }), "NETWORK_ERROR");
});

test("missing fields and a product disappearing during pagination fail closed", async () => {
  await rejectsCode(readStorefrontSnapshot({ fetchImpl: fakeFetch(() => response({ products: page([
    product(1, { variants: undefined }),
  ]) })) }), "INVALID_RESPONSE");
  const initial = product(1, { images: page([image(1)], true, "next") });
  await rejectsCode(readStorefrontSnapshot({ fetchImpl: fakeFetch(({ query }) => query === STOREFRONT_PRODUCTS_QUERY
    ? response({ products: page([initial]) })
    : response({ product: null })) }), "INVALID_RESPONSE");
});

test("repeated cursors, duplicate IDs, and next pages without a cursor fail closed", async () => {
  let number = 0;
  await rejectsCode(readStorefrontSnapshot({ fetchImpl: fakeFetch(() => response({
    products: page([product(++number)], true, "repeated"),
  })) }), "INVALID_RESPONSE");
  await rejectsCode(readStorefrontSnapshot({ fetchImpl: fakeFetch(() => response({
    products: page([product(1), product(1)]),
  })) }), "INVALID_RESPONSE");
  await rejectsCode(readStorefrontSnapshot({ fetchImpl: fakeFetch(() => response({
    products: page([product(1)], true, null),
  })) }), "INVALID_RESPONSE");
  await rejectsCode(readStorefrontSnapshot({ fetchImpl: fakeFetch(() => response({
    products: page([product(1, { images: page([image(1), image(1)]) })]),
  })) }), "INVALID_RESPONSE");
});

test("product, page and request bounds throw rather than silently truncate", async () => {
  await rejectsCode(readStorefrontSnapshot({ limits: { maxProducts: 1 }, fetchImpl: fakeFetch(() => response({
    products: page([product(1), product(2)]),
  })) }), "LIMIT_EXCEEDED");
  for (const limits of [{ maxPages: 1 }, { maxRequests: 1 }]) {
    await rejectsCode(readStorefrontSnapshot({ limits, fetchImpl: fakeFetch(() => response({
      products: page([product(1)], true, "next"),
    })) }), "LIMIT_EXCEEDED");
  }
  await rejectsCode(readStorefrontSnapshot({ limits: { maxRequests: 501 } }), "INVALID_LIMIT");
});

test("bounds a hanging fetch and hanging JSON body even when the injected fetch ignores abort", async () => {
  for (const fetchImpl of [
    fakeFetch(() => new Promise(() => {})),
    fakeFetch(() => ({ ok: true, json: () => new Promise(() => {}) })),
  ]) {
    await rejectsCode(readStorefrontSnapshot({ limits: { requestTimeoutMs: 10 }, fetchImpl }), "TIMEOUT");
  }
});

test("deduplicates pending reads, caches complete results and protects them from caller mutation", async () => {
  let count = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reader = createStorefrontReader({ fetchImpl: fakeFetch(async () => {
    count++;
    await gate;
    return response({ products: page([product(1)]) });
  }) });
  const first = reader();
  const second = reader();
  assert.equal(count, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  a.products[0].title = "caller mutation";
  assert.equal(b.products[0].title, "Product 1");
  assert.equal((await reader()).products[0].title, "Product 1");
  assert.equal(count, 1);
});

test("TTL cannot exceed 60 seconds; expired data is never served on error and failure is retryable", async () => {
  let now = 0;
  let count = 0;
  let fail = false;
  const reader = createStorefrontReader({ now: () => now, cacheTtlMs: 120000, fetchImpl: fakeFetch(() => {
    count++;
    if (fail) return new Response("failure", { status: 503 });
    return response({ products: page([product(count)]) });
  }) });
  assert.equal((await reader()).products[0].id, "product-1");
  now = 59999;
  assert.equal((await reader()).products[0].id, "product-1");
  now = 60000;
  fail = true;
  await rejectsCode(reader(), "HTTP_ERROR");
  assert.equal(count, 2);
  fail = false;
  assert.equal((await reader()).products[0].id, "product-3");
});

test("zero TTL permits deduplication but never retains a completed snapshot", async () => {
  let count = 0;
  const reader = createStorefrontReader({ cacheTtlMs: 0, fetchImpl: fakeFetch(() => {
    count++;
    return response({ products: page([]) });
  }) });
  await reader();
  await reader();
  assert.equal(count, 2);
});
