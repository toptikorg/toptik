import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { mediaSnapshotFingerprint, type MediaIdentity, type MediaPair, type MediaPlan, type RemovalEvidence, type DetachReceipt } from "./media-sync-core";
import { parseGalleryMediaRaw, type GalleryMediaRaw, type GalleryMediaRef } from "./media-gallery-transport";

export type MediaProofRow = { product_gid: string; evidence_id: string; asset_key: string; side: "gallery" | "shopify"; content_id: string; proof: Record<string, unknown> };
export type MediaRegisteredProof = { evidenceId: string; key: string; side: "gallery" | "shopify"; contentId: string; proof: Record<string, unknown> };
export type MediaPlanningContext = { identity: MediaIdentity; stateVersion: number; baselines: MediaPair; removals: RemovalEvidence[]; detached: DetachReceipt[];
  operations: Record<string, unknown>[]; steps: Record<string, unknown>[]; galleryRaw: GalleryMediaRaw; galleryRefs: GalleryMediaRef[]; provenance: MediaProofRow[] };
export type MediaPlanningOptions = { client?: Pick<SupabaseClient, "rpc">; now?: () => number };
const PRODUCT = /^gid:\/\/shopify\/Product\/[1-9]\d*$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fail(code: string): never { throw new Error(code); }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) fail("MEDIA_PLANNING_RESPONSE_INVALID"); return v as Record<string, unknown>; }
function uuid(v: string) { if (!UUID.test(v)) fail("MEDIA_PLANNING_ID_INVALID"); }
function pair(p: MediaPair, product: string) { for (const side of ["gallery", "shopify"] as const) {
  mediaSnapshotFingerprint(p[side]); if (p[side].side !== side || p[side].identity.productId !== product) fail("MEDIA_PLANNING_IDENTITY_CHANGED"); } }

/** Bounded RPC channel; all public methods use fixed names and typed arguments. */
export function createMediaPlanningRpc(productId: string, options: MediaPlanningOptions = {}) {
  if (!PRODUCT.test(productId)) fail("MEDIA_PLANNING_ID_INVALID");
  const now = options.now ?? Date.now; let client = options.client;
  async function call(name: string, args: Record<string, unknown>, deadline: number): Promise<unknown> {
    const ms = Math.min(5000, deadline - now()); if (!Number.isFinite(deadline) || ms <= 0) fail("MEDIA_PLANNING_TIME_BUDGET");
    const encoded = JSON.stringify(args); if (Buffer.byteLength(encoded) > 10_000_000) fail("MEDIA_PLANNING_INPUT_LIMIT");
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client ??= createSupabaseServiceRoleClient();
      const query = client.rpc(name, JSON.parse(encoded)), response = await Promise.race([Promise.resolve(query.abortSignal(controller.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("MEDIA_PLANNING_TIME_BUDGET")); }, ms);
      })]);
      if (now() >= deadline) fail("MEDIA_PLANNING_TIME_BUDGET");
      if (!response || response.error) throw response?.error ?? new Error("MEDIA_PLANNING_RESPONSE_INVALID");
      return structuredClone(response.data);
    } catch (error) { const code = error && typeof error === "object" && "message" in error ? String(error.message) : "";
      throw new Error(/^(MEDIA_|SYNC_COPY_)[A-Z0-9_]{1,90}$/.test(code) ? code : "MEDIA_PLANNING_RPC_FAILED");
    } finally { if (timer) clearTimeout(timer); }
  }
  const args = (owner: string) => { uuid(owner); return { p_product_gid: productId, p_lease_owner: owner }; };
  return {
    async context(owner: string, deadline: number): Promise<MediaPlanningContext> {
      const r = object(await call("read_toptik_media_planning_context", args(owner), deadline));
      const id = r.identity as MediaIdentity; if (id?.productId !== productId || !Number.isSafeInteger(r.stateVersion) || Number(r.stateVersion) < 1) fail("MEDIA_PLANNING_IDENTITY_CHANGED");
      pair(r.baselines as MediaPair, productId); const raw = parseGalleryMediaRaw(r.galleryRaw, id);
      if (!Array.isArray(r.galleryRefs) || r.galleryRefs.length > 31 || !Array.isArray(r.provenance) || r.provenance.length > 2000 ||
          r.provenance.some(p => object(p).product_gid !== productId) || !Array.isArray(r.operations) || r.operations.length > 1 ||
          !Array.isArray(r.steps) || r.steps.length > 2 || !Array.isArray(r.removals) || !Array.isArray(r.detached)) fail("MEDIA_PLANNING_RESPONSE_INVALID");
      return { ...r, galleryRaw: raw } as MediaPlanningContext;
    },
    async register(owner: string, proofs: MediaRegisteredProof[], deadline: number) {
      if (!Array.isArray(proofs) || proofs.length > 500) fail("MEDIA_PLANNING_INPUT_LIMIT");
      if (await call("register_toptik_media_provenance", { ...args(owner), p_proofs: proofs }, deadline) !== true) fail("MEDIA_PLANNING_REGISTER_FAILED");
    },
    async journal(owner: string, current: MediaPair, deadline: number) { pair(current, productId); return object(await call("read_toptik_media_journal", { ...args(owner), p_current: current }, deadline)); },
    async reserve(owner: string, version: number, current: MediaPair, plan: MediaPlan, deadline: number) {
      pair(current, productId); if (!Number.isSafeInteger(version) || version < 1) fail("MEDIA_PLANNING_VERSION_INVALID");
      return object(await call("reserve_toptik_media_operation", { ...args(owner), p_operation_id: randomUUID(), p_expected_version: version, p_current: current, p_plan: plan }, deadline));
    },
    async begin(owner: string, operationId: string, step: number, current: MediaPair, deadline: number) {
      uuid(operationId); pair(current, productId); if (!Number.isInteger(step) || step < 0 || step > 1000) fail("MEDIA_PLANNING_STEP_INVALID");
      return object(await call("begin_toptik_media_step", { ...args(owner), p_operation_id: operationId, p_step_index: step, p_attempt_id: randomUUID(), p_fresh: current }, deadline));
    },
    async accept(owner: string, operationId: string, step: number, current: MediaPair, deadline: number) {
      uuid(operationId); pair(current, productId); if (!Number.isInteger(step) || step < 0 || step > 1000) fail("MEDIA_PLANNING_STEP_INVALID");
      return object(await call("accept_toptik_media_readback", { ...args(owner), p_operation_id: operationId, p_step_index: step, p_request_id: randomUUID(), p_observed: current }, deadline));
    },
    async commit(owner: string, operationId: string, current: MediaPair, deadline: number) {
      uuid(operationId); pair(current, productId); return object(await call("commit_toptik_media_operation", { ...args(owner), p_operation_id: operationId, p_request_id: randomUUID(), p_fresh: current }, deadline));
    },
    async removal(owner: string, side: "gallery" | "shopify", key: string, fingerprint: string, evidence: Record<string, unknown>, deadline: number) {
      const requestId = randomUUID(), proof = side === "gallery" ? { kind: "authenticated_editor", ...evidence, requestId, origin: "https://landing.toptik.co.il" } : evidence;
      return await call("record_toptik_media_removal", { ...args(owner), p_request_id: requestId, p_side: side, p_key: key, p_baseline_fingerprint: fingerprint, p_auth_evidence: proof }, deadline) as RemovalEvidence;
    },
  };
}
