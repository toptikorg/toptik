# Colour names — closed allowlist

**Decision:** owner, 2026-09-29 (GAL-009 colour rule). A fixed table may turn a
manufacturer colour code or colour value into a Hebrew colour name, under these
conditions. Code: `src/lib/carousel/color-names.ts`. Guard:
`tests/color-names.test.mjs`.

## Rules

1. Map only a **full** code or a **full, exact** value.
2. Never split a colour into words and map each word.
3. No partial match (no "contains", prefix, suffix or token scan).
4. Never apply the table to a title, sentence, description or other free text.
5. Every mapping is an explicit entry in the allowlist.
6. Every entry has a documented source (`source` field).
7. An unknown code or value stays exactly as received and is flagged for review
   (`named: false`, `needsReview: true`).
8. No guessing.
9. No Google Translate and no external service — the module has no imports and
   no network access.
10. A test proves only full, defined values are mapped.
11. A test proves free text never passes through the table.
12. The original code/value is returned next to the Hebrew name (`sourceValue`;
    persisted colours carry `sourceValue` as well as `colorCode`).

Normalisation is limited to trimming, upper-casing codes, lower-casing values
and collapsing repeated spaces. Nothing else is accepted.

## Tables

| Table | Key | Used for |
|---|---|---|
| `MANDARINA_COLOR_CODES` | Mandarina colour code (P10SZV24-`05J`-TU) | gallery swatches, Mandarina import, Shopify export |
| `BRICS_COLOR_BY_SKU` | full Bric's / Porsche Design SKU `MODEL.CODE` | gallery swatches, Bric's import fallback, Shopify export |
| `COLOR_VALUE_NAMES` | the maker's complete colour value (Shopify "Color" option) | Bric's import, spec colour swatch fill |

Bric's colour suffixes are **not** global: `001` is *Black* on Taormina but
*Black Matte* on the Porsche Design Roadster. That is why Bric's / Porsche
Design entries are keyed by the full SKU, and a suffix alone never maps.
Mandarina colour codes are global (the maker uses `05J` for Duck Yellow across
models), so they are keyed by code.

## Sources (checked 2026-09-29)

Each Hebrew name is the one already used in the owner-reviewed TopTik catalog —
the reviewed gallery title and/or the TopTik Shopify title of the SKU. The
maker's own colour name comes from bricstore.com (Shopify product JSON),
huntleather.com or mandarinaduck.com. The exact note per entry is in the
`source` field. Two entries carry an open conflict for the owner (A83 Choco Ice
/ שוקולד, A81 White Mocha / מוקה לבן): the Shopify title uses the Hebrew name,
the reviewed gallery title keeps the maker's English name.

## Removed on 2026-09-29 (no documented source)

Mandarina `09K` taupe, `024` pirite, `A74` oil, `29U` graphite, `A93` diva,
`651` black, `07X` deep blue, `02F` emerald, `24N` pearl, `A82` pecan nut;
Bric's code-only entries `014` cream and `254` pink; the generic English
colour-word → Hebrew map (`COLOR_HEBREW`) and its hex map. None of these codes
is used by a product in the catalog. A future product with one of them shows
its original code, flagged for review, until an entry with a documented source
is added.

## Adding an entry

1. Confirm the code/value on the maker's own page for that exact SKU.
2. Use the Hebrew name the owner approved for that SKU (reviewed title), never
   a new translation.
3. Add the entry with a `source` note (maker page + SKU + date + where the
   Hebrew name is used) and run `npm test`.
