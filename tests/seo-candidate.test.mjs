import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// SEO candidate, indexing hold still active: these tests pin what the candidate
// is allowed to do (metadata, canonical, structured data
// that mirrors visible content) and what it must not do (lift noindex).
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

test("phase 1 ships no sitemap: the file is absent and nothing advertises one", async () => {
  await assert.rejects(read("src/app/sitemap.ts"), { code: "ENOENT" });
  await assert.rejects(read("src/app/sitemap.xml"), { code: "ENOENT" });
  await assert.rejects(read("public/sitemap.xml"), { code: "ENOENT" });
  assert.equal(Object.hasOwn(site, "SITEMAP_PATHS"), false);
});

test("robots.txt still does not advertise the sitemap during the hold", async () => {
  const source = await read("src/app/robots.ts");
  assert.doesNotMatch(source, /sitemap\s*:/i);
});

test("candidate never lifts the hold", async () => {
  for (const file of ["src/app/carousel/page.tsx", "src/app/page.tsx", "src/lib/seo/site.ts", "src/lib/seo/structured-data.ts"]) {
    const source = await read(file);
    assert.doesNotMatch(source, /index\s*:\s*true/, file);
    assert.doesNotMatch(source, /robots\s*:/, `${file} must not set robots itself`);
  }
  const config = await read("next.config.ts");
  assert.match(config, /X-Robots-Tag[\s\S]*noindex, follow/);
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
