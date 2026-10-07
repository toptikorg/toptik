import "server-only";
import { createHash } from "node:crypto";
import type { MediaPair, MediaSide } from "./media-sync-core";
import { mediaReadToSnapshot, type MediaDecodeReceipt } from "./media-read-adapter";
import { galleryRawToSnapshot, createGalleryMediaTransport, type GalleryMediaRef } from "./media-gallery-transport";
import { captureMediaSourceBytes, type CapturedMediaBytes } from "./media-source-bytes";
import { readReadyShopifyMedia } from "./media-shopify-transport";
import type { MediaPlanningContext, MediaRegisteredProof, MediaProofRow } from "./media-planning-rpc";

import { assertNotDeniedMedia, requireReviewedMedia, isReviewedMediaProof, reviewedMediaRegistry } from "./reviewed-media-guard";

import { loadReviewedMedia } from "./reviewed-media-store";

type CapturedMediaMetadata = Omit<CapturedMediaBytes, "bytes">;
type Dependencies = { capture?: typeof captureMediaSourceBytes; shopify?: typeof readReadyShopifyMedia; gallery?: typeof createGalleryMediaTransport; now?: () => number; reviewLoader?: typeof loadReviewedMedia; observationOnlyBootstrap?: boolean };
function fail(code: string): never { throw new Error(code); }
function stable(v: unknown): string { return Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ?
  `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}` : JSON.stringify(v); }
function same(a: unknown, b: unknown) { return stable(a) === stable(b); }
function registered(p: MediaProofRow): MediaRegisteredProof { return { evidenceId: p.evidence_id, key: p.asset_key, side: p.side, contentId: p.content_id, proof: structuredClone(p.proof) }; }

/** Only independent byte reads run in parallel. Every started read settles
 * before returning or throwing, so callers can safely release their lease.
 * Retain metadata only; three decoders is a hard resource bound, not a retry. */
export async function captureMediaMetadataSources(urls: string[], capture: (url: string) => Promise<CapturedMediaBytes>, check: () => void): Promise<Map<string, CapturedMediaMetadata>> {
  const unique = [...new Set(urls)], result = new Map<string, CapturedMediaMetadata>();
  let next = 0, failed = false, firstError: unknown;
  const worker = async () => {
    while (!failed && next < unique.length) {
      const url = unique[next++];
      try {
        check();
        const decoded = await capture(url);
        check();
        result.set(url, { sha256: decoded.sha256, mime: decoded.mime, width: decoded.width, height: decoded.height, byteLength: decoded.byteLength });
      } catch (error) {
        if (!failed) { failed = true; firstError = error; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, unique.length) }, worker));
  if (failed) throw firstError;
  check();
  return result;
}

/** Refresh only real current row/platform references. New logical keys derive
 * from immutable angle UUIDs/MediaImage IDs within this exact approved product.
 * An untracked Gallery reference to the exact current Shopify URL may reuse
 * that uniquely identified media key after decoding. Never infer a counterpart
 * from filename, order, dimensions, or visual similarity. */
