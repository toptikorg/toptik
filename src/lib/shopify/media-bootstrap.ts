import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { createMediaTransportRpc } from "./media-transport-rpc";
import { parseGalleryMediaRaw } from "./media-gallery-transport";
import { captureMediaPlanningPair } from "./media-planning-observation";
import { readMediaRuntimeScopes } from "./media-runtime-access";
import type { MediaIdentity, MediaPair } from "./media-sync-core";
import type { MediaPlanningContext } from "./media-planning-rpc";

type Db = Pick<SupabaseClient, "rpc">;
type Captured = Awaited<ReturnType<typeof captureMediaPlanningPair>>;
type Dependencies = { client?: Db; transport?: typeof createMediaTransportRpc; capture?: typeof captureMediaPlanningPair;
  scopes?: typeof readMediaRuntimeScopes; now?: () => number; environment?: { VERCEL_ENV?: string; SHOPIFY_MEDIA_SYNC?: string } };
function fail(code: string): never { throw new Error(code); }
/** Initial correspondence only when unique REAL decoded bytes match on both
 * sides. Same name/order/dimensions alone never establish a relationship. */
export function matchBootstrapExactBytes(input: Captured): Captured {
  const result = structuredClone(input);
  for (const g of result.pair.gallery.assets) {
    if (result.pair.gallery.assets.filter(a => a.contentId === g.contentId).length !== 1) continue;
    const matches = result.pair.shopify.assets.filter(a => a.contentId === g.contentId);
    if (matches.length !== 1) continue;
    const s = matches[0], gp = result.proofs.find(p => p.side === "gallery" && p.evidenceId === g.evidenceId),
      sp = result.proofs.find(p => p.side === "shopify" && p.evidenceId === s.evidenceId);
    if (!gp || !sp || gp.proof.decodedSha256 !== g.contentId || sp.proof.decodedSha256 !== g.contentId ||
        gp.proof.width !== sp.proof.width || gp.proof.height !== sp.proof.height || gp.proof.mime !== sp.proof.mime ||
        gp.proof.byteLength !== sp.proof.byteLength) continue;
    s.key = g.key; sp.key = g.key;
  }
  return result;
}

/** Only server reads establish this product's independent starting state. The
 * initialization transaction writes private evidence/baselines, never images,
 * Shopify fields, public catalog fields or the established copy approval. */
export async function bootstrapProductionMedia(productId: string, enable: boolean, deadline: number, dependencies: Dependencies = {}) {
  const env = dependencies.environment ?? process.env, now = dependencies.now ?? Date.now;
  if (env.VERCEL_ENV !== "production") fail("MEDIA_BOOTSTRAP_PRODUCTION_REQUIRED");
  if (!/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(productId) || typeof enable !== "boolean") fail("MEDIA_BOOTSTRAP_INPUT_INVALID");
  if (enable && env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") fail("MEDIA_BOOTSTRAP_ACTIVATION_DISABLED");
  const stop = Math.min(deadline, now() + 45000), work = stop - 3000;
  const check = () => { if (!Number.isFinite(deadline) || now() >= work) fail("MEDIA_BOOTSTRAP_TIME_BUDGET"); }; check();
  let client = dependencies.client;
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    check(); const ms = Math.min(5000, work - now()), abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client ??= createSupabaseServiceRoleClient();
      const response = await Promise.race([Promise.resolve(client.rpc(name, args).abortSignal(abort.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error("MEDIA_BOOTSTRAP_TIME_BUDGET")); }, ms);
      })]); check();
      if (!response || response.error) throw response?.error ?? new Error("MEDIA_BOOTSTRAP_RESPONSE_INVALID");
      if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) fail("MEDIA_BOOTSTRAP_RESPONSE_INVALID");
      return structuredClone(response.data);
    } catch (e) { const message = e && typeof e === "object" && "message" in e ? String(e.message) : "";
      throw new Error(/^(MEDIA_|SYNC_COPY_)[A-Z0-9_]{1,90}$/.test(message) ? message : "MEDIA_BOOTSTRAP_RPC_FAILED");
    } finally { if (timer) clearTimeout(timer); }
  };
  const rpc = (dependencies.transport ?? createMediaTransportRpc)(productId, dependencies.client ? { client: dependencies.client } : {});
  const lease = await rpc.acquire(work); if (!lease) fail("MEDIA_BOOTSTRAP_BUSY");
  try {
    if (lease.expiresAt < stop + 5000) fail("MEDIA_BOOTSTRAP_LEASE_TOO_SHORT");
    const scopes = await (dependencies.scopes ?? readMediaRuntimeScopes)(work); check();
    if (enable && (!scopes.scopes.includes("write_products") || !["write_files", "write_themes", "write_images"].some(s => scopes.scopes.includes(s)))) fail("MEDIA_BOOTSTRAP_SCOPE_REQUIRED");
    const args = { p_product_gid: productId, p_lease_owner: lease.owner };
    const status = await call("read_toptik_media_bootstrap_context", args), id = status.identity as MediaIdentity;
    if (id?.productId !== productId || typeof status.initialized !== "boolean" || typeof status.enabled !== "boolean") fail("MEDIA_BOOTSTRAP_IDENTITY_CHANGED");
    const raw = parseGalleryMediaRaw(status.galleryRaw, id);
    if (status.initialized) {
      if (typeof status.approvalId !== "string" || !/^[a-f0-9-]{36}$/.test(status.approvalId)) fail("MEDIA_BOOTSTRAP_RESPONSE_INVALID");
      if (enable && !status.enabled) await call("set_toptik_media_enabled", { ...args, p_request_id: randomUUID(), p_enabled: true, p_approval_id: status.approvalId });
      return { initialized: true, alreadyInitialized: true, enabled: enable || status.enabled, approvalId: status.approvalId };
    }
    const empty: MediaPair = { gallery: { identity: id, side: "gallery", complete: true, revision: raw.revision, assets: [] },
      shopify: { identity: id, side: "shopify", complete: true, revision: "uninitialized", assets: [] } };
    const context: MediaPlanningContext = { identity: id, stateVersion: 1, baselines: empty, removals: [], detached: [], operations: [], steps: [],
      galleryRaw: raw, galleryRefs: [], provenance: [] };
    const observed = matchBootstrapExactBytes(await (dependencies.capture ?? captureMediaPlanningPair)(context, lease.owner, work, { observationOnlyBootstrap: true })); check();
    const approvalId = randomUUID();
    const result = await call("initialize_toptik_media_observation", { ...args, p_approval_id: approvalId,
      p_pair: observed.pair, p_proofs: observed.proofs, p_refs: observed.refs, p_enable: enable,
      p_evidence: { evidenceId: `server-media-bootstrap-v1:${approvalId}`, policyVersion: "exact-decoded-independent-baselines-v1",
        verifiedAt: new Date(now()).toISOString(), scopes: scopes.scopes } });
    if (result.initialized !== true || result.approvalId !== approvalId || result.enabled !== enable) fail("MEDIA_BOOTSTRAP_RESPONSE_INVALID");
    return { initialized: true, alreadyInitialized: false, enabled: enable, approvalId,
      galleryImages: observed.pair.gallery.assets.length, shopifyImages: observed.pair.shopify.assets.length,
      sharedExactImages: observed.pair.gallery.assets.filter(g => observed.pair.shopify.assets.some(s => s.key === g.key)).length };
  } finally { try { await rpc.release(lease.owner, Math.min(stop, now() + 2000)); } catch { /* owned lease expires */ } }
}
