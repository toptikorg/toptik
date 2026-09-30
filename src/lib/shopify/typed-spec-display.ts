import type { CarouselItem, CachedTechSpecs } from "@/lib/carousel/types";
import { mergeTypedSpecPresentation } from "../carousel/merge-typed-specs";
import { FIELD_DEFINITIONS, SPEC_KEYS, validateSpecCell, type SpecKey, type Measurement, type Sections } from "./typed-spec-core";
export type PublicTypedSpecs = { itemId: string; exactSku: string; fields: Partial<Record<SpecKey, unknown>> };
const labels: Partial<Record<SpecKey, string[]>> = {
  material: ["חומר", "material"], height: ["גובה", "height"], width: ["רוחב", "width"], depth: ["עומק", "depth"],
  volume: ["נפח", "volume"], expanded_volume: ["נפח בהרחבה", "expanded volume"],
  net_weight: ["משקל עצמי", "משקל", "weight", "net weight"], wheel_count: ["מספר גלגלים", "number of wheels"],
  wheel_type: ["סוג גלגלים", "wheel type"], lock_type: ["מנעול", "lock"], expandable: ["אפשרות הרחבה", "expandable"],
  color_name: ["צבע", "colour", "color"], warranty_text: ["אחריות", "warranty"],
};
const normalized = (label: string) => label.trim().toLowerCase().replace(/[:：]\s*$/, "");
/** Escaped plain strings only. Never merge audits, HTML, prices or shipping measurements. */
export function overlayTypedSpecs(item: CarouselItem, projection: PublicTypedSpecs): CarouselItem {
  if (item.id !== projection.itemId || item.catalogNumber !== projection.exactSku || !projection.fields || typeof projection.fields !== "object") return item;
  const rows: Array<{ label: string; value: string }> = [], replace = new Set<string>(), additional: Sections = [];
  for (const [key, raw] of Object.entries(projection.fields)) {
    if (!SPEC_KEYS.includes(key as SpecKey)) throw new Error("SPEC_PUBLIC_FIELD_INVALID");
    const specKey = key as SpecKey;
    const checked = validateSpecCell(specKey, { state: "value", value: raw as never, provenance: { authority: "merchant", producer: "gallery_typed_editor", observedAt: "2026-09-30T00:00:00Z", evidenceId: "projection-shape-check", intentId: "projection-shape-check", raw: null } });
    if (checked.state !== "value") throw new Error("SPEC_PUBLIC_FIELD_INVALID");
    if (key === "additional_specs") { additional.push(...checked.value as Sections); continue; }
    let text: string;
    if (typeof checked.value === "object") {
      const measurement = checked.value as Measurement;
      text = `${measurement.decimal} ${measurement.unit === "centimeters" ? "ס״מ" : measurement.unit === "liters" ? "ליטר" : "ק״ג"}`;
    } else if (typeof checked.value === "boolean") text = checked.value ? "כן" : "לא";
    else text = checked.value;
    // A legacy "wheels" row can contain count and type together. A type-only
    // edit must not erase an untyped count or present itself as the whole fact.
    const label = specKey === "wheel_type" ? "סוג גלגלים" : FIELD_DEFINITIONS[specKey].labelHe;
    rows.push({ label, value: text });
    for (const previousLabel of [label, ...(labels[specKey] ?? [])]) replace.add(normalized(previousLabel));
  }
  if (!rows.length && !additional.length) return item;
  if (["height", "width", "depth"].every(key => Object.hasOwn(projection.fields, key))) for (const label of ["מידות", "dimensions"]) replace.add(label);
  if (["wheel_type", "wheel_count"].every(key => Object.hasOwn(projection.fields, key))) for (const label of ["גלגלים", "wheels"]) replace.add(label);
  const overlay = { specs: [...(rows.length ? [{ heading: "מפרט מעודכן", items: rows }] : []), ...additional], replacedLabels: [...replace],
    replacementPairs: additional.flatMap(section => section.items.map(row => `${section.heading}\u0000${normalized(row.label)}`)) };
  // An overlay is not a complete manufacturer cache. Keep the existing lazy lookup reachable.
  if (!item.techSpecs && item.sourceUrl) return { ...item, typedSpecsOverlay: overlay };
  const previous: CachedTechSpecs = item.techSpecs ?? { specs: [], colors: [] };
  return { ...item, techSpecs: mergeTypedSpecPresentation(previous, overlay) };
}
