import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (name) => JSON.parse(await readFile(new URL(`../src/lib/editorial/${name}`, import.meta.url), "utf8"));

async function gallerySlugs() {
  const source = await readFile(new URL("../src/lib/editorial/gallery-articles.tsx", import.meta.url), "utf8");
  const handwritten = [...source.matchAll(/^\s{4}slug: "([^"]+)"/gm)].map((m) => m[1]);
  const hubSource = await readFile(new URL("../src/lib/editorial/mandarina-hub-articles.tsx", import.meta.url), "utf8");
  handwritten.push(...[...hubSource.matchAll(/^\s{4}slug: "([^"]+)"/gm)].map((m) => m[1]));
  const comparisonSource = await readFile(new URL("../src/lib/editorial/comparison-articles.tsx", import.meta.url), "utf8");
  handwritten.push(...[...comparisonSource.matchAll(/^\s{4}slug: "([^"]+)"/gm)].map((m) => m[1]));
  const fromStories = [];
  for (const file of ["collection-stories.json", "lifestyle-stories.json", "practical-stories.json", "premium-stories.json", "product-guide-stories.json"]) {
    for (const story of await read(file)) fromStories.push(story.slug);
  }
  return new Set([...handwritten, ...fromStories]);
}

test("every mapped article slug is a real gallery article", async () => {
  const slugs = await gallerySlugs();
  for (const slug of Object.keys(await read("store-guides.json"))) {
    assert.ok(slugs.has(slug), `unknown gallery slug in store-guides.json: ${slug}`);
  }
});

test("every gallery article has at least one store guide", async () => {
  const map = await read("store-guides.json");
  for (const slug of await gallerySlugs()) {
    assert.ok(Array.isArray(map[slug]) && map[slug].length > 0, `missing store guides for ${slug}`);
  }
});

test("every referenced store guide has a title and no duplicates per article", async () => {
  const titles = await read("store-guide-titles.json");
  for (const [slug, guides] of Object.entries(await read("store-guides.json"))) {
    assert.equal(new Set(guides).size, guides.length, `${slug}: duplicate guide link`);
    for (const guide of guides) {
      assert.equal(typeof titles[guide], "string", `${slug}: no title for ${guide}`);
      assert.ok(titles[guide].length > 10, `${slug}: title too short for ${guide}`);
    }
  }
});

test("guide hrefs stay on the store origin", async () => {
  const source = await readFile(new URL("../src/lib/editorial/store-guides.ts", import.meta.url), "utf8");
  assert.match(source, /STORE_ORIGIN/);
  assert.doesNotMatch(source, /https?:\/\/(?!\s)/);
});
