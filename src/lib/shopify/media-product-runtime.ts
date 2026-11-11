import "server-only";
import { randomUUID } from "node:crypto";
import { reconcileMedia, mediaSnapshotFingerprint, type MediaPair, type MediaVisuals, type RemovalEvidence } from "./media-sync-core";
import { createMediaPlanningRpc, type MediaPlanningContext } from "./media-planning-rpc";
import { createMediaTransportRpc, discoverMediaTransportOperation, type MediaRpcGuard, type MediaOperationDiscovery } from "./media-transport-rpc";
import { createGalleryMediaTransport } from "./media-gallery-transport";
import { captureMediaPlanningPair } from "./media-planning-observation";
import { reviewedObservationEvidenceIds } from "./media-reviewed-observation";
import { createMediaRuntimeObserver } from "./media-runtime-observation";
import { runPersistedMediaPhase } from "./media-phase-runtime";
import type { MediaTransportReference } from "./media-transport-worker";
import type { ShopifyMediaTransportRead } from "./media-transport-read";

export type MediaWorkEvidence = { gallery?: { actorType: "supabase_user" | "admin_panel_token"; actorId: string };
  shopify?: { kind: "signed_shopify_event"; eventId: string; deliveryId: string } };
export type MediaProductRun = { status: "disabled" | "done" | "pending" | "review" | "busy"; progressed: boolean; executed: boolean;
  /** Durable verified cursor only, never a capture, preparation or uncertain write. */
  verifiedCheckpoint?: string;
  /** Exact pre-attempt guard cursor authorizes one guarded reload, never a mutation. */
  replanCheckpoint?: string;
  /** Allowlisted reason for a durable pending wait or review, recorded as last_error. */
  diagnostic?: string;
  /** Planning finished but too little budget remained to run the prepared phase. */
  deferred?: true };
type Dependencies = { planning?: typeof createMediaPlanningRpc; transport?: typeof createMediaTransportRpc; gallery?: typeof createGalleryMediaTransport;
  capture?: typeof captureMediaPlanningPair; discover?: typeof discoverMediaTransportOperation; observer?: typeof createMediaRuntimeObserver;
  phase?: typeof runPersistedMediaPhase; now?: () => number; timing?: (event: MediaPlanningTimingEvent) => void; environment?: { VERCEL_ENV?: string; SHOPIFY_MEDIA_SYNC?: string } };
export type MediaPlanningStage = "acquire" | "context" | "capture" | "register" | "observe" | "journal" | "reserve" | "commit" | "begin" | "guard" | "phase" | "refresh" | "removal" | "read" | "discover" | "accept" | "prepare" | "conflict" | "review_gate";
export type MediaPlanningTimingEvent = { productId: string; outcome: string; error: string | null; elapsedMs: number;
  lastStage: MediaPlanningStage | "entry"; captureCount: number; stages: Partial<Record<MediaPlanningStage, { calls: number; elapsedMs: number }>> };
/** Invocation-local measurements only: never caches bytes, changes deadlines or logs content/URLs/tokens. */
export function createMediaPlanningTiming(productId: string, now: () => number, emit: (event: MediaPlanningTimingEvent) => void) {
  const started = now(), stages: MediaPlanningTimingEvent["stages"] = {};
  let lastStage: MediaPlanningTimingEvent["lastStage"] = "entry", reported = false;
  const elapsed = (start: number) => Math.max(0, now() - start);
  return {
    async measure<T>(stage: MediaPlanningStage, action: () => Promise<T>): Promise<T> {
      lastStage = stage; const start = now();
      try { return await action(); }
      finally { const row = stages[stage] ?? { calls: 0, elapsedMs: 0 }; row.calls++; row.elapsedMs += elapsed(start); stages[stage] = row; }
    },
    finish(outcome: string, error?: unknown) {
      if (reported) return; reported = true;
      try {
        const message = error instanceof Error ? error.message : null;
        const code = typeof message === "string" && /^MEDIA_[A-Z0-9_]{1,90}$/.test(message) ? message : error === undefined ? null : "MEDIA_WORK_FAILED";
        emit({ productId, outcome, error: code, elapsedMs: elapsed(started), lastStage, captureCount: stages.capture?.calls ?? 0, stages });
      }
      catch { /* Diagnostics never change a reconciliation result or mask its original error. */ }
    }
  };
}

function fail(code: string): never { throw new Error(code); }
function stable(v: unknown): string { return Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ?
  `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}` : JSON.stringify(v); }
function same(a: unknown, b: unknown) { return stable(a) === stable(b); }

/** Existing transport may resume after an ordinary catalog edit introduced an
 * angle UUID or changed its URL. It must first register a complete decoded
 * observation through the usual identity/review gate, never guess a reference. */
