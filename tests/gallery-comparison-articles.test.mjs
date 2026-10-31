import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const articles = fs.readFileSync("src/lib/editorial/comparison-articles.tsx", "utf8");
const page = fs.readFileSync("src/app/journal/[slug]/page.tsx", "utf8");
const reviewedSeries = JSON.parse(fs.readFileSync("src/lib/carousel/series-reviewed.json", "utf8"));
const storeGuides = JSON.parse(fs.readFileSync("src/lib/editorial/store-guides.json", "utf8"));
const journal = fs.readFileSync("src/app/journal/page.tsx", "utf8");
const sitemap = fs.readFileSync("src/app/sitemap.ts", "utf8");

const slugs = [
  "samsonite-intuo-vs-upscape-hard-suitcases",
  "samsonite-hard-vs-soft-intuo-vs-urbify",
  "samsonite-c-lite-curv-vs-intuo-large-suitcases",
  "samsonite-laptop-backpacks-pro-dlx-6-vs-biz2go-vs-guardit",
  "american-tourister-urban-groove-ug16-vs-ug25-backpacks",
  "american-tourister-deep-dive-vs-nitestream-soft-luggage",
  "brics-taormina-vs-x-collection-hard-and-soft-luggage",
  "mandarina-duck-trolleys-logoduck-vs-zephyr-vs-eco-coated",
  "mandarina-duck-md20-vs-md20-leather-vs-md20-lux-bags",
  "mandarina-duck-mellow-leather-vs-revival-vs-daisy-bags",
  "underseat-and-wheeled-business-bags-urbify-vs-brics-vs-eco-coated",
];

test("the comparison articles are registered with the required clean language", () => {
  for (const slug of slugs) assert.ok(articles.includes(`slug: "${slug}"`), slug);
  assert.equal((articles.match(/slug: "/g) ?? []).length, slugs.length);
  assert.doesNotMatch(articles, /בגובה|—|–/);
  assert.match(page, /title: article\.title,/);
  assert.doesNotMatch(page, /title: `\$\{article\.title\} \|/);
});

test("comparison articles have strong crawl paths and current sitemap dates", () => {
  for (const slug of slugs) {
    assert.ok(Array.isArray(storeGuides[slug]) && storeGuides[slug].length > 0, `${slug}: missing store guide links`);
  }
  assert.match(journal, /comparisonArticles\.map/);
  assert.match(journal, /data-journal-comparison-links/);
  assert.match(sitemap, /lastModified: latestArticleUpdate/);
  assert.match(articles, /updatedAt: "2026-10-31"/);
});

test("comparison cards use exact color SKUs instead of Mandarina family prefixes", () => {
  const cardCalls = [...articles.matchAll(/<ArticleProductCards skus=\{\[([^\]]+)\]\}/g)];
  assert.equal(cardCalls.length, slugs.length);
  const familyPrefixes = new Set(["P10QMT39", "P10QMTX5", "P10QMT58", "P10TKTV8", "P10TKTZ4", "P10UYT39", "P10UYTX5", "P10FZT46", "P10FZT12", "P10FZT82", "P10FZP61", "P10OXT01", "P10OXT03", "P10OXT08", "P10UKT01", "P10OXB01"]);
  for (const call of cardCalls) {
    const skus = [...call[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    for (const sku of skus) assert.ok(!familyPrefixes.has(sku), `family prefix used as card SKU: ${sku}`);
  }
});

test("the ten newly added products have article cards and reviewed series mappings", () => {
  const expected = {
    KR209001: "samsonite-guardit-3-0",
    KR209002: "samsonite-guardit-3-0",
    KR201001: "samsonite-guardit-3-0",
    KF909003: "samsonite-mysight",
    KF901003: "samsonite-mysight",
    "24G09048": "american-tourister-urban-groove",
    "24G09057": "american-tourister-urban-groove",
    "24G54057": "american-tourister-urban-groove",
    "24GA4057": "american-tourister-urban-groove",
    "24G77057": "american-tourister-urban-groove",
  };

  for (const [sku, series] of Object.entries(expected)) {
    assert.match(articles, new RegExp(`\\"${sku}\\"`), `${sku} is missing from an article card`);
    assert.equal(reviewedSeries[sku]?.key, series, `${sku} has the wrong gallery series`);
  }
});
