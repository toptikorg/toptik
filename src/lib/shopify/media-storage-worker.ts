import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { MediaIdentity, MediaPair } from "./media-sync-core";
import { mediaSnapshotFingerprint } from "./media-sync-core";
import { assertMediaTransportRead } from "./media-transport-read";
import { stagedMediaUrl, type StagedMediaSource } from "./media-transport-requests";
import { discoverMediaTransportOperation, createMediaTransportRpc, type MediaOperationDiscovery, type MediaRpcGuard } from "./media-transport-rpc";
import { uploadImmutableMedia, readImmutableMedia, assertImmutableMediaUploadPreflight } from "./media-storage-transport";
import { mediaStorageDiagnostic, type MediaStorageDiagnostic } from "./media-storage-diagnostics";
import { assertMediaSourceBytesProof, readVerifiedMediaSourceBytes, type MediaSourceBytesProof } from "./media-source-bytes";
import type { MediaTransportReference, MediaTransportResult } from "./media-transport-worker";

type Row = Record<string, unknown>;
type StorageJob = { identity: MediaIdentity; phase: "stage_source" | "gallery_upload"; source: MediaSourceBytesProof;
  staged: StagedMediaSource; expectedContentId: string; guard: MediaRpcGuard; intent: Row; recovery: boolean };
export type MediaStorageObservation = (identity: MediaIdentity, target: "gallery" | "shopify", deadline: number) => Promise<MediaRpcGuard>;
type Dependencies = { now?: () => number; environment?: { VERCEL_ENV?: string; SHOPIFY_MEDIA_SYNC?: string };
  discover?: typeof discoverMediaTransportOperation; createRpc?: typeof createMediaTransportRpc;
  readSource?: typeof readVerifiedMediaSourceBytes; upload?: typeof uploadImmutableMedia; readUploaded?: typeof readImmutableMedia;
  preflight?: typeof assertImmutableMediaUploadPreflight; reportDiagnostic?: (value: MediaStorageDiagnostic & MediaTransportReference) => void };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
function fail(code: string): never { throw new Error(code); }
function row(v: unknown): Row { if (!v || typeof v !== "object" || Array.isArray(v)) fail("MEDIA_STORAGE_JOB_INVALID"); return v as Row; }
function stable(v: unknown): string { return Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ?
  `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}` : JSON.stringify(v); }
