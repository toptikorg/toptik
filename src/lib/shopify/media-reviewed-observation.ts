import "server-only";
import type { GalleryMediaRef } from "./media-gallery-transport";
import type { MediaPlanningContext, MediaRegisteredProof } from "./media-planning-rpc";
import { loadReviewedMedia } from "./reviewed-media-store";
import { requireReviewedMedia, reviewedMediaRegistry } from "./reviewed-media-guard";

/** The refresh RPC cannot inspect signed storage records. Only this service
 * gate authorizes changed evidence IDs, after verifying exact current reviews.
 * An unchanged baseline, old review or transformed-parent receipt is insufficient. */
export async function reviewedObservationEvidenceIds(context: MediaPlanningContext, refs: GalleryMediaRef[],
  proofs: MediaRegisteredProof[], deadline: number, loader = loadReviewedMedia): Promise<string[]> {
  const fail = (): never => { throw new Error("MEDIA_OBSERVATION_REFRESH_REVIEW_REQUIRED"); };
  if (context.operations.some(o => ["reserved", "running", "uncertain"].includes(String(o.status))) || refs.length !== context.galleryRefs.length) fail();
  const changed = new Map<string, MediaRegisteredProof>();
  for (let n = 0; n < refs.length; n++) {
    const next = refs[n], old = context.galleryRefs[n];
    if (!old || next.key !== old.key || next.role !== old.role || next.angleId !== old.angleId) fail();
    if (next.evidenceId === old.evidenceId) continue;
    const matches = proofs.filter(p => p.side === "gallery" && p.key === next.key && p.evidenceId === next.evidenceId);
    const p = matches[0];
    const path = next.role === "cover" ? context.galleryRaw.item.cover_image_path : context.galleryRaw.angles.find(a => a.id === next.angleId)?.image_path;
    if (matches.length !== 1 || typeof path !== "string" || p.proof.url !== path ||
        typeof p.proof.decodedSha256 !== "string" || p.contentId !== p.proof.decodedSha256 ||
        "operationId" in p.proof || "sourceEvidenceId" in p.proof) fail();
    changed.set(p.evidenceId, p);
  }
  if (!changed.size) fail();
  const reviews = reviewedMediaRegistry(await loader(context.identity, deadline));
  for (const p of changed.values()) {
    const sha = String(p.proof.decodedSha256);
    // Legacy URL-only entries must never authorize a new byte fingerprint.
    requireReviewedMedia(context.identity, String(p.proof.url), sha,
      { ...reviews, items: reviews.items.filter(entry => entry.decodedSha256 === sha) });
  }
  return [...changed.keys()].sort();
}
