import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// GAL-025: the public tech-spec route may not fetch arbitrary URLs, may not
// write to the database, and must keep serving existing stored specs.
const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const moduleFrom = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

const allowlist = await moduleFrom(await read("src/lib/catalog-source/source-allowlist.ts"));
globalThis.__sourceAllowlist = allowlist;
const withAllowlist = (source) => source.replace(
  /import \{ ([^}]+) \} from "\.\/source-allowlist";/,
  "const { $1 } = globalThis.__sourceAllowlist;",
);
const safeFetch = await moduleFrom(withAllowlist(await read("src/lib/catalog-source/safe-fetch.ts")));
const publicDetails = await moduleFrom(withAllowlist(await read("src/lib/catalog-source/public-product-details.ts")));

const PUBLIC_DNS = async () => [{ address: "23.227.38.65" }];
const okResponse = (body = "ok") => new Response(body, { status: 200 });
const redirect = (location) => new Response(null, { status: 302, headers: { location } });

test("only approved manufacturer HTTPS sources are accepted", () => {
  for (const url of [
    "https://bricstore.com/products/taormina-spinner-expandable-check-in",
    "https://mandarinaduck.com/en-us/products/logoduck-metal-cabin-expandable-lunar-ouv24a",
    "https://www.samsonite.fi/some/product.html",
  ]) assert.ok(allowlist.approvedSourceUrl(url), url);

  for (const url of [
    "https://evil.example/products/x",
    "https://bricstore.com.evil.example/x",
    "https://evilbricstore.com/x",
    "https://huntleather.com/products/brics-x-travel-pilot-cabin-case-olive",
    "http://bricstore.com/products/x",
    "https://user:pass@bricstore.com/x",
    "https://bricstore.com:8443/x",
    "ftp://bricstore.com/x",
    "javascript:alert(1)",
    " https://bricstore.com/x",
    "not a url",
    "",
    null,
    undefined,
    42,
  ]) assert.equal(allowlist.approvedSourceUrl(url), null, String(url));
});

test("localhost, internal hosts and IP literals are rejected", () => {
  for (const url of [
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://10.0.0.5/x",
    "https://169.254.169.254/latest/meta-data/",
    "https://192.168.1.10/x",
    "https://metadata.google.internal/x",
    "https://service.local/x",
  ]) assert.equal(allowlist.approvedSourceUrl(url), null, url);

  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1",
    "fc00::5", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip"]) {
    assert.equal(allowlist.isPrivateAddress(address), true, address);
  }
  for (const address of ["23.227.38.65", "104.16.1.1", "2606:4700::6810:1", "172.32.0.1"]) {
    assert.equal(allowlist.isPrivateAddress(address), false, address);
  }
});

test("safe fetch refuses unapproved URLs before any network call", async () => {
  let calls = 0;
  const deps = { fetch: async () => { calls++; return okResponse(); }, lookup: PUBLIC_DNS };
  for (const url of ["https://evil.example/x", "http://bricstore.com/x", "https://127.0.0.1/x", "https://localhost/x"]) {
    await assert.rejects(safeFetch.safeSourceFetch(url, {}, deps), { name: "UnsafeSourceError" }, url);
  }
  assert.equal(calls, 0);
});

test("safe fetch refuses an approved host that resolves to an internal address", async () => {
  let calls = 0;
  const deps = { fetch: async () => { calls++; return okResponse(); }, lookup: async () => [{ address: "10.0.0.7" }] };
  await assert.rejects(safeFetch.safeSourceFetch("https://bricstore.com/products/x", {}, deps), { name: "UnsafeSourceError" });
  assert.equal(calls, 0);
});

test("a redirect to an unapproved or internal destination is rejected and never requested", async () => {
  for (const location of [
    "https://evil.example/steal",
    "http://bricstore.com/products/x",
    "https://127.0.0.1/admin",
    "https://169.254.169.254/latest/meta-data/",
    "//evil.example/x",
  ]) {
    const requested = [];
    const deps = {
      lookup: PUBLIC_DNS,
      fetch: async (url, init) => {
        requested.push(url);
        assert.equal(init.redirect, "manual", "redirects must be followed manually");
        return redirect(location);
      },
    };
    await assert.rejects(safeFetch.safeSourceFetch("https://bricstore.com/products/x", {}, deps),
      { name: "UnsafeSourceError" }, location);
    assert.deepEqual(requested, ["https://bricstore.com/products/x"], location);
  }
});

test("a redirect within approved hosts is followed; loops are bounded", async () => {
  const requested = [];
  const deps = {
    lookup: PUBLIC_DNS,
    fetch: async (url) => {
      requested.push(url);
      return url.endsWith("/old") ? redirect("/products/new") : okResponse("details");
    },
  };
  const response = await safeFetch.safeSourceFetch("https://bricstore.com/products/old", {}, deps);
  assert.equal(await response.text(), "details");
  assert.deepEqual(requested, ["https://bricstore.com/products/old", "https://bricstore.com/products/new"]);

  const loop = { lookup: PUBLIC_DNS, fetch: async () => redirect("https://bricstore.com/products/loop") };
  await assert.rejects(safeFetch.safeSourceFetch("https://bricstore.com/products/loop", {}, loop), /Too many redirects/);
});

