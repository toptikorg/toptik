import type { SourceColorVariant } from "@/lib/catalog-source/types";
import type { CarouselColor, CarouselItem } from "./types";
import {
  colorNameForBricsSku,
  colorNameForMandarinaCode,
  colorNameForValue,
  type ColorNameResult,
} from "./color-names";
import { detectVendorFromCatalog } from "@/lib/catalog-source/vendor-detect";

// Colour NAMES come only from the closed allowlist in ./color-names (owner
// decision 2026-09-29): full code or full value, no word splitting, no partial
// matching, never from a title or any free text. An unknown code stays as the
// original code and is flagged for review.

// Vendor-aware resolution from a catalog number. Mandarina catalog numbers carry
// a global colour code; Bric's / Porsche Design are named only by the full SKU,
// because their colour suffixes mean different colours in different
// collections. When nothing matches, `name` is the bare colour code (or "צבע")
// and `named` is false — callers that must not show a code can check it.
export function resolveColorMetaForCatalog(catalogNumber: string | null | undefined): ColorNameResult {
  const code = colorCodeFromCatalog(catalogNumber);
  if (catalogNumber && detectVendorFromCatalog(catalogNumber) === "mandarina") {
    return colorNameForMandarinaCode(code);
  }
  const bySku = colorNameForBricsSku(catalogNumber);
  if (bySku.named) return bySku;
  return { name: code ?? "צבע", hex: null, named: false, needsReview: code !== null, sourceValue: code };
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
    // Mandarina: named by the colour code only. The colour word the scraper
    // found inside the page title is never used for the name (free text).
    const { name, hex, sourceValue } = colorNameForMandarinaCode(variant.colorCode);
    const key = (variant.colorCode || variant.colorWord || variant.handle).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push({
      name,
      hex,
      sourceValue,
      colorCode: variant.colorCode,
      imagePath: angles[0],
      angles,
      sourceUrl: variant.sourceUrl,
      catalogNumber: variant.catalogNumber,
    });
  }
  return colors;
}

// Bric's colour naming: the maker's complete colour value from the Shopify
// "Color" option (Black, Olive, Racing Yellow...), matched as a whole value;
// otherwise the full SKU. Never a word inside the value, never the Mandarina
// table (Bric's codes collide with Mandarina's), never a guess.
function bricsColorMeta(variant: SourceColorVariant): ColorNameResult {
  const byValue = colorNameForValue(variant.colorWord);
  if (byValue.named) return byValue;
  const bySku = colorNameForBricsSku(variant.catalogNumber);
  if (bySku.named) return { ...bySku, sourceValue: byValue.sourceValue ?? bySku.sourceValue };
  return byValue;
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
    const { name, hex, sourceValue } = bricsColorMeta(variant);
    const key = (variant.colorCode || variant.colorWord || variant.handle).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push({
      name,
      hex,
      sourceValue,
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
  // The title is never consulted for the colour name.
  const { name, hex, sourceValue } = resolveColorMetaForCatalog(item.catalogNumber);
  const own: CarouselColor = {
    name,
    hex,
    sourceValue,
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
  name: string; // Hebrew name from the allowlist, or the original colour code
  hex: string | null;
  sourceValue?: string | null; // the maker's colour code/value the name came from
  named?: boolean; // false ⇒ not in the allowlist; shown as the original code
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
  // Split on Bric's dot too (BXL58145.101 → base "BXL58145"), so every colour of
  // a model shares one model code (Mandarina P10SZV24-05J-TU → "SZV24").
  const head = catalogNumber.toUpperCase().split(/[-_/.]/)[0] ?? "";
  // TopTik's American Tourister SKUs start with the maker's COLOUR code
  // (4815-77TEAL LIME, 4815-55TEAL LIME): an all-digit head is a colour, not a
  // model, and grouping on it would present sizes as colours.
  if (/^\d+$/.test(head)) return null;
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
      // Named from the catalog number only — never from the product title.
      const { name, hex, sourceValue, named } = resolveColorMetaForCatalog(member.catalogNumber);
      const angles =
        member.angles.length > 0
          ? [...member.angles].sort((a, b) => a.angleOrder - b.angleOrder).map((a) => a.imagePath)
          : [member.coverImagePath];
      base.push({
        code,
        swatch: { key: code, itemId: member.id, name, hex, sourceValue, named, imagePath: member.coverImagePath, angles },
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
