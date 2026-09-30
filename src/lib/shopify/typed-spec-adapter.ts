/** Isolated pure GraphQL adapter draft. No HTTP client, credentials or runtime activation. */
import { createHash } from "node:crypto";
import { NAMESPACE, FIELD_DEFINITIONS, SPEC_KEYS, absent, observe, makeSpecClear,
  decodeShopifySpecField, encodeShopifySpecValue, assertFieldCas, validateSpecCell,
  specValuesEqual, type SpecKey, type Document, type Operation, type Provenance } from "./typed-spec-core";

export const API_VERSION = "2026-07";
export const CLEAR_NAMESPACE = "toptik_specs_sync";
export const CLEAR_KEY = "clear_state_v1";
export const CLEAR_CONSUMER_CONTRACT = "typed-spec-clear-aware-v1";
export type Identity = { productGid: string; variantGid: string; exactSku: string };
export type RawMetafield = { id: string; namespace: string; key: string; type: string; value: string; compareDigest: string; updatedAt: string };
type ClearMarker = { intentId: string; valueHash: string };
type ClearState = { version: 1; cleared: Partial<Record<SpecKey, ClearMarker>> };
export type SpecSnapshot = { identity: Identity; updatedAt: string; raw: Record<SpecKey, RawMetafield | null>;
  control: RawMetafield | null; clearState: ClearState; document: Document };
