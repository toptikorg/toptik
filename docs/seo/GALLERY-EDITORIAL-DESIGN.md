# Gallery editorial experience and SEO — design decision

Status: design/research specification; not a production release. Written 2026-09-30.

## What “static” means here

Rendering mode is only an implementation detail: an article is a live, public web page with its own URL and can be opened/shared from any browser. Article copy is authored in the repository, while the article route is dynamically rendered so embedded products are matched to the current active gallery catalog. Each request returns the article and matching product cards in server-rendered HTML; product images still confirm decoding in the browser before their cards are revealed. The `noindex` hold remains independent of rendering mode.

Every article should have an independent URL and complete, useful initial HTML, including its exact active product image and Shopify product link where present. Do not put article content behind a carousel, click-to-load panel, fragment-only route, or client-only placeholder. Keep crawlable navigation as ordinary links (`<a href>`). Google can render JavaScript, but server rendering improves access for crawlers and users and avoids depending on a delayed catalog fetch.

## Existing content and scope

- `/carousel` already contains two server-rendered editorial resources: the 55 cm manufacturer-dimension table by SKU and the Samsonite Intuo comparison. Keep and integrate these; do not duplicate their full copy in separate articles.
- The Shopify store already owns 57 blog articles. The existing article map identifies overlaps, especially cabin baggage, choosing luggage, Samsonite comparisons, and expandable luggage. Gallery articles must have a distinct visual/catalog purpose and must not rewrite those store articles under new URLs.
- The Gallery is not currently a Shopify blog or a bidirectionally synchronized CMS. It is a Next.js/Vercel site. Article content can be maintained in the repository and rendered into live URLs. Store prices, inventory, and checkout remain Shopify-owned; article product cards use the verified SKU-to-product/variant mapping. Do not claim automatic two-way synchronization.
- Keep the present `noindex, follow` hold while authoring and QA are in progress. Do not submit a sitemap, request indexing, or remove the hold in this change. Index release remains its own gate.

## Editorial design: quiet, premium, readable

### Entry point and archive

- Add one restrained, visible text link such as **מגזין** or **מדריכים** below the gallery content/footer area. It must be a real link, not hidden text or a decorative control, and it must not compete with the product gallery or purchase actions.
- Give the archive a calm editorial heading, one short intro, and a simple category selector only if it helps people browse. Show a responsive grid of article cards: image, short category label, concise title, one- or two-line summary. Avoid autoplay, pop-ups, stacked promotional banners, animated counters, and endless keyword blocks.
- Use a conventional paginated or finite archive with crawlable links. Do not rely on infinite scroll to expose article URLs.

### Article page

- Use a restrained editorial column (about 680–760 px on wide screens), generous whitespace, comfortable line length, clear RTL typography, and the existing gallery palette. Keep the product-gallery visual language intact; the article page should feel related but quieter.
- Order: unobtrusive breadcrumb → category/eyebrow → one descriptive H1 → short standfirst → verified update date and realistic reading time → one relevant hero image → article body → at most one or two contextual product cards → short “continue exploring” links.
- Use short paragraphs, meaningful H2/H3 sections, and lists only when they make a comparison or action easier. Avoid repetitive section templates, oversized tables, excessive bolding, decorative quotation blocks, and a “FAQ” appended only to capture keywords.
- Product imagery/cards should appear where the article discusses that exact model. Reuse the gallery's existing product card and link to the exact verified Shopify product/variant in the same tab. The purchase control remains visually clear; an inline text link should not be the only route to the product.
- Add a discreet “חזרה לגלריה” path and preserve browser Back behavior. Add related-article links only when they are genuinely relevant.
- Use official manufacturer pages to verify model, SKU, product name, color, dimensions, materials, and features. Use those pages as the source of facts, not as copy to translate. Link to a manufacturer page inline only where it helps the reader; do not add a noisy source dump. If a fact or exact SKU/color cannot be confirmed, omit it or mark that article blocked.

## SEO and indexing requirements

- Each archive/article URL must return the correct HTTP status and contain its unique title, meta description, self-referencing canonical, visible primary content, and internal navigation in the initial HTML.
- Use `Article`/`BlogPosting` JSON-LD only when its author, headline, image, and publication/modification dates match visible page information. Add `BreadcrumbList` that reflects the visible trail. Structured data can help Google understand a page; it does not guarantee a rich result or ranking.
- Keep all article pages under the current noindex hold during drafting/Preview. At the separately authorized indexing gate, verify canonical host, URL allowlist, robots directives, and the rendered content before adding only approved public archive/article URLs to a sitemap and Search Console.
- Do not expose admin/editor routes or draft-only content as indexable. Do not create tag/filter URLs that generate thin duplicate pages.
- Google's guidance is people-first and explicitly warns against creating many unoriginal pages mainly to manipulate rankings. Therefore “30 articles” is a ceiling/goal for a genuinely useful library, not a reason to publish 30 near-identical SKU/color pages. Each article must pass the evidence and distinct-value gate below. No one can promise high rankings or a particular amount of traffic.

## Minimum publication gate for every article

1. A clear reader question or visual/catalog comparison that is not already answered by a Shopify blog post or another Gallery article.
2. Original Hebrew explanation; no copied or lightly translated manufacturer text.
3. A source ledger with official manufacturer URL(s), exact model/SKU/color, facts used, and last verification date.
4. Any displayed product card matches the exact SKU and color; image has loaded and decoded; product page and variant are checked.
5. One distinct title/H1/meta description/canonical, useful image alt text, and truthful Article/Breadcrumb structured data.
6. Human editorial check for accuracy, accessibility, RTL layout, mobile reading comfort, and premium visual restraint.
7. Production acceptance only after the exact live URL is freshly loaded and checked. A build, saved admin change, or Preview is not proof of publication.

## Release path

1. Finish the overlap/source audit and article inventory against the existing 57 Shopify posts, the two current Gallery resources, and the live SKU catalogue.
2. Design and implement the archive and article template on an isolated branch; keep the product gallery and store untouched.
3. Draft and source-check articles in batches. Publish no unsupported or duplicate page just to reach a count.
4. Run lint/tests/build, then verify each route and product card on Preview at desktop and mobile widths; preserve `noindex`.
5. Release the editorial experience to Production only through the project's explicit deployment workflow.
6. Complete the independent indexing gate later: approved URL list, canonical/alias decision, Search Console, sitemap, and explicit removal of noindex. Recheck every public page after release.

## Google primary sources consulted

- Helpful, reliable, people-first content: https://developers.google.com/search/docs/fundamentals/creating-helpful-content
- JavaScript SEO, links, rendering and canonicals: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- Crawlable links: https://developers.google.com/search/docs/crawling-indexing/links-crawlable
- Structured data and breadcrumb validation: https://developers.google.com/search/docs/appearance/structured-data/breadcrumb
- Spam policies / scaled content abuse: https://developers.google.com/search/docs/essentials/spam-policies
