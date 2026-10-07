import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import type { MediaIdentity, MediaPair, MediaSnapshot, MediaConflict } from "./media-sync-core";
import { mediaSnapshotFingerprint } from "./media-sync-core";
import type { ShopifyMediaTransportRead } from "./media-transport-read";
import { assertMediaTransportRead } from "./media-transport-read";
import type { MediaTransportReference } from "./media-transport-worker";

export type MediaRpcGuard = { sourceFingerprint: string; target: ShopifyMediaTransportRead | MediaSnapshot; observedAt: string };
type Db = Pick<SupabaseClient, "rpc">;
type Options = { client?: Db; now?: () => number; maxRpcMs?: number };
type Row = Record<string, unknown>;
export type MediaRpcPermit = { mayExecute: boolean; status?: string; phase?: string; attemptId?: string; requestHash?: string;
  request?: Row; replayed?: boolean; verifiedNoop?: boolean; nextPhase?: number };
export type MediaTransportJournal = { chain: Row | null; attempts: Row[]; artifacts: Row[]; desiredSemanticSha256?: string | null };
export type MediaOperationDiscovery = { identity: MediaIdentity; enabled: boolean; operation: Row; step: Row;
  transport: MediaTransportJournal; provenance: Row[]; desiredSemanticSha256: string | null };
export type MediaStorageRepairRead = { approved: false; mayExecute: false } | {
  approved: true; mayExecute: false; expired: boolean; objectPresent: boolean; approval: Row; claim: Row | null; outcome: Row | null };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const PRODUCT = /^gid:\/\/shopify\/Product\/[1-9]\d*$/;
