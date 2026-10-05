import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { reconcilePersistedMediaProduct, type MediaWorkEvidence } from "./media-product-runtime";
import { bootstrapProductionMedia } from "./media-bootstrap";

type Db = Pick<SupabaseClient, "rpc">;
type Row = Record<string, unknown>;
export type MediaEditorActor = { actorType: "supabase_user" | "admin_panel_token"; actorId: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function mediaSyncEnabled() { return process.env.VERCEL_ENV === "production" && process.env.SHOPIFY_MEDIA_SYNC === "enabled_v1"; }
function fail(code: string): never { throw new Error(code); }
async function call(db: Db, name: string, args: Row, deadline: number): Promise<unknown> {
  const ms = Math.min(5000, deadline - Date.now()); if (!Number.isFinite(deadline) || ms <= 0) fail("MEDIA_QUEUE_TIME_BUDGET");
  const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { const response = await Promise.race([Promise.resolve(db.rpc(name, args).abortSignal(abort.signal)), new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(new Error("MEDIA_QUEUE_TIME_BUDGET")); }, ms);
  })]);
    if (Date.now() >= deadline) fail("MEDIA_QUEUE_TIME_BUDGET");
    if (!response || response.error) throw response?.error ?? new Error("MEDIA_QUEUE_RPC_FAILED"); return response.data;
  } catch (error) { const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
    throw new Error(/^MEDIA_[A-Z0-9_]{1,90}$/.test(message) ? message : "MEDIA_QUEUE_RPC_FAILED");
  } finally { if (timer) clearTimeout(timer); }
}
function mediaView(item: Row) {
  if (!Array.isArray(item.angles)) fail("MEDIA_QUEUE_CATALOG_INVALID");
  return JSON.stringify([item.title, item.coverImagePath, item.coverImageAlt ?? null, item.isActive,
    item.angles.map((a: Row) => [a.id, a.angleKey, a.imagePath, a.angleOrder, a.imageAlt ?? null])]);
}
/** Only server-side before/after snapshots from a SUCCESSFUL ordinary save.
 * The actor derives from authenticated token/session middleware, never JSON. */
export async function enqueueGalleryMediaChanges(beforeItems: readonly unknown[], afterItems: readonly unknown[], actor: MediaEditorActor,
  deadline = Date.now() + 5000, db?: Db): Promise<number> {
  if (!mediaSyncEnabled()) return 0;
  if (!Array.isArray(beforeItems) || !Array.isArray(afterItems) || beforeItems.length > 5000 || afterItems.length > 5000) fail("MEDIA_QUEUE_CATALOG_INVALID");
  const before = new Map(beforeItems.map(x => { const i = x as Row; if (!UUID.test(String(i?.id))) fail("MEDIA_QUEUE_CATALOG_INVALID"); return [i.id, i]; }));
  const ids: string[] = [];
  for (const x of afterItems) { const i = x as Row; if (!UUID.test(String(i?.id))) fail("MEDIA_QUEUE_CATALOG_INVALID");
    const old = before.get(i.id); if (old && mediaView(old) !== mediaView(i)) ids.push(String(i.id)); }
  if (!ids.length) return 0;
  const result = await call(db ?? createSupabaseServiceRoleClient(), "enqueue_toptik_gallery_media_work", { p_item_ids: [...new Set(ids)], p_actor: actor }, deadline);
  if (!Number.isSafeInteger(result) || Number(result) < 0 || Number(result) > ids.length) fail("MEDIA_QUEUE_RESPONSE_INVALID"); return Number(result);
}
/** Invoke only after the signed webhook inbox row was durably inserted. */
export async function enqueueShopifyMediaChange(productId: string, eventId: string, deadline = Date.now() + 5000, db?: Db): Promise<boolean> {
  if (!mediaSyncEnabled()) return false;
  if (!/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(productId) || !UUID.test(eventId)) fail("MEDIA_QUEUE_WEBHOOK_INVALID");
  const result = await call(db ?? createSupabaseServiceRoleClient(), "enqueue_toptik_shopify_media_work", { p_product_gid: productId, p_event_id: eventId }, deadline);
  if (typeof result !== "boolean") fail("MEDIA_QUEUE_RESPONSE_INVALID"); return result;
}
/** Read/reconcile existing enabled identities; never creates permission to delete. */
export async function recoverMediaWork(deadline = Date.now() + 5000, db?: Db): Promise<number> {
  if (!mediaSyncEnabled()) return 0;
  const result = await call(db ?? createSupabaseServiceRoleClient(), "recover_toptik_media_work", {}, deadline);
  if (!Number.isSafeInteger(result) || Number(result) < 0) fail("MEDIA_QUEUE_RESPONSE_INVALID"); return Number(result);
}
export async function drainMediaWork(deadline: number, client?: Db,
  run: typeof reconcilePersistedMediaProduct = reconcilePersistedMediaProduct,
  initialize: typeof bootstrapProductionMedia = bootstrapProductionMedia): Promise<{ processed: number; failed: number; reviewed: number; continuationNeeded: boolean }> {
  const result = { processed: 0, failed: 0, reviewed: 0, continuationNeeded: false };
  if (!mediaSyncEnabled()) return result;
  if (!Number.isFinite(deadline) || deadline - Date.now() < 12000) return result;
  const db = client ?? createSupabaseServiceRoleClient();
  const claimId = randomUUID(), input = await call(db, "claim_toptik_media_work", { p_claim_id: claimId }, deadline - 5000);
  if (input === null) return result;
  const claim = input as Row;
  if (!claim || claim.claimId !== claimId || !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(String(claim.productId)) ||
      !Number.isSafeInteger(claim.generation) || Number(claim.generation) < 1 || typeof claim.initialized !== "boolean" || !claim.evidence || typeof claim.evidence !== "object") fail("MEDIA_QUEUE_RESPONSE_INVALID");
  let status = "pending", error: string | null = null, progress = false;
  try {
    const outcome = claim.initialized ? await run(String(claim.productId), claim.evidence as MediaWorkEvidence, deadline - 5000) :
      (await initialize(String(claim.productId), true, deadline - 5000, { client: db }), { status: "done", progressed: true, executed: false });
    status = outcome.status === "done" ? "done" : outcome.status === "review" ? "review" : "pending";
    if (status === "review") result.reviewed++;
    if (outcome.progressed) result.processed++;
    // Completing an already-equal product advances the durable queue even when
    // no media mutation is necessary. Busy/unchanged pending work still stops;
    // do not confuse a no-op completion with a stalled reconciliation.
    progress = status === "done" || outcome.progressed || outcome.executed;
  } catch (e) {
    const code = e instanceof Error && /^MEDIA_[A-Z0-9_]{1,90}$/.test(e.message) ? e.message : "MEDIA_WORK_FAILED";
    error = code; status = /AMBIGUOUS|IDENTITY|APPROVAL|INVALID|UNSUPPORTED|REQUIRES|PROVENANCE|SOURCE_CHANGED|CAS_CHANGED/.test(code) ? "review" : "failed";
    if (status === "review") result.reviewed++; else result.failed++;
  }
  await call(db, "finish_toptik_media_work", { p_product_gid: claim.productId, p_claim_id: claimId, p_generation: claim.generation, p_status: status, p_error: error }, deadline - 1000);
  if (progress && !result.failed && !result.reviewed) result.continuationNeeded = await call(db, "toptik_media_work_pending", {}, deadline) === true;
  return result;
}
