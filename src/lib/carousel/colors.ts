import type { SourceColorVariant } from "@/lib/catalog-source/types";
import type { CarouselColor, CarouselItem } from "./types";
import { COLOR_HEX, COLOR_HEBREW, extractColorWord } from "./color-groups";
import { detectVendorFromCatalog } from "@/lib/catalog-source/vendor-detect";

// Global Mandarina Duck colour codes — the middle segment of the catalog number
// (P10·QMC01·`465`·TU). The code is stable across every model, so it's the most
// reliable colour key. Derived from the live 28-product catalog; hex is an
// approximate swatch fill. Extend as new codes are observed.
export const MANDARINA_COLOR_CODES: Record<string, { he: string; hex: string }> = {
  "465": { he: "פלדה", hex: "#6e7b8b" }, // steel
  "09K": { he: "טאופ", hex: "#8d7966" }, // taupe
  "024": { he: "פיריט", hex: "#6e7060" }, // pirite
  A74: { he: "אויל", hex: "#3d4a1e" }, // oil
  A89: { he: "לונר", hex: "#b8b8c0" }, // lunar
  "29U": { he: "גרפיט", hex: "#555555" }, // graphite
  "08Q": { he: "כחול", hex: "#1a2d5a" }, // dress blue
  "05J": { he: "צהוב", hex: "#f0c040" }, // duck yellow
  A92: { he: "מוארה", hex: "#6b6f76" }, // moire
  A93: { he: "דיווה", hex: "#a52828" }, // diva
  "651": { he: "שחור", hex: "#1a1a1a" }, // black
  "07X": { he: "כחול עמוק", hex: "#1c3a6e" }, // deep blue
  "02F": { he: "אמרלד", hex: "#2e7d52" }, // emerald
  "24N": { he: "פנינה", hex: "#eae6da" }, // pearl
  A82: { he: "אגוז פקאן", hex: "#8a5a3b" }, // pecan nut
  A32: { he: "טורקיז נצנצים", hex: "#3fb8ae" }, // glitter green/turquoise
  A83: { he: "שוקולד", hex: "#6b4b3e" }, // choco ice
  A81: { he: "מוקה לבן", hex: "#d9cdbf" }, // white mocha
};

// Bric's colour codes — the SKU suffix (BXL58145·`078`). Kept SEPARATE from the
// Mandarina table on purpose: the numeric codes collide (Mandarina 465 = steel,
// Bric's 465 would be something else entirely), so the two must never share a
// lookup. Derived from the colour names already scraped for this catalog.
export const BRICS_COLOR_CODES: Record<string, { he: string; hex: string }> = {
  "001": { he: "שחור", hex: "#1a1a1a" },
  "006": { he: "כחול", hex: "#1f3a6e" },
  "014": { he: "קרם", hex: "#e6dcc8" },
  "050": { he: "נייבי", hex: "#1c2a4a" },
  "078": { he: "זית", hex: "#6b6f4a" },
  "101": { he: "שחור", hex: "#1a1a1a" },
  "254": { he: "ורוד", hex: "#d98ba6" },
};

// Resolve a Hebrew name + swatch hex from the colour code (preferred, global)
// or the colour word parsed from the title (fallback).
export function resolveColorMeta(
  colorWord: string | null,
  colorCode: string | null,
): { name: string; hex: string | null } {
  const code = colorCode?.toUpperCase() ?? null;
  if (code && MANDARINA_COLOR_CODES[code]) {
    return { name: MANDARINA_COLOR_CODES[code].he, hex: MANDARINA_COLOR_CODES[code].hex };
  }
  const word = colorWord?.toLowerCase() ?? null;
  if (word) {
    return { name: COLOR_HEBREW[word] ?? colorWord!, hex: COLOR_HEX[word] ?? null };
  }
  return { name: code ?? "צבע", hex: null };
}

// Vendor-aware resolution from a catalog number: pick the colour table that
// belongs to the brand that issued the number, then fall back to a colour word
// in the title. `named` is false when nothing resolved and `name` is only the
// raw code — callers that must not show a code can check it.
export function resolveColorMetaForCatalog(
  catalogNumber: string | null | undefined,
  title: string | null | undefined,
): { name: string; hex: string | null; named: boolean } {
  const code = colorCodeFromCatalog(catalogNumber)?.toUpperCase() ?? null;
  const table =
    catalogNumber && detectVendorFromCatalog(catalogNumber) === "brics"
      ? BRICS_COLOR_CODES
      : MANDARINA_COLOR_CODES;
  if (code && table[code]) return { ...table[code], name: table[code].he, named: true };
  const word = title ? extractColorWord(title) : null;
  if (word) {
    return { name: COLOR_HEBREW[word.toLowerCase()] ?? word, hex: COLOR_HEX[word.toLowerCase()] ?? null, named: true };
  }
  return { name: code ?? "צבע", hex: null, named: false };
}

