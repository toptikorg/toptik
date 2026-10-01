import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchTypedSpecSnapshot, writeTypedSpecFields } from "./admin-api";
import { buildSpecWriteRequest, verifySpecWriteReadback, CLEAR_CONSUMER_CONTRACT, type Identity, type RawMetafield, type SpecSnapshot } from "./typed-spec-adapter";
import { SPEC_KEYS, FIELD_DEFINITIONS, absent, observe, makeSpecValue, makeSpecClear, decodeShopifySpecField, validateSpecDocument, planSpecMerge,
  acceptVerifiedSpecReadback, type Baselines, type Document, type Observation, type Provenance, type SpecKey } from "./typed-spec-core";
import { buildSpecStatePersistence } from "./typed-spec-state-adapter";

export const typedSpecSyncEnabled = () => process.env.VERCEL_ENV === "production" && process.env.SHOPIFY_TYPED_SPEC_SYNC === "enabled_v1";
export const typedSpecClearsEnabled = () => typedSpecSyncEnabled() && process.env.SHOPIFY_TYPED_SPEC_CLEAR_CONSUMER === CLEAR_CONSUMER_CONTRACT;
type FieldRow = { key: SpecKey; stateVersion: number; galleryVersion: number; galleryBaseline: Observation; shopifyBaseline: Observation; currentGallery: Observation };
export type TypedState = { identity: Identity & { itemId: string; gallerySku: string; productHandle: string }; fields: FieldRow[] };
export type TypedEditIdentity = Pick<TypedState["identity"], "itemId" | "variantGid" | "gallerySku" | "exactSku" | "productHandle">;
const safeCode = (error: unknown) => error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SPEC_OPERATION_FAILED";
export async function specRpc<T>(db: SupabaseClient, name: string, args: Record<string, unknown> = {}, deadline = Date.now() + 3_000): Promise<T> {
  if (Date.now() >= deadline) throw new Error("SPEC_TIME_BUDGET");
  const operation = db.rpc(name, args);
  const { data, error } = await (typeof operation.abortSignal === "function" ? operation.abortSignal(AbortSignal.timeout(Math.max(1, Math.min(3_000, deadline - Date.now())))) : operation);
  if (error) throw new Error(/^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SPEC_DATABASE_FAILED");
  return data as T;
}
export async function withTypedSpecLease<T>(db: SupabaseClient, productGid: string, callback: (owner: string) => Promise<T>): Promise<T> {
  if (!typedSpecSyncEnabled()) throw new Error("SPEC_DISABLED");
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productGid)) throw new Error("SPEC_IDENTITY_INVALID");
  const owner = randomUUID();
  if (!await specRpc<boolean>(db, "acquire_shopify_reconciliation_lease", { p_product_gid: productGid, p_owner: owner })) throw new Error("SPEC_PRODUCT_BUSY");
  try { return await callback(owner); } finally { await specRpc(db, "release_shopify_reconciliation_lease", { p_product_gid: productGid, p_owner: owner }); }
}
export async function readTypedState(db: SupabaseClient, productGid: string, owner: string, deadline = Date.now() + 5_000): Promise<TypedState> {
  const state = await specRpc<TypedState>(db, "read_toptik_spec_state", { p_product_gid: productGid, p_lease_owner: owner }, deadline);
  if (!state || state.identity?.productGid !== productGid || !Array.isArray(state.fields) || ![0, 19].includes(state.fields.length)) throw new Error("SPEC_STATE_INVALID");
  if (new Set(state.fields.map(field => field.key)).size !== state.fields.length) throw new Error("SPEC_STATE_INVALID");
  for (const field of state.fields) {
    if (!SPEC_KEYS.includes(field.key) || !Number.isSafeInteger(field.stateVersion) || field.stateVersion < 1 || !Number.isSafeInteger(field.galleryVersion) || field.galleryVersion < 1) throw new Error("SPEC_STATE_INVALID");
    for (const observation of [field.galleryBaseline, field.shopifyBaseline, field.currentGallery]) validateSpecDocument({ fields: { [field.key]: observation } });
  }
  return state;
}
function shopifyProvenance(key: SpecKey, raw: RawMetafield, clearIntentId?: string): Provenance {
  // Typed merchant fields are merchant claims, never inferred manufacturer facts.
  const base: Provenance = { authority: "merchant", producer: "shopify_typed_metafield", observedAt: raw.updatedAt,
    evidenceId: `${raw.id}:${raw.compareDigest}`, intentId: `shopify:${raw.id}:${raw.compareDigest}`,
    raw: { id: raw.id, namespace: raw.namespace, key, type: raw.type, value: raw.value, updatedAt: raw.updatedAt } };
  if (!clearIntentId) return base;
  const decoded = raw.namespace === "toptik_specs" ? decodeShopifySpecField(raw, base).cell : null;
  return { ...base, intentId: clearIntentId, raw: { intent: "clear", previousValue: decoded?.state === "value" ? decoded.value : null } };
}
export async function freshTypedShopify(state: TypedState, deadline = Date.now() + 10_000): Promise<SpecSnapshot> {
  if (Date.now() > deadline - 500) throw new Error("SPEC_TIME_BUDGET");
  const snapshot = await fetchTypedSpecSnapshot(state.identity, shopifyProvenance, Math.min(8_000, deadline - Date.now() - 250));
  return snapshot;
}
function docs(state: TypedState): { baseline: Baselines; currentGallery: Document } {
  return { baseline: { gallery: { fields: Object.fromEntries(state.fields.map(f => [f.key, f.galleryBaseline])) }, shopify: { fields: Object.fromEntries(state.fields.map(f => [f.key, f.shopifyBaseline])) } },
    currentGallery: { fields: Object.fromEntries(state.fields.map(f => [f.key, f.currentGallery])) } };
}
async function commitState(db: SupabaseClient, state: TypedState, owner: string, baselines: Baselines, keys: SpecKey[], initialize = false, deadline = Date.now() + 5_000): Promise<void> {
  const expectedVersions = Object.fromEntries(state.fields.filter(f => keys.includes(f.key)).map(f => [f.key, f.stateVersion]));
  const requestId = randomUUID();
  const built = buildSpecStatePersistence({ productGid: state.identity.productGid, leaseOwner: owner, requestId,
    mode: initialize ? "initialize" : "verified_readback", baselines, fieldKeys: keys, expectedVersions,
    evidence: { evidenceId: requestId, operation: initialize ? "independent_baseline" : "verified_readback", observedAt: new Date().toISOString() } });
  await specRpc(db, "commit_toptik_spec_readback", { ...built.args,
    p_gallery_versions: Object.fromEntries(state.fields.filter(f => keys.includes(f.key)).map(f => [f.key, f.galleryVersion])) }, deadline);
}
export async function initializeTypedSpecs(db: SupabaseClient, productGid: string): Promise<void> {
  await withTypedSpecLease(db, productGid, owner => initializeTypedSpecsUnderLease(db, productGid, owner));
}
export async function initializeTypedSpecsUnderLease(db: SupabaseClient, productGid: string, owner: string): Promise<void> {
    const state = await readTypedState(db, productGid, owner);
    if (state.fields.length) return;
    const snapshot = await freshTypedShopify(state);
    // Legacy dimension strings are intentionally not parsed. No initial cross-system overwrite.
    const gallery = { fields: Object.fromEntries(SPEC_KEYS.map(key => [key, absent()])) };
    await commitState(db, state, owner, { gallery, shopify: snapshot.document }, [...SPEC_KEYS], true);
}
export async function editTypedSpecs(db: SupabaseClient, productGid: string, requestId: string, changes: Record<string, unknown>, versions: Record<string, number>, expectedIdentity?: TypedEditIdentity): Promise<unknown> {
  return withTypedSpecLease(db, productGid, async owner => {
    const state = await readTypedState(db, productGid, owner);
    if (expectedIdentity && Object.entries(expectedIdentity).some(([key, value]) => state.identity[key as keyof TypedEditIdentity] !== value)) throw new Error("SPEC_IDENTITY_CHANGED");
    if (state.fields.length !== 19) throw new Error("SPEC_BASELINE_REQUIRED");
    const entries = Object.entries(changes);
    if (!entries.length || entries.length > 19 || Object.keys(versions).length !== entries.length || entries.some(([key]) => !Object.hasOwn(versions, key))) throw new Error("SPEC_EDIT_INVALID");
    const edits = entries.map(([key, raw]) => {
      if (!SPEC_KEYS.includes(key as SpecKey)) throw new Error("SPEC_FIELD_NOT_ALLOWED");
      if (raw === null && !typedSpecClearsEnabled()) throw new Error("SPEC_CLEAR_CONSUMER_NOT_READY");
      const version = versions[key]; if (!Number.isSafeInteger(version) || version < 1) throw new Error("SPEC_EDITOR_STALE");
      const provenance: Provenance = { authority: "merchant", producer: "gallery_typed_editor", observedAt: new Date().toISOString(),
        evidenceId: requestId, intentId: `${requestId}:${key}`, raw: raw as Provenance["raw"] };
      if (raw === null) {
        const row = state.fields.find(field => field.key === key)!;
        const cell = row.currentGallery.cell;
        const previous = cell.state === "value" ? cell.value : cell.state === "clear" && cell.provenance.raw && typeof cell.provenance.raw === "object" && "previousValue" in cell.provenance.raw ? cell.provenance.raw.previousValue : row.shopifyBaseline.cell.state === "value" ? row.shopifyBaseline.cell.value : null;
        provenance.raw = { intent: "clear", previousValue: previous } as Provenance["raw"];
      }
      return { key, expectedVersion: version, observation: observe(raw === null ? makeSpecClear(key as SpecKey, provenance) : makeSpecValue(key as SpecKey, raw, provenance), `${requestId}:${key}`) };
    });
    return specRpc(db, "edit_toptik_spec_fields", { p_product_gid: productGid, p_lease_owner: owner, p_request_id: requestId, p_edits: edits, p_evidence: { evidenceId: requestId, operation: "authenticated_editor" } });
  });
}

