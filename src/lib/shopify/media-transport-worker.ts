import { randomUUID } from "node:crypto";
import type { MediaTransportRequest } from "./media-transport-requests";
import { parseMediaTransportAcknowledgement } from "./media-transport-requests";
import type { ShopifyMediaTransportRead } from "./media-transport-read";
import { assertMediaTransportRead, onlyForwardProductTimestampDrift, PRODUCT_TIMESTAMP_TOLERANT_PHASES } from "./media-transport-read";
import { buildMediaJournalIntent, mediaJournalPhase } from "./media-transport-journal-intent";

export type MediaTransportReference = { operationId: string; step: number; phaseIndex: number };
export type MediaTransportGuard = { sourceFingerprint: string; target: ShopifyMediaTransportRead; observedAt: string };
export type MediaTransportPhaseJob = {
  request: MediaTransportRequest; before: ShopifyMediaTransportRead; sourceEvidenceId?: string;
  enabled: boolean; scopes: string[];
};
export type MediaTransportResult = { status: "disabled" | "scope_missing" | "lease_busy" | "pending" | "conflict" | "verified"; executed: boolean;
  /** Allowlisted MEDIA_* code explaining a durable pending wait; never a provider message. */
  diagnostic?: string };
type Permit = { mayExecute: boolean; status?: string; phase?: string; attemptId?: string; requestHash?: string; request?: Record<string, unknown>; replayed?: boolean };
type ObservationResult = { status: "pending" | "conflict" | "verified" };
export type MediaGuardRefresh = { status: "refreshed" | "unchanged" | "attempt_exists"; refreshed: boolean };
/** All ports are service-only, fixed-shop adapters. No browser JSON may supply jobs, guards or proofs. */
export type MediaTransportDependencies = {
  now(): number;
  load(reference: MediaTransportReference, deadline: number): Promise<MediaTransportPhaseJob>;
  acquire(productId: string, deadline: number): Promise<{ owner: string; expiresAt: number } | null>;
  release(productId: string, leaseOwner: string, deadline: number): Promise<void>;
  observe(job: MediaTransportPhaseJob, deadline: number): Promise<MediaTransportGuard>;
  begin(reference: MediaTransportReference, leaseOwner: string, attemptId: string, intent: Record<string, unknown>, guard: MediaTransportGuard, deadline: number): Promise<Permit>;
  execute(request: MediaTransportRequest, deadline: number): Promise<unknown>;
  uncertain(reference: MediaTransportReference, leaseOwner: string, receipt: { outcome: "unknown" | "accepted" | "processing"; mediaGid?: string; jobId?: string }, deadline: number): Promise<void>;
  conflict(reference: MediaTransportReference, leaseOwner: string, code: string, guard: MediaTransportGuard, deadline: number): Promise<void>;
  /** Pre-attempt only: SQL replaces the chain guard when ONLY product updatedAt/revision drifted. Never a permit. */
  refresh(reference: MediaTransportReference, leaseOwner: string, guard: MediaTransportGuard, deadline: number): Promise<MediaGuardRefresh>;
  /** Read/decode/recover ONLY, then call SQL accept. Must not issue a second external mutation. */
  recover(reference: MediaTransportReference, leaseOwner: string, job: MediaTransportPhaseJob, deadline: number): Promise<ObservationResult>;
};
function fail(code: string): never { throw new Error(code); }
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function validateGuard(guard: MediaTransportGuard, job: MediaTransportPhaseJob, now: number) {
  assertMediaTransportRead(guard.target);
  const keys = ["productId", "variantId", "itemId", "exactGallerySku", "exactShopifySku", "productHandle"] as const;
  if (!HASH.test(guard.sourceFingerprint) || keys.some(k => guard.target.identity[k] !== job.request.context.identity[k]) ||
      !Number.isFinite(Date.parse(guard.observedAt)) || Date.parse(guard.observedAt) < now - 30_000 || Date.parse(guard.observedAt) > now + 5_000) fail("MEDIA_TRANSPORT_OBSERVATION_INVALID");
}
function matchesBefore(guard: MediaTransportGuard, job: MediaTransportPhaseJob) {
  return guard.sourceFingerprint === job.request.context.sourceFingerprint && guard.target.revision === job.request.context.targetRevision;
}
/** Same source, loaded job consistent, and the target differs from job.before ONLY by a
 * forward product updatedAt (plus its revision digest). Backward or any other drift is
 * left to begin/hold, which record a durable conflict for review exactly as before. */
