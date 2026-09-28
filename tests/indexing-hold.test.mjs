import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// Import the actual production configuration without a server, dependencies,
// credentials, network access, or changes to the public catalogue.
const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const moduleFrom = source => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const { default: config } = await moduleFrom(await read("next.config.ts"));
const { default: robots } = await moduleFrom(await read("src/app/robots.ts"));
const layout = await read("src/app/layout.tsx");
const metadataSource = layout.match(/export const metadata: Metadata = \{[\s\S]*?\n\};/)?.[0];
assert.ok(metadataSource, "Root metadata export must exist");
const { metadata } = await moduleFrom(metadataSource);

test("root HTML metadata tells crawlers noindex, follow", () => {
  assert.deepEqual(metadata.robots, { index: false, follow: true });
  assert.equal(metadata.metadataBase.href, "https://landing.toptik.co.il/");
});

test("response header holds every app path without host or environment exceptions", async () => {
  const rules = await config.headers();
  assert.deepEqual(rules, [{
    source: "/:path*",
    headers: [{ key: "X-Robots-Tag", value: "noindex, follow" }],
  }]);
});

test("public pages and their assets remain crawlable", () => {
  const { rules } = robots();
  assert.equal(rules.userAgent, "*");
  assert.equal(rules.allow, "/");
  for (const path of ["/", "/carousel", "/carousel?category=travel", "/api/carousel", "/_next/static/app.js", "/image.jpg"]) {
    assert.ok(rules.disallow.every(prefix => !path.startsWith(prefix)), `${path} must be crawlable`);
  }
});

test("administration paths are not advertised to crawlers and no sitemap is advertised", () => {
  const result = robots();
  assert.deepEqual(result.rules.disallow, [
    "/admin", "/dashboard", "/settings", "/setup", "/login",
    "/reset", "/auth", "/api/admin", "/api/panel",
  ]);
  assert.equal(Object.hasOwn(result, "sitemap"), false);
  assert.equal(Object.hasOwn(result, "host"), false);
});

test("existing nested metadata cannot re-enable indexing", async () => {
  async function checkDirectory(directory) {
    for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await checkDirectory(path);
      else if (/^(?:layout|page)\.tsx$/.test(entry.name)) {
        const source = await read(path);
        for (const definition of source.matchAll(/robots\s*:\s*\{([^}]+)\}/g)) {
          assert.match(definition[1], /index\s*:\s*false/, `${path} must retain noindex`);
        }
      }
    }
  }
  await checkDirectory("src/app");
});

test("the isolated hold adds no product, editorial-admin or sitemap routes", async () => {
  for (const path of [
    "src/app/carousel/products", "src/app/admin/seo", "src/app/api/admin/editorial",
    "src/app/sitemap.ts", "src/app/sitemap.xml", "public/sitemap.xml", "public/robots.txt",
  ]) {
    await assert.rejects(access(new URL(path, root)), { code: "ENOENT" }, `${path} must remain absent`);
  }
});
