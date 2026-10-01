/** Pure typed-spec schema/merge policy. No network, storage or product-body inference. */
import { hash } from "node:crypto";

export const NAMESPACE = "toptik_specs";
export const CONTRACT_ID = "toptik-typed-spec-sync-contract-20260930-v1";
export const FIELD_DEFINITIONS = {
  manufacturer_sku: { labelHe: "מק״ט יצרן", type: "single_line_text_field" },
  manufacturer_model: { labelHe: "דגם יצרן", type: "single_line_text_field" },
  material: { labelHe: "חומר", type: "single_line_text_field" },
  height: { labelHe: "גובה", type: "dimension", unit: "centimeters" },
  width: { labelHe: "רוחב", type: "dimension", unit: "centimeters" },
  depth: { labelHe: "עומק", type: "dimension", unit: "centimeters" },
  expanded_height: { labelHe: "גובה בהרחבה", type: "dimension", unit: "centimeters" },
  expanded_width: { labelHe: "רוחב בהרחבה", type: "dimension", unit: "centimeters" },
  expanded_depth: { labelHe: "עומק בהרחבה", type: "dimension", unit: "centimeters" },
  volume: { labelHe: "נפח", type: "volume", unit: "liters" },
  expanded_volume: { labelHe: "נפח בהרחבה", type: "volume", unit: "liters" },
  net_weight: { labelHe: "משקל עצמי", type: "weight", unit: "kilograms" },
  wheel_count: { labelHe: "מספר גלגלים", type: "number_integer" },
  wheel_type: { labelHe: "גלגלים", type: "single_line_text_field" },
  lock_type: { labelHe: "מנעול", type: "single_line_text_field" },
  expandable: { labelHe: "אפשרות הרחבה", type: "boolean" },
  color_name: { labelHe: "צבע", type: "single_line_text_field" },
  warranty_text: { labelHe: "אחריות", type: "multi_line_text_field" },
  additional_specs: { labelHe: "פרטים נוספים", type: "json" },
} as const;
export type SpecKey = keyof typeof FIELD_DEFINITIONS;
export const SPEC_KEYS = Object.freeze(Object.keys(FIELD_DEFINITIONS) as SpecKey[]);
export type Side = "gallery" | "shopify";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Sections = Array<{ heading: string; items: Array<{ label: string; value: string }> }>;
export type Measurement = { kind: "measurement"; decimal: string; unit: "centimeters" | "liters" | "kilograms";
  numerator: string; denominator: string; original: { value: string | number; unit: string } };
export type NormalizedValue = string | boolean | Measurement | Sections;
export type Provenance = {
  authority: "manufacturer" | "merchant";
  producer: "manufacturer_catalog" | "gallery_typed_editor" | "shopify_typed_metafield";
  observedAt: string; evidenceId: string; raw: Json;
  sourceUrl?: string; manufacturerSku?: string; manufacturerModel?: string; color?: string;
  /** Required for manufacturer dimension evidence: explicitly identified axis. */
  axis?: SpecKey;
  /** Explicit merchant action identifier; never a scrape timestamp. */
  intentId?: string;
};
export type SpecCell = { state: "missing" } | { state: "absent" } |
  { state: "clear"; provenance: Provenance } |
  { state: "value"; value: NormalizedValue; provenance: Provenance };
export type Observation = { cell: SpecCell; revision: string | null };
export type Document = { fields: Partial<Record<SpecKey, Observation>>; rawProducerData?: Json; legacySections?: Json };
export type Baselines = { gallery: Document; shopify: Document };
export type Operation = { key: SpecKey; source: Side; target: Side; intent: "set" | "clear";
  value: SpecCell; sourceObservation: Observation; expectedRevision: string | null; expectedFingerprint: string };
export type Conflict = { key: SpecKey; code: string };
export type MergePlan = { operations: Operation[]; conflicts: Conflict[];
  acknowledgements: Array<{ key: SpecKey; gallery: Observation; shopify: Observation }> };

