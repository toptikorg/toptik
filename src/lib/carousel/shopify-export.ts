import type { CarouselItem, CachedTechSpecs } from "./types";
import { categorizeItem } from "./categories";
import { detectVendorFromCatalog, normalizeCatalogKey } from "@/lib/catalog-source/vendor-detect";
import { resolveColorMetaForCatalog } from "./colors";
import { trimmedProductSrc } from "./trim-src";
import { SUPPLIER_PRICE_LIST } from "./supplier-price-list";
import { HEBREW_TITLES } from "./product-names";

// Builds the Shopify-shaped product sheet: ONE ROW PER SKU, and — per the
// owner's decision (2026-08-16) — each colour is a SEPARATE product with its
// own unique Product_Key/handle, not a variant of a shared model.
//
// Price and Quantity come from the supplier's catalog sheet (see
// supplier-price-list.ts). The remaining commercial columns (cost, barcode,
// compare-at price) are intentionally emitted empty — the scrapers never
// captured them — and `Collection` is a merchandising decision, not something
// stored here. They are kept in the sheet so the file matches the agreed
// import schema and can be filled in by hand.

// Widest tier /api/img-trim accepts. `withoutEnlargement` keeps it a ceiling, so
// smaller sources are served at their own size rather than upscaled.
const EXPORT_IMG_WIDTH = 2048;

// The two catalog buckets, in the exact vocabulary the import expects.
const TYPE_LABEL: Record<string, string> = {
  suitcase: "מזוודה",
  carryon: "טרולי",
};

// Brand names as they should land in Shopify's Vendor field.
const VENDOR_LABEL: Record<string, string> = {
  mandarina: "mandarinaduck",
  brics: "BRICS",
};

export interface ShopifyExportRow {
  SKU: string;
  Product_Key: string;
  Title_HE: string;
  Title_EN: string;
  Description_HE: string;
  Vendor: string;
  Type: string;
  Color: string;
  Size: string;
  // Numeric so the cells land in the sheet as real numbers, not text.
  Price: number | "";
  Quantity: number | "";
  Status: string;
  Image_1_URL: string;
  Image_2_URL: string;
  Barcode: string;
  // Numeric so the cell lands in the sheet as a real number, not text.
  Weight_kg: number | "";
  Collection: string;
  Tags: string;
  Material: string;
  Volume: string;
  Compare_At_Price: string;
  Cost: string;
}

// Authoritative column order — passed to json_to_sheet as its `header` so the
// sheet never depends on object key-insertion order.
export const SHOPIFY_EXPORT_COLUMNS: Array<keyof ShopifyExportRow> = [
  "SKU",
  "Product_Key",
  "Title_HE",
  "Title_EN",
  "Description_HE",
  "Vendor",
  "Type",
  "Color",
  "Size",
  "Price",
  "Quantity",
  "Status",
  "Image_1_URL",
  "Image_2_URL",
  "Barcode",
  "Weight_kg",
  "Collection",
  "Tags",
  "Material",
  "Volume",
  "Compare_At_Price",
  "Cost",
];

// Same order as SHOPIFY_EXPORT_COLUMNS.
export const SHOPIFY_EXPORT_COLUMN_WIDTHS = [
  22, 20, 60, 60, 90, 16, 12, 18, 26, 10, 10, 10, 80, 80, 14, 12, 20, 40, 30, 14, 18, 10,
];

// Spec labels are stored already translated (see catalog-source/product-details),
// so look them up by their Hebrew label with a few known synonyms.
function specValue(techSpecs: CachedTechSpecs | null | undefined, labels: string[]): string {
  if (!techSpecs?.specs) return "";
  const wanted = new Set(labels.map((l) => l.trim()));
  for (const section of techSpecs.specs) {
    for (const spec of section.items ?? []) {
      if (wanted.has(spec.label?.trim())) return spec.value?.trim() ?? "";
    }
  }
  return "";
}

