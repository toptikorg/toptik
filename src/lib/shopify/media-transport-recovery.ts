import { randomUUID } from "node:crypto";
import type { MediaTransportReference, MediaTransportPhaseJob, MediaTransportGuard } from "./media-transport-worker";
import type { MediaTransportJournal } from "./media-transport-rpc";
import type { ShopifyMediaExecutionEvidence, DecodedOwnedShopifyMedia } from "./media-shopify-transport";
import type { MediaTransportContext, StagedMediaSource } from "./media-transport-requests";
import { ownedMediaFilename, buildOwnedMediaCreate, buildOwnedMediaAssociate, buildMediaVariantReassign,
  buildMediaReferenceDetach, buildMediaReorder } from "./media-transport-requests";
import { buildMediaJournalIntent, mediaJournalPhase } from "./media-transport-journal-intent";
import { assertMediaTransportRead, parseTransportMedia } from "./media-transport-read";

type Result = { status: "pending" | "conflict" | "verified" };
type Row = Record<string, unknown>;
/** These ports contain reads and an exact SQL receipt only: recovery cannot send a Shopify mutation. */
export type MediaRecoveryDependencies = {
  now(): number;
  readJournal(reference: MediaTransportReference, owner: string, deadline: number): Promise<MediaTransportJournal>;
  observe(job: MediaTransportPhaseJob, deadline: number): Promise<MediaTransportGuard>;
  readDecodedOwned(context: MediaTransportContext, sha: string, mime: StagedMediaSource["mime"], mediaGid: null, deadline: number): Promise<DecodedOwnedShopifyMedia | null>;
  accept(reference: MediaTransportReference, owner: string, requestId: string, requestHash: string, guard: MediaTransportGuard, artifact: Row | null, deadline: number): Promise<Row>;
};
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fail(code: string): never { throw new Error(code); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function same(a: unknown, b: unknown) { return stable(a) === stable(b); }
async function bounded<T>(action: () => Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = deadline - now();
  if (!Number.isFinite(deadline) || remaining <= 0) fail("MEDIA_RECOVERY_TIME_BUDGET");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([action(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("MEDIA_RECOVERY_TIME_BUDGET")), remaining);
    })]);
    if (now() >= deadline) fail("MEDIA_RECOVERY_TIME_BUDGET");
    return result;
  } finally { if (timer) clearTimeout(timer); }
}
function freshGuard(guard: MediaTransportGuard, job: MediaTransportPhaseJob, now: number) {
  assertMediaTransportRead(guard?.target);
  if (!same(guard.target.identity, job.request.context.identity) || !HASH.test(guard.sourceFingerprint) ||
      !Number.isFinite(Date.parse(guard.observedAt)) || Date.parse(guard.observedAt) < now - 30_000 || Date.parse(guard.observedAt) > now + 5000) fail("MEDIA_RECOVERY_GUARD_INVALID");
}
/** Recovery has no execution authority, but its proof must describe the exact frozen request. */
function assertExecutionEvidence(job: MediaTransportPhaseJob, proof: ShopifyMediaExecutionEvidence) {
  const context = job.request.context;
  const rebuilt = proof.phase === "create_owned" ? buildOwnedMediaCreate(context, proof.source, proof.alt) :
    proof.phase === "associate" ? buildOwnedMediaAssociate(context, proof.before, proof.owned) :
    proof.phase === "variant_reassign" ? buildMediaVariantReassign(context, proof.before, proof.oldMediaId, proof.owned) :
    proof.phase === "reorder" ? buildMediaReorder(context, proof.before, proof.desiredIds, true) :
    buildMediaReferenceDetach(context, proof.before, proof.oldMediaId, proof.phase);
  if (!same(rebuilt, job.request)) fail("MEDIA_RECOVERY_EXECUTION_EVIDENCE_CHANGED");
}

/** Recover one already-dispatched phase. Missing/processing/unchanged results remain pending.
 * A changed, complete target is submitted to the exact SQL acceptance policy, which either
 * verifies the allowed delta or records a conflict. It never grants a second external attempt. */
