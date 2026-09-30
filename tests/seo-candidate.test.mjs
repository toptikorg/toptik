import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// SEO release: these tests pin canonical metadata and structured data that
// mirrors visible content while public routes are indexable.
const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

// structured-data imports from ./site; inline the module so it runs without a bundler.
const siteSource = stripTypeScriptTypes(await read("src/lib/seo/site.ts"));
const sdSource = stripTypeScriptTypes(await read("src/lib/seo/structured-data.ts")).replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\.\/site";\s*$/m, "");
const site = await import(`data:text/javascript;base64,${Buffer.from(siteSource).toString("base64")}`);
const sd = await import(`data:text/javascript;base64,${Buffer.from(siteSource + "\n" + sdSource.replace(/^export /gm, "")+ "\nexport { carouselStructuredData, jsonLdString };").toString("base64")}`);

test("canonical host is landing.toptik.co.il and paths resolve against it", () => {
  assert.equal(site.SITE_ORIGIN, "https://landing.toptik.co.il");
  assert.equal(site.absoluteUrl("/carousel"), "https://landing.toptik.co.il/carousel");
});

test("robots.txt advertises the canonical sitemap", async () => {
  const source = await read("src/app/robots.ts");
  assert.match(source, /sitemap:\s*"https:\/\/landing\.toptik\.co\.il\/sitemap\.xml"/);
});

test("sitemap includes only canonical public routes and publishable article slugs", async () => {
  const sitemap = await read("src/app/sitemap.ts");
  assert.match(sitemap, /absoluteUrl\("\/"\)/);
  assert.match(sitemap, /absoluteUrl\("\/carousel"\)/);
  assert.match(sitemap, /absoluteUrl\("\/journal"\)/);
  assert.match(sitemap, /publishableGalleryArticles\.map/);
  assert.doesNotMatch(sitemap, /releaseBlocker|blocked/i);
});

test("public routes have no noindex directive; private surfaces remain explicitly excluded", async () => {
  const layout = await read("src/app/layout.tsx");
  assert.match(layout, /robots:\s*\{\s*index:\s*true,\s*follow:\s*true\s*\}/);
  const config = await read("next.config.ts");
  assert.doesNotMatch(config, /source:\s*"\/:path\*"\s*,\s*headers:\s*\[\{\s*key:\s*"X-Robots-Tag"/);
  assert.match(config, /X-Robots-Tag[\s\S]*noindex, nofollow/);
  const panel = await read("src/app/(panel)/layout.tsx");
  assert.match(panel, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
});

test("both public pages declare a same-page canonical path", async () => {
  assert.match(await read("src/app/carousel/page.tsx"), /alternates:\s*\{\s*canonical:\s*CAROUSEL_PATH\s*\}/);
  assert.match(await read("src/app/page.tsx"), /alternates:\s*\{\s*canonical:\s*"\/"\s*\}/);
});

test("structured data is one CollectionPage that mirrors visible content", async () => {
  const data = sd.carouselStructuredData();
  assert.equal(data["@type"], "CollectionPage");
  assert.equal(data.url, "https://landing.toptik.co.il/carousel");
  const client = await read("src/app/carousel/CarouselPageClient.tsx");
  assert.match(client, /קולקציה <span>נבחרת<\/span>/, "visible heading must exist");
  assert.equal(data.name, "קולקציה נבחרת");
  const serialised = JSON.stringify(data);
  for (const forbidden of ["Product", "Offer", "price", "AggregateRating", "Review", "ItemList", "availability"])
    assert.ok(!serialised.includes(forbidden), `${forbidden} must not be emitted`);
});

test("JSON-LD serialiser cannot break out of its script element", () => {
  const text = sd.jsonLdString({ name: "</script><script>alert(1)</script>" });
  assert.ok(!text.includes("</script>") && !text.includes("<"));
  assert.equal(JSON.parse(text).name, "</script><script>alert(1)</script>");
});

test("descriptive copy is original, Hebrew and makes no price or stock claim", () => {
  for (const text of [site.CAROUSEL_TITLE, site.CAROUSEL_DESCRIPTION]) {
    assert.match(text, /[֐-׿]/);
    assert.doesNotMatch(text, /₪|מחיר|במלאי|מבצע|הנחה|%/);
  }
  assert.ok(site.CAROUSEL_TITLE.length <= 70 && site.CAROUSEL_DESCRIPTION.length <= 170);
});
