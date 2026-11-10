import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { mediaSyncEnabled } from "./media-work-queue";
import { ownedFamilyForItem } from "./owned-edit-service";
import type { OwnedMediaServiceResult, OwnedMediaExecutionContext } from "./owned-media-service";

type Row = Record<string, unknown>;
type Resume = (db: SupabaseClient, input: { itemId: string; requestId: string }, execution: OwnedMediaExecutionContext) => Promise<OwnedMediaServiceResult>;
type Dependencies = { client?: SupabaseClient; resume?: Resume; now?: () => number };
export type OwnedMediaDrainResult = { processed: number; completed: number; failed: number; reviewed: number;
  continuationNeeded: boolean; claimedProductId?: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PRODUCT = /^gid:\/\/shopify\/Product\/[1-9]\d*$/;
function fail(code: string): never { throw new Error(code); }
function object(v: unknown): Row { if (!v || typeof v !== "object" || Array.isArray(v)) fail("OWNED_MEDIA_QUEUE_INVALID"); return v as Row; }
async function defaultResume(db: SupabaseClient, input: { itemId: string; requestId: string }, execution: OwnedMediaExecutionContext) {
  // Service imports the scheduler for wakeups. Resolve it only when a private queue claim exists.
  const { resumeOwnedMediaEdit } = await import("./owned-media-service");
  return resumeOwnedMediaEdit(db, input, execution);
}
/** One claimed shared operation only. The claim is separate from the common product lease. */
export async function drainOwnedMediaWork(deadline: number, excluded: readonly string[] = [], dependencies: Dependencies = {}): Promise<OwnedMediaDrainResult> {
  const result: OwnedMediaDrainResult = { processed: 0, completed: 0, failed: 0, reviewed: 0, continuationNeeded: false };
  if (!mediaSyncEnabled()) return result;
  const now = dependencies.now ?? Date.now;
  if (!Number.isFinite(deadline) || now() + 12_000 >= deadline) return result;
  if (!Array.isArray(excluded) || excluded.length > 10 || new Set(excluded).size !== excluded.length || excluded.some(id => !PRODUCT.test(id))) fail("OWNED_MEDIA_QUEUE_EXCLUSIONS_INVALID");
  const db = dependencies.client ?? createSupabaseServiceRoleClient(), owner = randomUUID();
  const call = async (name: string, args: Row, stop = deadline): Promise<unknown> => {
    const ms = Math.min(5000, stop - now()); if (ms <= 0) fail("OWNED_MEDIA_QUEUE_TIME_BUDGET");
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let query = db.rpc(name, args); if (typeof query.abortSignal === "function") query = query.abortSignal(abort.signal);
    const response = await Promise.race([Promise.resolve(query), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error("OWNED_MEDIA_QUEUE_TIME_BUDGET")); }, ms);
    })]).finally(() => { if (timer) clearTimeout(timer); });
    if (now() >= stop) fail("OWNED_MEDIA_QUEUE_TIME_BUDGET");
    if (response.error) {
      const message = String(response.error.message ?? "");
      throw new Error(/^(OWNED_MEDIA_|GROUP_MEDIA_|MEDIA_|SYNC_)[A-Z0-9_]{1,100}$/.test(message) ? message : "OWNED_MEDIA_QUEUE_RPC_FAILED");
    }
    return response.data;
  };
  const claim = object(await call("claim_toptik_owned_media_work", { p_owner: owner, p_excluded_product_gids: [...excluded] }));
  if (claim.operation === null) {
    const pending = object(await call("owned_media_work_pending", {}));
    result.continuationNeeded = pending.pending === true;
    return result;
  }
  if (typeof claim.operationId !== "string" || !UUID.test(claim.operationId) || claim.requestId !== claim.operationId ||
      typeof claim.claimId !== "string" || !UUID.test(claim.claimId) || typeof claim.itemId !== "string" || !UUID.test(claim.itemId) ||
      typeof claim.productGid !== "string" || !PRODUCT.test(claim.productGid) || excluded.includes(claim.productGid)) fail("OWNED_MEDIA_QUEUE_INVALID");
  const family = ownedFamilyForItem(claim.itemId), actor = object(claim.actor);
  if (!family || family.productGid !== claim.productGid || !["session_admin", "admin_token", "system"].includes(String(actor.actorType)) ||
      typeof actor.actorId !== "string" || !actor.actorId.trim() || actor.actorId.length > 255 ||
      (actor.actorType === "session_admin" && !UUID.test(actor.actorId)) ||
      !Number.isSafeInteger(claim.nextPhase) || Number(claim.nextPhase) < 0 || !Number.isSafeInteger(claim.mapVersion) || Number(claim.mapVersion) < 1) fail("OWNED_MEDIA_QUEUE_INVALID");
  result.claimedProductId = claim.productGid;
  const stop = Math.min(deadline - 3000, now() + 55_000);
  let status = "pending", error: string | null = null, progressed = false, leased = false;
  try {
    leased = await call("acquire_shopify_reconciliation_lease", { p_product_gid: claim.productGid, p_owner: owner }, stop) === true;
    if (!leased) error = "SYNC_RECONCILIATION_BUSY";
    else {
      const answer = await (dependencies.resume ?? defaultResume)(db, { itemId: claim.itemId, requestId: claim.requestId },
        { owner, deadline: stop, actor: actor as OwnedMediaExecutionContext["actor"] });
      if (!["pending", "review", "done"].includes(answer.status) || answer.requestId !== claim.requestId || typeof answer.checkpoint !== "string") fail("OWNED_MEDIA_QUEUE_RESULT_INVALID");
      const parts = answer.checkpoint.split(":");
      if (parts.length !== 4 || parts[0] !== claim.operationId || !/^[1-9]\d*$/.test(parts[1]) || !/^\d+$/.test(parts[2]) || parts[3] !== answer.status) fail("OWNED_MEDIA_QUEUE_RESULT_INVALID");
      progressed = Number(parts[1]) > Number(claim.mapVersion) || Number(parts[2]) > Number(claim.nextPhase) || answer.status === "done";
      status = answer.status === "done" ? "verified" : answer.status;
      if (answer.status === "done") result.completed++;
      if (progressed) result.processed++;
      if (answer.status === "review") result.reviewed++;
    }
  } catch (failure) {
    const code = failure instanceof Error && /^(OWNED_MEDIA_|GROUP_MEDIA_|MEDIA_|SYNC_)[A-Z0-9_]{1,100}$/.test(failure.message) ? failure.message : "OWNED_MEDIA_QUEUE_FAILED";
    error = code;
    status = /INVALID|CONFLICT|CHANGED|MISMATCH|REQUIRES|PROTECTED|AMBIGUOUS|UNSUPPORTED/.test(code) ? "review" : "failed";
    if (status === "review") result.reviewed++; else result.failed++;
  } finally {
    if (leased) { try { await call("release_shopify_reconciliation_lease", { p_product_gid: claim.productGid, p_owner: owner }); } catch { /* owned lease expires; never turn an uncertain result into done */ } }
    await call("finish_toptik_owned_media_work", { p_operation_id: claim.operationId, p_owner: owner, p_claim_id: claim.claimId,
      p_status: status, p_error: error, p_progressed: progressed });
  }
  const pending = object(await call("owned_media_work_pending", {}));
  result.continuationNeeded = pending.pending === true;
  return result;
}
