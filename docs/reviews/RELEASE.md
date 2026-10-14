# Google reviews and branch QR selector, 2026-10-14

Status: verified official URLs configured; Preview QA completed, public release pending. PR 133. Shopify unpublished theme 187020574970, based on MAIN 186955038970.

## Scope and states

- Shared controller: gallery header and floating control, Shopify top navigation and floating control.
- Three branches: Gan HaIr, Ramat Aviv/Brodetsky, Weizmann/Ichilov. Select a branch, show its QR and direct Google link, return to selection.
- Native modal dialog handles keyboard focus isolation and Escape. Close button and backdrop close; restore original scroll and opener focus.
- Hide controls during another dialog, product/specifications modal or open header menu. Hide floating control when its rectangle overlaps an existing interactive control. Mobile offset reserves purchase-bar space.
- The widget never reads or changes the cart, submits a review, requests customer details, loads Google code, or tracks visitors.
- Direct branch/contact-page controls are added beside the matching telephone link. No product content is altered.

## Blocking evidence

Tal supplied all three official links; matched to the exact branch addresses. Weizmann and Ramat opened review forms without submitting reviews. Gan opens its correct profile, but the write-review form is NOT VERIFIED for the signed-in account. Ramat previously displayed a suspension notice; its resolution is NOT VERIFIED.

Correct profiles: Gan resource 3934726923764709179/fid13423412973039537963; Ramat resource486185589586332219/fid4021150738185065028; Weiz resource1977301714706948533/fid9669335285642578791. Do not use the duplicate Gan profile in the personal account.

## Completion sequence

1. Obtain each official g.page review URL from its verified profile; confirm exact branch/address. Fill `src/components/reviews/branches.json`, `qrPath` `/reviews/<id>.svg`, and mark verified only after checking.
2. Run `scripts/reviews/generate-qr.py` with qrcode, pillow and zxing-cpp in an isolated local Python environment. It generates local SVG/PNG codes; decode must exactly match the official URLs. Also decode screenshots of the displayed QR codes.
3. Run `node scripts/reviews/package-shopify.mjs`. This refuses incomplete config/assets. It creates a single Shopify snippet using the same controller and CSS, plus three local Shopify SVG assets, independent of gallery uptime.
4. Run tests/lint/build. Check gallery Preview on desktop/mobile with real products, all three brands, selection, keyboard, backdrop, repeated open/close, scroll recovery, product/specification/brand/category/accessibility overlays and purchase-link navigation. Verify every Google destination without submitting a review.
5. Release gallery under Tal's authorization only after gates pass; verify master commit, Production Ready, actual public rendering and the same acceptance flows. Keep existing robots unchanged.
6. Shopify: snapshot current MAIN first; install candidate only in an unpublished theme, render snippet once before closing body, verify current `#tt-main-nav` exists on desktop/mobile. Test homepage, collection, product, contact, three branch pages, article and cart, including variant selection/add-to-cart without checkout. The connector prohibits MAIN writes and theme publishing. Final MAIN save must be performed manually by the merchant, not bypassed through UI/CLI.
7. After merchant save, compare live source and repeat public desktop/mobile checks. Record exact source hashes, deployment and evidence in canonical Master. Physical iPhone testing is separate.

## Evidence, 2026-10-14

- Full suite: 1713 pass, zero failures. Lint: zero errors, two existing warnings in unrelated SQL verifier. Vercel Preview builds READY. Official Liquid validator: success.
- Official links: Gan `https://g.page/r/CStPZIv6ikm6EBM/review`, Ramat `https://g.page/r/CUQS0plK_803EBM/review`, Weiz `https://g.page/r/CWdL4EI2YTCGEAI/review`.
- Independent QR decode: all three source PNGs and all three Shopify desktop/mobile screenshots match exactly. Gallery desktop screenshots all three exact. See local evidence directory `outputs/google-reviews-20261014` in task workspace.
- Shopify Preview: selector, branch switching, image loading, close/Escape, opener focus; product add-to-cart and test-item removal in desktop and mobile; cart quantity preserved across review dialog; contact and each branch page selects correct branch; collection/article dialog works. Mobile nav suppresses widget; no horizontal overflow in tested cart and modal.
- Gallery Preview: desktop and 390x844, QR/branch selector, product-angle dialog and next image, specifications, accessibility, four brand states, suppression while menus/dialogs open, purchase navigation to exact Shopify SKU/variant, return to gallery.
- Defects found and fixed: stale QR flash on switching branches (hide until load, failure fallback); unreadable gallery header (light text, gold star, separate flex row preserving brand heading).
- User requested label: דרגו אותנו בגוגל, one decorative gold star, aria-hidden. Neutral review request, no rating preselection or incentive.
- Desktop/mobile means browser responsive view; no physical iPhone test. Production verification remains required after publication.

## Rollback

Gallery: revert the eventual release commit, after checking for later changes. Shopify: remove only `{% render 'toptik-google-reviews' %}` from the exact released layout, preserve other work. The feature does not mutate catalog or customer data.
