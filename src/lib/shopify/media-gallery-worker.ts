import "server-only";
import { randomUUID } from "node:crypto";
import { mediaSnapshotFingerprint, type MediaIdentity } from "./media-sync-core";
import { buildGalleryMediaCasIntent, createGalleryMediaTransport } from "./media-gallery-transport";
import { createMediaTransportRpc, discoverMediaTransportOperation, type MediaRpcGuard } from "./media-transport-rpc";
import { createMediaRuntimeObserver } from "./media-runtime-observation";
import type { MediaTransportReference, MediaTransportResult } from "./media-transport-worker";

type Dependencies = { discover?: typeof discoverMediaTransportOperation; rpc?: typeof createMediaTransportRpc;
  gallery?: typeof createGalleryMediaTransport; observer?: typeof createMediaRuntimeObserver;
  now?: () => number; environment?: { VERCEL_ENV?: string; SHOPIFY_MEDIA_SYNC?: string } };
type Row = Record<string, unknown>;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
function fail(code: string): never { throw new Error(code); }
function row(value: unknown): Row { if (!value || typeof value !== "object" || Array.isArray(value)) fail("MEDIA_GALLERY_JOB_INVALID"); return value as Row; }
function stable(v: unknown): string { return Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ?
  `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}` : JSON.stringify(v); }