function same(a: unknown, b: unknown) { return stable(a) === stable(b); }
function checkGuard(guard: MediaRpcGuard, identity: MediaIdentity, target: "gallery" | "shopify", now?: number) {
  if (!guard || !HASH.test(guard.sourceFingerprint) || guard.target?.side !== target || !same(guard.target.identity, identity) || !Number.isFinite(Date.parse(guard.observedAt))) fail("MEDIA_STORAGE_GUARD_INVALID");
  if (now !== undefined && (Date.parse(guard.observedAt) < now - 30000 || Date.parse(guard.observedAt) > now + 5000)) fail("MEDIA_STORAGE_GUARD_INVALID");
  if (guard.target.side === "shopify") assertMediaTransportRead(guard.target as Parameters<typeof assertMediaTransportRead>[0]); else mediaSnapshotFingerprint(guard.target);
}
function sameGuard(a: MediaRpcGuard, b: MediaRpcGuard) { return a.sourceFingerprint === b.sourceFingerprint && same(a.target, b.target); }
/** Stable normalized SQL request. No caller query, bucket, pathname or overwrite option. */
export function buildMediaStorageIntent(reference: MediaTransportReference, phase: "stage_source" | "gallery_upload", sourceEvidenceId: string, staged: StagedMediaSource): Row {
  if (!UUID.test(reference.operationId) || !Number.isInteger(reference.step) || reference.step < 0 || reference.step > 1000 ||
      !Number.isInteger(reference.phaseIndex) || reference.phaseIndex < 0 || reference.phaseIndex > 10 || !["stage_source", "gallery_upload"].includes(phase) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(sourceEvidenceId) || staged.url !== stagedMediaUrl(staged.identity, staged.contentSha256, staged.mime)) fail("MEDIA_STORAGE_JOB_INVALID");
  const storagePath = new URL(staged.url).pathname.split("/carousel-media/")[1];
  const mutationSha256 = createHash("sha256").update(stable({ version: "immutable-media-upload/v1", reference, phase, identity: staged.identity,
    contentSha256: staged.contentSha256, mime: staged.mime, width: staged.width, height: staged.height, byteLength: staged.byteLength, sourceEvidenceId, storagePath, upsert: false })).digest("hex");
  return { mutationSha256, sourceEvidenceId, storagePath, upsert: false };
}
function load(ref: MediaTransportReference, discovery: MediaOperationDiscovery): StorageJob | MediaTransportResult {
  const d = structuredClone(discovery), identity = d.identity, op = row(d.operation), step = row(d.step), chain = row(d.transport.chain), body = row(step.body);
  if (op.id !== ref.operationId || op.product_gid !== identity.productId || step.operation_id !== ref.operationId || step.step_index !== ref.step ||
      chain.operation_id !== ref.operationId || chain.step_index !== ref.step || !Array.isArray(chain.phases) || chain.phases.length > 11 ||
      !Array.isArray(d.transport.attempts) || !Array.isArray(d.provenance)) fail("MEDIA_STORAGE_JOB_INVALID");
  if (!d.enabled) return { status: "disabled", executed: false };
  const phase = chain.phases[ref.phaseIndex];
  if (!(["stage_source", "gallery_upload"] as unknown[]).includes(phase) ||
      (phase === "stage_source" ? body.target !== "shopify" || !["attach", "replace_reference", "alt"].includes(String(body.kind)) :
        body.target !== "gallery" || !["attach", "replace_reference"].includes(String(body.kind)))) fail("MEDIA_STORAGE_PHASE_INVALID");
  const attempts = d.transport.attempts.filter(a => a.phase_index === ref.phaseIndex);
  if (attempts.length > 1) fail("MEDIA_STORAGE_JOB_INVALID"); const attempt = attempts[0];
  if (attempt && (attempt.operation_id !== ref.operationId || attempt.step_index !== ref.step || attempt.phase !== phase ||
      !UUID.test(String(attempt.attempt_id)) || !HASH.test(String(attempt.request_hash)))) fail("MEDIA_STORAGE_JOB_INVALID");
  if (op.status === "conflict" || step.status === "conflict" || chain.status === "conflict" || attempt?.status === "conflict") return { status: "conflict", executed: false };
  if (op.status === "verified" || step.status === "verified" || attempt?.status === "verified") return { status: "verified", executed: false };
  if (!["running", "uncertain"].includes(String(op.status)) || !["started", "uncertain"].includes(String(step.status)) ||
      !["ready", "running", "uncertain"].includes(String(chain.status)) || chain.next_phase !== ref.phaseIndex ||
      (attempt && !["started", "uncertain"].includes(String(attempt.status)))) fail("MEDIA_STORAGE_OUT_OF_ORDER");
  // Both supported storage phases are the first phase in their SQL-approved chain.
  if (ref.phaseIndex !== 0) fail("MEDIA_STORAGE_PHASE_INVALID");
  const observed = row(op.observed_pair) as MediaPair, expected = row(step.expected_pair) as MediaPair;
  for (const pair of [observed, expected]) for (const side of ["gallery", "shopify"] as const) {
    mediaSnapshotFingerprint(pair[side]); if (pair[side].side !== side || !same(pair[side].identity, identity)) fail("MEDIA_STORAGE_IDENTITY_CHANGED"); }
  const target = body.target as "shopify" | "gallery", assets = expected[target].assets.filter(a => a.key === body.key);
  if (assets.length !== 1) fail("MEDIA_STORAGE_SOURCE_PROOF_REQUIRED"); const asset = assets[0];
  const evidenceId = attempt ? row(attempt.request).sourceEvidenceId : asset.evidenceId;
  const proofs = d.provenance.filter(p => p.evidence_id === evidenceId && p.product_gid === identity.productId && p.asset_key === body.key && p.content_id === asset.contentId);
  if (proofs.length !== 1) fail("MEDIA_STORAGE_SOURCE_PROOF_REQUIRED"); const p = row(proofs[0].proof);
  const source: MediaSourceBytesProof = { identity, evidenceId: String(evidenceId), url: String(p.url), sha256: String(p.decodedSha256),
    mime: p.mime as StagedMediaSource["mime"], width: Number(p.width), height: Number(p.height), byteLength: Number(p.byteLength) };
  assertMediaSourceBytesProof(source);
  const staged: StagedMediaSource = { identity, receiptId: source.evidenceId, contentSha256: source.sha256, mime: source.mime,
    width: source.width, height: source.height, byteLength: source.byteLength, url: stagedMediaUrl(identity, source.sha256, source.mime) };
  const guard = (attempt ? attempt.before_guard : chain.current_guard) as MediaRpcGuard; checkGuard(guard, identity, target);
  if (guard.sourceFingerprint !== mediaSnapshotFingerprint(observed[target === "gallery" ? "shopify" : "gallery"])) fail("MEDIA_STORAGE_SOURCE_CHANGED");
  const intent = buildMediaStorageIntent(ref, phase as StorageJob["phase"], source.evidenceId, staged);
  if (attempt && !same(intent, attempt.request)) fail("MEDIA_STORAGE_IMMUTABLE_REQUEST_CHANGED");
  return { identity, phase: phase as StorageJob["phase"], source, staged, expectedContentId: asset.contentId, guard, intent, recovery: !!attempt };
}
async function bounded<T>(run: () => Promise<T>, deadline: number, now: () => number): Promise<T> {
  if (!Number.isFinite(deadline) || now() >= deadline) fail("MEDIA_STORAGE_TIME_BUDGET"); let timer: ReturnType<typeof setTimeout> | undefined;
  try { const value = await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MEDIA_STORAGE_TIME_BUDGET")), deadline - now()); })]);
    if (now() >= deadline) fail("MEDIA_STORAGE_TIME_BUDGET"); return value;
  } finally { if (timer) clearTimeout(timer); }
}

