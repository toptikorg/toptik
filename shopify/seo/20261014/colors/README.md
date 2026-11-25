# Product color canonicals, approval only

Prepared against MAIN Shopify theme 186955038970, read 2026-10-14. No Shopify data or theme files have been written. No merge or deployment is authorized.

## Scope and parent selection

The complete 94-family table was produced and opened before code changes in `outputs/seo-pr-review-20261014/color-groups-before-code.html` on Tal's workstation. It uses current published products and Shopify net units sold by SKU, from 2000-01-01 through the query date. Raw sales data stays local and is not committed.

The current 194-row GSC report contains 184 product URLs, eight collections and two blog URLs. Twenty product URLs have no multi-color family in the current catalog. Sixty-six multi-page families intersect the report: 244 pages including their siblings and parents, with exactly **178 child canonical changes** and 66 self-canonical parents. Other families are listed for completeness but are outside this patch. Do not force the historical estimate of 182 by changing unrelated products.

Parent rule: highest-selling currently offered individual color, then black, then neutral, then lexicographic URL. For a sales tie, the same fallback order resolves the tie. A multi-color product's combined sales do not outweigh the best-selling individual color. No sales totals or revenue are published in this PR.

The full child-to-parent table is canonical-map.md and must remain in the PR body. All parents are members of the same verified model/size family. A missing/unpublished parent fails back to the existing canonical instead of producing a dead target.

## Changes

* `theme.patch` contains only the two small layout integration changes against the hashed live baseline.
* Two new snippets provide the explicit family mapping and enrich existing native Product nodes with color and isSimilarTo. Existing ProductGroup variants, offers, price, SKU and image data are preserved.
* `product-updates.json` records exact before/after values. All 244 pages have nonempty SEO title and description. Only missing SEO values are filled; 66 parent descriptions gain a Hebrew sentence listing the offered colors. Applying data changes requires a fresh before-value comparison and Tal approval.
* Direct product pages are scoped using request.path and product.selected_variant. Existing collection-path, `/tag`, and explicit variant alternates retain their previous canonical behavior.
* No noindex, deletion, sitemap, color-picker, price, inventory or publication change.

## Local preparation and rollback

After approval, pull the exact theme to a local directory and run `python shopify/seo/20261014/colors/prepare-theme.py --theme-dir <downloaded-theme>`. It validates the baseline and prepares files locally only. It never uploads anything.

Exact canonical-only rollback command, to run only with release authorization:

`powershell -NoProfile -File shopify/seo/20261014/colors/rollback-canonical.ps1 -ThemeId 186955038970`

This downloads the current layout, checks the exact reviewed canonical block, removes only that block, and uploads only the layout. It preserves subsequent unrelated changes and refuses changed boundaries. Re-read MAIN's ID before release; if Tal changes the active theme, update the reviewed release record and rollback target accordingly. The rollback script has been parsed and its transformation tested locally; it has not been run against Shopify.

## Verification and open gates

2,134 local checks passed, including all 244 canonical cases, protected alternates, missing-parent fallback, all 66 parent schemas and native field preservation. These use captured live JSON, not a production deployment. All 244 pre-change live pages returned 200, and no literal /tag href was found. Seven collection texts were separately checked: 120–180 words, meta 140–155 characters, maximum pairwise token-frequency cosine similarity 38.5%.

Rich Results Test is **not completed**. Opening the local rendered candidate in the connected browser was rejected by its URL security policy. No workaround or deployment was used. The local `rich-results-candidate.html` contains all 66 candidates for an approved code-input check. Local JSON/Liquid tests do not replace Rich Results Test or live verification after approval.

After Tal's approval and deployment: verify every mapped live canonical, parent sentence, SEO fields and schema; confirm customer color navigation is unchanged on desktop/mobile. Do not request URL Inspection or start GSC validation before approval and publication.
