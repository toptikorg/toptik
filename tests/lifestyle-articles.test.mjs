import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const read = (p) => readFile(new URL(`../${p}`, import.meta.url));
const stories = JSON.parse(await read("src/lib/editorial/lifestyle-stories.json"));
const pages = JSON.parse(await read("src/lib/carousel/store-product-pages.json"));
test("ten original lifestyle essays have distinct routes, images and contextual products", async () => {
  assert.equal(stories.length, 10);
  assert.equal(new Set(stories.map(s => s.slug)).size, 10);
  assert.equal(new Set(stories.map(s => s.image)).size, 10);
  const hashes = [];
  for (const s of stories) {
    assert.equal(s.sections.length, 3);
    const words = s.sections.flatMap(x => x.paragraphs).join(" ").split(/\s+/).length;
    assert.ok(words >= 270, `${s.slug}: substantive editorial text (${words})`);
    assert.ok(stories.some(x => x.slug === s.related));
    assert.ok(s.title && s.description && s.alt && s.productIntro);
    const key = s.productSku.replace(/[^A-Z0-9]/g, "").replace(/TU$/, "");
    assert.ok(pages[key]?.handle && pages[key]?.variant, `exact product mapping: ${s.productSku}`);
    const image = await read(`public/images/journal/lifestyle-20261001/${s.image}.png`);
    assert.equal(image.subarray(1, 4).toString(), "PNG");
    assert.equal(image.readUInt32BE(16), 1536);
    assert.equal(image.readUInt32BE(20), 1024);
    hashes.push(createHash("sha256").update(image).digest("hex"));
  }
  assert.equal(new Set(hashes).size, 10, "new distinct image assets, no reuse");
});
test("lifestyle articles join public inventory, render server cards and disclose AI imagery", async () => {
  const module = (await read("src/lib/editorial/lifestyle-articles.tsx")).toString();
  const inventory = (await read("src/lib/editorial/gallery-articles.tsx")).toString();
  const route = (await read("src/app/journal/[slug]/page.tsx")).toString();
  assert.match(inventory, /\.\.\.lifestyleArticles/);
  assert.match(module, /ArticleProductCards skus=\{\[story.productSku\]\}/);
  assert.match(module, /בינה מלאכותית/);
  assert.match(module, /publishedAt: "2026-10-01"/);
  assert.match(route, /image: absoluteUrl\(article.hero.src\)/);
  assert.match(route, /<figcaption>\{article.hero.caption\}<\/figcaption>/);
});