function fail(code: string): never { throw new Error(code); }
function clone<T>(value: T): T { return structuredClone(value); }
function assertKey(key: string): asserts key is SpecKey {
  if (!Object.hasOwn(FIELD_DEFINITIONS, key)) fail("SPEC_FIELD_NOT_ALLOWED");
}
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function boundedJson(value: unknown): Json {
  function verify(node: unknown, depth: number): void {
    if (depth > 40) fail("SPEC_RAW_PROVENANCE_TOO_DEEP");
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number") { if (!Number.isFinite(node)) fail("SPEC_RAW_PROVENANCE_NOT_JSON"); return; }
    if (typeof node !== "object" || (!Array.isArray(node) && ![null, Object.prototype].includes(Object.getPrototypeOf(node)))) fail("SPEC_RAW_PROVENANCE_NOT_JSON");
    for (const child of Object.values(node)) verify(child, depth + 1);
  }
  verify(value, 0);
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > 250_000) fail("SPEC_RAW_PROVENANCE_TOO_LARGE");
  const parsed = JSON.parse(encoded);
  if (stable(parsed) !== stable(value)) fail("SPEC_RAW_PROVENANCE_NOT_JSON");
  return parsed;
}
function gcd(a: bigint, b: bigint): bigint { while (b) [a, b] = [b, a % b]; return a; }
function rational(n: bigint, d: bigint): [bigint, bigint] { const g = gcd(n, d); return [n / g, d / g]; }
function parseDecimal(value: unknown): [bigint, bigint] {
  if (typeof value !== "number" && typeof value !== "string") fail("SPEC_MEASUREMENT_NUMBER_REQUIRED");
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) fail("SPEC_UNSAFE_NUMBER");
  const text = String(value);
  if (text.length > 120) fail("SPEC_DECIMAL_TOO_LARGE");
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (!match) fail("SPEC_DECIMAL_INVALID");
  const exponent = Number(match[3] ?? "0") - (match[2]?.length ?? 0);
  if (Math.abs(exponent) > 100) fail("SPEC_DECIMAL_TOO_LARGE");
  let numerator = BigInt(match[1] + (match[2] ?? "")), denominator = BigInt(1);
  if (exponent >= 0) numerator *= BigInt(10) ** BigInt(exponent); else denominator = BigInt(10) ** BigInt(-exponent);
  return rational(numerator, denominator);
}
function exactDecimal(n: bigint, d: bigint): string {
  const integer = n / d; let remainder = n % d;
  if (!remainder) return integer.toString();
  let fraction = "";
  while (remainder) {
    remainder *= BigInt(10); fraction += String(remainder / d); remainder %= d;
    if (fraction.length > 300) fail("SPEC_NON_TERMINATING_DECIMAL");
  }
  return `${integer}.${fraction}`;
}
// Exact metric and explicitly named US/imperial conversions. Ambiguous oz/gal rejected.
const UNIT_FACTORS: Record<string, Record<string, [string, string]>> = {
  dimension: { millimeters: ["1", "10"], mm: ["1", "10"], centimeters: ["1", "1"], cm: ["1", "1"],
    meters: ["100", "1"], m: ["100", "1"], inches: ["127", "50"], in: ["127", "50"], feet: ["762", "25"], ft: ["762", "25"], yards: ["2286", "25"] },
  volume: { milliliters: ["1", "1000"], ml: ["1", "1000"], centiliters: ["1", "100"], cl: ["1", "100"],
    liters: ["1", "1"], l: ["1", "1"], cubic_meters: ["1000", "1"], us_fluid_ounces: ["473176473", "16000000000"],
    us_pints: ["473176473", "1000000000"], us_quarts: ["473176473", "500000000"], us_gallons: ["473176473", "125000000"],
    imperial_fluid_ounces: ["454609", "16000000"], imperial_pints: ["454609", "800000"],
    imperial_quarts: ["454609", "400000"], imperial_gallons: ["454609", "100000"] },
  weight: { kilograms: ["1", "1"], kg: ["1", "1"], grams: ["1", "1000"], g: ["1", "1000"],
    pounds: ["45359237", "100000000"], lb: ["45359237", "100000000"], ounces: ["45359237", "1600000000"] },
};

