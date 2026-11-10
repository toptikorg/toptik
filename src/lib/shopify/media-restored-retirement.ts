import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { VERIFIED_COPY_COLUMNS } from "./copy-eligibility";
import { assertVerifiedCopyApproval, type VerifiedCopyEligibility } from "./sync-rules";
import { reviewIdentity } from "./reviewed-media-record";
import { isShopifyOwnedVariant } from "./variant-source-policy";
import { createMediaTransportRpc } from "./media-transport-rpc";
import { captureMediaPlanningPair } from "./media-planning-observation";
import { parseGalleryMediaRaw } from "./media-gallery-transport";
import { mediaSnapshotFingerprint, type MediaIdentity, type MediaPair } from "./media-sync-core";
import type { MediaPlanningContext } from "./media-planning-rpc";

export const RESTORED_RETIREMENT_APPROVAL = "RESTORED_BEFORE_TRANSPORT";
export type RestoredRetirementCommand = { itemId: string; operationId: string; requestId: string; approval: typeof RESTORED_RETIREMENT_APPROVAL };
export type RestoredRetirementActor = { actorId: string; authMethod: "session_admin" | "admin_token" };
type Db = Pick<SupabaseClient, "from" | "rpc">;
type Row = Record<string, unknown>;
type RetirementContext = { planningContext: MediaPlanningContext; operation: Row; queueFence: Row; priorReceipt: Row | null };
type Dependencies = { now?: () => number; transport?: typeof createMediaTransportRpc; capture?: typeof captureMediaPlanningPair;
  environment?: { VERCEL_ENV?: string; SHOPIFY_MEDIA_SYNC?: string } };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
function fail(code: string): never { throw new Error(code); }
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MEDIA_RETIREMENT_RESPONSE_INVALID");
  return value as Row;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }

/** An explicit admin decision, never a client-provided snapshot, URL or proof. */
export function parseRestoredRetirementCommand(value: unknown): RestoredRetirementCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MEDIA_RETIREMENT_INPUT_INVALID");
  const input = object(value);
  if (Object.keys(input).sort().join("|") !== "approval|itemId|operationId|requestId" ||
      [input.itemId, input.operationId, input.requestId].some(v => typeof v !== "string" || !UUID.test(v)) ||
      input.approval !== RESTORED_RETIREMENT_APPROVAL) fail("MEDIA_RETIREMENT_INPUT_INVALID");
  return { itemId: String(input.itemId).toLowerCase(), operationId: String(input.operationId).toLowerCase(),
    requestId: String(input.requestId).toLowerCase(), approval: RESTORED_RETIREMENT_APPROVAL };
}

/** The sole allowed difference is an actual read revision, never an asset, ALT, order or evidence ID. */
export function assertRestoredMediaPair(current: MediaPair, baseline: MediaPair, identity: MediaIdentity) {
  for (const side of ["gallery", "shopify"] as const) {
    mediaSnapshotFingerprint(current?.[side]); mediaSnapshotFingerprint(baseline?.[side]);
    const actual = current[side], expected = baseline[side];
    if (actual.side !== side || expected.side !== side || !same(actual.identity, identity) || !same(expected.identity, identity) ||
        actual.complete !== true || expected.complete !== true || !same(actual.assets, expected.assets)) fail("MEDIA_RETIREMENT_NOT_RESTORED");
  }
}

