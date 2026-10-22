import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const expectedTitles = new Map([
  ["samsonite-intuo-sizes-55-69-81", "מזוודות סמסונייט (Samsonite Intuo): ההבדלים בין 55, 69 ו־81 ס״מ"],
  ["samsonite-intuo-55-vs-easy-access", "טרולי סמסונייט Intuo בגודל של 55 ס״מ מול Easy Access: ההבדלים במידות ובנפח"],
  ["samsonite-urbify-55-68-78-dimensions", "מזוודות רכות סמסונייט (Samsonite Urbify): מה משתנה בין 55, 68 ו־78 ס״מ"],
  ["samsonite-c-lite-75-vs-86", "מזוודות סמסונייט C-Lite בגודל של 75 מול 86 ס״מ: מידות, נפח ומבנה Curv"],
  ["samsonite-respark-79-recycled-materials", "מזוודה רכה סמסונייט Respark בגודל של 79 ס״מ: מידות ההרחבה והחומרים"],
  ["brics-taormina-four-sizes-dimensions", "מזוודות וטרולי בריקס (Bric's Taormina): השוואת מידות בין 55, 69, 75 ו־82 ס״מ"],
  ["brics-x-collection-soft-trolley-55-vs-77", "מזוודות רכות בריקס (Bric's X-Collection): טרולי בגודל של 55 ס״מ מול מזוודת 77 ס״מ"],
  ["mandarina-duck-city-bags-compared", "תיקי מנדרינה דאק (Mandarina Duck): השוואת 7 דגמי תיקי גב, כתף וצד ליום בעיר"],
  ["mandarina-duck-pouches-toiletry-compared", "נרתיקים ותיקי רחצה מנדרינה דאק (Mandarina Duck): השוואת OXM04, QMMO1 ו־OSN02"],
  ["mandarina-duck-suitcase-and-weekender", "מזוודה גדולה או תיק נסיעות מנדרינה דאק (Mandarina Duck): השוואת OSV04 ו־OXB01"],
]);

test("base pages use the requested clean metadata and matching H1", async () => {
  const journal = await read("src/app/journal/page.tsx");
  const site = await read("src/lib/seo/site.ts");
  const carousel = await read("src/app/carousel/CarouselPageClient.tsx");
  const accessibility = await read("src/app/accessibility/page.tsx");
  assert.ok(journal.includes("מדריכי השוואת מזוודות, טרולי ותיקים: סמסונייט, בריקס ומנדרינה דאק"));
  assert.ok(journal.includes("טבלאות השוואה ומדריכי בחירה לפי מפרט היצרן: מזוודות קשיחות ורכות, טרולי לעלייה למטוס ותיקי גב וצד של סמסונייט, בריקס, מנדרינה דאק ואמריקן טוריסטר."));
  assert.match(journal, /<h1>\{JOURNAL_TITLE\}<\/h1>/);
  assert.ok(site.includes("קטלוג מזוודות, טרולי ותיקים בתצוגת זוויות: סמסונייט, בריקס ומנדרינה דאק"));
  assert.ok(site.includes("השוו תמונות מכל הזוויות ומפרטי יצרן של מזוודות, טרולי, תיקי גב ותיקי צד מבית סמסונייט, בריקס, מנדרינה דאק ואמריקן טוריסטר, והמשיכו לרכישה בחנות."));
  assert.match(carousel, /<h1 className="collection-title">\{CAROUSEL_VISIBLE_HEADING\}<\/h1>/);
  assert.match(accessibility, /title: "הצהרת נגישות"/);
});

test("the ten requested article titles are exact and the forbidden height phrasing is absent", async () => {
  const gallery = await read("src/lib/editorial/gallery-articles.tsx");
  const mandarina = await read("src/lib/editorial/mandarina-hub-articles.tsx");
  const reviewedCopy = await read("src/lib/carousel/reviewed-copy.json");
  const samsoniteCopy = await read("src/lib/carousel/samsonite-reviewed.json");
  const combined = `${gallery}\n${mandarina}\n${reviewedCopy}\n${samsoniteCopy}`;
  for (const [slug, title] of expectedTitles) {
    assert.ok(combined.includes(`slug: "${slug}"`), slug);
    assert.ok(combined.includes(`title: "${title}"`), title);
  }
  assert.doesNotMatch(combined, /בגובה/);
});

test("thin articles are redirected permanently and excluded from the active inventory", async () => {
  const config = await read("next.config.ts");
  const articles = await read("src/lib/editorial/gallery-articles.tsx");
  const redirects = [
    ["samsonite-pro-dlx6-17-work-trip", "samsonite-laptop-backpacks-pro-dlx-6-vs-biz2go-vs-guardit"],
    ["mandarina-md20-qmtx5-city-day", "mandarina-duck-md20-vs-md20-leather-vs-md20-lux-bags"],
    ["mandarina-fzt73-light-daily-carry", "mandarina-duck-mellow-leather-vs-revival-vs-daisy-bags"],
    ["brics-x-collection-wheeled-pilot-case-bxl38124", "underseat-and-wheeled-business-bags-urbify-vs-brics-vs-eco-coated"],
  ];
  for (const [from, to] of redirects) {
    assert.ok(config.includes(`["${from}", "${to}"]`));
    assert.ok(articles.includes(`"${from}"`));
  }
  assert.match(config, /permanent: true/);
  assert.match(articles, /!THIN_CONTENT_REDIRECT_SLUGS\.has\(article\.slug\)/);
});

test("journal priority, store subcategories and carousel index dedupe are explicit", async () => {
  const journal = await read("src/app/journal/page.tsx");
  const categories = await read("src/lib/editorial/store-categories.ts");
  const index = await read("src/components/carousel/CarouselStoreIndex.tsx");
  for (const category of ["השוואת דגמים", "השוואת מידות וארגון", "מידות לפי סדרה", "תיקים ליום יום ולעבודה"])
    assert.ok(journal.includes(`["${category}",`));
  for (const handle of ["מזוודות-קשיחות", "מזוודות-רכות", "מזוודות-גדולות", "מזוודות-בינוניות", "תיקי-גב-למחשב"])
    assert.ok(categories.includes(`collection("${handle}"`));
  assert.match(categories, /const FALLBACK:[\s\S]*collection\("מזוודות", "מזוודות"\)/);
  assert.match(index, /seenHrefs\.has\(hrefKey\)/);
  assert.match(index, /seenTitles\.has\(titleKey\)/);
  assert.match(index, /purchaseUrl\.split\("\?"\)\[0\]/);
});