export function normalizeMeasurement(key: SpecKey, raw: unknown): Measurement {
  assertKey(key);
  const definition = FIELD_DEFINITIONS[key];
  if (!("unit" in definition) || !raw || typeof raw !== "object" || Array.isArray(raw)) fail("SPEC_MEASUREMENT_REQUIRED");
  const input = raw as { value: unknown; unit: unknown };
  if (Object.keys(raw).some(k => !["value", "unit"].includes(k)) || typeof input.unit !== "string") fail("SPEC_MEASUREMENT_INVALID");
  const factors = UNIT_FACTORS[definition.type];
  const unit = input.unit.trim().toLowerCase();
  if (!Object.hasOwn(factors, unit)) fail("SPEC_UNIT_UNSUPPORTED_OR_AMBIGUOUS");
  const [n, d] = parseDecimal(input.value); if (n <= BigInt(0)) fail("SPEC_MEASUREMENT_MUST_BE_POSITIVE");
  const [fn, fd] = factors[unit];
  const [numerator, denominator] = rational(n * BigInt(fn), d * BigInt(fd));
  return { kind: "measurement", decimal: exactDecimal(numerator, denominator), unit: definition.unit,
    numerator: String(numerator), denominator: String(denominator), original: { value: input.value as string | number, unit: input.unit } };
}

export function validateProvenance(key: SpecKey, provenance: Provenance): Provenance {
  assertKey(key);
  if (!provenance || !["manufacturer", "merchant"].includes(provenance.authority) ||
      !["manufacturer_catalog", "gallery_typed_editor", "shopify_typed_metafield"].includes(provenance.producer) ||
      !provenance.evidenceId?.trim() || !Number.isFinite(Date.parse(provenance.observedAt))) fail("SPEC_PROVENANCE_REQUIRED");
  if (provenance.authority === "manufacturer") {
    if (provenance.producer !== "manufacturer_catalog" || !provenance.sourceUrl?.startsWith("https://") ||
        !(provenance.manufacturerSku || provenance.manufacturerModel)) fail("SPEC_MANUFACTURER_EVIDENCE_REQUIRED");
    if (FIELD_DEFINITIONS[key].type === "dimension" && provenance.axis !== key) fail("SPEC_EXPLICIT_AXIS_EVIDENCE_REQUIRED");
  } else if (provenance.producer === "manufacturer_catalog" || !provenance.intentId?.trim()) fail("SPEC_MERCHANT_INTENT_REQUIRED");
  return { ...clone(provenance), raw: boundedJson(provenance.raw) };
}