function context(value: unknown, command: RestoredRetirementCommand, identity: MediaIdentity): RetirementContext {
  const result = object(value), raw = object(result.planningContext), operation = object(result.operation), queueFence = object(result.queueFence);
  const registered = reviewIdentity(raw.identity);
  if (!same(registered, identity) || !integer(raw.stateVersion)) fail("MEDIA_RETIREMENT_IDENTITY_CHANGED");
  const baseline = raw.baselines as MediaPair;
  assertRestoredMediaPair(baseline, baseline, identity);
  const galleryRaw = parseGalleryMediaRaw(raw.galleryRaw, identity);
  if (!Array.isArray(raw.galleryRefs) || raw.galleryRefs.length > 31 || !Array.isArray(raw.provenance) || raw.provenance.length > 2000 ||
      raw.provenance.some(p => object(p).product_gid !== identity.productId) ||
      !Array.isArray(raw.operations) || !Array.isArray(raw.steps) || !Array.isArray(raw.removals) || !Array.isArray(raw.detached)) {
    fail("MEDIA_RETIREMENT_RESPONSE_INVALID");
  }
  if (operation.id !== command.operationId || operation.product_gid !== identity.productId || !integer(operation.version) ||
      operation.state_version !== raw.stateVersion || operation.next_step !== 0 || !HASH.test(String(operation.request_hash)) ||
      !["reserved", "running", "conflict"].includes(String(operation.status)) || queueFence.product_gid !== identity.productId) {
    fail("MEDIA_RETIREMENT_OPERATION_CHANGED");
  }
  const priorReceipt = result.priorReceipt === null ? null : object(result.priorReceipt);
  if (operation.status === "conflict" && (!priorReceipt || priorReceipt.request_id !== command.requestId ||
      priorReceipt.operation_id !== command.operationId || priorReceipt.event_kind !== "restored_before_transport")) {
    fail("MEDIA_RETIREMENT_OPERATION_CHANGED");
  }
  return { planningContext: { ...raw, galleryRaw } as MediaPlanningContext, operation, queueFence, priorReceipt };
}

/** Records a terminal CONFLICT for one abandoned zero-transport operation.
 * It never writes Shopify, Gallery media, proofs or baselines, and never marks a sync verified. */
