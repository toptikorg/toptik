import "server-only";
import { randomUUID } from "node:crypto";
import { readGroupMediaSnapshot } from "./group-media-read";
import { sendGroupMediaMutation, observeGroupOwnedFile, readGroupMediaJob } from "./group-media-shopify";
import { buildGroupMediaPhase, verifyGroupMediaPhase, type GroupMediaPhaseRequest, type GroupOwnedMediaReceipt } from "./group-media-transport";
import type { GroupMediaBinding, GroupMediaSnapshot } from "./group-media-policy";
import type { GroupMediaJournalPort, GroupMediaPhaseArtifact, GroupMediaPhaseRef } from "./group-media-journal";
import { ownedMediaCreatedIds, resolveOwnedMediaPhase, type OwnedMediaPhaseSpec, type OwnedMediaVerifiedArtifact } from "./owned-media-phases";
export { buildOwnedMediaPhaseSpecs } from "./owned-media-phases";

export type OwnedMediaPhaseOperation = { id: string; productGid: string; nextPhase: number;
  phases: OwnedMediaPhaseSpec[]; cursor: GroupMediaSnapshot; artifacts: OwnedMediaVerifiedArtifact[] };
export type GroupMediaOperationPorts = { journal: GroupMediaJournalPort;
  readSnapshot?: (binding: GroupMediaBinding, deadline: number) => Promise<GroupMediaSnapshot>;
  execute?: (request: GroupMediaPhaseRequest, deadline: number) => Promise<GroupMediaPhaseArtifact>;
  observeOwnedFile?: (request: GroupMediaPhaseRequest, receiptId: string, deadline: number) => Promise<GroupOwnedMediaReceipt | null>;
  readJob?: (jobId: string, deadline: number) => Promise<boolean>;
  now?: () => number; environment?: { VERCEL_ENV?: string; SHOPIFY_MEDIA_SYNC?: string } };
export type OwnedMediaPhaseRun = { status: "disabled" | "pending" | "review" | "phases_verified";
  cursor: GroupMediaSnapshot; artifacts: OwnedMediaVerifiedArtifact[]; createdMediaIdsByUploadKey: Record<string, string>;
  nextPhase: number; /** A transport invocation was attempted, not proof that Shopify applied it. */ executed: boolean };
type SingleResult = { status: "pending" | "review" | "verified"; cursor: GroupMediaSnapshot; artifact?: OwnedMediaVerifiedArtifact; executed: boolean };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
function fail(code: string): never { throw new Error(code); }