function text(value: unknown, max: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || (!multiline && /[\r\n]/.test(value))) fail("SPEC_TEXT_INVALID");
  // No HTML conversion/interpretation. Callers must escape this plain text on render.
  return value;
}
function sections(value: unknown): Sections {
  if (!Array.isArray(value) || value.length > 20) fail("SPEC_SECTIONS_INVALID");
  return value.map(section => {
    if (!section || typeof section !== "object" || Object.keys(section).some(k => !["heading", "items"].includes(k)) ||
        !Array.isArray(section.items) || section.items.length > 60) fail("SPEC_SECTIONS_INVALID");
    return { heading: text(section.heading, 60), items: section.items.map((item: { label: unknown; value: unknown }) => {
      if (!item || Object.keys(item).some(k => !["label", "value"].includes(k))) fail("SPEC_SECTIONS_INVALID");
      // Empty legacy value is preserved when the label itself carries the fact.
      if (typeof item.value !== "string" || item.value.length > 200) fail("SPEC_SECTIONS_INVALID");
      return { label: text(item.label, 200), value: item.value };
    }) };
  });
}
export function makeSpecValue(key: SpecKey, value: unknown, provenance: Provenance): SpecCell {
  assertKey(key); const definition = FIELD_DEFINITIONS[key]; let normalized: NormalizedValue;
  if ("unit" in definition) normalized = normalizeMeasurement(key, value);
  else if (definition.type === "boolean") { if (typeof value !== "boolean") fail("SPEC_BOOLEAN_REQUIRED"); normalized = value; }
  else if (definition.type === "number_integer") {
    const input = String(value); if (!/^\d{1,9}$/.test(input)) fail("SPEC_INTEGER_REQUIRED");
    normalized = String(BigInt(input)); // Zero is accepted only as an explicit certified value, never a default.
  } else if (definition.type === "json") normalized = sections(value);
  else normalized = text(value, definition.type === "multi_line_text_field" ? 10_000 : 1000, definition.type === "multi_line_text_field");
  return { state: "value", value: normalized, provenance: validateProvenance(key, provenance) };
}
export function makeSpecClear(key: SpecKey, provenance: Provenance): SpecCell {
  const checked = validateProvenance(key, provenance);
  if (checked.authority !== "merchant") fail("SPEC_CLEAR_REQUIRES_MERCHANT_INTENT");
  return { state: "clear", provenance: checked };
}
export function validateSpecCell(key: SpecKey, cell: SpecCell): SpecCell {
  assertKey(key);
  if (!cell || typeof cell !== "object") fail("SPEC_CELL_INVALID");
  if (cell.state === "missing" || cell.state === "absent") {
    if (Object.keys(cell).length !== 1) fail("SPEC_CELL_INVALID"); return clone(cell);
  }
  if (cell.state === "clear") return makeSpecClear(key, cell.provenance);
  if (cell.state !== "value") fail("SPEC_CELL_INVALID");
  const definition = FIELD_DEFINITIONS[key];
  if ("unit" in definition) {
    const measurement = cell.value as Measurement;
    if (!measurement || typeof measurement !== "object" || !measurement.original) fail("SPEC_MEASUREMENT_REQUIRED");
    const result = makeSpecValue(key, measurement.original, cell.provenance);
    if (result.state !== "value" || stable(result.value) !== stable(measurement)) fail("SPEC_NORMALIZED_VALUE_TAMPERED");
    return result;
  }
  return makeSpecValue(key, cell.value, cell.provenance);
}
export function validateSpecDocument(document: Document): Document {
  if (!document || typeof document !== "object" || !document.fields || typeof document.fields !== "object" || Array.isArray(document.fields)) fail("SPEC_DOCUMENT_INVALID");
  const fields: Document["fields"] = {};
  for (const [key, observation] of Object.entries(document.fields)) {
    assertKey(key); if (!observation) fail("SPEC_OBSERVATION_INVALID");
    fields[key] = observe(validateSpecCell(key, observation.cell), observation.revision);
  }
  return { fields, ...(document.rawProducerData === undefined ? {} : { rawProducerData: boundedJson(document.rawProducerData) }),
    ...(document.legacySections === undefined ? {} : { legacySections: boundedJson(document.legacySections) }) };
}
export function observe(cell: SpecCell, revision: string | null): Observation {
  if (revision !== null && (typeof revision !== "string" || !revision)) fail("SPEC_REVISION_INVALID");
  if (cell.state === "missing" && revision !== null) fail("SPEC_UNOBSERVED_REVISION_INVALID");
  if (cell.state === "absent" && revision !== null) fail("SPEC_ABSENT_REVISION_INVALID");
  if (cell.state === "value" && revision === null) fail("SPEC_PRESENT_REVISION_REQUIRED");
  return { cell: clone(cell), revision };
}
export function missing(): Observation { return { cell: { state: "missing" }, revision: null }; }
export function absent(): Observation { return { cell: { state: "absent" }, revision: null }; }
function semantic(cell: SpecCell): unknown {
  if (cell.state === "absent" || cell.state === "clear") return { state: "absent" };
  if (cell.state !== "value") return { state: cell.state };
  const value = cell.value;
  return { state: "value", value: value && typeof value === "object" && !Array.isArray(value) && "kind" in value
    ? { kind: "measurement", decimal: value.decimal, unit: value.unit } : value };
}
export function specValuesEqual(a: SpecCell, b: SpecCell): boolean { return stable(semantic(a)) === stable(semantic(b)); }
export function observationFingerprint(observation: Observation): string {
  return hash("sha256", stable(observation), "hex");
}
function isProtected(cell: SpecCell): boolean { return (cell.state === "value" || cell.state === "clear") && cell.provenance.authority === "merchant"; }
function manufacturerChange(cell: SpecCell): boolean { return cell.state === "value" && cell.provenance.authority === "manufacturer"; }
function hasFieldChange(current: SpecCell, baseline: SpecCell): boolean {
  if (current.state === "missing") return false;
  // Readback may represent a completed clear as absent, but a new merchant
  // deletion intent must still propagate across intentionally different baselines.
  const freshClear = current.state === "clear" && (baseline.state !== "clear" || current.provenance.intentId !== baseline.provenance.intentId);
  return freshClear || !specValuesEqual(current, baseline);
}