export async function recoverShopifyMediaPhase(reference: MediaTransportReference, owner: string,
  job: MediaTransportPhaseJob, evidence: ShopifyMediaExecutionEvidence, expectedContentId: string | null,
  deadline: number, deps: MediaRecoveryDependencies): Promise<Result> {
  const ref = structuredClone(reference), saved = structuredClone(job), proof = structuredClone(evidence);
  if (!UUID.test(ref.operationId) || !UUID.test(owner) || !Number.isInteger(ref.step) || ref.step < 0 || ref.step > 1000 ||
      !Number.isInteger(ref.phaseIndex) || ref.phaseIndex < 0 || ref.phaseIndex > 10 ||
      saved.request.context.operationId !== ref.operationId || saved.request.context.step !== ref.step ||
      proof.phase !== saved.request.phase || !same(proof.before, saved.before)) fail("MEDIA_RECOVERY_REFERENCE_INVALID");
  assertExecutionEvidence(saved, proof);
  const intent = buildMediaJournalIntent(saved.request, saved.before, saved.sourceEvidenceId);
  const journal = await bounded(() => deps.readJournal(ref, owner, deadline), deadline, deps.now);
  if (!journal.chain || journal.chain.operation_id !== ref.operationId || journal.chain.step_index !== ref.step ||
      !Array.isArray(journal.chain.phases) || journal.chain.phases[ref.phaseIndex] !== mediaJournalPhase(saved.request)) fail("MEDIA_RECOVERY_JOURNAL_MISMATCH");
  const attempts = journal.attempts.filter(row => row.operation_id === ref.operationId && row.step_index === ref.step && row.phase_index === ref.phaseIndex);
  if (attempts.length !== 1) fail("MEDIA_RECOVERY_ATTEMPT_REQUIRED");
  const attempt = attempts[0];
  const beforeGuard = attempt.before_guard as MediaTransportGuard;
  if (attempt.phase !== mediaJournalPhase(saved.request) || !HASH.test(String(attempt.request_hash)) ||
      !same(attempt.request, intent) || !beforeGuard || beforeGuard.sourceFingerprint !== saved.request.context.sourceFingerprint ||
      !same(beforeGuard.target, saved.before)) fail("MEDIA_RECOVERY_IMMUTABLE_REQUEST_MISMATCH");
  if (attempt.status === "verified") return { status: "verified" };
  if (attempt.status === "conflict" || journal.chain.status === "conflict") return { status: "conflict" };
  if (!["started", "uncertain"].includes(String(attempt.status)) || journal.chain.next_phase !== ref.phaseIndex) fail("MEDIA_RECOVERY_NOT_STARTED");

  let artifact: Row | null = null;
  if (proof.phase === "create_owned") {
    if (typeof expectedContentId !== "string" || !HASH.test(expectedContentId)) fail("MEDIA_RECOVERY_CONTENT_LINEAGE_REQUIRED");
    let recovered: DecodedOwnedShopifyMedia | null;
    try {
      recovered = await bounded(() => deps.readDecodedOwned(saved.request.context, proof.source.contentSha256, proof.source.mime, null, deadline), deadline, deps.now);
    } catch (error) {
      // Only the exact known processing result is pending; decoder/identity errors remain errors.
      if (error instanceof Error && ["MEDIA_TRANSPORT_NOT_READY", "MEDIA_TRANSPORT_RECOVERY_PENDING"].includes(error.message)) return { status: "pending" };
      throw error;
    }
    if (!recovered) return { status: "pending" };
    const { media, decoded, filename } = recovered;
    parseTransportMedia({ ...media, id: media.mediaId });
    if (filename !== ownedMediaFilename(saved.request.context, proof.source.contentSha256, proof.source.mime) ||
        !media.image || media.status !== "READY" || media.fileStatus !== "READY" || (media.alt ?? "") !== proof.alt ||
        new URL(media.image.url).pathname.split("/").at(-1) !== filename || decoded.mediaGid !== media.mediaId ||
        decoded.url !== media.image.url || decoded.width !== media.image.width || decoded.height !== media.image.height ||
        !HASH.test(decoded.sha256) || !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(decoded.mime) ||
        !Number.isSafeInteger(decoded.byteLength) || decoded.byteLength <= 0 || decoded.byteLength > 8 * 1024 * 1024) fail("MEDIA_RECOVERY_DECODE_INVALID");
    artifact = { contentId: expectedContentId, decodedSha256: decoded.sha256, ready: true, url: decoded.url,
      width: decoded.width, height: decoded.height, byteLength: decoded.byteLength, mime: decoded.mime, mediaGid: media.mediaId, filename };
  }

  // Read AFTER decoding: the source or unrelated target images might have changed during the download.
  const fresh = await bounded(() => deps.observe(saved, deadline), deadline, deps.now);
  freshGuard(fresh, saved, deps.now());
  if (proof.phase !== "create_owned" && fresh.sourceFingerprint === beforeGuard.sourceFingerprint) {
    const target = fresh.target, before = saved.before;
    const unchanged = same(target.media, before.media) && same(target.variantMediaIds, before.variantMediaIds) && same(target.variantImage, before.variantImage);
    if (unchanged) return { status: "pending" };
    if (proof.phase === "associate") {
      const added = target.media.find(m => m.mediaId === proof.owned.media.mediaId);
      // A newly associated, still-processing image may legitimately lack its final URL.
      if (added && ["UPLOADED", "PROCESSING"].includes(added.status) && ["UPLOADED", "PROCESSING", "READY"].includes(added.fileStatus) &&
          same(target.media.filter(m => m.mediaId !== added.mediaId), before.media) &&
          same(target.variantMediaIds, before.variantMediaIds) && same(target.variantImage, before.variantImage)) return { status: "pending" };
    }
  }
  const result = await bounded(() => deps.accept(ref, owner, randomUUID(), String(attempt.request_hash), fresh, artifact, deadline), deadline, deps.now);
  if (result.mayExecute !== false || !["verified", "conflict"].includes(String(result.status))) fail("MEDIA_RECOVERY_ACCEPT_INVALID");
  return { status: result.status as Result["status"] };
}
