import "server-only";
import { createHash } from "node:crypto";
import type { MediaPair, MediaSide } from "./media-sync-core";
import { mediaReadToSnapshot, type MediaDecodeReceipt } from "./media-read-adapter";
import { galleryRawToSnapshot, createGalleryMediaTransport, type GalleryMediaRef } from "./media-gallery-transport";
import { captureMediaSourceBytes, type CapturedMediaBytes } from "./media-source-bytes";
import { readReadyShopifyMedia } from "./media-shopify-transport";
import type { MediaPlanningContext, MediaRegisteredProof, MediaProofRow } from "./media-planning-rpc";

type Dependencies = { capture?: typeof captureMediaSourceBytes; shopify?: typeof readReadyShopifyMedia; gallery?: typeof createGalleryMediaTransport; now?: () => number };
function fail(code: string): never { throw new Error(code); }
function stable(v: unknown): string { return Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ?
  `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}` : JSON.stringify(v); }
function same(a: unknown, b: unknown) { return stable(a) === stable(b); }
function registered(p: MediaProofRow): MediaRegisteredProof { return { evidenceId: p.evidence_id, key: p.asset_key, side: p.side, contentId: p.content_id, proof: structuredClone(p.proof) }; }

/** Refresh only real current row/platform references. New logical keys derive
 * from immutable angle UUIDs/MediaImage IDs within this exact approved product.
 * A new image is never assigned an old counterpart by filename/order/guessing. */
export async function captureMediaPlanningPair(context: MediaPlanningContext, owner: string, deadline: number,
  dependencies: Dependencies = {}): Promise<{ pair: MediaPair; proofs: MediaRegisteredProof[]; refs: GalleryMediaRef[] }> {
  const c = structuredClone(context), id = c.identity, now = dependencies.now ?? Date.now;
  const check = () => { if (!Number.isFinite(deadline) || now() >= deadline) fail("MEDIA_PLANNING_TIME_BUDGET"); };
  check();
  const galleryPort = (dependencies.gallery ?? createGalleryMediaTransport)(id), shopRead = dependencies.shopify ?? readReadyShopifyMedia;
  const shop = await shopRead(id, deadline); check();
  const proofs: MediaRegisteredProof[] = [], captured = new Map<string, CapturedMediaBytes>();
  const capture = async (url: string) => { check(); let value = captured.get(url); if (!value) {
    value = await (dependencies.capture ?? captureMediaSourceBytes)(id, url, deadline); captured.set(url, value); } check(); return value; };
  const choose = (side: MediaSide, key: string, url: string, platformRef: string, bytes: CapturedMediaBytes): MediaRegisteredProof => {
    const matches = c.provenance.filter(p => p.side === side && p.asset_key === key && p.proof.url === url &&
      p.proof.decodedSha256 === bytes.sha256 && p.proof.width === bytes.width && p.proof.height === bytes.height &&
      p.proof.mime === bytes.mime && p.proof.byteLength === bytes.byteLength && (side === "gallery" || p.proof.platformRef === platformRef));
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
  const angleRefs: GalleryMediaRef[] = [];
  for (const angle of c.galleryRaw.angles) {
    const old = c.galleryRefs.filter(r => r.role === "angle" && r.angleId === angle.id);
    if (old.length > 1) fail("MEDIA_PLANNING_AMBIGUOUS_LINEAGE");
    const key = old[0]?.key ?? `g-angle:${angle.id}`, bytes = await capture(angle.image_path);
    const p = choose("gallery", key, angle.image_path, `angle:${angle.id}`, bytes);
    angleRefs.push({ role: "angle", angleId: angle.id, key, evidenceId: p.evidenceId });
  }
  const coverBytes = await capture(c.galleryRaw.item.cover_image_path);
  const matchingAngles = angleRefs.filter(r => c.galleryRaw.angles.find(a => a.id === r.angleId)?.image_path === c.galleryRaw.item.cover_image_path);
  const oldCover = c.galleryRefs.find(r => r.role === "cover" && r.angleId === null);
  let cover: GalleryMediaRef;
  if (matchingAngles.length) {
    const selected = matchingAngles.find(r => r.key === oldCover?.key) ?? (matchingAngles.length === 1 ? matchingAngles[0] : null);
    if (!selected) fail("MEDIA_PLANNING_COVER_AMBIGUOUS");
    cover = { ...selected, role: "cover", angleId: null };
  } else {
    const key = oldCover && !angleRefs.some(r => r.key === oldCover.key) ? oldCover.key : `g-cover:${id.itemId}`;
    const p = choose("gallery", key, c.galleryRaw.item.cover_image_path, `cover:${id.itemId}`, coverBytes);
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
    const p = choose("shopify", key, image.url, image.mediaId, bytes);
    receipts.set(image.mediaId, { identity: id, side: "shopify", mediaId: image.mediaId, imageId: image.imageId, url: image.url,
      width: image.width, height: image.height, platformUpdatedAt: image.updatedAt, decodedSha256: bytes.sha256, byteLength: bytes.byteLength, mime: bytes.mime,
      key, contentId: p.contentId, evidenceId: p.evidenceId, ...(p.proof.operationId ? { importReceiptId: String(p.proof.operationId) } : {}) });
  }
  const shopify = mediaReadToSnapshot(shop, image => receipts.get(image.mediaId) ?? null);
  const lastGallery = await galleryPort.read(owner, deadline), lastShop = await shopRead(id, deadline); check();
  if (!same(lastGallery, c.galleryRaw) || lastShop.fingerprint !== shop.fingerprint) fail("MEDIA_PLANNING_SOURCE_CHANGED_DURING_READ");
  return { pair: { gallery, shopify }, proofs, refs };
}
