import type { CarouselItem } from "./types";
import type { ColorSwatch } from "../catalog-source/product-details";

// English colour words used ONLY to recognise that a title mentions a colour —
// for grouping colour siblings and de-duplicating scraped variants. This list
// never produces display text: Hebrew colour names come exclusively from the
// allowlist in ./color-names, by full code or full value (owner decision
// 2026-09-29; tests/color-names.test.mjs).
const COLOR_WORDS = new Set([
  "black", "white", "red", "blue", "navy", "green", "yellow", "orange",
  "purple", "pink", "brown", "grey", "gray", "beige", "taupe", "camel",
  "tan", "khaki", "ivory", "cream", "silver", "gold", "steel", "pirite",
  "diva", "stone", "sand", "teal", "wine", "bordeaux", "burgundy", "latte",
  "coral", "rust", "mustard", "olive", "cobalt", "charcoal", "graphite",
  "lunar", "oil", "aqua", "petrol", "midnight", "vanilla", "forest",
  "emerald", "pearl", "pecan", "pecan nut", "deep blue", "dress blue",
  "ocean", "cappuccino", "eucalyptus", "espresso", "fire red", "grafite",
]);

function normalizeForFamily(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*-?\s*mandarina duck\b/gi, "")
    .replace(/[+\-–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Multi-word colours must be matched before single tokens (longest-first).
const MULTI_WORD_COLORS = ["dress blue", "deep blue", "pecan nut", "rose gold", "light blue"];

export function extractColorWord(title: string): string | null {
  const t = normalizeForFamily(title);
  for (const phrase of MULTI_WORD_COLORS) {
    if (t.includes(phrase)) return phrase;
  }
  for (const token of t.split(/\s+/)) {
    if (COLOR_WORDS.has(token)) return token;
  }
  return null;
}

export function getFamilyKey(title: string): string {
  const normalized = normalizeForFamily(title);
  const color = extractColorWord(title);
  if (!color) return normalized;
  return normalized.replace(new RegExp(`\\b${color.replace(" ", "\\s+")}\\b`, "gi"), "").replace(/\s+/g, " ").trim();
}

export function buildItemColorGroups(items: CarouselItem[]): Map<string, ColorSwatch[]> {
  const families = new Map<string, Array<{ id: string; colorWord: string | null }>>();
  for (const item of items) {
    const key = getFamilyKey(item.title);
    const colorWord = extractColorWord(item.title);
    if (!families.has(key)) families.set(key, []);
    families.get(key)!.push({ id: item.id, colorWord });
  }

  const result = new Map<string, ColorSwatch[]>();
  for (const [, members] of families) {
    const seen = new Set<string>();
    const swatches: ColorSwatch[] = members
      .filter(m => m.colorWord && !seen.has(m.colorWord) && (seen.add(m.colorWord), true))
      // Diagnostic only: the detected word is shown as found, untranslated.
      .map(m => ({
        name: m.colorWord!,
        hex: null,
        swatchUrl: null,
      }));
    if (swatches.length < 1) continue;
    for (const { id } of members) {
      result.set(id, swatches);
    }
  }
  return result;
}
