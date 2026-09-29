# Preview-only product packages

**Decision:** owner, 2026-09-29. Products that exist in the TopTik Shopify store
but not in the gallery database may be prepared as a reviewed package that is
shown **only on a Vercel Preview deployment** (`VERCEL_ENV=preview`). Production
never appends it; nothing writes to Shopify or Supabase.

Code: `src/lib/carousel/preview-packages.ts` (appended in
`src/app/api/carousel/route.ts` after the Samsonite supplement), data:
`src/lib/carousel/american-tourister-preview.json`, purchase links:
`PREVIEW_PACKAGE_VARIANT_IDS` in `purchase-links.ts`. Guard:
`tests/preview-packages.test.mjs`.

## American Tourister package (snapshot 2026-09-29)

Rules applied to every record: real TopTik store photos of the same SKU and
colour only (checked visually), exact Shopify product and variant IDs (cart
permalink, never a guessed link), the maker's specification with its source
URL, Hebrew copy written from the maker's facts without machine translation
(draft for the owner's review), price and stock not copied into the gallery.

- In the package (10): Deep Dive 80 / 68 / 55 cm in Teal/Lime, Navy Blue and
  Black/Grey (maker models 132505 / 132504 / 132503), At Work NXT 17.3"
  (160125-1041).
- Held back (4): Nitestream 77 / 66 / 55 (MJ7014903, MJ7014902L, MJ7014901S)
  and Urban Groove 15.6" (24G09064) — the maker's specification could not be
  verified on 2026-09-29.
- Not added: the checkout test product ("מוצר בדיקת סליקה – 1 ₪",
  EXCLUDED_TEST_PRODUCT); Porsche Design ORI05500.909 / .024 stay hidden
  (HIDDEN_BY_APPROVED_BRAND_POLICY).

The brand appears in the picker only where its items exist, so on Production
(no package) the picker is unchanged. TopTik's American Tourister SKUs start
with the maker's colour code (4815-77TEAL LIME); `modelCodeFromCatalog` ignores
an all-digit head so sizes are never shown as colour swatches.

The Preview shows the package only once the Preview reads gallery data; while
the Preview has no database connection the gallery shows its "unavailable"
message and nothing is appended.