/** Independent baselines are mandatory. Neither timestamps nor scraper freshness pick a winner. */
export function planSpecMerge(currentInput: Baselines, baselineInput: Baselines): MergePlan {
  const current = { gallery: validateSpecDocument(currentInput.gallery), shopify: validateSpecDocument(currentInput.shopify) };
  const baseline = { gallery: validateSpecDocument(baselineInput.gallery), shopify: validateSpecDocument(baselineInput.shopify) };
  const plan: MergePlan = { operations: [], conflicts: [], acknowledgements: [] };
  for (const key of SPEC_KEYS) {
    const g = current.gallery.fields[key] ?? missing(), s = current.shopify.fields[key] ?? missing();
    const bg = baseline.gallery.fields[key] ?? missing(), bs = baseline.shopify.fields[key] ?? missing();
    if (g.cell.state === "missing" && s.cell.state === "missing") continue;
    if (bg.cell.state === "missing" || bs.cell.state === "missing") { plan.conflicts.push({ key, code: "SPEC_BASELINE_REQUIRED" }); continue; }
    const gc = hasFieldChange(g.cell, bg.cell);
    const sc = hasFieldChange(s.cell, bs.cell);
    if (!gc && !sc) continue;
    if ((gc && g.cell.state === "absent") || (sc && s.cell.state === "absent")) { plan.conflicts.push({ key, code: "SPEC_ABSENCE_NEEDS_EXPLICIT_CLEAR" }); continue; }
    if (g.cell.state === "missing" || s.cell.state === "missing") { plan.conflicts.push({ key, code: "SPEC_TARGET_UNOBSERVED" }); continue; }
    // Explicit clears also suppress legacy fallback when the typed target is
    // absent; semantic absence alone is not a durable cross-system clear receipt.
    const clearNeedsMarker = (gc && g.cell.state === "clear" && s.cell.state === "absent") || (sc && s.cell.state === "clear" && g.cell.state === "absent");
    if (specValuesEqual(g.cell, s.cell) && !clearNeedsMarker) { plan.acknowledgements.push({ key, gallery: clone(g), shopify: clone(s) }); continue; }
    if (gc && sc) { plan.conflicts.push({ key, code: "SPEC_CONCURRENT_FIELD_CONFLICT" }); continue; }
    const source: Side = gc ? "gallery" : "shopify", target: Side = gc ? "shopify" : "gallery";
    const sourceObservation = gc ? g : s, targetObservation = gc ? s : g;
    if (manufacturerChange(sourceObservation.cell) && isProtected(targetObservation.cell)) {
      plan.conflicts.push({ key, code: "SPEC_MERCHANT_CORRECTION_PROTECTED" }); continue;
    }
    plan.operations.push({ key, source, target, intent: sourceObservation.cell.state === "clear" ? "clear" : "set",
      value: clone(sourceObservation.cell), sourceObservation: clone(sourceObservation), expectedRevision: targetObservation.revision,
      expectedFingerprint: observationFingerprint(targetObservation) });
  }
  return plan;
}

export function assertFieldCas(operation: Operation, target: Observation): void {
  if (target.cell.state === "missing" || target.revision !== operation.expectedRevision || observationFingerprint(target) !== operation.expectedFingerprint) fail("SPEC_FIELD_CAS_CONFLICT");
}

/** Only verified readback advances baselines; conflicting fields and raw legacy data remain untouched. */
export function acceptVerifiedSpecReadback(baseline: Baselines, plan: MergePlan, readback: Baselines): Baselines {
  const next = { gallery: validateSpecDocument(baseline.gallery), shopify: validateSpecDocument(baseline.shopify) };
  readback = { gallery: validateSpecDocument(readback.gallery), shopify: validateSpecDocument(readback.shopify) };
  for (const operation of plan.operations) {
    const source = readback[operation.source].fields[operation.key] ?? missing();
    const target = readback[operation.target].fields[operation.key] ?? missing();
    if (source.revision !== operation.sourceObservation.revision || observationFingerprint(source) !== observationFingerprint(operation.sourceObservation) ||
        !specValuesEqual(source.cell, operation.value) || !specValuesEqual(target.cell, operation.value) || target.cell.state === "missing") fail("SPEC_READBACK_CONFLICT");
    next[operation.source].fields[operation.key] = clone(source);
    next[operation.target].fields[operation.key] = clone(target);
  }
  for (const acknowledgement of plan.acknowledgements) {
    for (const side of ["gallery", "shopify"] as const) {
      const actual = readback[side].fields[acknowledgement.key] ?? missing();
      if (observationFingerprint(actual) !== observationFingerprint(acknowledgement[side])) fail("SPEC_READBACK_CONFLICT");
      next[side].fields[acknowledgement.key] = clone(actual);
    }
  }
  return next;
}