export function galleryObservationNeedsRefresh(context: MediaPlanningContext): boolean {
  const { galleryRaw: raw, galleryRefs: refs, provenance, identity } = context;
  if (refs.length !== raw.angles.length + 1) return true;
  const expected = [{ role: "cover", angleId: null, url: raw.item.cover_image_path },
    ...raw.angles.map(a => ({ role: "angle", angleId: a.id, url: a.image_path }))];
  return expected.some(e => {
    const matches = refs.filter(r => r && r.role === e.role && r.angleId === e.angleId);
    if (matches.length !== 1) return true;
    const ref = matches[0];
    return !provenance.some(p => p.product_gid === identity.productId && p.side === "gallery" &&
      p.evidence_id === ref.evidenceId && p.asset_key === ref.key && p.proof?.url === e.url);
  });
}

/** Bounded planning + at most ONE real transport phase. The durable operation
 * and queue survive each invocation. Existing 78 baselines are never rebound;
 * new/unknown products cannot enter this enabled-identity lane. */
export async function reconcilePersistedMediaProduct(productId: string, evidence: MediaWorkEvidence, deadline: number,
  dependencies: Dependencies = {}): Promise<MediaProductRun> {
  const timing = createMediaPlanningTiming(productId, dependencies.now ?? Date.now,
    dependencies.timing ?? (event => console.info("toptik.media.planning_timing", event)));
  try {
    const outcome = await runMeasuredMediaProduct(productId, evidence, deadline, dependencies, timing);
    timing.finish(outcome.status); return outcome;
  } catch (error) { timing.finish("error", error); throw error; }
}
async function runMeasuredMediaProduct(productId: string, evidence: MediaWorkEvidence, deadline: number,
  dependencies: Dependencies, timing: ReturnType<typeof createMediaPlanningTiming>): Promise<MediaProductRun> {
  const env = dependencies.environment ?? process.env, now = dependencies.now ?? Date.now;
  const result = (status: MediaProductRun["status"], progressed = false, executed = false): MediaProductRun => ({ status, progressed, executed });
  if (env.VERCEL_ENV !== "production" || env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") return result("disabled");
  const stop = Math.min(deadline, now() + 40000), work = stop - 2000;
  const check = () => { if (!Number.isFinite(deadline) || now() >= work) fail("MEDIA_PLANNING_TIME_BUDGET"); }; check();
  const rpc = (dependencies.transport ?? createMediaTransportRpc)(productId), planning = (dependencies.planning ?? createMediaPlanningRpc)(productId);
  const lease = await timing.measure("acquire", () => rpc.acquire(work)); if (!lease) return result("busy");
  let phaseRef: MediaTransportReference | null = null, progressed = false;
  try {
    if (lease.expiresAt < stop + 5000) fail("MEDIA_PLANNING_LEASE_TOO_SHORT");
    let context = await timing.measure("context", () => planning.context(lease.owner, work)); check();
    let visuals: MediaVisuals | null = null;
    const capture = async (c: MediaPlanningContext, verifiedTransport?: MediaOperationDiscovery): Promise<MediaPair> => {
      const observed = await timing.measure("capture", () => (dependencies.capture ?? captureMediaPlanningPair)(c, lease.owner, work,
        verifiedTransport ? { verifiedTransport } : undefined)); check();
      // Planning without pixel fingerprints could write the same photo twice in another encoding.
      if (!observed.visuals || typeof observed.visuals !== "object") fail("MEDIA_VISUAL_IDENTITY_MISSING");
      visuals = observed.visuals;
      await timing.measure("register", () => planning.register(lease.owner, observed.proofs, work));
      const gallery = (dependencies.gallery ?? createGalleryMediaTransport)(c.identity);
      let registered, refreshed = false;
      try { registered = await timing.measure("observe", () => gallery.observe(lease.owner, c.galleryRaw, observed.refs, work)); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "MEDIA_GALLERY_OBSERVATION_REUSED" || verifiedTransport) throw error;
        const ids = await timing.measure("review_gate", () => reviewedObservationEvidenceIds(c, observed.refs, observed.proofs, work));
        registered = await timing.measure("refresh", () => gallery.refreshReviewedObservation(lease.owner, c.galleryRaw, observed.refs, ids, work));
        refreshed = true;
      }
      const expected = refreshed ? { ...observed.pair.gallery, revision: registered.snapshot.revision } : observed.pair.gallery;
      if (!same(registered.snapshot, expected)) fail("MEDIA_PLANNING_OBSERVATION_CHANGED");
      observed.pair.gallery = registered.snapshot;
      return observed.pair;
    };
    let operation = context.operations.find(o => ["reserved", "running", "uncertain"].includes(String(o.status)));
    if (!operation) {
      const current = await capture(context), removals: RemovalEvidence[] = [...context.removals];
      for (const side of ["gallery", "shopify"] as const) {
        if (!evidence[side]) continue;
        for (const asset of context.baselines[side].assets) {
          if (current[side].assets.some(a => a.key === asset.key) || removals.some(r => r.side === side && r.key === asset.key)) continue;
          removals.push(await timing.measure("removal", () => planning.removal(lease.owner, side, asset.key, mediaSnapshotFingerprint(context.baselines[side]), evidence[side]!, work)));
        }
      }
      const journal = await timing.measure("journal", () => planning.journal(lease.owner, current, work));
      const plan = reconcileMedia(context.baselines, current, removals, journal.detached as typeof context.detached, visuals ?? fail("MEDIA_VISUAL_IDENTITY_MISSING"));
      if (plan.conflicts.length) {
        await timing.measure("conflict", () => rpc.recordPlannerConflict(lease.owner, randomUUID(), context.stateVersion, current, plan.conflicts, work));
        const code = plan.conflicts[0].code;
        return { ...result("review"), diagnostic: /^MEDIA_[A-Z0-9_]{1,90}$/.test(code) ? code : "MEDIA_PLANNER_CONFLICT" };
      }
      if (!plan.patches.length && !plan.orders.length && same(current, context.baselines)) return result("done");
      const reserved = await timing.measure("reserve", () => planning.reserve(lease.owner, context.stateVersion, current, plan, work)); progressed = true;
      if (typeof reserved.operationId !== "string") fail("MEDIA_PLANNING_RESERVATION_INVALID");
      const reservedId = reserved.operationId;
      if (!plan.patches.length && !plan.orders.length) {
        const committed = await timing.measure("commit", () => planning.commit(lease.owner, reservedId, current, work));
        return result(committed.status === "verified" ? "done" : "review", true);
      }
      context = await timing.measure("context", () => planning.context(lease.owner, work));
      operation = context.operations.find(o => o.id === reserved.operationId);
    }
    if (!operation || typeof operation.id !== "string" || !Number.isInteger(operation.next_step)) fail("MEDIA_PLANNING_OPERATION_INVALID");
    const op = operation, opId = operation.id as string, stepIndex = Number(operation.next_step);
    const plan = op.plan as { patches?: unknown[]; orders?: unknown[] };
    if (!Array.isArray(plan?.patches) || !Array.isArray(plan?.orders)) fail("MEDIA_PLANNING_OPERATION_INVALID");
    const total = plan.patches.length + plan.orders.length;
    if (stepIndex === total) {
      const current = await capture(context), committed = await timing.measure("commit", () => planning.commit(lease.owner, opId, current, work));
      return result(committed.status === "verified" ? "done" : "review", true);
    }
    if (stepIndex < 0 || stepIndex > total) fail("MEDIA_PLANNING_STEP_INVALID");
    const step = context.steps.find(s => s.operation_id === opId && s.step_index === stepIndex);
    if (!step) fail("MEDIA_PLANNING_STEP_INVALID");
    const ref = { operationId: opId, step: stepIndex, phaseIndex: 0 };
    let journal = await timing.measure("read", () => rpc.read(ref, lease.owner, work));
    if (journal.chain?.status === "verified") {
      const discovered = await timing.measure("discover", () => (dependencies.discover ?? discoverMediaTransportOperation)(ref, work));
      const current = await capture(context, discovered);
      const target = (discovered.step.body as { target?: string })?.target;
      if (target !== "gallery" && target !== "shopify") fail("MEDIA_PLANNING_BODY_INVALID");
      // Re-pin a complete raw observation after byte decoding. The SQL gate
      // distinguishes copy-only product timestamps from genuine media drift.
      const guard = await timing.measure("guard", () => (dependencies.observer ?? createMediaRuntimeObserver)(discovered)(context.identity, target, work)); check();
      const accepted = await timing.measure("accept", () => planning.acceptFinal(lease.owner, opId, stepIndex, current, guard, work));
      return accepted.status === "verified" ? { ...result("pending", true), verifiedCheckpoint: `${opId}:${stepIndex}:accepted` } : result("review");
    }
    if (journal.chain?.status === "conflict" || step.status === "conflict") return result("review");
    if (step.status !== "ready" && galleryObservationNeedsRefresh(context)) {
      // The byte decoder and reviewed exact-product lineage checks in capture
      // remain mandatory. This only appends observation/provenance records;
      // the frozen transport guard still decides whether to hold a real drift.
      await capture(context); progressed = true;
    }
    if (step.status === "ready") {
      const current = await capture(context), begun = await timing.measure("begin", () => planning.begin(lease.owner, opId, stepIndex, current, work));
      if (begun.status === "conflict") return result("review");
      if (begun.status !== "started") fail("MEDIA_PLANNING_BEGIN_INVALID"); progressed = true;
    }
    if (!journal.chain) {
      const discovered = await timing.measure("discover", () => (dependencies.discover ?? discoverMediaTransportOperation)(ref, work));
      const body = discovered.step.body as { target?: string; kind?: string; key?: string };
      if (!body || !["gallery", "shopify"].includes(String(body.target))) fail("MEDIA_PLANNING_BODY_INVALID");
      const guard = await timing.measure("guard", () => (dependencies.observer ?? createMediaRuntimeObserver)(discovered)(context.identity, body.target as "gallery" | "shopify", work));
      const phases = transportPhases(discovered.operation.observed_pair as MediaPair, body, guard, discovered.provenance);
      await timing.measure("prepare", () => rpc.prepare(ref, lease.owner, randomUUID(), phases, guard, work)); progressed = true;
      journal = await timing.measure("read", () => rpc.read(ref, lease.owner, work));
    }
    if (!journal.chain || !Number.isInteger(journal.chain.next_phase)) fail("MEDIA_PLANNING_CHAIN_INVALID");
    phaseRef = { ...ref, phaseIndex: Number(journal.chain.next_phase) };
  } finally { try { await rpc.release(lease.owner, Math.min(stop, now() + 1000)); } catch { /* bounded owned lease expiry */ } }
  // Never start another fixed-duration worker after a long planning request.
  // Prepared work is durable and continuation carries it into a fresh budget.
  if (stop - now() < 12000) return { ...result("pending", progressed), deferred: true };
  const phase = await timing.measure("phase", () => (dependencies.phase ?? runPersistedMediaPhase)(phaseRef!, stop));
  if (phase.replanCheckpoint !== undefined) {
    const prefix = `${phaseRef!.operationId}:${phaseRef!.step}:${phaseRef!.phaseIndex}:`;
    if (phase.status !== "pending" || phase.executed || typeof phase.replanCheckpoint !== "string" ||
        !phase.replanCheckpoint.startsWith(prefix) || !/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(phase.replanCheckpoint.slice(prefix.length)))
      fail("MEDIA_PLANNING_REPLAN_CHECKPOINT_INVALID");
    return { ...result("pending", progressed), replanCheckpoint: phase.replanCheckpoint };
  }
  if (phase.status === "verified") return { ...result("pending", true, phase.executed),
    verifiedCheckpoint: `${phaseRef!.operationId}:${phaseRef!.step}:phase:${phaseRef!.phaseIndex}` };
  if (phase.status === "conflict" || phase.status === "scope_missing") return result("review", false, phase.executed);
  if (phase.status === "lease_busy") return result("busy");
  const waiting = result(phase.status === "disabled" ? "disabled" : "pending", false, phase.executed);
  return phase.status === "pending" && typeof phase.diagnostic === "string" && /^MEDIA_[A-Z0-9_]{1,90}$/.test(phase.diagnostic) ? { ...waiting, diagnostic: phase.diagnostic } : waiting;
}