// "3.5 ק״ג" → 3.5; "2,6 ק״ג" → 2.6; "850 גרם" → 0.85. Units and the European
// decimal comma are stripped so the cell is a bare number, which is what an
// import expects. Returns "" when no number is present.
function weightKg(raw: string): number | "" {
  if (!raw) return "";
  const match = raw.replace(",", ".").match(/(\d+(?:\.\d+)?)/);
  if (!match) return "";
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return "";
  const isGrams = /גרם|\bg\b|\bgr\b/i.test(raw) && !/ק["״']?ג|\bkg\b/i.test(raw);
  const kg = isGrams ? value / 1000 : value;
  return Math.round(kg * 100) / 100;
}

// Titles are stored as the vendor wrote them; only the DESCRIPTION is translated
// on import. So a title counts as Hebrew only if it actually contains Hebrew
// letters (i.e. an editor rewrote it) — otherwise Title_HE is left blank and the
// source name goes to Title_EN, making the rows still needing a Hebrew name
// obvious instead of shipping English text in a column labelled Hebrew.
function splitTitle(title: string): { he: string; en: string } {
  const value = title?.trim() ?? "";
  return /[֐-׿]/.test(value) ? { he: value, en: "" } : { he: "", en: value };
}

// Absolute, publicly fetchable URL of an image AFTER the background trim — the
// same pipeline the catalog renders. Absolute against `origin` (the landing
// domain, which serves /api/img-trim) rather than the current page origin, so a
// sheet exported from a local dev run still holds usable URLs.
function publicImageUrl(path: string | null | undefined, origin: string): string {
  const trimmed = trimmedProductSrc(path, EXPORT_IMG_WIDTH);
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? `${origin.replace(/\/$/, "")}${trimmed}` : trimmed;
}

// A scraped swatch sometimes carries the raw colour code as its name (e.g.
// "A83") when the vendor page gave no word — that is not a colour to publish.
function isBareCode(name: string): boolean {
  return /^[A-Z0-9]{2,3}$/.test(name.trim());
}

function tagsFor(vendor: string, type: string, color: string): string {
  // The store's automatic "מזוודות" collection matches on the PLURAL tag, so
  // the singular Type label is pluralized for tagging.
  const collectionTag = type === "מזוודה" ? "מזוודות" : type;
  return [vendor, collectionTag, color].filter(Boolean).join(", ");
}

// Matching key for a catalog number: letters+digits, uppercase, with the
// Mandarina size suffix dropped, so "BAH08453.001" and "BAH08453-001" — and
// "P10SZV24-05J-TU" against a supplier's "P10SZV2405J" — collapse to one key.
function catalogKey(value: string): string {
  return normalizeCatalogKey(value).replace(/TU$/, "");
}


// First two DISTINCT images of a gallery. Some products repeat the cover as
// their first angle; sending it twice would create a duplicate Shopify image.
function firstTwoImages(gallery: Array<string | null | undefined>, origin: string) {
  const urls: string[] = [];
  for (const path of gallery) {
    const url = publicImageUrl(path, origin);
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length === 2) break;
  }
  return { first: urls[0] ?? "", second: urls[1] ?? "" };
}

