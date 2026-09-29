import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// GAL-026: the public /api/debug-scrape route was an open server-side fetch
// proxy. It is closed; diagnostics are admin-only and use the guarded fetcher.
const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const moduleFrom = (source) =>
  import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

const allowlist = await moduleFrom(await read("src/lib/catalog-source/source-allowlist.ts"));
globalThis.__debugAllowlist = allowlist;
const safeFetch = await moduleFrom((await read("src/lib/catalog-source/safe-fetch.ts")).replace(
  /import \{ ([^}]+) \} from "\.\/source-allowlist";/,
  "const { $1 } = globalThis.__debugAllowlist;",
));
const diagnostics = await moduleFrom(await read("src/lib/catalog-source/scrape-diagnostics.ts"));

const PUBLIC_DNS = async () => [{ address: "23.227.38.65" }];
const guarded = (network) => (url, init) => safeFetch.safeSourceFetch(url, init, { fetch: network, lookup: PUBLIC_DNS });

test("the public debug-scrape route is closed: 404, no fetch, no URL handling", async () => {
  const route = await read("src/app/api/debug-scrape/route.ts");
  assert.match(route, /status: 404/);
  assert.doesNotMatch(route, /\bfetch\(|searchParams|scrapeDiagnostics|safeSourceFetch|service-role|supabase/);
  assert.match(route, /export const GET = NOT_FOUND;/);
});

test("the admin diagnostics route authenticates before doing anything", async () => {
  const route = await read("src/app/api/admin/debug-scrape/route.ts");
  const handler = route.slice(route.indexOf("export async function GET"));
  const authAt = handler.indexOf("if (!isAuthorized(req))");
  const unauthorizedAt = handler.indexOf("status: 401");
  const urlAt = handler.indexOf("searchParams.get(\"url\")");
  const approvedAt = handler.indexOf("approvedSourceUrl(url)");
  const scrapeAt = handler.indexOf("scrapeDiagnostics(");
  assert.ok(authAt >= 0 && unauthorizedAt > authAt, "401 for missing or wrong admin token");
  assert.ok(urlAt > unauthorizedAt && approvedAt > urlAt && scrapeAt > approvedAt, "auth, then allowlist, then scrape");
  assert.match(handler, /safeSourceFetch\(target, init\)/, "only the guarded fetcher is used");
  assert.doesNotMatch(route, /\bfetch\(|service-role|createSupabaseServiceRoleClient|\.(insert|update|upsert|delete)\(/);
  assert.match(route, /token === supabaseEnv\.adminToken/);
});

test("diagnostics never touch the network directly", async () => {
  const lib = await read("src/lib/catalog-source/scrape-diagnostics.ts");
  assert.doesNotMatch(lib.replace(/fetcher\(/g, ""), /\bfetch\(/);
  assert.doesNotMatch(lib, /supabase|\.(insert|update|upsert|delete)\(/i);
});

test("an unapproved external URL is rejected before any request", async () => {
  const requested = [];
  const network = async (url) => { requested.push(url); return new Response("x"); };
  const result = await diagnostics.scrapeDiagnostics("https://evil.example/products/x", guarded(network));
  assert.match(String(result.pageError), /approved/);
  assert.match(String(result.shopifyError), /approved/);
  assert.deepEqual(requested, []);
});

test("localhost, private and metadata addresses are rejected", async () => {
  for (const url of [
    "https://localhost/products/x",
    "https://127.0.0.1/products/x",
    "https://10.0.0.8/products/x",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/products/x",
  ]) {
    const requested = [];
    const result = await diagnostics.scrapeDiagnostics(url, guarded(async (u) => { requested.push(u); return new Response("x"); }));
    assert.ok(result.pageError, url);
    assert.deepEqual(requested, [], url);
  }
  const internalDns = (url, init) => safeFetch.safeSourceFetch(url, init, {
    fetch: async () => new Response("x"), lookup: async () => [{ address: "192.168.1.20" }],
  });
  const viaDns = await diagnostics.scrapeDiagnostics("https://bricstore.com/products/x", internalDns);
  assert.match(String(viaDns.pageError), /non-public/);
});

test("a redirect to a forbidden destination is rejected", async () => {
  const requested = [];
  const network = async (url) => {
    requested.push(url);
    return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } });
  };
  const result = await diagnostics.scrapeDiagnostics("https://bricstore.com/products/x", guarded(network));
  assert.match(String(result.pageError), /approved/);
  assert.ok(requested.every((url) => url.startsWith("https://bricstore.com/")), requested.join(", "));
});

test("an approved manufacturer page is still diagnosable by an admin", async () => {
  const network = async (url) => url.endsWith(".json")
    ? Response.json({ product: { body_html: "<p>spec</p>", options: [{ name: "Color" }] } })
    : new Response('<html>"body_html" Exterior shell</html>', { status: 200 });
  const result = await diagnostics.scrapeDiagnostics("https://bricstore.com/products/x-travel-spinner-carry-on", guarded(network));
  assert.equal(result.pageStatus, 200);
  assert.equal(result.shopifyJsonStatus, 200);
  assert.equal(result.shopifyHasBodyHtml, true);
  assert.equal(result.shopifyOptionsCount, 1);
});
