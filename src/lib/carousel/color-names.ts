// Closed colour-name allowlist — owner decision 2026-09-29 (GAL-009 colour rule).
//
// This is the ONLY place that turns a manufacturer colour code or colour value
// into a Hebrew colour name. Rules (docs/COLOR-NAMES.md):
//   1. Lookup by a FULL code or a FULL, exact value only.
//   2. Never split a colour into words and map each word.
//   3. Never match partially (no "contains", no prefix, no token scan).
//   4. Never used on a title, sentence, description or any free text.
//   5. Every mapping is an explicit entry below.
//   6. Every entry documents its source.
//   7. An unknown code or value is returned unchanged and flagged for review.
//   8. No guessing: a Bric's colour code is only trusted for the models it was
//      verified on, because the same suffix means different colours in
//      different collections (001 = Black on Taormina, Black Matte on Porsche).
//   9. No external service, no network, no machine translation.
//  12. The original code/value is always returned next to the Hebrew name.
// tests/color-names.test.mjs enforces these rules.

export interface ColorNameEntry {
  he: string; // Hebrew display name
  hex: string | null; // approximate swatch fill; null when none was approved
  source: string; // where the code/value and the Hebrew name come from
}

export interface ColorNameResult {
  name: string; // Hebrew name, or the original code/value when not in the allowlist
  hex: string | null;
  named: boolean; // true only for an exact allowlist hit
  needsReview: boolean; // an input was given but is not in the allowlist
  sourceValue: string | null; // the code/value exactly as received (trimmed)
}

// Mandarina Duck global colour codes — the colour segment of the catalog number
// (P10·JNV05·`465` / P10SZV24-`05J`-TU). Mandarina uses the same code for the
// same colour across models (05J Duck Yellow on SZV24 and OSV03/OSV04).
export const MANDARINA_COLOR_CODES: Readonly<Record<string, ColorNameEntry>> = {
  "465": {
    he: "פלדה",
    hex: "#6e7b8b",
    source:
      "TopTik SKU P10JNV05465 (Smile & Go): Hebrew name in the reviewed gallery title and in the Shopify title. Manufacturer name for 465 not found on mandarinaduck.com (search, 2026-09-29).",
  },
  "08Q": {
    he: "כחול",
    hex: "#1a2d5a",
    source:
      "Mandarina Duck colour 'Dress Blue' = code 08Q (e.g. OTV0108Q, mandarinaduck.com, 2026-09-29). TopTik SKU P10JNV0508Q: reviewed gallery title and Shopify title use 'כחול'.",
  },
  "05J": {
    he: "צהוב",
    hex: "#f0c040",
    source:
      "Mandarina Duck colour 'Duck Yellow' = code 05J (SZV2405J, OSV0305J, mandarinaduck.com, 2026-09-29). TopTik SKUs P10SZV24-05J-TU, P10OSV04-05J-TU: reviewed gallery titles; Shopify title of P10SZV2405J uses 'צהוב'.",
  },
  A32: {
    he: "טורקיז נצנצים",
    hex: "#3fb8ae",
    source:
      "TopTik SKU P10GXV24A32 (Logoduck+ Glitter): reviewed gallery title and Shopify title use 'טורקיז נצנצים'. Manufacturer colour name not verified (2026-09-29).",
  },
  A83: {
    he: "שוקולד",
    hex: "#6b4b3e",
    source:
      "Mandarina Duck colour 'Choco Ice' = code A83 (source URL …choco-ice-szv24a83 stored with TopTik SKU P10SZV24-A83-TU). 'שוקולד' is the TopTik Shopify title; the reviewed gallery title keeps 'Choco Ice' — open conflict for the owner.",
  },
  A81: {
    he: "מוקה לבן",
    hex: "#d9cdbf",
    source:
      "Mandarina Duck colour 'White Mocha' = code A81 (SZV32A81, mandarinaduck.com, 2026-09-29; source URL …white-mocha-szv24a81 of TopTik SKU P10SZV24-A81-TU). 'מוקה לבן' is the TopTik Shopify title; the reviewed gallery title keeps 'White Mocha' — open conflict for the owner.",
  },
  A92: {
    he: "מוארה",
    hex: "#6b6f76",
    source:
      "Mandarina Duck colour 'Moire' = code A92 (source URLs …moire-ujv24a92, …moire-ujn01a92). TopTik SKUs P10UJV24-A92-TU, P10UJN01-A92-TU: reviewed gallery titles and Shopify titles use 'מוארה'.",
  },
  A89: {
    he: "לונר",
    hex: "#b8b8c0",
    source:
      "Mandarina Duck colour 'Lunar' = code A89 (source URLs …lunar-ouv24a89, …lunar-oun01a89). TopTik SKUs P10OUV24-A89-TU, P10OUN01-A89-TU: reviewed gallery titles and Shopify titles use 'לונר'.",
  },
};