export async function retireRestoredMediaOperation(db: Db, value: RestoredRetirementCommand, actor: RestoredRetirementActor,
  deadline: number, dependencies: Dependencies = {}) {
  const command = parseRestoredRetirementCommand(value), now = dependencies.now ?? Date.now, environment = dependencies.environment ?? process.env;
  if (!UUID.test(actor?.actorId) || !["session_admin", "admin_token"].includes(actor?.authMethod)) fail("MEDIA_RETIREMENT_ACTOR_INVALID");
  if (environment.VERCEL_ENV !== "production" || environment.SHOPIFY_MEDIA_SYNC !== "enabled_v1") fail("MEDIA_RETIREMENT_DISABLED");
  if (isShopifyOwnedVariant(command.itemId)) fail("MEDIA_RETIREMENT_OWNED_GROUP_UNSUPPORTED");
  const work = deadline - 2500;
  const check = () => { if (!Number.isFinite(deadline) || now() >= work) fail("MEDIA_RETIREMENT_TIME_BUDGET"); };
  check();
  const initial = await db.from("shopify_gallery_copy_eligibility").select(VERIFIED_COPY_COLUMNS)
    .eq("carousel_item_id", command.itemId).limit(2).abortSignal(AbortSignal.timeout(Math.min(4000, work - now())));
  check();
  if (initial.error || !Array.isArray(initial.data) || initial.data.length !== 1) fail("MEDIA_RETIREMENT_IDENTITY_CHANGED");
  const approval = initial.data[0] as VerifiedCopyEligibility;
  assertVerifiedCopyApproval(approval);
  const identity = reviewIdentity({ productId: approval.product_gid, variantId: approval.variant_gid, itemId: approval.carousel_item_id,
    exactGallerySku: approval.exact_gallery_sku, exactShopifySku: approval.exact_shopify_sku, productHandle: approval.approved_product_handle });
  if (identity.itemId !== command.itemId) fail("MEDIA_RETIREMENT_IDENTITY_CHANGED");
  const transport = (dependencies.transport ?? createMediaTransportRpc)(identity.productId, { client: db, now, maxRpcMs: 4000 });
  const lease = await transport.acquire(work);
  if (!lease) fail("MEDIA_RETIREMENT_BUSY");
  async function call(name: "read_toptik_media_retirement_context" | "retire_restored_toptik_media_operation", args: Row, final = false) {
    check();
    const abort = new AbortController(), ms = Math.min(4000, work - now());
    let timer: ReturnType<typeof setTimeout> | undefined, dispatched = false, rejected = false;
    try {
      const encoded = JSON.stringify(args);
      if (Buffer.byteLength(encoded) > 10_000_000) fail("MEDIA_RETIREMENT_INPUT_LIMIT");
      const query = db.rpc(name, JSON.parse(encoded));
      dispatched = true;
      const response = await Promise.race([Promise.resolve(query.abortSignal(abort.signal)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("MEDIA_RETIREMENT_TIME_BUDGET")); }, ms); })]);
      if (!response || response.error) {
        // Only a received SQL RAISE proves rollback. A gateway error or malformed
        // response can follow a commit and must be recovered by the same request ID.
        rejected = response?.error?.code === "P0001";
        throw response?.error ?? new Error("MEDIA_RETIREMENT_RESPONSE_INVALID");
      }
      return object(response.data);
    } catch (error) {
      if (final && dispatched && !rejected) fail("MEDIA_RETIREMENT_RESULT_UNCERTAIN");
      const message = error instanceof Error ? error.message : error && typeof error === "object" && "message" in error ? String(error.message) : "";
      if (/^(?:MEDIA_|SYNC_COPY_)[A-Z0-9_]{1,90}$/.test(message) && !(final && message === "MEDIA_RETIREMENT_TIME_BUDGET")) throw new Error(message);
      fail(final ? "MEDIA_RETIREMENT_RESULT_UNCERTAIN" : "MEDIA_RETIREMENT_READ_FAILED");
    } finally { if (timer) clearTimeout(timer); }
  }
  try {
    check();
    if (lease.expiresAt < deadline + 5000) fail("MEDIA_RETIREMENT_LEASE_TOO_SHORT");
    const readArgs = { p_product_gid: identity.productId, p_lease_owner: lease.owner, p_operation_id: command.operationId, p_request_id: command.requestId };
    const first = context(await call("read_toptik_media_retirement_context", readArgs), command, identity);
    const observed = await (dependencies.capture ?? captureMediaPlanningPair)(first.planningContext, lease.owner, work);
    check();
    const observedAt = new Date(now()).toISOString();
    assertRestoredMediaPair(observed.pair, first.planningContext.baselines, identity);
    // Only existing immutable baseline evidence is eligible; no registration or observation write occurs here.
    const fresh = context(await call("read_toptik_media_retirement_context", readArgs), command, identity);
    check();
    if (fresh.planningContext.stateVersion !== first.planningContext.stateVersion || !same(fresh.planningContext.baselines, first.planningContext.baselines) ||
        !same(fresh.operation, first.operation) || !same(fresh.queueFence, first.queueFence) ||
        !same(fresh.planningContext.galleryRaw, first.planningContext.galleryRaw) || !same(observed.refs, fresh.planningContext.galleryRefs)) {
      fail("MEDIA_RETIREMENT_CONCURRENT_CHANGE");
    }
    const result = await call("retire_restored_toptik_media_operation", { ...readArgs,
      p_actor_id: actor.actorId, p_auth_method: actor.authMethod, p_approval: command.approval,
      p_expected_state_version: fresh.planningContext.stateVersion, p_expected_operation_version: fresh.operation.version,
      p_expected_operation_hash: fresh.operation.request_hash, p_queue_fence: fresh.queueFence,
      p_current_pair: observed.pair, p_gallery_raw: fresh.planningContext.galleryRaw, p_gallery_refs: observed.refs,
      p_observed_at: observedAt }, true);
    const replayed = result.replayed === true;
    const queueStates = replayed ? ["pending", "done", "review", "failed"] : ["pending"];
    if (result.status !== "conflict" || result.code !== "MEDIA_RESTORED_BEFORE_TRANSPORT" || result.mayExecute !== false ||
        result.retiredBeforeTransport !== true || result.operationId !== command.operationId || result.requestId !== command.requestId ||
        !integer(result.stateVersion) || !integer(result.operationVersion) || !queueStates.includes(String(result.queueStatus))) {
      fail("MEDIA_RETIREMENT_RESULT_UNCERTAIN");
    }
    return { status: "conflict" as const, code: "MEDIA_RESTORED_BEFORE_TRANSPORT", retiredBeforeTransport: true,
      mayExecute: false, operationId: command.operationId, requestId: command.requestId,
      stateVersion: result.stateVersion, operationVersion: result.operationVersion,
      queueStatus: result.queueStatus as "pending" | "done" | "review" | "failed", replayed };
  } finally {
    try { await transport.release(lease.owner, Math.min(deadline, now() + 1500)); } catch { /* Existing lease expiry remains the fallback. */ }
  }
}
