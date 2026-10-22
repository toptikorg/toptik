import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const articles = fs.readFileSync("src/lib/editorial/comparison-articles.tsx", "utf8");
const page = fs.readFileSync("src/app/journal/[slug]/page.tsx", "utf8");

const slugs = [
  "samsonite-intuo-vs-upscape-hard-suitcases",
  "samsonite-hard-vs-soft-intuo-vs-urbify",
  "samsonite-c-lite-curv-vs-intuo-large-suitcases",
  "samsonite-laptop-backpacks-pro-dlx-6-vs-biz2go-vs-guardit",
  "american-tourister-deep-dive-vs-nitestream-soft-luggage",
  "brics-taormina-vs-x-collection-hard-and-soft-luggage",
  "mandarina-duck-trolleys-logoduck-vs-zephyr-vs-eco-coated",
  "mandarina-duck-md20-vs-md20-leather-vs-md20-lux-bags",
  "mandarina-duck-mellow-leather-vs-revival-vs-daisy-bags",
  "underseat-and-wheeled-business-bags-urbify-vs-brics-vs-eco-coated",
];

test("the ten comparison articles are registered with the required clean language", () => {
  for (const slug of slugs) assert.ok(articles.includes(`slug: "${slug}"`), slug);
  assert.equal((articles.match(/slug: "/g) ?? []).length, 10);
  assert.doesNotMatch(articles, /בגובה|—|–/);
  assert.match(page, /title: article\.title,/);
  assert.doesNotMatch(page, /title: `\$\{article\.title\} \|/);
});

test("comparison cards use exact color SKUs instead of Mandarina family prefixes", () => {
  const cardCalls = [...articles.matchAll(/<ArticleProductCards skus=\{\[([^\]]+)\]\}/g)];
  assert.equal(cardCalls.length, 10);
  const familyPrefixes = new Set(["P10QMT39", "P10QMTX5", "P10QMT58", "P10TKTV8", "P10TKTZ4", "P10UYT39", "P10UYTX5", "P10FZT46", "P10FZT12", "P10FZT82", "P10FZP61", "P10OXT01", "P10OXT03", "P10OXT08", "P10UKT01", "P10OXB01"]);
  for (const call of cardCalls) {
    const skus = [...call[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    for (const sku of skus) assert.ok(!familyPrefixes.has(sku), `family prefix used as card SKU: ${sku}`);
  }
});