// Bric's / Porsche Design colours, keyed by the FULL SKU (8-char model + "." +
// 3-digit colour code). Only SKUs verified against the maker's own store.
export const BRICS_COLOR_BY_SKU: Readonly<Record<string, ColorNameEntry>> = {
  "BAH08451.001": {
    he: "שחור",
    hex: "#1a1a1a",
    source:
      "bricstore.com Taormina Expandable Carry-On: SKU BAH08451.001 Color 'Black' (2026-09-29). Reviewed gallery title and Shopify title use 'שחור'.",
  },
  "BAH08453.001": {
    he: "שחור",
    hex: "#1a1a1a",
    source:
      "bricstore.com Taormina Expandable Checked: SKU BAH08453.001 Color 'Black' (2026-09-29). Reviewed gallery title and Shopify title use 'שחור'.",
  },
  "BAH08453.006": {
    he: "כחול",
    hex: "#1f3a6e",
    source:
      "bricstore.com Taormina Expandable Checked: SKU BAH08453.006 Color 'Blue' (2026-09-29). Reviewed gallery title and Shopify title use 'כחול'.",
  },
  "BAH08453.078": {
    he: "זית",
    hex: "#6b6f4a",
    source:
      "bricstore.com Taormina Expandable Checked: SKU BAH08453.078 Color 'Olive' (2026-09-29). Reviewed gallery title and Shopify title use 'זית'.",
  },
  "BAH08454.001": {
    he: "שחור",
    hex: "#1a1a1a",
    source:
      "bricstore.com Taormina Expandable Checked: SKU BAH08454.001 Color 'Black' (2026-09-29). Reviewed gallery title and Shopify title use 'שחור'.",
  },
  "BXL58117.101": {
    he: "שחור",
    hex: "#1a1a1a",
    source:
      "bricstore.com X-Collection Carry-On: SKU BXL58117.101 Color 'Black' (2026-09-29). Reviewed gallery title and Shopify title use 'שחור'.",
  },
  "BXL58145.101": {
    he: "שחור",
    hex: "#1a1a1a",
    source:
      "bricstore.com X-Collection Checked: SKU BXL58145.101 Color 'Black' (2026-09-29). Reviewed gallery title and Shopify title use 'שחור'.",
  },
  "BXL58145.050": {
    he: "נייבי",
    hex: "#1c2a4a",
    source:
      "bricstore.com X-Collection Checked: SKU BXL58145.050 Color 'Navy' (2026-09-29). Reviewed gallery title and Shopify title use 'נייבי'.",
  },
  "BXL58145.078": {
    he: "זית",
    hex: "#6b6f4a",
    source:
      "bricstore.com X-Collection Checked: SKU BXL58145.078 Color 'Olive' (2026-09-29). Reviewed gallery title and Shopify title use 'זית'.",
  },
  "BXL38124.101": {
    he: "שחור",
    hex: "#1a1a1a",
    source:
      "huntleather.com 'Bric's X-Travel Pilot Cabin Case - Black', SKU BXL38124101 (2026-09-29). Reviewed gallery title and Shopify title use 'שחור'.",
  },
  "BXL38124.078": {
    he: "זית",
    hex: "#6b6f4a",
    source:
      "huntleather.com 'Bric's X-Travel Pilot Cabin Case - Olive', SKU BXL38124078 (2026-09-29). Reviewed gallery title and Shopify title use 'זית'.",
  },
  "ORI05500.909": {
    he: "שחור מבריק",
    hex: null,
    source:
      "bricstore.com Porsche Carry-On: SKU ORI05500.909 Color 'Shiny Black' (2026-09-29). Reviewed gallery title and Shopify title use 'שחור מבריק'.",
  },
  "ORI05500.024": {
    he: "צהוב רייסינג",
    hex: null,
    source:
      "bricstore.com Porsche Carry-On: SKU ORI05500.024 Color 'Racing Yellow' (2026-09-29). Reviewed gallery title and Shopify title use 'צהוב רייסינג'.",
  },
};