export async function captureMediaPlanningPair(context: MediaPlanningContext, owner: string, deadline: number,
  dependencies: Dependencies = {}): Promise<{ pair: MediaPair; proofs: MediaRegisteredProof[]; refs: GalleryMediaRef[] }> {
  const c = structuredClone(context), id = c.identity, now = dependencies.now ?? Date.now;
  const check = () => { if (!Number.isFinite(deadline) || now() >= deadline) fail("MEDIA_PLANNING_TIME_BUDGET"); };
  check();
  const galleryPort = (dependencies.gallery ?? createGalleryMediaTransport)(id), shopRead = dependencies.shopify ?? readReadyShopifyMedia;
  const shop = await shopRead(id, deadline); check();
  // The bootstrap caller may observe existing independent catalogs without
  // approving propagation. Persisted attach/replace still requires review.
  const bootstrapObservation = dependencies.observationOnlyBootstrap === true;
  if (bootstrapObservation && (c.provenance.length || c.baselines.gallery.assets.length || c.baselines.shopify.assets.length))
    fail("MEDIA_REVIEW_BOOTSTRAP_NOT_EMPTY");
  let extraReviews: ReturnType<typeof reviewedMediaRegistry> | undefined;
  const checkReview = async (url: string, bytes: CapturedMediaMetadata, matches: MediaProofRow[]) => {
    const check = (reviews?: ReturnType<typeof reviewedMediaRegistry>) => {
      if (!matches.some(p => isReviewedMediaProof(id, p, c.provenance, reviews))) requireReviewedMedia(id, url, bytes.sha256, reviews);
    };
    try { check(extraReviews); } catch (error) {
      if (!(error instanceof Error) || error.message !== "MEDIA_REVIEW_REQUIRED" || extraReviews) throw error;
      extraReviews = reviewedMediaRegistry(await (dependencies.reviewLoader ?? loadReviewedMedia)(id, deadline));
      check(extraReviews);
    }
  };
  const proofs: MediaRegisteredProof[] = [];
  const captured = await captureMediaMetadataSources([
    ...c.galleryRaw.angles.map(angle => angle.image_path), c.galleryRaw.item.cover_image_path, ...shop.images.map(image => image.url),
  ], url => (dependencies.capture ?? captureMediaSourceBytes)(id, url, deadline), check);
  const capture = async (url: string) => { check(); const value = captured.get(url);
    if (!value) fail("MEDIA_PLANNING_CAPTURE_MISSING"); return value; };
  const choose = async (side: MediaSide, key: string, url: string, platformRef: string, bytes: CapturedMediaMetadata): Promise<MediaRegisteredProof> => {
    assertNotDeniedMedia(url, bytes.sha256);
    const matches = c.provenance.filter(p => p.side === side && p.asset_key === key && p.proof.url === url &&
      p.proof.decodedSha256 === bytes.sha256 && p.proof.width === bytes.width && p.proof.height === bytes.height &&
      p.proof.mime === bytes.mime && p.proof.byteLength === bytes.byteLength && (side === "gallery" || p.proof.platformRef === platformRef));
    const unchanged = matches.some(p => c.baselines[side].assets.some(a => a.key === key && a.evidenceId === p.evidence_id && a.contentId === p.content_id));
    if (!unchanged && !bootstrapObservation) await checkReview(url, bytes, matches);
    let result: MediaRegisteredProof;
    if (matches.length) {
      if (new Set(matches.map(p => p.content_id)).size !== 1) fail("MEDIA_PLANNING_AMBIGUOUS_LINEAGE");
      const prior = c.baselines[side].assets.find(a => a.key === key)?.evidenceId;
      result = registered(matches.find(p => p.evidence_id === prior) ?? matches.sort((a, b) => a.evidence_id.localeCompare(b.evidence_id))[0]);
    } else {
      const evidenceId = `${side === "gallery" ? "g" : "s"}:` + createHash("sha256").update(JSON.stringify([id.productId, key, platformRef, url, bytes.sha256])).digest("hex");
      result = { evidenceId, key, side, contentId: bytes.sha256, proof: { platformRef, url, decodedSha256: bytes.sha256,
        mime: bytes.mime, width: bytes.width, height: bytes.height, byteLength: bytes.byteLength, verifiedAt: new Date(now()).toISOString(),
        ownership: side === "gallery" && url.startsWith("https://ekgpaoavsavrtbhlbwdg.supabase.co/") ? "owned_storage" : "reference_only" } };
    }
    if (!proofs.some(p => p.evidenceId === result.evidenceId)) proofs.push(result);
    return result;
  };
  const oldCover = c.galleryRefs.find(r => r.role === "cover" && r.angleId === null);
  const angleRefs: GalleryMediaRef[] = [];
  for (const angle of c.galleryRaw.angles) {
    const old = c.galleryRefs.filter(r => r.role === "angle" && r.angleId === angle.id);
    if (old.length > 1) fail("MEDIA_PLANNING_AMBIGUOUS_LINEAGE");
    const bytes = await capture(angle.image_path);
    let key = old[0]?.key ?? `g-angle:${angle.id}`;
    // Adding a modal angle for an existing independent cover must not detach
    // the old cover's logical identity and manufacture a removal on both sides.
    const independentCover = !old.length && oldCover &&
      !c.galleryRefs.some(r => r.role === "angle" && r.key === oldCover.key) &&
      !angleRefs.some(r => r.key === oldCover.key) &&
      angle.image_path === c.galleryRaw.item.cover_image_path;
    if (independentCover) {
      key = oldCover.key;
    } else if (!old.length && c.baselines.gallery.assets.length && c.baselines.shopify.assets.length) {
      const exact = shop.images.filter(image => image.url === angle.image_path);
      if (exact.length > 1) fail("MEDIA_PLANNING_EQUIVALENT_SOURCE_AMBIGUOUS");
      if (exact.length === 1) {
        const image = exact[0];
        const known = [...new Set(c.provenance.filter(p => p.side === "shopify" && p.proof.platformRef === image.mediaId).map(p => p.asset_key))];
        if (known.length > 1) fail("MEDIA_PLANNING_AMBIGUOUS_LINEAGE");
        const sourceKey = known[0] ?? `s-media:${image.mediaId.split("/").at(-1)}`;
        // Never rebind a known Gallery identity or collapse two Gallery angles.
        if (c.baselines.gallery.assets.some(a => a.key === sourceKey) ||
            c.galleryRefs.some(r => r.key === sourceKey) || angleRefs.some(r => r.key === sourceKey)) {
          fail("MEDIA_PLANNING_EQUIVALENT_TARGET_EXISTS");
        }
        if (bytes.width !== image.width || bytes.height !== image.height) fail("MEDIA_PLANNING_IMAGE_DIMENSIONS_CHANGED");
        const counterpart = await choose("shopify", sourceKey, image.url, image.mediaId, bytes);
        // A transformed clone's semantic ID can differ from its decoded bytes.
        // New cross-side clone lineage requires the existing transport journal,
        // never an invented operation receipt from this observation-only path.
        if (counterpart.contentId !== bytes.sha256) fail("MEDIA_PLANNING_IMPORT_LINEAGE_REQUIRES_REVIEW");
        key = sourceKey;
      }
    }
    const p = await choose("gallery", key, angle.image_path, `angle:${angle.id}`, bytes);
    angleRefs.push({ role: "angle", angleId: angle.id, key, evidenceId: p.evidenceId });
  }
  const coverBytes = await capture(c.galleryRaw.item.cover_image_path);
  const matchingAngles = angleRefs.filter(r => c.galleryRaw.angles.find(a => a.id === r.angleId)?.image_path === c.galleryRaw.item.cover_image_path);
  let cover: GalleryMediaRef;
  if (matchingAngles.length) {
    const selected = matchingAngles.find(r => r.key === oldCover?.key) ?? (matchingAngles.length === 1 ? matchingAngles[0] : null);
    if (!selected) fail("MEDIA_PLANNING_COVER_AMBIGUOUS");
    cover = { ...selected, role: "cover", angleId: null };
  } else {
    const key = oldCover && !angleRefs.some(r => r.key === oldCover.key) ? oldCover.key : `g-cover:${id.itemId}`;
    const p = await choose("gallery", key, c.galleryRaw.item.cover_image_path, `cover:${id.itemId}`, coverBytes);
    cover = { role: "cover", angleId: null, key, evidenceId: p.evidenceId };
  }
  const refs = [cover, ...angleRefs];
  const gallery = galleryRawToSnapshot(c.galleryRaw, refs, proofs.filter(p => p.side === "gallery").map(p => ({ ...p, side: "gallery", proof: p.proof as { url: string } })));
  const receipts = new Map<string, MediaDecodeReceipt>();
  for (const image of shop.images) {
    const historical = c.provenance.filter(p => p.side === "shopify" && p.proof.platformRef === image.mediaId);
    const keys = [...new Set(historical.map(p => p.asset_key))]; if (keys.length > 1) fail("MEDIA_PLANNING_AMBIGUOUS_LINEAGE");
    const key = keys[0] ?? `s-media:${image.mediaId.split("/").at(-1)}`;
    const bytes = await capture(image.url);
    if (bytes.width !== image.width || bytes.height !== image.height) fail("MEDIA_PLANNING_IMAGE_DIMENSIONS_CHANGED");
    const p = await choose("shopify", key, image.url, image.mediaId, bytes);
    receipts.set(image.mediaId, { identity: id, side: "shopify", mediaId: image.mediaId, imageId: image.imageId, url: image.url,
      width: image.width, height: image.height, platformUpdatedAt: image.updatedAt, decodedSha256: bytes.sha256, byteLength: bytes.byteLength, mime: bytes.mime,
      key, contentId: p.contentId, evidenceId: p.evidenceId, ...(p.proof.operationId ? { importReceiptId: String(p.proof.operationId) } : {}) });
  }
  const shopify = mediaReadToSnapshot(shop, image => receipts.get(image.mediaId) ?? null);
  const lastGallery = await galleryPort.read(owner, deadline), lastShop = await shopRead(id, deadline); check();
  if (!same(lastGallery, c.galleryRaw) || lastShop.fingerprint !== shop.fingerprint) fail("MEDIA_PLANNING_SOURCE_CHANGED_DURING_READ");
  return { pair: { gallery, shopify }, proofs, refs };
}