// Map scraped colour variants → persisted colours, attaching the Supabase-hosted
// gallery re-hosted for each variant (its rotation angles). Variants whose images
// couldn't be re-hosted are dropped (a swatch with no image can't drive a swap).
export function toCarouselColors(
  variants: SourceColorVariant[],
  galleryByHandle: Map<string, string[]>,
): CarouselColor[] {
  const colors: CarouselColor[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    const angles = galleryByHandle.get(variant.handle) ?? [];
    if (angles.length === 0) continue;
    const { name, hex } = resolveColorMeta(variant.colorWord, variant.colorCode);
    const key = (variant.colorCode || variant.colorWord || variant.handle).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push({
      name,
      hex,
      colorCode: variant.colorCode,
      imagePath: angles[0],
      angles,
      sourceUrl: variant.sourceUrl,
      catalogNumber: variant.catalogNumber,
    });
  }
  return colors;
}

// Bric's colour naming: the colour is a plain English word/phrase from the
// Shopify "Color" option (Ocean, Bordeaux, Cappuccino...), and the colour code
// is the SKU suffix (BOE58117·050). Never consult MANDARINA_COLOR_CODES here —
// Bric's numeric codes can collide with Mandarina's and would resolve to the
// wrong Hebrew name.
function bricsColorMeta(colorWord: string | null): { name: string; hex: string | null } {
  const word = colorWord?.trim().toLowerCase() ?? null;
  if (!word) return { name: "צבע", hex: null };
  if (COLOR_HEBREW[word]) return { name: COLOR_HEBREW[word], hex: COLOR_HEX[word] ?? null };
  const translated = word
    .split(/\s+/)
    .map((w) => COLOR_HEBREW[w] ?? w)
    .join(" ");
  const hex = word.split(/\s+/).map((w) => COLOR_HEX[w]).find(Boolean) ?? null;
  return { name: translated !== word ? translated : colorWord!, hex };
}

export function toBricsCarouselColors(
  variants: SourceColorVariant[],
  galleryByHandle: Map<string, string[]>,
): CarouselColor[] {
  const colors: CarouselColor[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    const angles = galleryByHandle.get(variant.handle) ?? [];
    if (angles.length === 0) continue;
    const { name, hex } = bricsColorMeta(variant.colorWord);
    const key = (variant.colorCode || variant.colorWord || variant.handle).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push({
      name,
      hex,
      colorCode: variant.colorCode,
      imagePath: angles[0],
      angles,
      sourceUrl: variant.sourceUrl,
      catalogNumber: variant.catalogNumber,
    });
  }
  return colors;
}

// Guarantee a product's OWN colour is present — a product always exists at least
// in the colour it was imported in. Uses the item's existing cover so it never
// ends up with zero colours even when sibling scraping fails entirely.
export function ensureOwnColor(
  colors: CarouselColor[],
  item: { catalogNumber: string | null; title?: string | null; coverImagePath: string },
): CarouselColor[] {
  if (!item.coverImagePath) return colors;
  const ownCode = colorCodeFromCatalog(item.catalogNumber);
  const hasOwn =
    (ownCode != null && colors.some((c) => c.colorCode?.toUpperCase() === ownCode)) ||
    colors.some((c) => c.imagePath === item.coverImagePath);
  if (hasOwn) return colors;
  // Vendor-aware: a Bric's suffix must not be read off the Mandarina table.
  const { name, hex } = resolveColorMetaForCatalog(item.catalogNumber, item.title);
  const own: CarouselColor = {
    name,
    hex,
    colorCode: ownCode,
    imagePath: item.coverImagePath,
    angles: [item.coverImagePath],
    sourceUrl: null,
    catalogNumber: item.catalogNumber,
  };
  return [own, ...colors];
}

// ─── UI swatch resolution ────────────────────────────────────────────────────

// A swatch ready to render. `imagePath` non-null ⇒ clicking swaps the displayed
// product image to that colour; null ⇒ a passive colour dot (title fallback).
export interface ResolvedSwatch {
  key: string;
  itemId?: string; // the catalog item this colour IS (drives navigation on click)
  name: string;
  hex: string | null;
  imagePath: string | null; // cover (= angles[0])
  angles: string[]; // this colour's full gallery — drives rotation while selected
  isCurrent: boolean;
}

