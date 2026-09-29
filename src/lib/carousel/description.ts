// The catalog number has its own visible field. Remove only repetitions of
// that exact identity from display prose; never strip model names or numbers
// generically, and never modify the stored identifier or purchasing lookup.
export function descriptionWithoutCatalogNumber(
  description: string | null | undefined,
  catalogNumber: string | null | undefined,
): string {
  const original = description ?? "";
  const normalized = catalogNumber?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
  // Short names such as MD20 are useful model names, not safe SKU candidates.
  if (normalized.length < 6 || !/[A-Z]/.test(normalized) || !/[0-9]/.test(normalized)) {
    return original;
  }

  const aliases = [normalized];
  // Mandarina's TU is the one-size suffix. Accept its presence or absence,
  // while keeping every model and colour character mandatory.
  if (normalized.startsWith("P10")) {
    aliases.push(normalized.endsWith("TU") ? normalized.slice(0, -2) : `${normalized}TU`);
  }
  const separator = "[-._/ \\t\\u00a0]*";
  const identity = aliases.sort((a, b) => b.length - a.length)
    .map(alias => alias.split("").join(separator)).join("|");
  const before = "(?<![\\p{L}\\p{N}_/.-])";
  const after = "(?![\\p{L}\\p{N}]|[-_/][A-Za-z0-9]|\\.[A-Za-z0-9])";
  const label = "(?:מק[״\"׳']?ט|מספר\\s+קטלוגי|קוד\\s+פריט|SKU|catalog(?:ue)?\\s+(?:number|no\\.?))";
  const exact = `(?:${identity})${after}`;
  let text = original
    .replace(new RegExp(`\\(\\s*(?:${label}\\s*[:：]?\\s*)?${exact}\\s*\\)`, "giu"), "")
    .replace(new RegExp(`(?:,\\s*)?${before}${label}\\s*[:：]?\\s*${exact}`, "giu"), "")
    .replace(new RegExp(`${before}${exact}`, "giu"), "");
  if (text === original) return original;

  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/,\s*([.;!?])/g, "$1")
    .replace(/([.!?])\s*[,;:]/g, "$1")
    .replace(/^[\s,;:.!?]+|[ \t]+$/g, "")
    .replace(/\(\s*\)/g, "")
    .trim();
  return text;
}