const specsA = { specs: [{ heading: "פרטי מוצר", items: [{ label: "מותג", value: "Bric's" }, { label: "גובה", value: "75 ס״מ" }] }], colors: [], category: "suitcase" };
const specsB = { specs: [{ heading: "פרטי מוצר", items: [{ label: "מותג", value: "Bric's" }, { label: "גובה", value: "77 ס״מ" }] }], colors: [] };
const item = (catalogNumber, sourceUrl, techSpecs, isActive = true) => ({
  id: catalogNumber, title: catalogNumber, description: null, catalogNumber, sourceUrl, coverImagePath: "x",
  displayOrder: 1, isActive, techSpecs, angles: [],
});

test("existing products keep their stored specs through the public route logic", () => {
  const items = [
    item("BAH08453.001", "https://bricstore.com/products/taormina-spinner-expandable-check-in", specsA),
    item("BAH08453.006", "https://bricstore.com/products/taormina-spinner-expandable-check-in", specsA),
    item("P10OUV24-A89-TU", "https://mandarinaduck.com/en-us/products/logoduck", specsB),
  ];
  const result = publicDetails.resolvePublicProductDetails("https://bricstore.com/products/taormina-spinner-expandable-check-in", items);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { specs: specsA.specs, colors: specsA.colors });
  const single = publicDetails.resolvePublicProductDetails("https://mandarinaduck.com/en-us/products/logoduck#x", items);
  assert.deepEqual(single, { status: 200, body: { specs: specsB.specs, colors: [] } });
});

test("the public route logic never answers for unknown, uncached, inactive or ambiguous records", () => {
  const url = "https://bricstore.com/products/shared";
  assert.equal(publicDetails.resolvePublicProductDetails("https://evil.example/x", []).status, 400);
  assert.equal(publicDetails.resolvePublicProductDetails("https://localhost/x", []).status, 400);
  assert.equal(publicDetails.resolvePublicProductDetails(null, []).status, 400);
  assert.equal(publicDetails.resolvePublicProductDetails(url, []).status, 404);
  assert.equal(publicDetails.resolvePublicProductDetails(url, [item("A", url, null)]).status, 404);
  assert.equal(publicDetails.resolvePublicProductDetails(url, [item("A", url, specsA, false)]).status, 404);
  const ambiguous = publicDetails.resolvePublicProductDetails(url, [item("A", url, specsA), item("B", url, specsB)]);
  assert.deepEqual(ambiguous, { status: 404, body: { specs: [], colors: [], error: "not_cached" } });
});

test("the public route performs no outbound fetch, no scraping and no database write", async () => {
  const route = await read("src/app/api/product-details/route.ts");
  assert.doesNotMatch(route, /\bfetch\(|fetchProductDetails|service-role|createSupabaseServiceRoleClient|hasSupabaseAdminEnv/);
  assert.doesNotMatch(route, /\.(insert|update|upsert|delete)\(/);
  assert.match(route, /getCarouselPayload\(\{ includeInactive: true \}\)/);
  assert.match(route, /resolvePublicProductDetails\(rawUrl, items\)/);
  const logic = await read("src/lib/catalog-source/public-product-details.ts");
  assert.doesNotMatch(logic, /\bfetch\(|\.(insert|update|upsert|delete)\(/);
});

test("the read path used by the public route only issues select queries", async () => {
  // Execute the real getCarouselPayload body against a recording fake client.
  const repository = await read("src/lib/carousel/repository.ts");
  const readStart = repository.indexOf("export async function getCarouselPayload");
  const { makeReader } = await moduleFrom(`export function makeReader(deps) {
    const { hasSupabasePublicEnv, createSupabaseServerClient, fallbackCarouselPayload, applyReviewedCopy, normalizeSyncSku } = deps;
    ${repository.slice(readStart).replace(/^export /gm, "")}
    return getCarouselPayload;
  }`);
  const calls = [];
  const chain = (table, rows) => {
    const query = {
      select: (...args) => { calls.push([table, "select", ...args]); return query; },
      order: () => query, eq: () => query, in: () => query,
      maybeSingle: async () => ({ data: { id: 1, autoplay_ms: 3500, transition_mode: "shatter-particle" } }),
      then: (resolve) => resolve({ data: rows, error: null }),
    };
    for (const write of ["insert", "update", "upsert", "delete"]) {
      query[write] = () => { calls.push([table, write]); return query; };
    }
    return query;
  };
  const client = {
    from: (table) => chain(table, table === "carousel_items"
      ? [{ id: "1", title: "t", description: null, catalog_number: "BAH08453.001", source_url: "https://bricstore.com/products/x",
          cover_image_path: "c", display_order: 1, is_active: true, tech_specs: specsA }]
      : []),
  };
  const getCarouselPayload = makeReader({
    hasSupabasePublicEnv: () => true,
    createSupabaseServerClient: () => client,
    fallbackCarouselPayload: { unavailable: true, items: [], settings: {} },
    applyReviewedCopy: (value) => value,
    normalizeSyncSku: (value) => value?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? null,
  });
  const payload = await getCarouselPayload({ includeInactive: true });
  assert.equal(payload.items.length, 1);
  assert.deepEqual(payload.items[0].techSpecs, specsA);
  assert.ok(calls.length > 0);
  assert.deepEqual(calls.filter(([, method]) => method !== "select"), [], "public read must not write");
});
