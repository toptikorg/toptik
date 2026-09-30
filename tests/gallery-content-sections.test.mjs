import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const collectionPage = await read("src/app/carousel/page.tsx");
const teasers = await read("src/components/carousel/GalleryContentSections.tsx");
const articles = await read("src/lib/editorial/gallery-articles.tsx");
const articlePage = await read("src/app/journal/[slug]/page.tsx");

test("the gallery links to the journal through ordinary crawlable links", () => {
  assert.match(collectionPage, /<CarouselPageClient\s*\/>\s*<GalleryContentSections\s*\/>/);
  assert.doesNotMatch(teasers, /"use client"/);
  assert.match(teasers, /href="\/journal"/);
  assert.ok(teasers.includes('href={`/journal/${article.slug}`}'), "each teaser links to its canonical article route");
  for (const slug of ["samsonite-carry-on-55-sku-dimensions", "samsonite-intuo-55-vs-easy-access"]) {
    assert.match(articles, new RegExp(`slug: "${slug}"`));
  }
});

test("the moved 55 cm reference retains exactly the 20 verified gallery SKUs", () => {
  const rows = articles.match(/const CARRYON_55_ROWS = \[([\s\S]*?)\] as const/)?.[1];
  assert.ok(rows, "55 cm rows are stored in the article source");
  const skus = [...rows.matchAll(/\["([A-Z0-9]+)"/g)].map(match => match[1]);
  const expected = [
    "KL909001", "KL901001", "KL924001", "KL966001", "KL974001",
    "KL909005", "KL901005", "KL924005", "KL966005", "KL974005",
    "KJ109001", "KJ111001", "KJ114001", "KJ106001", "KJ114007", "KJ106007",
    "KO709005", "KO701005", "KO704005", "KO776005",
  ];
  assert.deepEqual(skus, expected);
  assert.equal(new Set(skus).size, 20);
  assert.doesNotMatch(rows, /P10JNV|P10GXV/);
});

test("published product specifications contain no unverified weights or public source dump", () => {
  assert.doesNotMatch(articles, /\d+(?:\.\d+)?\s*ק״ג|\d+(?:\.\d+)?\s*kg/i);
  assert.doesNotMatch(articles, /<th scope="row">משקל<\/th>/, "public article tables do not show a weight row");
  assert.doesNotMatch(teasers, /מקורות|בדקנו את המקורות/i);
  assert.doesNotMatch(articles, /מקורות הנתונים|אומת 30\.09\.2026/, "no editorial process note is rendered to visitors");
  assert.match(articles, /sourceUrls: \[/);
  assert.ok(!/https:\/\/(?!www\.toptik\.co\.il|www\.samsonite\.(?:de|fi|co\.uk|com\.au)|www\.bricsmilano\.com|mandarinaduck\.com)/.test(articles), "facts link only to manufacturer pages or the store");
});

test("contextual product cards are server-selected by exact active SKU and safe store mapping", async () => {
  const card = await read("src/components/carousel/ArticleProductCard.tsx");
  const serverCards = await read("src/components/editorial/ArticleProductCards.tsx");
  const publicPayload = await read("src/lib/carousel/public-payload.ts");
  const carouselRoute = await read("src/app/api/carousel/route.ts");
  assert.match(serverCards, /await getPublicCarouselPayload\(\)/);
  assert.match(carouselRoute, /getPublicCarouselPayload\(\)/);
  assert.match(publicPayload, /getCarouselPayload\(\{ includeInactive: true \}\)/);
  assert.match(publicPayload, /appendSamsoniteItems\(payload\.items\)\.filter\(\(item\) => item\.isActive\)/);
  assert.match(serverCards, /normalizeCatalogKey\(candidate\.catalogNumber\) === key/);
  assert.match(serverCards, /matches\.length === 1 \? matches\[0\] : undefined/);
  assert.match(serverCards, /purchaseUrlFor\(item\.catalogNumber, item\.shopifyLink\)/);
  assert.match(card, /if \(!purchaseUrl \|\| hidden\) return null;/);
  assert.match(card, /interactive=\{false\}/);
  assert.doesNotMatch(card, /ProductModal|TechSpecsModal/);
  assert.doesNotMatch(card, /fetch\("\/api\/carousel"\)/);
  for (const sku of ["KL909001", "KJ109001", "KO709005", "KL909005", "BXL38124078"]) assert.ok(articles.includes(`"${sku}"`));
});

test("journal article routes have live URLs, canonical metadata and truthful schema", () => {
  assert.match(articlePage, /export const dynamicParams = false/);
  assert.match(articlePage, /export const dynamic = "force-dynamic"/);
  assert.match(articlePage, /generateStaticParams/);
  assert.match(articlePage, /alternates:\s*\{\s*canonical:/);
  assert.match(articlePage, /@type": "Article"/);
  assert.match(articlePage, /@type": "BreadcrumbList"/);
  assert.match(articlePage, /<div className=\{styles\.articleBody\}>\{article\.content\}<\/div>/);
  assert.match(articlePage, /<Link className=\{styles\.backLink\} href="\/carousel">/);
  assert.doesNotMatch(articlePage, /robots\s*:\s*\{\s*index\s*:\s*true/);
  assert.match(articles, /slug: "samsonite-intuo-sizes-55-69-81"/);
  assert.match(articles, /KL909002/);
  assert.match(articles, /KL909004/);
  assert.match(articles, /slug: "brics-x-collection-wheeled-pilot-case-bxl38124"/);
  assert.match(articles, /descriptionOverrides=\{\{ KJ344007:/, "the Respark article card uses its article-safe, manufacturer-verified summary");
  assert.doesNotMatch(articles, /3\.6\s*ק״ג/, "the Respark article must not inherit the catalog's weight claim");
  const slugs = [...articles.matchAll(/slug: "([^"]+)"/g)].map((match) => match[1]);
  assert.equal(slugs.length, 13, "thirteen distinct evidence-backed article drafts are in the editorial inventory");
  assert.equal(new Set(slugs).size, slugs.length);
  for (const slug of ["brics-taormina-four-sizes-dimensions", "brics-x-collection-soft-trolley-55-vs-77", "samsonite-urbify-55-68-78-dimensions", "mandarina-logoduck-metal-trolley-beauty-case", "mandarina-eco-coated-large-interior-map", "mandarina-active-lux-shopper-pocket-layout", "brics-taormina-55-interior-and-features", "samsonite-c-lite-75-vs-86"]) {
    assert.ok(slugs.includes(slug), `missing drafted article ${slug}`);
  }
  assert.ok(slugs.includes("samsonite-respark-79-recycled-materials"));
  assert.match(articles, /sourceUrls: \["https:\/\/www\.bricsmilano\.com\//);
});

test("articles without a verified Shopify destination stay out of the public archive and routes", async () => {
  const archive = await read("src/app/journal/page.tsx");
  assert.match(articles, /releaseBlocker: "אין מיפוי מאומת לעמוד מוצר Shopify של המק״ט P10OSV04-05J-TU\./);
  assert.match(articles, /releaseBlocker: "אין מיפוי מאומת לעמוד מוצר Shopify של המק״ט P10ZJT06-24U-TU\./);
  assert.match(articles, /publishableGalleryArticles = galleryArticles\.filter\(\(article\) => !article\.releaseBlocker\)/);
  assert.match(archive, /publishableGalleryArticles\.map/);
  assert.match(articlePage, /return publishableGalleryArticles\.map\(\(\{ slug \}\) => \(\{ slug \}\)\)/);
  assert.match(articles, /return publishableGalleryArticles\.find\(\(article\) => article\.slug === slug\)/);
});

test("every article product card has an exact verified store mapping or a publication blocker", async () => {
  const pages = JSON.parse(await read("src/lib/carousel/store-product-pages.json"));
  const variants = JSON.parse(await read("src/lib/carousel/samsonite-variants.json"));
  const purchaseLinks = await read("src/lib/carousel/purchase-links.ts");
  const variantIds = { ...variants };
  for (const [, key, id] of purchaseLinks.matchAll(/^\s{2}([A-Z0-9]+): "(\d+)"/gm)) variantIds[key] = id;

  const blockedKeys = new Set(
    [...articles.matchAll(/releaseBlocker: "[^"]*מק״ט ([A-Z0-9.-]+)\./g)]
      .map(([, sku]) => sku.replace(/[^A-Z0-9]/gi, "").replace(/TU$/i, "").toUpperCase()),
  );
  const cardSkus = [...articles.matchAll(/<ArticleProductCards\s+skus=\{\[([^\]]*)\]\}\s*\/>/g)]
    .flatMap(([, list]) => [...list.matchAll(/"([A-Z0-9.-]+)"/g)].map(([, sku]) => sku));

  for (const sku of cardSkus) {
    const key = sku.replace(/[^A-Z0-9]/gi, "").replace(/TU$/i, "").toUpperCase();
    if (!pages[key]) {
      assert.ok(blockedKeys.has(key), `${sku} has no verified Shopify page and must block its article`);
      continue;
    }
    assert.ok(variantIds[key], `${sku} has a store page but no verified variant ID`);
    assert.equal(pages[key].variant, variantIds[key], `${sku} page must target the exact mapped variant`);
  }
});

test("article tables remain readable on mobile with labeled horizontal scroll regions", () => {
  assert.match(articles, /role="region" aria-label="מידות יצרן לפי מק״ט" tabIndex=\{0\}/);
  assert.match(articles, /role="region" aria-label="צבעי Intuo 55 לפי מק״ט" tabIndex=\{0\}/);
  assert.match(articles, /<caption>/);
});