export function buildShopifyExportRows(items: CarouselItem[], origin: string): ShopifyExportRow[] {
  // ONE ROW PER GALLERY ITEM. An item's `colors` array is the swatch strip the
  // carousel renders — every colour the vendor sells of that model, scraped from
  // their site — NOT a list of products stocked here. Each gallery item is one
  // product in one colour, carrying its own catalog number, so expanding the
  // swatches would ship colours that were never bought.
  const bySku = new Map<string, ShopifyExportRow>();
  let fallbackKey = 0;

  // Colour names, pooled from every item's swatch list, so an item can be named
  // even when its own swatch strip omits its colour (a few were scraped that way).
  const colorByCatalog = new Map<string, string>();
  for (const item of items) {
    for (const color of item.colors ?? []) {
      const key = color.catalogNumber ? catalogKey(color.catalogNumber) : "";
      if (key && color.name && !colorByCatalog.has(key)) colorByCatalog.set(key, color.name);
    }
  }

  for (const item of [...items].sort((a, b) => a.displayOrder - b.displayOrder)) {
    const baseCatalog = item.catalogNumber?.trim() ?? "";
    // Each SKU is its own product with a unique key/handle. Items with no
    // catalog number fall back to their row id, which is just as stable.
    const productKey = baseCatalog ? catalogKey(baseCatalog) : item.id;
    // detectVendorFromCatalog defaults to Bric's for anything that is not a
    // Mandarina pattern — including an empty string. Only claim a brand when
    // there is actually a catalog number to judge.
    const vendor = baseCatalog ? VENDOR_LABEL[detectVendorFromCatalog(baseCatalog)] ?? "" : "";
    const category = categorizeItem(item);
    const type = category ? TYPE_LABEL[category] ?? "" : "";
    const title = splitTitle(item.title);
    // Hebrew storefront name from the curated per-SKU table; a stored Hebrew
    // title (an editor's rewrite) still wins.
    const titleHe = title.he || (baseCatalog ? HEBREW_TITLES[catalogKey(baseCatalog)] ?? "" : "");
    const description = item.description?.trim() ?? "";
    const size = specValue(item.techSpecs, ["מידות", "גודל"]);
    const material = specValue(item.techSpecs, ["חומר", "חומרים", "הרכב"]);
    const volume = specValue(item.techSpecs, ["נפח", "קיבולת"]);
    const weight = weightKg(specValue(item.techSpecs, ["משקל"]));
    // Unit price (incl. VAT) and purchased stock from the supplier's catalog
    // sheet, matched on the normalized catalog key.
    const supplier = baseCatalog ? SUPPLIER_PRICE_LIST[catalogKey(baseCatalog)] : undefined;

    const shared = {
      Product_Key: productKey,
      Title_HE: titleHe,
      Title_EN: title.en,
      Description_HE: description,
      Vendor: vendor,
      Type: type,
      Size: size,
      Price: supplier?.price ?? ("" as const),
      Quantity: supplier?.quantity ?? ("" as const),
      // Active per the owner's decision (2026-08-16): price and stock now ship
      // in the sheet, so imported products should be live immediately.
      // `isActive` is deliberately NOT used here — it governs visibility in the
      // landing-page carousel, a separate concern from storefront publication.
      Status: "active",
      Barcode: "",
      Weight_kg: weight,
      Collection: "",
      Material: material,
      Volume: volume,
      Compare_At_Price: "",
      Cost: "",
    };

    // The item's OWN gallery: cover first, then its rotation angles.
    const images = firstTwoImages(
      [item.coverImagePath, ...item.angles.map((a) => a.imagePath)],
      origin,
    );
    // Colour, resolved the way the catalog itself resolves it: the swatch strip
    // first, then the vendor's colour-code table (what `ensureOwnColor` does at
    // render time — the export used to read only the stored strip, so items
    // whose own colour was never scraped as a swatch came out blank). A bare
    // code is not a colour name, so it is left empty rather than shipped.
    const swatchName = baseCatalog ? colorByCatalog.get(catalogKey(baseCatalog)) : undefined;
    const resolved = resolveColorMetaForCatalog(baseCatalog || null);
    const color = swatchName && !isBareCode(swatchName) ? swatchName : resolved.named ? resolved.name : "";

    // Rows with no catalog number cannot be compared — keep each of them.
    const key = baseCatalog ? catalogKey(baseCatalog) : `#${fallbackKey++}`;
    if (bySku.has(key)) continue;
    bySku.set(key, {
      SKU: baseCatalog,
      ...shared,
      Color: color,
      Image_1_URL: images.first,
      Image_2_URL: images.second,
      Tags: tagsFor(vendor, type, color),
    });
  }

  // Colours of one model sit together, ready for review.
  return [...bySku.values()].sort(
    (a, b) => a.Product_Key.localeCompare(b.Product_Key) || a.SKU.localeCompare(b.SKU),
  );
}