function transportPhases(pair: MediaPair, body: { target?: string; kind?: string; key?: string }, guard: MediaRpcGuard, proofs: Record<string, unknown>[]) {
  if (body.target === "gallery") return ["attach", "replace_reference"].includes(String(body.kind)) ? ["gallery_upload", "gallery_cas"] : ["gallery_cas"];
  if (body.kind === "attach") return ["stage_source", "create_owned", "associate", "reorder"];
  if (body.kind === "reorder") return ["reorder"];
  if (guard.target.side !== "shopify") fail("MEDIA_PLANNING_GUARD_INVALID");
  const asset = pair.shopify.assets.find(a => a.key === body.key), matches = proofs.filter(p => p.evidence_id === asset?.evidenceId && p.side === "shopify");
  if (matches.length !== 1) fail("MEDIA_PLANNING_EXISTING_MEDIA_REQUIRED");
  const mediaId = (matches[0].proof as Record<string, unknown>).platformRef;
  const assigned = (guard.target as ShopifyMediaTransportRead).variantMediaIds.includes(String(mediaId));
  if (body.kind === "detach_reference") { if (assigned) fail("MEDIA_VARIANT_LINKED_REMOVAL_REQUIRES_REPLACEMENT"); return ["detach_old"]; }
  if (!["replace_reference", "alt"].includes(String(body.kind))) fail("MEDIA_PLANNING_BODY_INVALID");
  return ["stage_source", "create_owned", "associate", ...(assigned ? ["variant_reassign"] : []), "detach_old", "reorder"];
}