// Middle segment of a catalog number = the colour code. Handles both catalog
// styles: Mandarina dash-separated (P10·QMC01·`465`·TU) and Bric's dot-separated
// (BOE58117·`050`) — plus the un-separated forms some rows were saved in
// (P10JNV05·465, BXL38124·078), where the colour is the trailing 3 characters.
// Without that fallback those products resolve to no colour at all.
export function colorCodeFromCatalog(catalogNumber: string | null | undefined): string | null {
  if (!catalogNumber) return null;
  const parts = catalogNumber.toUpperCase().split(/[-_/.]/).filter(Boolean);
  if (parts.length >= 2) return parts[1];
  const token = parts[0]?.replace(/TU$/, "") ?? "";
  // Mandarina: P + 2 digits + 5-char model + 3-char colour.
  // Bric's: 2-4 letters + 5 digits + 3-digit colour.
  if (/^P\d{2}[A-Z0-9]{5}[A-Z0-9]{3}$/.test(token) || /^[A-Z]{2,4}\d{8}$/.test(token)) {
    return token.slice(-3);
  }
  return null;
}

// Model code = first catalog segment minus the P-prefix (P10·`QMC01`·465·TU).
// Every colour of a product shares this code; the colour is the second segment.
export function modelCodeFromCatalog(catalogNumber: string | null | undefined): string | null {
  if (!catalogNumber) return null;
  // Compact Mandarina SKUs keep the 5-character model before the 3-character
  // colour (P10FZT73A46). Match the whole SKU so separated formats stay intact.
  const compactModel = catalogNumber.toUpperCase().match(/^P10([A-Z0-9]{5})[A-Z0-9]{3}(?:TU)?$/);
  if (compactModel) return compactModel[1];
  // Split on Bric's dot too (BXL58145.101 → base "BXL58145"), so every colour of
  // a model shares one model code (Mandarina P10SZV24-05J-TU → "SZV24").
  const head = catalogNumber.toUpperCase().split(/[-_/.]/)[0] ?? "";
  const stripped = head.replace(/^P\d+/, "");
  return stripped.length >= 4 ? stripped : null;
}

// Swatches for a card come ONLY from colour-sibling ITEMS that actually exist in
// the catalog (built by buildModelSiblingSwatches, grouped by model code). A
// colour that has no product of its own is never shown, and clicking a swatch
// navigates to that colour's product. A model with a single colour in the
// catalog therefore has no swatch selector at all.
export function resolveItemSwatches(modelSiblings?: ResolvedSwatch[]): ResolvedSwatch[] {
  return modelSiblings ?? [];
}

// Fallback swatches (pre-warm) built from colour-variant ITEMS already in the
// catalog, grouped by EXACT model code so only true colour siblings merge — a
// swatch can never resolve to a different product (the wrong-product bug). Each
// swatch carries that sibling's own angle gallery, so colours stay rotatable
// without any scraped data.
export function buildModelSiblingSwatches(items: CarouselItem[]): Map<string, ResolvedSwatch[]> {
  const families = new Map<string, CarouselItem[]>();
  for (const item of items) {
    const model = modelCodeFromCatalog(item.catalogNumber);
    if (!model) continue;
    if (!families.has(model)) families.set(model, []);
    families.get(model)!.push(item);
  }

  const result = new Map<string, ResolvedSwatch[]>();
  for (const members of families.values()) {
    const seen = new Set<string>();
    const base: Array<{ code: string; swatch: Omit<ResolvedSwatch, "isCurrent"> }> = [];
    for (const member of members) {
      const code = (colorCodeFromCatalog(member.catalogNumber) ?? member.id).toUpperCase();
      if (seen.has(code)) continue;
      seen.add(code);
      const { name, hex } = resolveColorMeta(
        extractColorWord(member.title),
        colorCodeFromCatalog(member.catalogNumber),
      );
      const angles =
        member.angles.length > 0
          ? [...member.angles].sort((a, b) => a.angleOrder - b.angleOrder).map((a) => a.imagePath)
          : [member.coverImagePath];
      base.push({
        code,
        swatch: { key: code, itemId: member.id, name, hex, imagePath: member.coverImagePath, angles },
      });
    }
    if (base.length < 2) continue; // need 2+ colours to form a selector

    for (const member of members) {
      const ownCode = (colorCodeFromCatalog(member.catalogNumber) ?? member.id).toUpperCase();
      result.set(
        member.id,
        base.map((b) => ({ ...b.swatch, isCurrent: b.code === ownCode })),
      );
    }
  }
  return result;
}