// Exact, complete colour VALUES as the maker publishes them in a structured
// colour field (Shopify "Color" option on bricstore.com, the colour segment of
// a huntleather.com title). Keys are the value lower-cased with spaces
// collapsed — the whole value, never a word inside it.
export const COLOR_VALUE_NAMES: Readonly<Record<string, ColorNameEntry>> = {
  black: {
    he: "שחור",
    hex: "#1a1a1a",
    source: "Bric's Color option 'Black' (BAH08451.001, BAH08453.001, BXL58145.101, bricstore.com 2026-09-29); TopTik titles use 'שחור'.",
  },
  blue: {
    he: "כחול",
    hex: "#1f3a6e",
    source: "Bric's Color option 'Blue' (BAH08453.006, bricstore.com 2026-09-29); TopTik titles use 'כחול'.",
  },
  olive: {
    he: "זית",
    hex: "#6b6f4a",
    source: "Bric's Color option 'Olive' (BAH08453.078, BXL58145.078, bricstore.com 2026-09-29); TopTik titles use 'זית'.",
  },
  navy: {
    he: "נייבי",
    hex: "#1c2a4a",
    source: "Bric's Color option 'Navy' (BXL58145.050, bricstore.com 2026-09-29); TopTik titles use 'נייבי'.",
  },
  "shiny black": {
    he: "שחור מבריק",
    hex: null,
    source: "Porsche Design Color option 'Shiny Black' (ORI05500.909, bricstore.com 2026-09-29); TopTik titles use 'שחור מבריק'.",
  },
  "racing yellow": {
    he: "צהוב רייסינג",
    hex: null,
    source: "Porsche Design Color option 'Racing Yellow' (ORI05500.024, bricstore.com 2026-09-29); TopTik titles use 'צהוב רייסינג'.",
  },
};

// Own-key test that also runs on older browsers (Object.prototype form).
function has(table: Readonly<Record<string, ColorNameEntry>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function hit(entry: ColorNameEntry, sourceValue: string): ColorNameResult {
  return { name: entry.he, hex: entry.hex, named: true, needsReview: false, sourceValue };
}

function unknown(sourceValue: string | null): ColorNameResult {
  return {
    name: sourceValue ?? "צבע",
    hex: null,
    named: false,
    needsReview: sourceValue !== null,
    sourceValue,
  };
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// A Mandarina colour code, e.g. "465" or "05J". Exact code only.
export function colorNameForMandarinaCode(code: string | null | undefined): ColorNameResult {
  const original = clean(code);
  if (original === null) return unknown(null);
  const key = original.toUpperCase();
  const entry = has(MANDARINA_COLOR_CODES, key) ? MANDARINA_COLOR_CODES[key] : undefined;
  return entry ? hit(entry, original) : unknown(original);
}

// Full Bric's / Porsche Design SKU → "MODEL.CODE" key. "BXL38124101",
// "bxl38124.101" and "BXL38124-101" all resolve to "BXL38124.101"; anything
// that is not exactly 2-4 letters + 5 digits + 3 digits gives null.
export function bricsSkuKey(catalogNumber: string | null | undefined): string | null {
  const original = clean(catalogNumber);
  if (original === null) return null;
  const token = original.toUpperCase().replace(/[-_/.\s]/g, "");
  const match = /^([A-Z]{2,4}\d{5})(\d{3})$/.exec(token);
  return match ? `${match[1]}.${match[2]}` : null;
}

// A full Bric's / Porsche Design SKU. The colour code alone is never enough.
export function colorNameForBricsSku(catalogNumber: string | null | undefined): ColorNameResult {
  const original = clean(catalogNumber);
  if (original === null) return unknown(null);
  const key = bricsSkuKey(original);
  const entry = key && has(BRICS_COLOR_BY_SKU, key) ? BRICS_COLOR_BY_SKU[key] : undefined;
  return entry ? hit(entry, original) : unknown(original);
}

// A complete colour value from a structured colour field ("Black", "Racing
// Yellow"). Case and repeated spaces are ignored; nothing else is.
export function colorNameForValue(value: string | null | undefined): ColorNameResult {
  const original = clean(value);
  if (original === null) return unknown(null);
  const key = original.toLowerCase().replace(/\s+/g, " ");
  const entry = has(COLOR_VALUE_NAMES, key) ? COLOR_VALUE_NAMES[key] : undefined;
  return entry ? hit(entry, original) : unknown(original);
}
