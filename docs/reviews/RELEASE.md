# Google reviews and branch QR selector, 2026-10-14

Status: code prepared, NOT RELEASED. Three official Google review URLs are missing. Never deploy sample links.

## Scope and states

- Shared controller: gallery header and floating control, Shopify top navigation and floating control.
- Three branches: Gan HaIr, Ramat Aviv/Brodetsky, Weizmann/Ichilov. Select a branch, show its QR and direct Google link, return to selection.
- Native modal dialog handles keyboard focus isolation and Escape. Close button and backdrop close; restore original scroll and opener focus.
- Hide controls during another dialog, product/specifications modal or open header menu. Hide floating control when its rectangle overlaps an existing interactive control. Mobile offset reserves purchase-bar space.
- The widget never reads or changes the cart, submits a review, requests customer details, loads Google code, or tracks visitors.
- Direct branch/contact-page controls are added beside the matching telephone link. No product content is altered.

## Blocking evidence

Google Business account info@toptik.co.il shows all three verified locations. Request-reviews popup stayed blank; direct popup navigation was rejected by the browser URL security policy. No alternate route attempted. Tal has been asked for the three official links.

Correct profiles: Gan resource 3934726923764709179/fid13423412973039537963; Ramat resource486185589586332219/fid4021150738185065028; Weiz resource1977301714706948533/fid9669335285642578791. Do not use the duplicate Gan profile in the personal account.

## Completion sequence

1. Obtain each official g.page review URL from its verified profile; confirm exact branch/address. Fill `src/components/reviews/branches.json`, `qrPath` `/reviews/<id>.svg`, and mark verified only after checking.
2. Run `scripts/reviews/generate-qr.py` with qrcode, pillow and zxing-cpp in an isolated local Python environment. It generates local SVG/PNG codes; decode must exactly match the official URLs. Also decode screenshots of the displayed QR codes.
3. Run `node scripts/reviews/package-shopify.mjs`. This refuses incomplete config/assets. It creates a single Shopify snippet using the same controller and CSS, with QR assets served from the gallery.
4. Run tests/lint/build. Check gallery Preview on desktop/mobile with real products, all three brands, selection, keyboard, backdrop, repeated open/close, scroll recovery, product/specification/brand/category/accessibility overlays and purchase-link navigation. Verify every Google destination without submitting a review.
5. Release gallery under Tal's authorization only after gates pass; verify master commit, Production Ready, actual public rendering and the same acceptance flows. Keep existing robots unchanged.
6. Shopify: snapshot current MAIN first; install candidate only in an unpublished theme, render snippet once before closing body, verify current `#tt-main-nav` exists on desktop/mobile. Test homepage, collection, product, contact, three branch pages, article and cart, including variant selection/add-to-cart without checkout. The connector prohibits MAIN writes and theme publishing. Final MAIN save must be performed manually by the merchant, not bypassed through UI/CLI.
7. After merchant save, compare live source and repeat public desktop/mobile checks. Record exact source hashes, deployment and evidence in canonical Master. Physical iPhone testing is separate.

## Evidence so far

- Local fixture only, clearly labeled; three deliberately non-production test URLs. Actual pointer selection for all three branches passed desktop/390x844, QR images loaded, Escape and opener restoration passed, product dialog/menu suppression passed, no mobile horizontal overflow.
- Fixture QR encoder/independent PNG decoder: 3/3 exact. Production QR and Google endpoints: NOT TESTED.
- Full initial code suite: 1713 passed; lint 0 errors/2 pre-existing warnings; production build passed. Initial missing liquidjs in reused node_modules resolved for tests via isolated NODE_PATH dependency, without changing shared node_modules or lockfile.
- Shopify Preview, live gallery, live store and real cart regression: NOT TESTED. No claim of completion.

## Rollback

Gallery: revert the eventual release commit, after checking for later changes. Shopify: remove only `{% render 'toptik-google-reviews' %}` from the exact released layout, preserve other work. The feature does not mutate catalog or customer data.
