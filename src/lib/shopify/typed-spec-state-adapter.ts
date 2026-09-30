/** Pure named-argument builder for the isolated private state RPC. */
import { SPEC_KEYS, validateSpecDocument, type Baselines, type SpecKey, type Json } from "./typed-spec-core";
type StateVersions = Partial<Record<SpecKey, number>>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function buildSpecStatePersistence(input: {
  productGid: string; leaseOwner: string; requestId: string; mode: "initialize" | "verified_readback";
  baselines: Baselines; fieldKeys: SpecKey[]; expectedVersions: StateVersions;
  evidence: { evidenceId: string; [key: string]: Json };
}) {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(input.productGid) || !uuid.test(input.leaseOwner) || !uuid.test(input.requestId)) throw new Error("SPEC_STATE_IDENTITY_INVALID");
  if (!["initialize", "verified_readback"].includes(input.mode)) throw new Error("SPEC_STATE_MODE_INVALID");
  const gallery = validateSpecDocument(input.baselines.gallery), shopify = validateSpecDocument(input.baselines.shopify);
  const keys = input.fieldKeys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 19 || new Set(keys).size !== keys.length || keys.some(key => !SPEC_KEYS.includes(key))) throw new Error("SPEC_STATE_FIELDS_INVALID");
  if (input.mode === "initialize" && (keys.length !== 19 || Object.keys(input.expectedVersions).length !== 0)) throw new Error("SPEC_COMPLETE_BASELINE_REQUIRED");
  if (input.mode === "verified_readback" && (Object.keys(input.expectedVersions).length !== keys.length || Object.keys(input.expectedVersions).some(key => !keys.includes(key as SpecKey)))) throw new Error("SPEC_STATE_VERSIONS_INVALID");
  const changes = keys.map(key => {
    const g = gallery.fields[key], s = shopify.fields[key];
    if (!g || !s || g.cell.state === "missing" || s.cell.state === "missing") throw new Error("SPEC_BASELINE_REQUIRED");
    const version = input.expectedVersions[key];
    if (input.mode === "verified_readback" && (!Object.hasOwn(input.expectedVersions, key) || !Number.isSafeInteger(version) || version! < 1)) throw new Error("SPEC_STATE_VERSIONS_INVALID");
    return { key, expectedVersion: input.mode === "initialize" ? null : version!, gallery: g, shopify: s };
  });
  if (!input.evidence || typeof input.evidence.evidenceId !== "string" || !input.evidence.evidenceId.trim()) throw new Error("SPEC_STATE_EVIDENCE_REQUIRED");
  // Reuse strict JSON validation: do not lose undefined/NaN producer evidence during serialization.
  const evidence = validateSpecDocument({ fields: {}, rawProducerData: input.evidence }).rawProducerData;
  return { rpc: "persist_toptik_spec_state", args: { p_product_gid: input.productGid, p_lease_owner: input.leaseOwner,
    p_request_id: input.requestId, p_changes: changes, p_evidence: evidence } };
}
