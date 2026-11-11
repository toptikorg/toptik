import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { VERIFIED_COPY_COLUMNS } from "./copy-eligibility";
import { assertVerifiedCopyApproval, type VerifiedCopyEligibility } from "./sync-rules";
import { reviewIdentity } from "./reviewed-media-record";
import { isShopifyOwnedVariant } from "./variant-source-policy";
import { mediaSnapshotFingerprint, reconcileMedia, type MediaPair, type RemovalEvidence } from "./media-sync-core";
import { createMediaPlanningRpc, type MediaPlanningContext } from "./media-planning-rpc";
import { createMediaTransportRpc } from "./media-transport-rpc";
import { captureMediaPlanningPair } from "./media-planning-observation";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export const OBSOLETE_MEMBERSHIP_APPROVAL = "RETIRE_MISSING_GALLERY_KEYS_WITHOUT_MEDIA_CHANGES";
type Command = { itemId: string; action: "preview" } | { itemId: string; action: "confirm"; proposalHash: string; approval: typeof OBSOLETE_MEMBERSHIP_APPROVAL };
type Actor = { actorType: "supabase_user" | "admin_panel_token"; actorId: string };
type Db = Pick<SupabaseClient, "from" | "rpc">;
type Observed = Awaited<ReturnType<typeof captureMediaPlanningPair>>;
type Dependencies = { now?: () => number; planning?: typeof createMediaPlanningRpc; transport?: typeof createMediaTransportRpc;
  capture?: typeof captureMediaPlanningPair; environment?: { VERCEL_ENV?: string; SHOPIFY_MEDIA_SYNC?: string } };