export function encodeShopifySpecValue(key: SpecKey, cell: SpecCell): string {
  assertKey(key); cell = validateSpecCell(key, cell); if (cell.state !== "value") fail("SPEC_SET_REQUIRES_VALUE");
  const definition = FIELD_DEFINITIONS[key];
  if ("unit" in definition) {
    const value = cell.value as Measurement;
    // Write the exact decimal token, never Number(decimal), which can round.
    return `{"value":${value.decimal},"unit":${JSON.stringify(value.unit)}}`;
  }
  if (definition.type === "boolean") return cell.value ? "true" : "false";
  if (definition.type === "json") return JSON.stringify(cell.value);
  return cell.value as string;
}

export function buildShopifySpecWritePlan(ownerId: string, operations: Operation[]) {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(ownerId)) fail("SPEC_PRODUCT_OWNER_REQUIRED");
  const writes = operations.filter(operation => operation.target === "shopify");
  if (new Set(writes.map(operation => operation.key)).size !== writes.length || writes.length > 19) fail("SPEC_DUPLICATE_OR_TOO_MANY_FIELDS");
  for (const operation of writes) {
    if (!Object.hasOwn(operation, "expectedRevision") || (operation.expectedRevision !== null &&
        (typeof operation.expectedRevision !== "string" || !operation.expectedRevision.trim()))) fail("SPEC_COMPARE_DIGEST_REQUIRED");
  }
  const clears = writes.filter(operation => operation.intent === "clear");
  // metafieldsSet has compareDigest; deletion is a separate capability. Do not
  // call an unguarded delete or pretend blank/zero is a valid measurement clear.
  if (clears.length) return { status: "blocked_clear_transport" as const, sets: [], clears: clone(clears), reason: "SPEC_CLEAR_REQUIRES_GUARDED_TRANSPORT" };
  return { status: "ready" as const, clears: [], sets: writes.map(operation => ({
    ownerId, namespace: NAMESPACE, key: operation.key, type: FIELD_DEFINITIONS[operation.key].type,
    value: encodeShopifySpecValue(operation.key, operation.value), compareDigest: operation.expectedRevision,
  })) };
}

/** Decode only explicit typed metafields; never receive bodyHtml/inventory weight here. */
export function decodeShopifySpecField(input: { namespace: string; key: string; type: string; value: string; compareDigest: string }, provenance: Provenance): Observation {
  if (input.namespace !== NAMESPACE) fail("SPEC_NAMESPACE_MISMATCH"); assertKey(input.key);
  const definition = FIELD_DEFINITIONS[input.key];
  if (input.type !== definition.type) fail("SPEC_TYPE_COLLISION");
  let value: unknown = input.value;
  if ("unit" in definition) {
    // Narrow full-object parser retains the decimal token, including >53-bit precision.
    const number = "(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d{1,3})?)";
    const first = new RegExp(`^\\s*\\{\\s*"value"\\s*:\\s*${number}\\s*,\\s*"unit"\\s*:\\s*"([a-z_]+)"\\s*\\}\\s*$`).exec(input.value);
    const second = new RegExp(`^\\s*\\{\\s*"unit"\\s*:\\s*"([a-z_]+)"\\s*,\\s*"value"\\s*:\\s*${number}\\s*\\}\\s*$`).exec(input.value);
    if (!first && !second) fail("SPEC_MEASUREMENT_JSON_INVALID");
    value = first ? { value: first[1], unit: first[2] } : { value: second![2], unit: second![1] };
  } else if (definition.type === "boolean") {
    if (!["true", "false"].includes(input.value)) fail("SPEC_BOOLEAN_REQUIRED"); value = input.value === "true";
  } else if (definition.type === "json") {
    if (input.value.length > 250_000) fail("SPEC_SECTIONS_INVALID");
    try { value = JSON.parse(input.value); } catch { fail("SPEC_SECTIONS_INVALID"); }
  }
  return observe(makeSpecValue(input.key, value, provenance), input.compareDigest);
}