function same(a: unknown, b: unknown) { return stable(a) === stable(b); }
function checkGuard(g: MediaRpcGuard, id: MediaIdentity) {
  if (!g || !HASH.test(g.sourceFingerprint) || g.target?.side !== "gallery" || !same(g.target.identity, id) || !Number.isFinite(Date.parse(g.observedAt))) fail("MEDIA_GALLERY_JOB_GUARD_INVALID");
  mediaSnapshotFingerprint(g.target);
}
function sameGuard(a: MediaRpcGuard, b: MediaRpcGuard) { return a.sourceFingerprint === b.sourceFingerprint && same(a.target, b.target); }
async function bounded<T>(fn: () => Promise<T>, deadline: number, now: () => number): Promise<T> {
  if (!Number.isFinite(deadline) || now() >= deadline) fail("MEDIA_GALLERY_WORKER_TIME_BUDGET"); let timer: ReturnType<typeof setTimeout> | undefined;
  try { const result = await Promise.race([fn(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MEDIA_GALLERY_WORKER_TIME_BUDGET")), deadline - now()); })]);
    if (now() >= deadline) fail("MEDIA_GALLERY_WORKER_TIME_BUDGET"); return result;
  } finally { if (timer) clearTimeout(timer); }
}

/** One exact SQL media CAS at most. Once a durable attempt exists, only its
 * immutable commit receipt may acknowledge it; absent receipt never reauthorizes
 * apply. The SQL transaction preserves copy, specs, prices and every other SKU. */
export async function runPersistedGalleryMediaPhase(reference: MediaTransportReference, deadline: number,
  dependencies: Dependencies = {}): Promise<MediaTransportResult> {
  const now = dependencies.now ?? Date.now, env = dependencies.environment ?? process.env;
  if (env.VERCEL_ENV !== "production" || env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") return { status: "disabled", executed: false };
  if (!UUID.test(reference?.operationId) || !Number.isInteger(reference.step) || reference.step < 0 || reference.step > 1000 ||
      !Number.isInteger(reference.phaseIndex) || reference.phaseIndex < 0 || reference.phaseIndex > 10) fail("MEDIA_GALLERY_JOB_INVALID");
  const ref = structuredClone(reference), stop = Math.min(deadline, now() + 30000), work = stop - 1000;
  const d = await bounded(() => (dependencies.discover ?? discoverMediaTransportOperation)(ref, work), work, now);
  if (!d.enabled) return { status: "disabled", executed: false };
  const op = row(d.operation), step = row(d.step), body = row(step.body), chain = row(d.transport.chain), id = d.identity;
  if (op.id !== ref.operationId || op.product_gid !== id.productId || step.operation_id !== ref.operationId || step.step_index !== ref.step ||
      chain.operation_id !== ref.operationId || chain.step_index !== ref.step || !Array.isArray(chain.phases) || chain.phases[ref.phaseIndex] !== "gallery_cas" ||
      body.target !== "gallery" || !["attach", "replace_reference", "alt", "detach_reference", "reorder"].includes(String(body.kind))) fail("MEDIA_GALLERY_JOB_INVALID");
  const attempts = d.transport.attempts.filter(a => a.phase_index === ref.phaseIndex);
  if (attempts.length > 1) fail("MEDIA_GALLERY_JOB_INVALID"); const previous = attempts[0];
  if (previous && (previous.operation_id !== ref.operationId || previous.step_index !== ref.step || previous.phase !== "gallery_cas" ||
      !UUID.test(String(previous.attempt_id)) || !HASH.test(String(previous.request_hash)))) fail("MEDIA_GALLERY_JOB_INVALID");
  if ([op.status, step.status, chain.status, previous?.status].includes("conflict")) return { status: "conflict", executed: false };
  if ([op.status, step.status, previous?.status].includes("verified")) return { status: "verified", executed: false };
  if (!["running", "uncertain"].includes(String(op.status)) || !["started", "uncertain"].includes(String(step.status)) ||
      !["ready", "running", "uncertain"].includes(String(chain.status)) || chain.next_phase !== ref.phaseIndex ||
      (previous && !["started", "uncertain"].includes(String(previous.status)))) fail("MEDIA_GALLERY_JOB_OUT_OF_ORDER");
  const guard = (previous ? previous.before_guard : chain.current_guard) as MediaRpcGuard; checkGuard(guard, id);
  const intent = buildGalleryMediaCasIntent(guard.target.revision, String(d.desiredSemanticSha256));
  if (previous && !same(previous.request, intent)) fail("MEDIA_GALLERY_IMMUTABLE_REQUEST_CHANGED");
  const observe = (dependencies.observer ?? createMediaRuntimeObserver)(d), rpc = (dependencies.rpc ?? createMediaTransportRpc)(id.productId);
  const gallery = (dependencies.gallery ?? createGalleryMediaTransport)(id);
  const lease = await bounded(() => rpc.acquire(work), work, now); if (!lease) return { status: "lease_busy", executed: false };
  let executed = false;
  try {
    if (!UUID.test(lease.owner) || !Number.isFinite(lease.expiresAt) || lease.expiresAt < stop + 5000) fail("MEDIA_GALLERY_LEASE_TOO_SHORT");
    const observation = async () => { const value = await bounded(() => observe(id, "gallery", work), work, now); checkGuard(value, id);
      if (Date.parse(value.observedAt) < now() - 30000 || Date.parse(value.observedAt) > now() + 5000) fail("MEDIA_GALLERY_JOB_GUARD_INVALID"); return value; };
    const fresh = await observation(), attemptId = randomUUID();
    const permit = await bounded(() => rpc.begin(ref, lease.owner, attemptId, intent, fresh, work), work, now);
    if (permit.mayExecute === true) {
      if (previous || permit.replayed !== false || permit.attemptId !== attemptId || permit.phase !== "gallery_cas" ||
          !HASH.test(permit.requestHash ?? "") || !same(permit.request, intent)) fail("MEDIA_GALLERY_PERMIT_INVALID");
      const last = await observation();
      if (!sameGuard(fresh, guard) || !sameGuard(last, guard)) {
        await bounded(() => rpc.conflict(ref, lease.owner, "MEDIA_TRANSPORT_CHANGED_BEFORE_CALL", last, work), work, now);
        return { status: "conflict", executed };
      }
      if (work - now() < 6000) {
        await bounded(() => rpc.conflict(ref, lease.owner, "MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET", last, work), work, now);
        return { status: "conflict", executed };
      }
      try {
        executed = true;
        await bounded(() => gallery.apply(ref, lease.owner, attemptId, randomUUID(), permit.requestHash!, last, work - 4000), work - 4000, now);
      } catch { /* A missing acknowledgement never permits a second apply. Read the durable transaction receipt. */ }
    } else if (permit.mayExecute !== false) fail("MEDIA_GALLERY_PERMIT_INVALID");
    else if (permit.status === "verified" || permit.status === "conflict") return { status: permit.status, executed };
    const journal = await bounded(() => rpc.read(ref, lease.owner, work), work, now);
    const exact = journal.attempts.filter(a => a.operation_id === ref.operationId && a.step_index === ref.step && a.phase_index === ref.phaseIndex);
    if (exact.length !== 1) fail("MEDIA_GALLERY_RECOVERY_INVALID"); const a = exact[0];
    if (a.phase !== "gallery_cas" || !HASH.test(String(a.request_hash)) || !same(a.request, intent) || !sameGuard(a.before_guard as MediaRpcGuard, guard)) fail("MEDIA_GALLERY_RECOVERY_INVALID");
    if (a.status === "verified" || a.status === "conflict") return { status: a.status, executed };
    if (!["started", "uncertain"].includes(String(a.status))) fail("MEDIA_GALLERY_RECOVERY_INVALID");
    const commit = await bounded(() => gallery.recover(ref, lease.owner, work), work, now);
    if (!commit) return { status: "pending", executed };
    if (commit.attemptId !== a.attempt_id || commit.requestHash !== a.request_hash) fail("MEDIA_GALLERY_RECOVERY_INVALID");
    if (!commit.readbackMatches) return { status: "conflict", executed };
    const after = await observation();
    if (!same(after.target, commit.snapshot)) return { status: "conflict", executed };
    const result = await bounded(() => rpc.accept(ref, lease.owner, randomUUID(), String(a.request_hash), after, null, work), work, now);
    if (result.mayExecute !== false || !["verified", "conflict"].includes(String(result.status))) fail("MEDIA_GALLERY_ACCEPT_INVALID");
    return { status: result.status as "verified" | "conflict", executed };
  } finally { try { await bounded(() => rpc.release(lease.owner, stop), stop, now); } catch { /* server lease expires */ } }
}