/** One durable phase. A started/uncertain attempt can only observe and recover, never send again. */
export async function runGroupMediaPhase(ref: GroupMediaPhaseRef, proposed: GroupMediaPhaseRequest, before: GroupMediaSnapshot,
  deadline: number, ports: GroupMediaOperationPorts, artifactContext: { uploadKey?: string } = {}): Promise<SingleResult> {
  const now = ports.now ?? Date.now, read = ports.readSnapshot ?? readGroupMediaSnapshot;
  const execute = ports.execute ?? sendGroupMediaMutation;
  const observedFile = ports.observeOwnedFile ?? observeGroupOwnedFile, readJob = ports.readJob ?? readGroupMediaJob;
  if (!UUID.test(ref.operationId) || !UUID.test(ref.owner) || !Number.isInteger(ref.phaseIndex) || ref.phaseIndex < 0 || ref.phaseIndex > 1000 ||
      ref.productGid !== before.binding.productGid || proposed.operationId !== ref.operationId || proposed.phaseIndex !== ref.phaseIndex ||
      !same(proposed, buildGroupMediaPhase({ operationId: ref.operationId, phaseIndex: ref.phaseIndex, before, phase: proposed.input }))) fail("GROUP_MEDIA_REQUEST_CHANGED");
  const stop = Math.min(deadline - 1500, now() + 35_000);
  if (!Number.isFinite(deadline) || now() + 6000 >= stop) return { status: "pending", cursor: before, executed: false };
  let saved = await ports.journal.read(ref, stop), executed = false;
  const check = () => { if (now() >= stop) fail("GROUP_MEDIA_TIME_BUDGET"); };
  const result = (status: SingleResult["status"], cursor = before, artifact?: OwnedMediaVerifiedArtifact): SingleResult => ({ status, cursor, artifact, executed });
  if (saved.status === "review") return result("review");
  if (saved.status === "verified") {
    if (!saved.observedGraph || !saved.request || saved.request.requestHash !== proposed.requestHash) fail("GROUP_MEDIA_VERIFIED_RECEIPT_INVALID");
    return result("verified", saved.observedGraph, saved.artifact as OwnedMediaVerifiedArtifact | undefined);
  }
  if (saved.request && !same(saved.request, proposed)) fail("GROUP_MEDIA_REQUEST_CHANGED");
  if (saved.status !== "prepared" && !saved.request) fail("GROUP_MEDIA_REQUEST_CHANGED");
  if (!same(saved.before, before)) fail("GROUP_MEDIA_SOURCE_CHANGED");
  let attemptId = saved.attemptId;
  const record = async (action: "begin" | "ack" | "uncertain" | "recovered" | "review", observedGraph?: GroupMediaSnapshot, artifact?: GroupMediaPhaseArtifact) => {
    if (!attemptId) fail("GROUP_MEDIA_ATTEMPT_REQUIRED");
    return ports.journal.record(ref, { action, attemptId, requestHash: proposed.requestHash, requestJson: proposed, observedGraph, artifact }, stop);
  };
  if (saved.status === "prepared") {
    attemptId = randomUUID();
    const fresh = await read(proposed.binding, stop - 4000); check();
    if (fresh.fingerprint !== before.fingerprint) { await record("review", fresh, { reason: "GROUP_MEDIA_NOT_SENT_SOURCE_CHANGED" }); return result("review", fresh); }
    const permit = await record("begin"); check();
    if (permit.mayExecute !== true) {
      saved = await ports.journal.read(ref, stop); attemptId = saved.attemptId;
      if (saved.status === "prepared") return result("pending");
      if (!saved.request || !same(saved.request, proposed) || !attemptId) fail("GROUP_MEDIA_ATTEMPT_REQUIRED");
      if (saved.status === "review") return result("review");
      if (saved.status === "verified") {
        if (!saved.observedGraph) fail("GROUP_MEDIA_VERIFIED_RECEIPT_INVALID");
        return result("verified", saved.observedGraph, saved.artifact as OwnedMediaVerifiedArtifact | undefined);
      }
    } else {
      const expiry = Date.parse(permit.leaseExpiresAt ?? saved.leaseExpiresAt);
      // Re-check after the SQL gate has waited. A locally calculated lease TTL is never evidence.
      if (!Number.isFinite(expiry) || expiry <= stop + 5000) fail("GROUP_MEDIA_LEASE_TOO_SHORT");
      const last = await read(proposed.binding, stop - 4000); check();
      if (last.fingerprint !== before.fingerprint) { await record("review", last, { reason: "GROUP_MEDIA_NOT_SENT_SOURCE_CHANGED" }); return result("review", last); }
      saved = { ...saved, request: proposed, attemptId, status: "started" };
      if (!proposed.readOnlyNoop) {
        try {
          if (now() + 5000 >= stop || expiry <= now() + 10_000) fail("GROUP_MEDIA_TIME_BUDGET");
          executed = true;
          const ack = await execute(proposed, stop - 4000);
          saved.ack = ack;
          await record("ack", undefined, ack);
        } catch (error) {
          const code = error instanceof Error && /^(GROUP_MEDIA_|SHOPIFY_)[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : "GROUP_MEDIA_RESULT_UNCERTAIN";
          if (code === "GROUP_MEDIA_WRITE_REJECTED") {
            // A userError can accompany a partial native write. Preserve actual readback for
            // review; never retry it and never leave an explicitly rejected command as success.
            const rejected = await read(proposed.binding, stop - 2000); check();
            const providerCodes = error && typeof error === "object" && "providerCodes" in error && Array.isArray(error.providerCodes)
              ? error.providerCodes.filter((value: unknown): value is string => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)).slice(0, 10) : [];
            await record("review", rejected, { reason: code, ...(providerCodes.length ? { providerCodes } : {}) });
            return result("review", rejected);
          }
          await record("uncertain", undefined, { ...saved.ack, reason: code });
          saved.status = "uncertain";
        }
      }
    }
  }
  if (!["started", "uncertain"].includes(saved.status) || !attemptId) fail("GROUP_MEDIA_ATTEMPT_REQUIRED");
  if (now() + 5000 >= stop) return result("pending");
  let artifact: OwnedMediaVerifiedArtifact | undefined;
  if (proposed.input.kind === "create_owned") {
    // Upload provenance and dispatch-attempt identities are different receipts.
    // SQL binds the created file to the immutable decoded upload, not to a retry owner.
    const owned = await observedFile(proposed, proposed.input.source.receiptId, stop - 3000); check();
    if (!owned) return result("pending");
    if (saved.ack?.mediaId && saved.ack.mediaId !== owned.media.mediaId) {
      const fresh = await read(proposed.binding, stop - 2000); check();
      await record("review", fresh, { reason: "GROUP_MEDIA_CREATED_FILE_ID_CHANGED" });
      return result("review", fresh);
    }
    // Validate all ownership/filename/decode metadata using the following canonical attach builder.
    buildGroupMediaPhase({ operationId: ref.operationId, phaseIndex: ref.phaseIndex + 1, before,
      phase: { kind: "product_attach", owned } });
    artifact = { ...artifactContext, owned, mediaId: owned.media.mediaId };
  }
  if (proposed.input.kind === "reorder" && saved.ack?.jobId && !(await readJob(String(saved.ack.jobId), stop - 3000))) return result("pending");
  const observed = await read(proposed.binding, stop - 2000); check();
  const status = proposed.input.kind === "create_owned" ? (observed.fingerprint === before.fingerprint ? "verified" : "review") :
    verifyGroupMediaPhase(proposed, before, observed);
  if (status === "pending") return result("pending", observed);
  if (status === "review") { await record("review", observed, { reason: "GROUP_MEDIA_READBACK_MISMATCH" }); return result("review", observed); }
  const accepted = await record("recovered", observed, { ...artifact, ...(proposed.readOnlyNoop ? { verifiedNoop: true } : {}) });
  if (accepted.mayExecute !== false) fail("GROUP_MEDIA_RECOVERY_EXECUTION_FORBIDDEN");
  if (accepted.status !== "verified") return result("review", observed);
  return result("verified", observed, artifact);
}