function fail(code: string): never { throw new Error(code); }
function stable(v: unknown): string { return Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ?
  `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}` : JSON.stringify(v); }
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
function hash(v: unknown) { return createHash("sha256").update(stable(v)).digest("hex"); }
/** Repeat the SAME audited request after a lost response, never create a second decision. */
export function obsoleteMembershipRequestId(proposalHash: string, key: string) {
  const h = hash(["obsolete-gallery-membership-v1", proposalHash, key]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function parseObsoleteMembershipCommand(value: unknown): Command {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MEDIA_OBSOLETE_INPUT_INVALID");
  const v = value as Record<string, unknown>;
  if (typeof v.itemId !== "string" || !UUID.test(v.itemId)) fail("MEDIA_OBSOLETE_INPUT_INVALID");
  if (v.action === "preview" && Object.keys(v).sort().join() === "action,itemId") return { itemId: v.itemId.toLowerCase(), action: "preview" };
  if (v.action !== "confirm" || Object.keys(v).sort().join() !== "action,approval,itemId,proposalHash" ||
      v.approval !== OBSOLETE_MEMBERSHIP_APPROVAL || typeof v.proposalHash !== "string" || !HASH.test(v.proposalHash)) fail("MEDIA_OBSOLETE_INPUT_INVALID");
  return { itemId: v.itemId.toLowerCase(), action: "confirm", proposalHash: v.proposalHash, approval: OBSOLETE_MEMBERSHIP_APPROVAL };
}
/** Pure preflight. A missing old Gallery-only identity may retire only when BOTH
 * present catalogs already agree exactly. This never authorizes a media write. */
export function obsoleteMembershipProposal(context: MediaPlanningContext, observed: Observed) {
  const { baselines, identity } = context, current = observed.pair;
  for (const p of [baselines, current]) for (const side of ["gallery", "shopify"] as const) {
    mediaSnapshotFingerprint(p[side]);
    if (!same(p[side].identity, identity)) fail("MEDIA_OBSOLETE_IDENTITY_CHANGED");
  }
  // The journal includes the most recent terminal conflict as history. A
  // conflict fenced to an OLDER committed state cannot resume in the ordinary
  // runtime. Preserve it, but never accept an open/current/unknown operation.
  if (!Number.isSafeInteger(context.stateVersion) || context.stateVersion < 1 || context.detached.length ||
      context.operations.some(o => o.status !== "conflict" || o.product_gid !== identity.productId || typeof o.id !== "string" || !UUID.test(o.id) ||
        !Number.isSafeInteger(o.state_version) || Number(o.state_version) < 1 || Number(o.state_version) >= context.stateVersion) ||
      context.steps.some(s => !context.operations.some(o => o.id === s.operation_id)))
    fail("MEDIA_OBSOLETE_OPERATION_OR_RECEIPT_PRESENT");
  const semantic = (pair: MediaPair, side: "gallery" | "shopify") => pair[side].assets.map(({ key, contentId, alt }) => ({ key, contentId, alt }));
  if (!current.gallery.assets.length || !same(semantic(current, "gallery"), semantic(current, "shopify"))) fail("MEDIA_OBSOLETE_CURRENT_CATALOGS_DIFFER");
  // No Shopify drift may be smuggled into an old Gallery membership decision.
  if (!same(semantic(baselines, "shopify"), semantic(current, "shopify"))) fail("MEDIA_OBSOLETE_SHOPIFY_BASELINE_CHANGED");
  const missing = baselines.gallery.assets.filter(a => !current.gallery.assets.some(c => c.key === a.key)).map(a => a.key).sort();
  if (!missing.length || missing.some(key => !key.startsWith("g-angle:") || !UUID.test(key.slice(8)) ||
      baselines.shopify.assets.some(a => a.key === key) || current.shopify.assets.some(a => a.key === key))) fail("MEDIA_OBSOLETE_NOT_GALLERY_ONLY");
  if (context.removals.some(r => r.side !== "gallery" || !missing.includes(r.key))) fail("MEDIA_OBSOLETE_OTHER_REMOVAL_PRESENT");
  const fingerprint = mediaSnapshotFingerprint(baselines.gallery);
  const hypothetical: RemovalEvidence[] = missing.map(key => ({ side: "gallery", key, kind: "authenticated_editor",
    expectedBaselineFingerprint: fingerprint, requestId: obsoleteMembershipRequestId(fingerprint, key) }));
  const plan = reconcileMedia(baselines, current, hypothetical, [], observed.visuals);
  if (plan.conflicts.length || plan.patches.length || plan.orders.length || !same(plan.projected.gallery, current.gallery.assets) ||
      !same(plan.projected.shopify, current.shopify.assets)) fail("MEDIA_OBSOLETE_WOULD_CHANGE_MEDIA");
  const sources = observed.proofs.map(p => ({ side: p.side, key: p.key, evidenceId: p.evidenceId, contentId: p.contentId,
    url: p.proof.url, platformRef: p.proof.platformRef, sha256: p.proof.decodedSha256, width: p.proof.width, height: p.proof.height, byteLength: p.proof.byteLength, mime: p.proof.mime }))
    .sort((a, b) => `${a.side}:${a.key}:${a.evidenceId}`.localeCompare(`${b.side}:${b.key}:${b.evidenceId}`));
  for (const side of ["gallery", "shopify"] as const) for (const asset of current[side].assets) {
    const proof = sources.filter(p => p.side === side && p.key === asset.key && p.evidenceId === asset.evidenceId && p.contentId === asset.contentId);
    if (proof.length !== 1 || typeof proof[0].sha256 !== "string" || !HASH.test(proof[0].sha256) ||
        typeof proof[0].url !== "string" || !proof[0].url.startsWith("https://") || typeof proof[0].platformRef !== "string" ||
        !Number.isSafeInteger(proof[0].width) || Number(proof[0].width) < 1 || !Number.isSafeInteger(proof[0].height) || Number(proof[0].height) < 1 ||
        !Number.isSafeInteger(proof[0].byteLength) || Number(proof[0].byteLength) < 1) fail("MEDIA_OBSOLETE_CURRENT_PROOF_MISSING");
  }
  const decision = { identity, stateVersion: context.stateVersion, baselineFingerprint: fingerprint,
    shopifyBaselineFingerprint: mediaSnapshotFingerprint(baselines.shopify), galleryRawRevision: context.galleryRaw.revision,
    currentFingerprints: { gallery: mediaSnapshotFingerprint(current.gallery), shopify: mediaSnapshotFingerprint(current.shopify) },
    historicalJournalFingerprint: hash([context.operations, context.steps]), missingGalleryKeys: missing, sources };
  const proposalHash = hash(decision), seen = new Set<string>();
  for (const r of context.removals) {
    // An earlier partial decision must belong to THIS exact proposal. A new
    // capture/hash must never create duplicate intent rows for the same key.
    if (seen.has(r.key) || r.kind !== "authenticated_editor" || r.expectedBaselineFingerprint !== fingerprint ||
        r.requestId !== obsoleteMembershipRequestId(proposalHash, r.key)) fail("MEDIA_OBSOLETE_EXISTING_DECISION_DIFFERS");
    seen.add(r.key);
  }
  return { ...decision, proposalHash, mediaChanges: 0, syncVerified: false };
}

/** Preview is read-only apart from a temporary lease. Confirm records ONLY
 * explicit, hash-bound historical membership decisions, then queues the ordinary
 * reconciler with NO implicit editor deletion authority. It never commits a
 * baseline, creates media, modifies ALT/order or marks reconciliation verified. */
export async function handleObsoleteMembership(db: Db, command: Command, actor: Actor, deadline: number, deps: Dependencies = {}) {
  const now = deps.now ?? Date.now, env = deps.environment ?? process.env, work = deadline - 2500;
  const check = () => { if (!Number.isFinite(deadline) || now() >= work) fail("MEDIA_OBSOLETE_TIME_BUDGET"); }; check();
  if (env.VERCEL_ENV !== "production" || env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") fail("MEDIA_OBSOLETE_DISABLED");
  if (isShopifyOwnedVariant(command.itemId)) fail("MEDIA_OBSOLETE_OWNED_UNSUPPORTED");
  if ((actor.actorType === "supabase_user" && !UUID.test(actor.actorId)) ||
      (actor.actorType === "admin_panel_token" && actor.actorId !== "configured-admin-panel") ||
      !["supabase_user", "admin_panel_token"].includes(actor.actorType)) fail("MEDIA_OBSOLETE_ACTOR_INVALID");
  const initial = await db.from("shopify_gallery_copy_eligibility").select(VERIFIED_COPY_COLUMNS)
    .eq("carousel_item_id", command.itemId).limit(2).abortSignal(AbortSignal.timeout(Math.min(4000, work - now()))); check();
  if (initial.error || initial.data?.length !== 1) fail("MEDIA_OBSOLETE_IDENTITY_CHANGED");
  const approval = initial.data[0] as VerifiedCopyEligibility; assertVerifiedCopyApproval(approval);
  const identity = reviewIdentity({ productId: approval.product_gid, variantId: approval.variant_gid, itemId: approval.carousel_item_id,
    exactGallerySku: approval.exact_gallery_sku, exactShopifySku: approval.exact_shopify_sku, productHandle: approval.approved_product_handle });
  if (identity.itemId !== command.itemId) fail("MEDIA_OBSOLETE_IDENTITY_CHANGED");
  const transport = (deps.transport ?? createMediaTransportRpc)(identity.productId, { client: db, now, maxRpcMs: 4000 });
  const planning = (deps.planning ?? createMediaPlanningRpc)(identity.productId, { client: db, now });
  const lease = await transport.acquire(work); if (!lease) fail("MEDIA_OBSOLETE_BUSY");
  try {
    if (lease.expiresAt < deadline + 5000) fail("MEDIA_OBSOLETE_LEASE_TOO_SHORT");
    const context = await planning.context(lease.owner, work); check();
    if (!same(context.identity, identity)) fail("MEDIA_OBSOLETE_IDENTITY_CHANGED");
    const observed = await (deps.capture ?? captureMediaPlanningPair)(context, lease.owner, work); check();
    const proposal = obsoleteMembershipProposal(context, observed);
    const fresh = await planning.context(lease.owner, work); check();
    if (!same(context, fresh)) fail("MEDIA_OBSOLETE_SOURCE_CHANGED");
    if (command.action === "preview") return { ...proposal, decisionRecorded: false };
    if (command.proposalHash !== proposal.proposalHash) fail("MEDIA_OBSOLETE_PROPOSAL_CHANGED");
    // The existing RPC validates the live baseline and appends immutable audit.
    // Request IDs are deterministic so a partially acknowledged request can be
    // retried against the identical proposal, never silently broadened.
    for (const key of proposal.missingGalleryKeys) {
      const requestId = obsoleteMembershipRequestId(proposal.proposalHash, key);
      await planning.removal(lease.owner, "gallery", key, proposal.baselineFingerprint, actor, work, requestId); check();
    }
    const queued = await db.rpc("enqueue_toptik_shopify_media_work", { p_product_gid: identity.productId, p_event_id: null })
      .abortSignal(AbortSignal.timeout(Math.min(4000, work - now()))); check();
    if (queued.error || queued.data !== true) fail("MEDIA_OBSOLETE_QUEUE_UNCONFIRMED");
    return { ...proposal, decisionRecorded: true, queued: true };
  } finally { try { await transport.release(lease.owner, now() + 2000); } catch { /* bounded lease expires */ } }
}