function onlyProductTimestampDrift(guard: MediaTransportGuard, job: MediaTransportPhaseJob) {
  return guard.sourceFingerprint === job.request.context.sourceFingerprint && job.before.revision === job.request.context.targetRevision &&
    onlyForwardProductTimestampDrift(guard.target, job.before);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
function recoveryStatus(result: ObservationResult): ObservationResult["status"] {
  if (!result || !["pending", "conflict", "verified"].includes(result.status)) fail("MEDIA_TRANSPORT_RECOVERY_INVALID");
  return result.status;
}
async function bounded<T>(action: () => Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) fail("MEDIA_TRANSPORT_TIME_BUDGET");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([action(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("MEDIA_TRANSPORT_TIME_BUDGET")), remaining);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function scopeAvailable(job: MediaTransportPhaseJob) {
  if (!Array.isArray(job.scopes)) return false;
  if (job.request.phase === "create_owned") return ["write_files", "write_themes", "write_images"].some(s => job.scopes.includes(s));
  if (["associate", "detach_old", "detach_reference"].includes(job.request.phase)) return ["write_files", "write_themes"].some(s => job.scopes.includes(s));
  return job.scopes.includes("write_products");
}

/** At most one Shopify mutation per invocation. A lost reply consumes the attempt; resume by reading. */
export async function runMediaTransportPhase(reference: MediaTransportReference, deadline: number, deps: MediaTransportDependencies): Promise<MediaTransportResult> {
  if (!UUID.test(reference.operationId) || !Number.isInteger(reference.step) || reference.step < 0 || reference.step > 1000 ||
      !Number.isInteger(reference.phaseIndex) || reference.phaseIndex < 0 || reference.phaseIndex > 10 || !Number.isFinite(deadline)) fail("MEDIA_TRANSPORT_REFERENCE_INVALID");
  const stopAt = Math.min(deadline, deps.now() + 30_000);
  const workDeadline = stopAt - 1000; // Reserve bounded lease cleanup; SQL attempt remains durable if cleanup fails.
  const checkTime = () => { if (deps.now() >= stopAt) fail("MEDIA_TRANSPORT_TIME_BUDGET"); };
  checkTime();
  const job = structuredClone(await bounded(() => deps.load(reference, workDeadline), workDeadline, deps.now));
  if (job.enabled !== true) return { status: "disabled", executed: false };
  if (job.request.context.operationId !== reference.operationId || job.request.context.step !== reference.step) fail("MEDIA_TRANSPORT_JOB_MISMATCH");
  const intent = buildMediaJournalIntent(job.request, job.before, job.sourceEvidenceId);
  if (!scopeAvailable(job)) return { status: "scope_missing", executed: false };
  checkTime();
  const productId = job.request.context.identity.productId;
  const leaseRecord = await bounded(() => deps.acquire(productId, workDeadline), workDeadline, deps.now);
  if (leaseRecord === null) return { status: "lease_busy", executed: false };
  const lease = leaseRecord.owner;
  if (!UUID.test(lease)) fail("MEDIA_TRANSPORT_LEASE_INVALID");
  let executed = false;
  try {
    if (!Number.isFinite(leaseRecord.expiresAt) || leaseRecord.expiresAt < stopAt + 5000) fail("MEDIA_TRANSPORT_LEASE_TOO_SHORT");
    checkTime();
    const guard = await bounded(() => deps.observe(job, workDeadline), workDeadline, deps.now); validateGuard(guard, job, deps.now()); checkTime();
    if (!matchesBefore(guard, job) && onlyProductTimestampDrift(guard, job)) {
      // No attempt is created. SQL re-verifies the exact equality under the same lease and
      // refuses once an attempt exists; the next invocation reloads the refreshed guard.
      // 'unchanged' means this loaded job is already stale (another worker refreshed):
      // never begin from it, or the strict post-begin recheck would conflict mid-chain.
      // Only an existing attempt continues, to replay/recover with its frozen before_guard.
      const refreshed = await bounded(() => deps.refresh(reference, lease, guard, workDeadline), workDeadline, deps.now);
      checkTime();
      // A plain pending (no diagnostic) keeps an in-flight product's queue position after a
      // verified phase in this claim; a diagnostic would send it to the back of the queue.
      if (refreshed?.status !== "attempt_exists") return { status: "pending", executed };
    }
    // The SQL function checks the live shared lease and returns false for any previous attempt.
    // A timeout here grants no execution authority; its outcome is resolved next invocation.
    const attemptId = randomUUID();
    const permit = await bounded(() => deps.begin(reference, lease, attemptId, intent, guard, workDeadline), workDeadline, deps.now);
    checkTime();
    if (permit.mayExecute !== true) {
      if (permit.status === "verified") return { status: "verified", executed };
      if (permit.status === "conflict") return { status: "conflict", executed };
      const recovered = await bounded(() => deps.recover(reference, lease, job, workDeadline), workDeadline, deps.now);
      return { status: recoveryStatus(recovered), executed };
    }
    if (permit.replayed !== false || permit.phase !== mediaJournalPhase(job.request) || permit.attemptId !== attemptId ||
        !HASH.test(permit.requestHash ?? "") || stable(permit.request) !== stable(intent)) fail("MEDIA_TRANSPORT_PERMIT_INVALID");
    if (job.request.phase === "reorder" && Array.isArray(job.request.variables.moves) && job.request.variables.moves.length === 0) {
      fail("MEDIA_TRANSPORT_NOOP_EXECUTION_FORBIDDEN");
    }
    const lastGuard = await bounded(() => deps.observe(job, workDeadline), workDeadline, deps.now); validateGuard(lastGuard, job, deps.now()); checkTime();
    // An asynchronous product updatedAt bump can land after begin. For phases whose SQL
    // readback ignores product updatedAt, that alone must not hold the chain mid-step.
    const lastTolerated = PRODUCT_TIMESTAMP_TOLERANT_PHASES.includes(job.request.phase) && onlyProductTimestampDrift(lastGuard, job);
    if (!matchesBefore(guard, job) || (!matchesBefore(lastGuard, job) && !lastTolerated)) {
      await bounded(() => deps.conflict(reference, lease, "MEDIA_TRANSPORT_CHANGED_BEFORE_CALL", lastGuard, workDeadline), workDeadline, deps.now);
      return { status: "conflict", executed };
    }
    // Reserve enough time to record uncertainty; fixed-shop transport enforces its own deadline.
    const executeDeadline = workDeadline - 4000;
    if (executeDeadline - deps.now() < 1000) {
      await bounded(() => deps.conflict(reference, lease, "MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET", lastGuard, workDeadline), workDeadline, deps.now);
      return { status: "conflict", executed };
    }
    let acknowledgement: ReturnType<typeof parseMediaTransportAcknowledgement>;
    try {
      executed = true;
      acknowledgement = parseMediaTransportAcknowledgement(await bounded(() => deps.execute(structuredClone(job.request), executeDeadline), executeDeadline, deps.now), job.request);
    } catch {
      await bounded(() => deps.uncertain(reference, lease, { outcome: "unknown" }, workDeadline), workDeadline, deps.now);
      return { status: "pending", executed };
    }
    await bounded(() => deps.uncertain(reference, lease, { outcome: "accepted",
      ...(acknowledgement.media ? { mediaGid: acknowledgement.media.mediaId } : {}),
      ...(acknowledgement.jobId ? { jobId: acknowledgement.jobId } : {}) }, workDeadline), workDeadline, deps.now);
    if (deps.now() >= workDeadline) return { status: "pending", executed };
    const recovered = await bounded(() => deps.recover(reference, lease, job, workDeadline), workDeadline, deps.now);
    return { status: recoveryStatus(recovered), executed };
  } finally {
    // Never override durable success/uncertainty because cleanup failed. The lease expires server-side.
    try { await bounded(() => deps.release(productId, lease, stopAt), stopAt, deps.now); } catch { /* bounded best effort */ }
  }
}
