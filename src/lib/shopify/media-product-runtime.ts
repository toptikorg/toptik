import "server-only";
import { randomUUID } from "node:crypto";
import { reconcileMedia, mediaSnapshotFingerprint, type MediaPair, type RemovalEvidence } from "./media-sync-core";
import { createMediaPlanningRpc, type MediaPlanningContext } from "./media-planning-rpc";
import { createMediaTransportRpc, discoverMediaTransportOperation, type MediaRpcGuard } from "./media-transport-rpc";
import { createGalleryMediaTransport } from "./media-gallery-transport";
import { captureMediaPlanningPair } from "./media-planning-observation";
import { createMediaRuntimeObserver } from "./media-runtime-observation";
import { runPersistedMediaPhase } from "./media-phase-runtime";
import type { MediaTransportReference } from "./media-transport-worker";
import type { ShopifyMediaTransportRead } from "./media-transport-read";

export type MediaWorkEvidence = { gallery?: { actorType: "supabase_user" | "admin_panel_token"; actorId: string };
  shopify?: { kind: "signed_shopify_event"; eventId: string; deliveryId: string } };
export type MediaProductRun = { status: "disabled" | "done" | "pending" | "review" | "busy"; progressed: boolean; executed: boolean };
type Dependencies = { planning?: typeof createMediaPlanningRpc; transport?: typeof createMediaTransportRpc; gallery?: typeof createGalleryMediaTransport;
  capture?: typeof captureMediaPlanningPair; discover?: typeof discoverMediaTransportOperation; observer?: typeof createMediaRuntimeObserver;
  phase?: typeof runPersistedMediaPhase; now?: () => number; environment?: { VERCEL_ENV?: string; SHOPIFY_MEDIA_SYNC?: string } };
function fail(code: string): never { throw new Error(code); }
function stable(v: unknown): string { return Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ?
  `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}` : JSON.stringify(v); }
function same(a: unknown, b: unknown) { return stable(a) === stable(b); }

/** Bounded planning + at most ONE real transport phase. The durable operation
 * and queue survive each invocation. Existing 78 baselines are never rebound;
 * new/unknown products cannot enter this enabled-identity lane. */