/** Resume phases from private SQL state. phases_verified is deliberately not a Gallery commit. */
export async function runOwnedMediaOperationPhases(operation: OwnedMediaPhaseOperation, owner: string, deadline: number,
  ports: GroupMediaOperationPorts): Promise<OwnedMediaPhaseRun> {
  const env = ports.environment ?? process.env, now = ports.now ?? Date.now;
  let cursor = structuredClone(operation.cursor), nextPhase = operation.nextPhase, executed = false;
  const artifacts = structuredClone(operation.artifacts);
  const finish = (status: OwnedMediaPhaseRun["status"]): OwnedMediaPhaseRun => ({ status, cursor, artifacts,
    createdMediaIdsByUploadKey: ownedMediaCreatedIds(artifacts), nextPhase, executed });
  if (env.VERCEL_ENV !== "production" || env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") return finish("disabled");
  if (!UUID.test(operation.id) || !UUID.test(owner) || operation.productGid !== cursor.binding.productGid ||
      !Number.isInteger(nextPhase) || nextPhase < 0 || nextPhase > operation.phases.length || operation.phases.length > 1000) fail("GROUP_MEDIA_OPERATION_INVALID");
  for (; nextPhase < operation.phases.length && now() + 10_000 < deadline; nextPhase++) {
    const spec = operation.phases[nextPhase];
    const request = resolveOwnedMediaPhase(spec, operation.id, nextPhase, cursor, artifacts);
    const outcome = await runGroupMediaPhase({ productGid: operation.productGid, operationId: operation.id, phaseIndex: nextPhase, owner }, request, cursor,
      deadline, ports, spec.kind === "create_owned" ? { uploadKey: spec.uploadKey } : {});
    executed ||= outcome.executed;
    cursor = outcome.cursor;
    if (outcome.status !== "verified") return finish(outcome.status);
    if (outcome.artifact?.uploadKey) artifacts.push(outcome.artifact);
  }
  return finish(nextPhase === operation.phases.length ? "phases_verified" : "pending");
}