/** Exported integration hook: call after an accepted product webhook; no catalog admission. */
export async function enqueueTypedSpecProduct(db: SupabaseClient, productGid: string): Promise<boolean> {
  if (!typedSpecSyncEnabled()) return false;
  return specRpc(db, "enqueue_toptik_spec_work", { p_product_gid: productGid, p_reason: "shopify" });
}
export async function reconcileTypedSpecProduct(db: SupabaseClient, productGid: string, deadline = Date.now() + 40_000): Promise<{ conflicts: string[]; fields: number }> {
  return withTypedSpecLease(db, productGid, async owner => {
    let state: TypedState, initial: SpecSnapshot | undefined;
    try { state = await readTypedState(db, productGid, owner, deadline - 18_000); }
    catch (error) {
      if (safeCode(error) !== "SPEC_APPROVAL_MISSING_OR_CHANGED") throw error;
      const admission = await specRpc<{ identity: TypedState["identity"]; copyApprovalId: string }>(db, "read_toptik_spec_admission", { p_product_gid: productGid, p_lease_owner: owner }, deadline - 15_000);
      if (!admission || admission.identity?.productGid !== productGid || typeof admission.copyApprovalId !== "string") throw new Error("SPEC_STATE_INVALID");
      state = { identity: admission.identity, fields: [] };
      initial = await freshTypedShopify(state, deadline - 9_000);
      await specRpc(db, "activate_toptik_spec_product", { p_product_gid: productGid, p_lease_owner: owner,
        p_expected: { itemId: state.identity.itemId, variantId: state.identity.variantGid, exactGallerySku: state.identity.gallerySku, exactShopifySku: state.identity.exactSku, productHandle: state.identity.productHandle },
        p_approval_id: "copy-approved-auto-v1", p_evidence: { evidenceId: `copy-admission:${productGid}`, copyApprovalId: admission.copyApprovalId } }, deadline - 6_000);
      state = await readTypedState(db, productGid, owner, deadline - 3_000);
    }
    if (!state.fields.length) {
      initial ??= await freshTypedShopify(state, deadline - 3_000);
      const gallery = { fields: Object.fromEntries(SPEC_KEYS.map(key => [key, absent()])) };
      await commitState(db, state, owner, { gallery, shopify: initial.document }, [...SPEC_KEYS], true, deadline);
      return { conflicts: [], fields: 19 }; // Independent baseline only; never initial cross-system fill.
    }
    const before = await freshTypedShopify(state, deadline), { baseline, currentGallery } = docs(state);
    const plan = planSpecMerge({ gallery: currentGallery, shopify: before.document }, baseline);
    if (plan.operations.some(op => op.target === "shopify" && op.intent === "clear") && !typedSpecClearsEnabled()) throw new Error("SPEC_CLEAR_CONSUMER_NOT_READY");
    const toShopify = plan.operations.filter(op => op.target === "shopify");
    let after = before;
    if (toShopify.length) {
      // Recheck the live identity/approvals/lease just before the provider CAS write.
      await readTypedState(db, productGid, owner, deadline - 18_000);
      const immediate = await freshTypedShopify(state, deadline);
      const request = buildSpecWriteRequest(immediate, toShopify, { clearConsumerContract: typedSpecClearsEnabled() ? CLEAR_CONSUMER_CONTRACT : undefined });
      if (Date.now() > deadline - 18_000) throw new Error("SPEC_TIME_BUDGET");
      await writeTypedSpecFields(immediate, toShopify, deadline - 10_000);
      after = await freshTypedShopify(state, deadline - 6_000);
      if (request) verifySpecWriteReadback(request, after);
    } else if (plan.operations.length || plan.acknowledgements.length) after = await freshTypedShopify(state, deadline - 6_000);
    const freshState = await readTypedState(db, productGid, owner, deadline - 3_000), freshGallery = docs(freshState).currentGallery;
    // Simulate only the exact Shopify→Gallery planned fields; the commit RPC performs editor CAS.
    for (const operation of plan.operations.filter(op => op.target === "gallery")) freshGallery.fields[operation.key] = structuredClone(after.document.fields[operation.key]);
    const accepted = acceptVerifiedSpecReadback(baseline, plan, { gallery: freshGallery, shopify: after.document });
    const keys = [...new Set([...plan.operations.map(op => op.key), ...plan.acknowledgements.map(ack => ack.key)])];
    if (keys.length) await commitState(db, state, owner, accepted, keys, false, deadline);
    return { conflicts: plan.conflicts.map(conflict => conflict.code), fields: keys.length };
  });
}
export async function recoverTypedSpecQueue(db: SupabaseClient): Promise<number> {
  if (!typedSpecSyncEnabled()) return 0;
  return specRpc<number>(db, "recover_toptik_spec_work");
}
export async function typedSpecQueueStatus(db: SupabaseClient, deadline = Date.now() + 3_000): Promise<{pending:number;failed:number;review:number;processing:number}> {
  if (!typedSpecSyncEnabled()) return { pending: 0, failed: 0, review: 0, processing: 0 };
  return specRpc(db, "toptik_spec_queue_status", {}, deadline);
}
export async function drainTypedSpecQueue(db: SupabaseClient, deadline = Date.now() + 40_000): Promise<{ processed: number; failed: number; reviewed: number; continuationNeeded: boolean }> {
  const counts = { processed: 0, failed: 0, reviewed: 0, continuationNeeded: false };
  if (!typedSpecSyncEnabled()) return counts;
  for (let i = 0; i < 5 && Date.now() < deadline - 30_000; i++) {
    const owner = randomUUID(), claim = await specRpc<{ productGid: string; generation: number } | null>(db, "claim_toptik_spec_work", { p_owner: owner });
    if (!claim) break;
    let status: "complete" | "pending" | "failed" | "review" = "complete", error: string | null = null;
    // Nine seconds are reserved for lease release, queue completion and pending-work read.
    try { const result = await reconcileTypedSpecProduct(db, claim.productGid, deadline - 9_000); if (result.conflicts.length) { status = "review"; error = result.conflicts[0]; } }
    catch (failure) { error = safeCode(failure); status = ["SPEC_PRODUCT_BUSY", "SPEC_TIME_BUDGET"].includes(error) ? "pending" : "failed"; }
    await specRpc(db, "finish_toptik_spec_work", { p_product_gid: claim.productGid, p_owner: owner, p_generation: claim.generation, p_status: status, p_error: error }, deadline - 3_000);
    if (status === "complete") counts.processed++; else if (status === "review") counts.reviewed++;
    else if (error !== "SPEC_TIME_BUDGET") counts.failed++;
    if (status !== "complete") break;
  }
  if (counts.processed > 0 && !counts.failed && !counts.reviewed) counts.continuationNeeded = (await typedSpecQueueStatus(db, deadline)).pending > 0;
  return counts;
}
export function typedSpecDefinitions() { return SPEC_KEYS.map(key => ({ key, ...FIELD_DEFINITIONS[key] })); }
