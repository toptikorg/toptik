# Gallery share image (GAL-028)

File: `public/og/toptik-showroom-1200x630.jpg` — 1200×630 JPEG, used as
`og:image` and `twitter:image` for `/carousel` (see `src/app/carousel/page.tsx`).
Public URL after release: `https://landing.toptik.co.il/og/toptik-showroom-1200x630.jpg`.

## What it shows

- The TopTik logo ("TOPTIK — Luggage and Lifestyle"), taken from the existing
  site asset `public/bb-logos/toptik-414.svg` (its embedded 2000×2000 PNG).
- Five real products from the live gallery, each the product's own cover image
  as served by `/api/carousel` on 2026-09-29:

| Position | Catalog number | Brand | Gallery title |
|---|---|---|---|
| 1 | BAH08453.001 | Bric's | מזוודה Bric's Taormina מתרחבת 75 ס״מ בצבע שחור |
| 2 | P10GXV24A32 | Mandarina Duck | טרולי מנדרינה דאק Logoduck+ Glitter בטורקיז נצנצים |
| 3 | KO701007 | Samsonite | מזוודת Samsonite Urbify 78 ס״מ, כחול נייבי |
| 4 | P10JNV05465 | Mandarina Duck | טרולי מנדרינה דאק Smile & Go בצבע פלדה |
| 5 | KJ114001 | Samsonite | מזוודת טרולי Samsonite Upscape 55 ס״מ, ירוק |

## How it was made

Composed in the browser on a plain white 2400×1260 canvas: the logo and the
five cover images were only cropped to their visible edges (the flat white
photo background removed) and scaled uniformly, bottom-aligned in one row.
No recolouring, retouching, generated imagery or placeholder was used. The
result was downscaled to 1200×630 and saved as JPEG (quality 88).

Relative product sizes in the image are not to scale and make no size claim.

## Replacing it

Keep the same path and 1200×630 size, use only the TopTik logo and real
products that are in the gallery, update the table above, and run
`node --test tests/share-metadata.test.mjs`.