/** One immutable upload maximum. Previous/lost permits recover by GET; 404 never authorizes POST. */
export async function runPersistedStorageMediaPhase(reference: MediaTransportReference, deadline: number,
  observe: MediaStorageObservation, dependencies: Dependencies = {}): Promise<MediaTransportResult> {
  const now = dependencies.now ?? Date.now, env = dependencies.environment ?? process.env;
  if (env.VERCEL_ENV !== "production" || env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") return { status: "disabled", executed: false };
  if (!UUID.test(reference.operationId) || !Number.isInteger(reference.step) || reference.step < 0 || reference.step > 1000 ||
      !Number.isInteger(reference.phaseIndex) || reference.phaseIndex < 0 || reference.phaseIndex > 10) fail("MEDIA_STORAGE_JOB_INVALID");
  const ref = structuredClone(reference), stop = Math.min(deadline, now() + 30000), work = stop - 1000;
  const d = await bounded(() => (dependencies.discover ?? discoverMediaTransportOperation)(ref, work), work, now);
  if (d.enabled !== true) return { status: "disabled", executed: false };
  const loaded = load(ref, d); if ("status" in loaded) return loaded; const job = loaded;
  // The unchanged live bucket currently has no proven AVIF permission.
  if (job.staged.mime === "image/avif") fail("MEDIA_STORAGE_MIME_NOT_ENABLED");
  const rpc = (dependencies.createRpc ?? createMediaTransportRpc)(job.identity.productId);
  const lease = await bounded(() => rpc.acquire(work), work, now); if (!lease) return { status: "lease_busy", executed: false };
  let executed = false;
  const reportFailure = (error: unknown, stage: MediaStorageDiagnostic["stage"]) => {
    const diagnostic = { ...ref, ...mediaStorageDiagnostic(error, stage) };
    try { (dependencies.reportDiagnostic ?? (value => console.warn("toptik.media.storage", value)))(diagnostic); }
    catch { /* Observability cannot change durable transport semantics. */ }
  };
  try {
    if (!UUID.test(lease.owner) || !Number.isFinite(lease.expiresAt) || lease.expiresAt < stop + 5000) fail("MEDIA_STORAGE_LEASE_TOO_SHORT");
    const getObservation = async () => { const value = await bounded(() => observe(job.identity, job.guard.target.side, work), work, now);
      checkGuard(value, job.identity, job.guard.target.side, now()); return value; };
    let bytes: Uint8Array | undefined;
    if (!job.recovery) {
      try { (dependencies.preflight ?? assertImmutableMediaUploadPreflight)(job.staged, work); }
      catch (error) { reportFailure(error, "preflight"); throw error; }
      bytes = await bounded(() => (dependencies.readSource ?? readVerifiedMediaSourceBytes)(job.source, work - 7000), work - 7000, now);
    }
    const fresh = await getObservation(), attemptId = randomUUID();
    const permit = await bounded(() => rpc.begin(ref, lease.owner, attemptId, job.intent, fresh, work), work, now);
    if (permit.mayExecute === true) {
      if (job.recovery || permit.replayed !== false || permit.attemptId !== attemptId || permit.phase !== job.phase ||
          !HASH.test(permit.requestHash ?? "") || !same(permit.request, job.intent)) fail("MEDIA_STORAGE_PERMIT_INVALID");
      const last = await getObservation();
      if (!sameGuard(fresh, job.guard) || !sameGuard(last, job.guard)) {
        await bounded(() => rpc.conflict(ref, lease.owner, "MEDIA_TRANSPORT_CHANGED_BEFORE_CALL", last, work), work, now);
        return { status: "conflict", executed };
      }
      const uploadDeadline = work - 5000;
      if (uploadDeadline - now() < 1000) { await bounded(() => rpc.conflict(ref, lease.owner, "MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET", last, work), work, now); return { status: "conflict", executed }; }
      let outcome: "accepted" | "unknown" = "unknown";
      try { executed = true; const response = await bounded(() => (dependencies.upload ?? uploadImmutableMedia)(job.staged, bytes!, uploadDeadline), uploadDeadline, now);
        if (response.outcome !== "accepted") fail("MEDIA_STORAGE_UPLOAD_UNCONFIRMED"); outcome = "accepted";
      } catch (error) {
        reportFailure(error, "upload");
        // A failed/lost upload consumes this attempt; never submit it again.
        // The SQL receipt schema stays unchanged; sanitized detail belongs in logs.
      }
      await bounded(() => rpc.uncertain(ref, lease.owner, { outcome }, work), work, now);
    } else if (permit.mayExecute !== false) fail("MEDIA_STORAGE_PERMIT_INVALID");
    else if (permit.status === "verified" || permit.status === "conflict") return { status: permit.status, executed };
    const journal = await bounded(() => rpc.read(ref, lease.owner, work), work, now);
    const attempts = journal.attempts.filter(a => a.operation_id === ref.operationId && a.step_index === ref.step && a.phase_index === ref.phaseIndex);
    if (attempts.length !== 1) fail("MEDIA_STORAGE_RECOVERY_INVALID"); const a = attempts[0];
    if (a.phase !== job.phase || !HASH.test(String(a.request_hash)) || !same(a.request, job.intent) || !sameGuard(a.before_guard as MediaRpcGuard, job.guard)) fail("MEDIA_STORAGE_RECOVERY_INVALID");
    if (a.status === "verified" || a.status === "conflict") return { status: a.status, executed };
    if (!["started", "uncertain"].includes(String(a.status))) fail("MEDIA_STORAGE_RECOVERY_INVALID");
    let uploaded: Awaited<ReturnType<typeof readImmutableMedia>>;
    try { uploaded = await bounded(() => (dependencies.readUploaded ?? readImmutableMedia)(job.staged, work), work, now); }
    catch (error) { if (error instanceof Error && error.message === "MEDIA_STORAGE_READ_FAILED") return { status: "pending", executed }; throw error; }
    if (uploaded.sha256 !== job.staged.contentSha256 || uploaded.mime !== job.staged.mime || uploaded.width !== job.staged.width || uploaded.height !== job.staged.height ||
        uploaded.byteLength !== job.staged.byteLength || uploaded.url !== job.staged.url || uploaded.storagePath !== job.intent.storagePath) fail("MEDIA_STORAGE_READBACK_CHANGED");
    const after = await getObservation();
    const artifact = { contentId: job.expectedContentId, decodedSha256: uploaded.sha256, ready: true, url: uploaded.url,
      storagePath: uploaded.storagePath, width: uploaded.width, height: uploaded.height, byteLength: uploaded.byteLength, mime: uploaded.mime };
    const result = await bounded(() => rpc.accept(ref, lease.owner, randomUUID(), String(a.request_hash), after, artifact, work), work, now);
    if (result.mayExecute !== false || !["verified", "conflict"].includes(String(result.status))) fail("MEDIA_STORAGE_ACCEPT_INVALID");
    return { status: result.status as "verified" | "conflict", executed };
  } finally { try { await bounded(() => rpc.release(lease.owner, stop), stop, now); } catch { /* owned lease expires server-side */ } }
}