export async function reconcilePersistedMediaProduct(productId: string, evidence: MediaWorkEvidence, deadline: number,
  dependencies: Dependencies = {}): Promise<MediaProductRun> {
  const env = dependencies.environment ?? process.env, now = dependencies.now ?? Date.now;
  const result = (status: MediaProductRun["status"], progressed = false, executed = false): MediaProductRun => ({ status, progressed, executed });
  if (env.VERCEL_ENV !== "production" || env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") return result("disabled");
  const stop = Math.min(deadline, now() + 40000), work = stop - 2000;
  const check = () => { if (!Number.isFinite(deadline) || now() >= work) fail("MEDIA_PLANNING_TIME_BUDGET"); }; check();
  const rpc = (dependencies.transport ?? createMediaTransportRpc)(productId), planning = (dependencies.planning ?? createMediaPlanningRpc)(productId);
  const lease = await rpc.acquire(work); if (!lease) return result("busy");
  let phaseRef: MediaTransportReference | null = null, progressed = false;
  try {
    if (lease.expiresAt < stop + 5000) fail("MEDIA_PLANNING_LEASE_TOO_SHORT");
    let context = await planning.context(lease.owner, work); check();
    const capture = async (c: MediaPlanningContext): Promise<MediaPair> => {
      const observed = await (dependencies.capture ?? captureMediaPlanningPair)(c, lease.owner, work); check();
      await planning.register(lease.owner, observed.proofs, work);
      const gallery = (dependencies.gallery ?? createGalleryMediaTransport)(c.identity);
      const registered = await gallery.observe(lease.owner, c.galleryRaw, observed.refs, work);
      if (!same(registered.snapshot, observed.pair.gallery)) fail("MEDIA_PLANNING_OBSERVATION_CHANGED");
      return observed.pair;
    };
    let operation = context.operations.find(o => ["reserved", "running", "uncertain"].includes(String(o.status)));
    if (!operation) {
      const current = await capture(context), removals: RemovalEvidence[] = [...context.removals];
      for (const side of ["gallery", "shopify"] as const) {
        if (!evidence[side]) continue;
        for (const asset of context.baselines[side].assets) {
          if (current[side].assets.some(a => a.key === asset.key) || removals.some(r => r.side === side && r.key === asset.key)) continue;
          removals.push(await planning.removal(lease.owner, side, asset.key, mediaSnapshotFingerprint(context.baselines[side]), evidence[side]!, work));
        }
      }
      const journal = await planning.journal(lease.owner, current, work);
      const plan = reconcileMedia(context.baselines, current, removals, journal.detached as typeof context.detached);
      if (plan.conflicts.length) {
        await rpc.recordPlannerConflict(lease.owner, randomUUID(), context.stateVersion, current, plan.conflicts, work);
        return result("review");
      }
      if (!plan.patches.length && !plan.orders.length && same(current, context.baselines)) return result("done");
      const reserved = await planning.reserve(lease.owner, context.stateVersion, current, plan, work); progressed = true;
      if (typeof reserved.operationId !== "string") fail("MEDIA_PLANNING_RESERVATION_INVALID");
      if (!plan.patches.length && !plan.orders.length) {
        const committed = await planning.commit(lease.owner, reserved.operationId, current, work);
        return result(committed.status === "verified" ? "done" : "review", true);
      }
      context = await planning.context(lease.owner, work);
      operation = context.operations.find(o => o.id === reserved.operationId);
    }
    if (!operation || typeof operation.id !== "string" || !Number.isInteger(operation.next_step)) fail("MEDIA_PLANNING_OPERATION_INVALID");
    const op = operation, opId = operation.id as string, stepIndex = Number(operation.next_step);
    const plan = op.plan as { patches?: unknown[]; orders?: unknown[] };
    if (!Array.isArray(plan?.patches) || !Array.isArray(plan?.orders)) fail("MEDIA_PLANNING_OPERATION_INVALID");
    const total = plan.patches.length + plan.orders.length;
    if (stepIndex === total) {
      const current = await capture(context), committed = await planning.commit(lease.owner, opId, current, work);
      return result(committed.status === "verified" ? "done" : "review", true);
    }
    if (stepIndex < 0 || stepIndex > total) fail("MEDIA_PLANNING_STEP_INVALID");
    const step = context.steps.find(s => s.operation_id === opId && s.step_index === stepIndex);
    if (!step) fail("MEDIA_PLANNING_STEP_INVALID");
    const ref = { operationId: opId, step: stepIndex, phaseIndex: 0 };
    let journal = await rpc.read(ref, lease.owner, work);
    if (journal.chain?.status === "verified") {
      const current = await capture(context), accepted = await planning.accept(lease.owner, opId, stepIndex, current, work);
      return result(accepted.status === "verified" ? "pending" : "review", accepted.status === "verified");
    }
    if (journal.chain?.status === "conflict" || step.status === "conflict") return result("review");
    if (step.status === "ready") {
      const current = await capture(context), begun = await planning.begin(lease.owner, opId, stepIndex, current, work);
      if (begun.status === "conflict") return result("review");
      if (begun.status !== "started") fail("MEDIA_PLANNING_BEGIN_INVALID"); progressed = true;
    }
    if (!journal.chain) {
      const discovered = await (dependencies.discover ?? discoverMediaTransportOperation)(ref, work);
      const body = discovered.step.body as { target?: string; kind?: string; key?: string };
      if (!body || !["gallery", "shopify"].includes(String(body.target))) fail("MEDIA_PLANNING_BODY_INVALID");
      const guard = await (dependencies.observer ?? createMediaRuntimeObserver)(discovered)(context.identity, body.target as "gallery" | "shopify", work);
      const phases = transportPhases(discovered.operation.observed_pair as MediaPair, body, guard, discovered.provenance);
      await rpc.prepare(ref, lease.owner, randomUUID(), phases, guard, work); progressed = true;
      journal = await rpc.read(ref, lease.owner, work);
    }
    if (!journal.chain || !Number.isInteger(journal.chain.next_phase)) fail("MEDIA_PLANNING_CHAIN_INVALID");
    phaseRef = { ...ref, phaseIndex: Number(journal.chain.next_phase) };
  } finally { try { await rpc.release(lease.owner, Math.min(stop, now() + 1000)); } catch { /* bounded owned lease expiry */ } }
  // Never start another fixed-duration worker after a long planning request.
  // Prepared work is durable and continuation carries it into a fresh budget.
  if (stop - now() < 12000) return result("pending", progressed);
  const phase = await (dependencies.phase ?? runPersistedMediaPhase)(phaseRef!, stop);
  if (phase.status === "verified") return result("pending", true, phase.executed);
  if (phase.status === "conflict" || phase.status === "scope_missing") return result("review", false, phase.executed);
  if (phase.status === "lease_busy") return result("busy");
  return result(phase.status === "disabled" ? "disabled" : "pending", false, phase.executed);
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