const PHASES = ["stage_source", "create_owned", "associate", "variant_reassign", "detach_old", "reorder", "gallery_upload", "gallery_cas"];
const STATUSES = ["ready", "reserved", "running", "started", "uncertain", "verified", "conflict"];
function fail(code: string): never { throw new Error(code); }
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MEDIA_RPC_RESPONSE_INVALID");
  return value as Row;
}
function uuid(value: unknown): asserts value is string { if (typeof value !== "string" || !UUID.test(value)) fail("MEDIA_RPC_ID_INVALID"); }
function product(value: string) { if (!PRODUCT.test(value)) fail("MEDIA_IDENTITY_INVALID"); }
function reference(ref: MediaTransportReference) {
  uuid(ref?.operationId);
  if (!Number.isInteger(ref.step) || ref.step < 0 || ref.step > 1000 || !Number.isInteger(ref.phaseIndex) || ref.phaseIndex < 0 || ref.phaseIndex > 10) fail("MEDIA_TRANSPORT_REFERENCE_INVALID");
}
function json<T>(value: T, maxBytes = 5_000_000): T {
  try { const encoded = JSON.stringify(value); if (!encoded || Buffer.byteLength(encoded) > maxBytes) fail("MEDIA_RPC_PAYLOAD_INVALID"); return JSON.parse(encoded) as T; }
  catch { return fail("MEDIA_RPC_PAYLOAD_INVALID"); }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function identity(value: unknown, productId?: string): MediaIdentity {
  const id = object(value) as MediaIdentity;
  mediaSnapshotFingerprint({ identity: id, side: "gallery", complete: true, revision: "rpc-identity", assets: [] });
  if (productId && id.productId !== productId) fail("MEDIA_RPC_IDENTITY_CHANGED");
  return id;
}
function guard(value: MediaRpcGuard, productId: string, now: number, fresh = true) {
  if (!value || !HASH.test(value.sourceFingerprint) || !Number.isFinite(Date.parse(value.observedAt)) ||
      (fresh && (Date.parse(value.observedAt) < now - 300_000 || Date.parse(value.observedAt) > now + 10_000))) fail("MEDIA_RPC_GUARD_INVALID");
  identity(value.target?.identity, productId);
  if (value.target.side === "shopify") assertMediaTransportRead(value.target as ShopifyMediaTransportRead);
  else if (value.target.side === "gallery") mediaSnapshotFingerprint(value.target as MediaSnapshot);
  else fail("MEDIA_RPC_GUARD_INVALID");
}
function pair(value: MediaPair, productId: string) {
  if (!value) fail("MEDIA_RPC_GUARD_INVALID");
  for (const side of ["gallery", "shopify"] as const) { mediaSnapshotFingerprint(value[side]); identity(value[side].identity, productId); if (value[side].side !== side) fail("MEDIA_RPC_GUARD_INVALID"); }
}
function masked(error: unknown): Error {
  const code = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  return new Error(/^(MEDIA_|SYNC_COPY_)[A-Z0-9_]{1,90}$/.test(code) ? code : "MEDIA_RPC_FAILED");
}
function connection(options: Options) {
  const now = options.now ?? Date.now;
  const maxMs = options.maxRpcMs ?? 5000;
  if (!Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > 10_000) fail("MEDIA_RPC_OPTIONS_INVALID");
  let client = options.client;
  async function call(name: string, args: Row, deadline: number): Promise<unknown> {
    const remaining = Math.min(maxMs, deadline - now());
    if (!Number.isFinite(deadline) || remaining <= 0) fail("MEDIA_RPC_TIME_BUDGET");
    const body = json(args), controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client ??= createSupabaseServiceRoleClient();
      const request = client.rpc(name, body);
      const promise = typeof request.abortSignal === "function" ? request.abortSignal(controller.signal) : request;
      const response = await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("MEDIA_RPC_TIME_BUDGET")); }, remaining);
      })]);
      if (now() >= deadline) fail("MEDIA_RPC_TIME_BUDGET");
      if (!response || response.error) throw response?.error ?? new Error("MEDIA_RPC_RESPONSE_INVALID");
      return json(response.data);
    } catch (error) { throw masked(error); }
    finally { if (timer) clearTimeout(timer); }
  }
  return { now, call };
}
function journal(value: unknown, ref: MediaTransportReference, productId: string): MediaTransportJournal {
  const data = object(value);
  if (!Array.isArray(data.attempts) || !Array.isArray(data.artifacts) || data.attempts.length > 11 || data.artifacts.length > 11) fail("MEDIA_RPC_JOURNAL_INVALID");
  const check = (value: unknown) => { const row = object(value); if (row.operation_id !== ref.operationId || row.step_index !== ref.step) fail("MEDIA_RPC_JOURNAL_INVALID"); return row; };
  const chain = data.chain === null ? null : check(data.chain);
  if (chain) {
    if (!STATUSES.includes(String(chain.status)) || !Array.isArray(chain.phases) || chain.phases.length > 11 || chain.phases.some(p => !PHASES.includes(String(p))) ||
        !Number.isInteger(chain.next_phase) || Number(chain.next_phase) < 0 || Number(chain.next_phase) > chain.phases.length) fail("MEDIA_RPC_JOURNAL_INVALID");
    guard(chain.initial_guard as MediaRpcGuard, productId, 0, false); guard(chain.current_guard as MediaRpcGuard, productId, 0, false);
  }
  const attempts = data.attempts.map(value => { const row = check(value); uuid(row.attempt_id);
    if (!Number.isInteger(row.phase_index) || Number(row.phase_index) < 0 || Number(row.phase_index) > 10 || !HASH.test(String(row.request_hash)) || !PHASES.includes(String(row.phase)) || !STATUSES.includes(String(row.status))) fail("MEDIA_RPC_JOURNAL_INVALID");
    object(row.request); guard(row.before_guard as MediaRpcGuard, productId, 0, false); if (row.after_guard !== null) guard(row.after_guard as MediaRpcGuard, productId, 0, false); return row; });
  const artifacts = data.artifacts.map(value => { const row = check(value); if (!Number.isInteger(row.phase_index) || Number(row.phase_index) < 0 || Number(row.phase_index) > 10) fail("MEDIA_RPC_JOURNAL_INVALID"); object(row.artifact); return row; });
  if (new Set(attempts.map(a => a.phase_index)).size !== attempts.length || new Set(artifacts.map(a => a.phase_index)).size !== artifacts.length) fail("MEDIA_RPC_JOURNAL_INVALID");
  if (data.desiredSemanticSha256 !== undefined && data.desiredSemanticSha256 !== null && !HASH.test(String(data.desiredSemanticSha256))) fail("MEDIA_RPC_JOURNAL_INVALID");
  return { chain, attempts, artifacts, ...(data.desiredSemanticSha256 === undefined ? {} : { desiredSemanticSha256: data.desiredSemanticSha256 as string | null }) };
}

