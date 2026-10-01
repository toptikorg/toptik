# Ten lifestyle articles — 2026-10-01

User authorized writing, original built-in ChatGPT AI photographs, contextual product cards and publication of all ten gallery magazine articles. Scope excludes Shopify content edits and unrelated synchronization PR #30.

## Content and presentation
- Ten original Hebrew editorial essays in `src/lib/editorial/lifestyle-stories.json`; each has three sections, more than 270 body words, its own title/description and a related article.
- Topics: airport mornings, hotel arrival, family city breaks, evenings on business trips, personal travel style, breakfast, couples with different rhythms, multigenerational holidays, rainy city days, travel notebooks.
- Existing magazine routes, RTL dark/gold styling and server-rendered article body retained. Ten distinct new AI photos with visible disclosure; fictional people, not stock model photos. Image prompts: `lifestyle-images-20261001.json`.
- Original image assets copied into project public directory. Next Image delivers responsive optimized images; archive images lazy-load. No generated image is used as a product photograph.
- Each article embeds one real live catalog product through the existing exact-SKU ArticleProductCards component and its exact Shopify product/variant mapping. No cart action or checkout, no invented product features.
- Existing public sitemap derives its URLs from publishableGalleryArticles and therefore includes the ten new routes after release. Existing indexing and admin restrictions unchanged. Publication is not proof Google indexed/ranked the articles.

## Acceptance
- Local targeted editorial tests and lint passed. Image visual review completed for all ten.
- Full build/CI, Preview and Production results recorded in release evidence and canonical Drive Master after deployment.
- Desktop/mobile browser interaction requires the connected browser. At authoring time the CUA provider timed out; HTTP/HTML checks are not reported as physical-device or click verification.
- Rollback: revert this isolated content release; prior master was 5a6b159 (PR #31, Eco Coated article publication).

## Editorial boundaries
No hotel reviews, invented firsthand visits, airline limits, prices, statistics or medical claims. General original lifestyle advice does not copy manufacturer text. Product cards resolve current identity from the gallery/store mapping. Existing 12 published product articles remain; unresolved Active Lux article stays blocked.
