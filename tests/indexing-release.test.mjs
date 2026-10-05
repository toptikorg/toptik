import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const moduleFrom = source => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const { default: config } = await moduleFrom(await read("next.config.ts"));
const { default: robots } = await moduleFrom(await read("src/app/robots.ts"));
const layout = await read("src/app/layout.tsx");
const metadataSource = layout.match(/export const metadata: Metadata = \{[\s\S]*?\n\};/)?.[0];
assert.ok(metadataSource, "Root metadata export must exist");
const { metadata } = await moduleFrom(metadataSource);

test("public root metadata allows indexing and contains the GSC ownership token", () => {
  assert.deepEqual(metadata.robots, { index: true, follow: true });
  assert.equal(metadata.metadataBase.href, "https://landing.toptik.co.il/");
  assert.deepEqual(metadata.verification.google, [
    "SOL1x5W_O4mnV5j6IGHiH-mW4jopb3hJjIOWZXlaLbg",
    "i3_TvaN0Unb_P7E8uqkDjZ7ag4kwTx-WBgkUTIj7Ssk",
  ]);
});

test("robots permits public HTML crawl, blocks API crawl, and advertises the canonical sitemap", () => {
  const result = robots();
  assert.deepEqual(result.rules, { userAgent: "*", allow: "/", disallow: "/api/" });
  assert.equal(result.sitemap, "https://landing.toptik.co.il/sitemap.xml");
});

test("noindex response headers are scoped to admin/account/API surfaces and admin host", async () => {
  const rules = await config.headers();
  assert.ok(!rules.some(rule => rule.source === "/:path*" && !rule.has && rule.headers.some(h => h.key.toLowerCase() === "x-robots-tag")), "no global public noindex header");
  assert.ok(rules.some(rule => rule.source === "/:path*" && rule.has?.some(match => match.type === "host" && match.value === "admin.toptik.co.il") && rule.headers.some(h => h.value === "noindex, nofollow")));
  for (const route of ["/admin/:path*", "/dashboard/:path*", "/settings/:path*", "/setup/:path*", "/login/:path*", "/reset/:path*", "/auth/:path*", "/api/:path*"]) {
    assert.ok(rules.some(rule => rule.source === route && rule.headers.some(h => h.key === "X-Robots-Tag" && h.value === "noindex, nofollow")), `${route} remains excluded`);
  }
});

test("legacy public hosts redirect permanently to the canonical host and preserve path", async () => {
  const redirects = await config.redirects();
  for (const host of ["site.toptik.co.il", "toptik-iota.vercel.app"]) {
    assert.ok(redirects.some(rule => rule.source === "/:path*" && rule.destination === "https://landing.toptik.co.il/:path*" && rule.permanent && rule.has.some(match => match.type === "host" && match.value === host)), `${host} redirects to canonical`);
  }
  assert.ok(!redirects.some(rule => rule.has?.some(match => match.value === "admin.toptik.co.il")), "admin host is not redirected to the public host");
});

test("sitemap includes only the public root, gallery, journal, and publishable article URLs", async () => {
  const source = await read("src/app/sitemap.ts");
  assert.match(source, /absoluteUrl\("\/"\)/);
  assert.match(source, /absoluteUrl\("\/carousel"\)/);
  assert.match(source, /absoluteUrl\("\/journal"\)/);
  assert.match(source, /publishableGalleryArticles\.map/);
  assert.match(source, /absoluteUrl\(`\/journal\/\$\{article\.slug\}`\)/);
  assert.doesNotMatch(source, /releaseBlocker|draft|blocked/i);
  const articles = await read("src/lib/editorial/gallery-articles.tsx");
  assert.match(articles, /publishableGalleryArticles = galleryArticles\.filter\(\(article\) => !article\.releaseBlocker\)/);
});

test("only admin surfaces retain noindex metadata", async () => {
  const panelLayout = await read("src/app/(panel)/layout.tsx");
  assert.match(panelLayout, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  const adminLayout = await read("src/app/admin/layout.tsx");
  assert.match(adminLayout, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  for (const path of ["src/app/page.tsx", "src/app/carousel/page.tsx", "src/app/journal/page.tsx", "src/app/journal/[slug]/page.tsx"]) {
    const source = await read(path);
    assert.doesNotMatch(source, /index\s*:\s*false/, `${path} must not suppress public indexing`);
  }
});

test("public home title remains a semantic H1 without changing its visual class", async () => {
  const home = await read("src/app/page.tsx");
  assert.match(home, /<h1 className="title">TOPTIK COLLECTION<\/h1>/);
});