/** Private read-only discovery. This does not produce a permit or trust browser job JSON. */
export async function discoverMediaTransportOperation(ref: MediaTransportReference, deadline: number, options: Options = {}): Promise<MediaOperationDiscovery> {
  reference(ref); const rpc = connection(options);
  const data = object(await rpc.call("read_toptik_media_operation", { p_operation_id: ref.operationId, p_step_index: ref.step, p_phase_index: ref.phaseIndex }, deadline));
  const id = identity(data.identity), operation = object(data.operation), step = object(data.step);
  if (typeof data.enabled !== "boolean" || operation.id !== ref.operationId || operation.product_gid !== id.productId || step.operation_id !== ref.operationId || step.step_index !== ref.step ||
      !STATUSES.includes(String(operation.status)) || !STATUSES.includes(String(step.status)) || !Array.isArray(data.provenance) || data.provenance.length > 1000 ||
      (data.desiredSemanticSha256 !== null && !HASH.test(String(data.desiredSemanticSha256)))) fail("MEDIA_RPC_DISCOVERY_INVALID");
  pair(operation.observed_pair as MediaPair, id.productId); if (step.expected_pair !== null) pair(step.expected_pair as MediaPair, id.productId);
  const provenance = data.provenance.map(value => { const row = object(value); if (row.product_gid !== id.productId || typeof row.evidence_id !== "string") fail("MEDIA_RPC_DISCOVERY_INVALID"); object(row.proof); return row; });
  return { identity: id, enabled: data.enabled, operation, step, transport: journal(data.transport, ref, id.productId), provenance, desiredSemanticSha256: data.desiredSemanticSha256 as string | null };
}

