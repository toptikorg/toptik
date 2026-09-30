import type { CachedTechSpecs, CarouselItem } from "./types";
const normalized = (label: string) => label.trim().toLowerCase().replace(/[:：]\s*$/, "");
/** Receives only server-validated, escaped plain presentation strings; usable in the modal. */
export function mergeTypedSpecPresentation<T extends CachedTechSpecs>(legacy: T, overlay?: CarouselItem["typedSpecsOverlay"]): T {
  if (!overlay) return legacy;
  const labels = new Set(overlay.replacedLabels), pairs = new Set(overlay.replacementPairs);
  const specs = legacy.specs.map(section => ({ ...section, items: section.items.filter(row =>
    !labels.has(normalized(row.label)) && !pairs.has(`${section.heading}\u0000${normalized(row.label)}`)) })).filter(section => section.items.length);
  return { ...legacy, specs: [...specs, ...overlay.specs] };
}