export type ProvenanceResolver = (key: SpecKey, raw: RawMetafield, clearIntentId?: string) => Provenance;
export type MetafieldSet = { ownerId: string; namespace: string; key: string; type: string; value: string; compareDigest: string | null };
const selected = "id namespace key type value compareDigest updatedAt";
function fail(code: string): never { throw new Error(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SPEC_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function iso(value: unknown): value is string { return typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)); }
function keyAllowed(key: string): asserts key is SpecKey { if (!Object.hasOwn(FIELD_DEFINITIONS, key)) fail("SPEC_FIELD_NOT_ALLOWED"); }
function identity(value: Identity): Identity {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(value.productGid) || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(value.variantGid) ||
      !nonempty(value.exactSku) || value.exactSku !== value.exactSku.trim() || value.exactSku.length > 64) fail("SPEC_IDENTITY_INVALID");
  return structuredClone(value);
}
function data(response: unknown): Record<string, unknown> {
  const envelope = object(response);
  if (Object.hasOwn(envelope, "errors") && (!Array.isArray(envelope.errors) || envelope.errors.length)) fail("SPEC_GRAPHQL_ERROR");
  return object(envelope.data);
}
function rawField(input: unknown, namespace: string, key: string, type: string): RawMetafield | null {
  if (input === null) return null;
  const value = object(input);
  if (!/^gid:\/\/shopify\/Metafield\/\d+$/.test(String(value.id)) || value.namespace !== namespace || value.key !== key || value.type !== type ||
      typeof value.value !== "string" || value.value.length > 300_000 || !nonempty(value.compareDigest) || !iso(value.updatedAt)) fail("SPEC_METAFIELD_SHAPE_OR_TYPE_CONFLICT");
  return { id: value.id as string, namespace, key, type, value: value.value, compareDigest: value.compareDigest, updatedAt: value.updatedAt };
}
export function rawSpecValueHash(raw: Pick<RawMetafield, "namespace" | "key" | "type" | "value">): string {
  return createHash("sha256").update(JSON.stringify([raw.namespace, raw.key, raw.type, raw.value])).digest("hex");
}
function parseClearState(control: RawMetafield | null): ClearState {
  if (!control) return { version: 1, cleared: {} };
  let parsed: Record<string, unknown>;
  try { parsed = object(JSON.parse(control.value)); } catch { return fail("SPEC_CLEAR_STATE_INVALID"); }
  if (parsed.version !== 1 || Object.keys(parsed).sort().join(",") !== "cleared,version") fail("SPEC_CLEAR_STATE_INVALID");
  const cleared = object(parsed.cleared), result: ClearState = { version: 1, cleared: {} };
  if (Object.keys(cleared).length > 19) fail("SPEC_CLEAR_STATE_INVALID");
  for (const [key, markerInput] of Object.entries(cleared)) {
    keyAllowed(key); const marker = object(markerInput);
    if (Object.keys(marker).sort().join(",") !== "intentId,valueHash" || !nonempty(marker.intentId) || marker.intentId.length > 200 || !/^[a-f0-9]{64}$/.test(String(marker.valueHash))) fail("SPEC_CLEAR_STATE_INVALID");
    result.cleared[key] = { intentId: marker.intentId, valueHash: marker.valueHash as string };
  }
  return result;
}
export function buildSpecReadRequest(expected: Identity) {
  identity(expected);
  const fields = SPEC_KEYS.map(key => `f_${key}: metafield(namespace: "${NAMESPACE}", key: "${key}") { ${selected} }`).join("\n");
  return { apiVersion: API_VERSION, query: `query TopTikTypedSpecs($id: ID!, $publicationId: ID!) { product(id: $id) { id handle status publishedOnPublication(publicationId: $publicationId) updatedAt variants(first: 2) { nodes { id sku } pageInfo { hasNextPage } } ${fields}\n control: metafield(namespace: "${CLEAR_NAMESPACE}", key: "${CLEAR_KEY}") { ${selected} } } }`, variables: { id: expected.productGid, publicationId: "gid://shopify/Publication/79538258170" } };
}
export function parseSpecReadResponse(response: unknown, expectedInput: Identity, provenance: ProvenanceResolver): SpecSnapshot {
  const expected = identity(expectedInput), product = object(data(response).product), variants = object(product.variants);
  const nodes = variants.nodes;
  if (product.id !== expected.productGid || !iso(product.updatedAt) || !Array.isArray(nodes) || nodes.length !== 1 ||
      object(variants.pageInfo).hasNextPage !== false || object(nodes[0]).id !== expected.variantGid || object(nodes[0]).sku !== expected.exactSku) fail("SPEC_IDENTITY_CHANGED");
  if (!Object.hasOwn(product, "control")) fail("SPEC_RESPONSE_INCOMPLETE");
  const control = rawField(product.control, CLEAR_NAMESPACE, CLEAR_KEY, "json"), clearState = parseClearState(control);
  const raw = {} as Record<SpecKey, RawMetafield | null>, document: Document = { fields: {} };
  for (const key of SPEC_KEYS) {
    if (!Object.hasOwn(product, `f_${key}`)) fail("SPEC_RESPONSE_INCOMPLETE");
    const field = rawField(product[`f_${key}`], NAMESPACE, key, FIELD_DEFINITIONS[key].type); raw[key] = field;
    if (!field) { document.fields[key] = absent(); continue; }
    const marker = clearState.cleared[key];
    if (marker && marker.valueHash === rawSpecValueHash(field)) {
      const source = provenance(key, field, marker.intentId);
      if (source.authority !== "merchant" || source.intentId !== marker.intentId) fail("SPEC_CLEAR_PROVENANCE_MISSING");
      document.fields[key] = observe(makeSpecClear(key, source), field.compareDigest);
    } else document.fields[key] = decodeShopifySpecField(field, provenance(key, field));
  }
  return { identity: expected, updatedAt: product.updatedAt, raw, control, clearState, document };
}
export type SpecWriteRequest = { apiVersion: string; query: string; variables: { metafields: MetafieldSet[] }; identity: Identity; operations: Operation[] };
/** Caller must perform final exact-identity/lease authorization before sending. No automatic retries. */
export function buildSpecWriteRequest(snapshot: SpecSnapshot, operations: Operation[], options: { clearConsumerContract?: string } = {}): SpecWriteRequest | null {
  const expected = identity(snapshot.identity), writes = operations.filter(operation => operation.target === "shopify");
  if (!writes.length) return null;
  if (writes.length > 19 || new Set(writes.map(operation => operation.key)).size !== writes.length) fail("SPEC_DUPLICATE_OR_TOO_MANY_FIELDS");
  if (!Object.hasOwn(snapshot, "control")) fail("SPEC_RESPONSE_INCOMPLETE");
  const control = rawField(snapshot.control, CLEAR_NAMESPACE, CLEAR_KEY, "json");
  const clearState = parseClearState(control), metafields: MetafieldSet[] = [];
  for (const operation of writes) {
    keyAllowed(operation.key);
    if (!Object.hasOwn(operation, "expectedRevision") || (operation.expectedRevision !== null && !nonempty(operation.expectedRevision))) fail("SPEC_COMPARE_DIGEST_REQUIRED");
    if (operation.source !== "gallery" || !["clear", "set"].includes(operation.intent)) fail("SPEC_OPERATION_INVALID");
    const cell = validateSpecCell(operation.key, operation.value), target = snapshot.document.fields[operation.key];
    if (!target) fail("SPEC_TARGET_UNOBSERVED"); assertFieldCas(operation, target);
    if (!Object.hasOwn(snapshot.raw, operation.key)) fail("SPEC_RESPONSE_INCOMPLETE");
    const raw = rawField(snapshot.raw[operation.key], NAMESPACE, operation.key, FIELD_DEFINITIONS[operation.key].type);
    if (operation.expectedRevision !== (raw?.compareDigest ?? null)) fail("SPEC_FIELD_CAS_CONFLICT");
    let value: string;
    if (operation.intent === "clear") {
      if (cell.state !== "clear" || !raw || options.clearConsumerContract !== CLEAR_CONSUMER_CONTRACT) fail("SPEC_CLEAR_REQUIRES_VERIFIED_CONSUMERS");
      value = raw.value; // A no-op typed-value write supplies the atomic CAS guard for the clear marker.
      clearState.cleared[operation.key] = { intentId: cell.provenance.intentId!, valueHash: rawSpecValueHash(raw) };
    } else {
      if (cell.state !== "value") fail("SPEC_SET_REQUIRES_VALUE");
      value = encodeShopifySpecValue(operation.key, cell); delete clearState.cleared[operation.key];
    }
    metafields.push({ ownerId: expected.productGid, namespace: NAMESPACE, key: operation.key, type: FIELD_DEFINITIONS[operation.key].type, value, compareDigest: operation.expectedRevision });
  }
  // One shared marker map keeps all19 possible field edits inside Shopify's25-field atomic limit.
  metafields.push({ ownerId: expected.productGid, namespace: CLEAR_NAMESPACE, key: CLEAR_KEY, type: "json", value: JSON.stringify(clearState), compareDigest: control?.compareDigest ?? null });
  const query = `mutation TopTikTypedSpecsSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { ${selected} } userErrors { field code } } }`;
  if (Buffer.byteLength(JSON.stringify({ query, variables: { metafields } }), "utf8") > 1_000_000) fail("SPEC_MUTATION_TOO_LARGE");
  return { apiVersion: API_VERSION, query, variables: { metafields }, identity: expected, operations: structuredClone(writes) };
}
/** Mutation acknowledgement is not live completion: a fresh product readback is mandatory. */
export function parseSpecWriteResponse(response: unknown, request: SpecWriteRequest): RawMetafield[] {
  const result = object(data(response).metafieldsSet);
  if (!Array.isArray(result.userErrors)) fail("SPEC_MUTATION_RESPONSE_INVALID");
  if (result.userErrors.length) {
    const isCas = result.userErrors.some(error => ["INVALID_COMPARE_DIGEST", "STALE_OBJECT"].includes(String(object(error).code)));
    fail(isCas ? "SPEC_SHOPIFY_CAS_CONFLICT" : "SPEC_SHOPIFY_MUTATION_REJECTED");
  }
  if (!Array.isArray(result.metafields) || result.metafields.length !== request.variables.metafields.length) fail("SPEC_MUTATION_RESPONSE_INCOMPLETE");
  return request.variables.metafields.map(expected => {
    const matches = (result.metafields as unknown[]).filter(candidate => object(candidate).namespace === expected.namespace && object(candidate).key === expected.key);
    if (matches.length !== 1) fail("SPEC_MUTATION_RESPONSE_INCOMPLETE");
    const actual = rawField(matches[0], expected.namespace, expected.key, expected.type);
    if (!actual) fail("SPEC_MUTATION_RESPONSE_INCOMPLETE"); return actual;
  });
}
export function verifySpecWriteReadback(request: SpecWriteRequest, fresh: SpecSnapshot): void {
  for (const key of ["productGid", "variantGid", "exactSku"] as const) if (fresh.identity[key] !== request.identity[key]) fail("SPEC_IDENTITY_CHANGED");
  for (const operation of request.operations) {
    const actual = fresh.document.fields[operation.key];
    if (!actual || !specValuesEqual(actual.cell, operation.value)) fail("SPEC_READBACK_CONFLICT");
    if (operation.intent === "clear" && (actual.cell.state !== "clear" || operation.value.state !== "clear" || actual.cell.provenance.intentId !== operation.value.provenance.intentId)) fail("SPEC_READBACK_CONFLICT");
  }
}