/** Fixed-product service port. Call only from authenticated server/cron workers. */
export function createMediaTransportRpc(productId: string, options: Options = {}) {
  product(productId); const rpc = connection(options), permits = new Map<string, string>();
  const key = (ref: MediaTransportReference) => `${ref.operationId}:${ref.step}:${ref.phaseIndex}`;
  const args = (ref: MediaTransportReference, owner: string) => { reference(ref); uuid(owner); return { p_product_gid: productId, p_lease_owner: owner, p_operation_id: ref.operationId, p_step_index: ref.step }; };
  const status = (value: unknown, allowed: string[]) => { const row = object(value); if (!allowed.includes(String(row.status)) || row.mayExecute !== false) fail("MEDIA_RPC_RESPONSE_INVALID"); return row; };
  return {
    async acquire(deadline: number) {
      const owner = randomUUID(); const granted = await rpc.call("acquire_shopify_reconciliation_lease", { p_product_gid: productId, p_owner: owner }, deadline);
      if (granted === false) return null; if (granted !== true) fail("MEDIA_RPC_RESPONSE_INVALID");
      const lease = object(await rpc.call("read_toptik_media_lease", { p_product_gid: productId, p_owner: owner }, deadline));
      if (lease.owner !== owner || typeof lease.expiresAt !== "number" || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= rpc.now()) fail("MEDIA_RPC_LEASE_INVALID");
      return { owner, expiresAt: lease.expiresAt };
    },
    async release(owner: string, deadline: number) { uuid(owner); await rpc.call("release_shopify_reconciliation_lease", { p_product_gid: productId, p_owner: owner }, deadline); },
    async prepare(ref: MediaTransportReference, owner: string, requestId: string, phases: string[], fresh: MediaRpcGuard, deadline: number) {
      uuid(requestId); guard(fresh, productId, rpc.now());
      if (!Array.isArray(phases) || !phases.length || phases.length > 11 || phases.some(p => !PHASES.includes(p))) fail("MEDIA_RPC_PHASE_INVALID");
      return status(await rpc.call("prepare_toptik_media_transport", { ...args(ref, owner), p_request_id: requestId, p_phases: phases, p_guard: fresh }, deadline), ["ready", "running", "uncertain", "verified", "conflict"]);
    },
    async begin(ref: MediaTransportReference, owner: string, attemptId: string, intent: Row, fresh: MediaRpcGuard, deadline: number): Promise<MediaRpcPermit> {
      uuid(attemptId); guard(fresh, productId, rpc.now()); if (!HASH.test(String(object(intent).mutationSha256))) fail("MEDIA_RPC_INTENT_INVALID");
      const result = object(await rpc.call("begin_toptik_media_transport", { ...args(ref, owner), p_phase_index: ref.phaseIndex, p_attempt_id: attemptId, p_request: json(intent, 100_000), p_fresh_guard: fresh }, deadline));
      if (typeof result.mayExecute !== "boolean" || (result.status !== undefined && !STATUSES.includes(String(result.status)))) fail("MEDIA_RPC_PERMIT_INVALID");
      if (result.mayExecute) {
        if (result.replayed !== false || result.attemptId !== attemptId || !HASH.test(String(result.requestHash)) || !PHASES.includes(String(result.phase)) || stable(result.request) !== stable(intent)) fail("MEDIA_RPC_PERMIT_INVALID");
        permits.set(key(ref), attemptId);
      }
      return result as MediaRpcPermit;
    },
    async read(ref: MediaTransportReference, owner: string, deadline: number) {
      return journal(await rpc.call("read_toptik_media_transport", args(ref, owner), deadline), ref, productId);
    },
    // The worker can read/consume a separately approved exact repair scope.
    // It deliberately has no method to authorize a repair for itself.
    async readStorageRepair(owner: string, originalAttemptId: string, deadline: number): Promise<MediaStorageRepairRead> {
      uuid(owner); uuid(originalAttemptId);
      const value = object(await rpc.call("read_toptik_storage_repair", {
        p_product_gid: productId, p_lease_owner: owner, p_original_attempt_id: originalAttemptId }, deadline));
      if (value.mayExecute !== false || typeof value.approved !== "boolean") fail("MEDIA_STORAGE_REPAIR_RESPONSE_INVALID");
      if (!value.approved) return { approved: false, mayExecute: false };
      const a = object(value.approval);
      if (a.product_gid !== productId || a.original_attempt_id !== originalAttemptId || !UUID.test(String(a.approval_id)) ||
          !HASH.test(String(a.original_request_hash)) || !HASH.test(String(a.source_sha256)) ||
          !Number.isFinite(Date.parse(String(a.expires_at))) || typeof value.expired !== "boolean" || typeof value.objectPresent !== "boolean") fail("MEDIA_STORAGE_REPAIR_RESPONSE_INVALID");
      identity(a.identity, productId);
      for (const entry of [value.claim, value.outcome]) if (entry !== null) object(entry);
      return value as MediaStorageRepairRead;
    },
    async claimStorageRepair(owner: string, approvalId: string, repairId: string, originalAttemptId: string,
      requestHash: string, storagePath: string, sourceSha256: string, fresh: MediaRpcGuard, deadline: number): Promise<Row> {
      uuid(owner); uuid(approvalId); uuid(repairId); uuid(originalAttemptId); guard(fresh, productId, rpc.now());
      if (!HASH.test(requestHash) || !HASH.test(sourceSha256) ||
          storagePath !== `sync-media/${fresh.target.identity.itemId}/${sourceSha256}.${storagePath.split(".").at(-1)}` ||
          !/\.(jpg|png|webp)$/.test(storagePath)) fail("MEDIA_STORAGE_REPAIR_SCOPE_INVALID");
      const value = object(await rpc.call("claim_toptik_storage_repair", { p_product_gid: productId, p_lease_owner: owner,
        p_approval_id: approvalId, p_repair_id: repairId, p_original_attempt_id: originalAttemptId,
        p_request_hash: requestHash, p_storage_path: storagePath, p_source_sha256: sourceSha256, p_fresh_guard: fresh }, deadline));
      if (typeof value.mayExecute !== "boolean" || typeof value.replayed !== "boolean") fail("MEDIA_STORAGE_REPAIR_PERMIT_INVALID");
      if (value.mayExecute && (value.replayed !== false || value.repairId !== repairId || value.approvalId !== approvalId ||
          value.originalAttemptId !== originalAttemptId || value.originalRequestHash !== requestHash ||
          value.storagePath !== storagePath || value.sourceSha256 !== sourceSha256 || value.upsert !== false ||
          !Number.isFinite(Date.parse(String(value.mayExecuteUntil))) || Date.parse(String(value.mayExecuteUntil)) <= rpc.now())) fail("MEDIA_STORAGE_REPAIR_PERMIT_INVALID");
      if (!value.mayExecute && !["consumed", "object_present_use_readback"].includes(String(value.status))) fail("MEDIA_STORAGE_REPAIR_PERMIT_INVALID");
      return value;
    },
    async recordStorageRepairOutcome(owner: string, repairId: string, outcome: "accepted" | "unknown",
      stage: "preflight" | "decode" | "dns" | "upload" | "readback", httpStatus: number | null, deadline: number, requestId = randomUUID()) {
      uuid(owner); uuid(repairId); uuid(requestId);
      if (!["accepted", "unknown"].includes(outcome) || !["preflight", "decode", "dns", "upload", "readback"].includes(stage) ||
          (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599))) fail("MEDIA_STORAGE_REPAIR_RECEIPT_INVALID");
      const value = object(await rpc.call("record_toptik_storage_repair_outcome", { p_product_gid: productId, p_lease_owner: owner,
        p_repair_id: repairId, p_request_id: requestId, p_outcome: outcome, p_stage: stage, p_http_status: httpStatus }, deadline));
      if (value.recorded !== true || value.mayExecute !== false || typeof value.replayed !== "boolean") fail("MEDIA_STORAGE_REPAIR_RESPONSE_INVALID");
      return value;
    },
    async uncertain(ref: MediaTransportReference, owner: string, receipt: { outcome: "unknown" | "accepted" | "processing"; mediaGid?: string; jobId?: string }, deadline: number, requestId = randomUUID()) {
      uuid(requestId); permits.delete(key(ref));
      if (!receipt || !["unknown", "accepted", "processing"].includes(receipt.outcome) || Object.keys(receipt).some(k => !["outcome", "mediaGid", "jobId"].includes(k)) ||
          (receipt.mediaGid !== undefined && !/^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/.test(receipt.mediaGid)) || (receipt.jobId !== undefined && !/^gid:\/\/shopify\/Job\/[A-Za-z0-9-]{1,100}$/.test(receipt.jobId))) fail("MEDIA_RPC_RECEIPT_INVALID");
      return status(await rpc.call("mark_toptik_media_transport_uncertain", { ...args(ref, owner), p_phase_index: ref.phaseIndex, p_request_id: requestId, p_receipt: receipt }, deadline), ["uncertain"]);
    },
    async accept(ref: MediaTransportReference, owner: string, requestId: string, requestHash: string, fresh: MediaRpcGuard, artifact: Row | null, deadline: number) {
      uuid(requestId); guard(fresh, productId, rpc.now()); if (!HASH.test(requestHash)) fail("MEDIA_RPC_RECEIPT_INVALID"); permits.delete(key(ref));
      const readbackSha256 = fresh.target.side === "shopify" ? fresh.target.revision : mediaSnapshotFingerprint(fresh.target as MediaSnapshot);
      return status(await rpc.call("accept_toptik_media_transport", { ...args(ref, owner), p_phase_index: ref.phaseIndex, p_request_id: requestId, p_guard: fresh,
        p_receipt: { requestHash, readbackSha256, artifact: artifact === null ? null : json(object(artifact), 20_000) } }, deadline), ["verified", "conflict"]);
    },
    async conflict(ref: MediaTransportReference, owner: string, code: string, fresh: MediaRpcGuard, deadline: number, requestId = randomUUID()) {
      uuid(requestId); guard(fresh, productId, rpc.now()); const attemptId = permits.get(key(ref));
      if (!attemptId || !["MEDIA_TRANSPORT_CHANGED_BEFORE_CALL", "MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET", "MEDIA_TRANSPORT_NOT_SENT_PRECONDITION"].includes(code)) fail("MEDIA_RPC_HOLD_WITHOUT_PERMIT");
      permits.delete(key(ref));
      return status(await rpc.call("hold_toptik_media_transport", { ...args(ref, owner), p_phase_index: ref.phaseIndex, p_attempt_id: attemptId, p_request_id: requestId, p_code: code, p_guard: fresh }, deadline), ["conflict"]);
    },
    /** Only the worker that consumed this exact Gallery CAS permit, after the
     * database definitively rejected (rolled back) its apply, may record it. */
    async rejectGalleryCas(ref: MediaTransportReference, owner: string, attemptId: string, rejection: string, fresh: MediaRpcGuard, deadline: number, requestId = randomUUID()) {
      uuid(requestId); uuid(attemptId); guard(fresh, productId, rpc.now());
      if (permits.get(key(ref)) !== attemptId || fresh.target.side !== "gallery" || !/^(MEDIA|SYNC_COPY)_[A-Z0-9_]{1,90}$/.test(rejection)) fail("MEDIA_RPC_REJECTION_WITHOUT_PERMIT");
      permits.delete(key(ref));
      const row = status(await rpc.call("reject_toptik_gallery_media_cas", { ...args(ref, owner), p_phase_index: ref.phaseIndex, p_attempt_id: attemptId,
        p_request_id: requestId, p_rejection: rejection, p_guard: fresh }, deadline), ["conflict"]);
      if (row.notApplied !== true || row.rejection !== rejection) fail("MEDIA_RPC_RESPONSE_INVALID");
      return row;
    },
    async recordPlannerConflict(owner: string, requestId: string, expectedVersion: number, current: MediaPair, conflicts: MediaConflict[], deadline: number) {
      uuid(owner); uuid(requestId); pair(current, productId);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !Array.isArray(conflicts) || !conflicts.length || conflicts.length > 1000) fail("MEDIA_RPC_CONFLICT_INVALID");
      return status(await rpc.call("record_toptik_media_conflict", { p_product_gid: productId, p_lease_owner: owner, p_request_id: requestId, p_expected_version: expectedVersion, p_current: current, p_conflicts: json(conflicts, 200_000) }, deadline), ["conflict"]);
    },
  };
}
