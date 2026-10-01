import "server-only";
import type { MediaIdentity, MediaSnapshot } from "./media-sync-core";
import { mediaSnapshotFingerprint } from "./media-sync-core";
import { mediaReadToSnapshot, type MediaDecodeReceipt } from "./media-read-adapter";
import { readReadyShopifyMedia, readShopifyMediaTransport } from "./media-shopify-transport";
import { readGalleryMediaSnapshot } from "./media-gallery-transport";
import { readVerifiedMediaSourceBytes } from "./media-source-bytes";
import type { MediaOperationDiscovery, MediaRpcGuard } from "./media-transport-rpc";

type Dependencies = { readReady?: typeof readReadyShopifyMedia; readRaw?: typeof readShopifyMediaTransport;
  readGallery?: typeof readGalleryMediaSnapshot; readBytes?: typeof readVerifiedMediaSourceBytes; now?: () => number };
function fail(code: string): never { throw new Error(code); }
function sameIdentity(a: MediaIdentity, b: MediaIdentity) {
  for (const key of ["productId", "variantId", "itemId", "exactGallerySku", "exactShopifySku", "productHandle"] as const) {
    if (a?.[key] !== b[key]) fail("MEDIA_RUNTIME_IDENTITY_CHANGED");
  }
}

/** Existing registered lineage is read from service discovery; actual bytes are
 * decoded again before using it. No URL/filename/position establishes identity. */
export async function readRegisteredShopifyMedia(discovery: MediaOperationDiscovery, deadline: number,
  dependencies: Dependencies = {}): Promise<MediaSnapshot> {
  const now = dependencies.now ?? Date.now, d = structuredClone(discovery), id = d.identity;
  const check = () => { if (!Number.isFinite(deadline) || now() >= deadline) fail("MEDIA_RUNTIME_TIME_BUDGET"); };
  check();
  const read = dependencies.readReady ?? readReadyShopifyMedia, first = await read(id, deadline);
  check(); sameIdentity(first.identity, id);
  const receipts = new Map<string, MediaDecodeReceipt>();
  for (let n = 0; n < first.images.length; n += 2) {
    check();
    await Promise.all(first.images.slice(n, n + 2).map(async image => {
      let matches = d.provenance.filter(p => p.product_gid === id.productId && p.side === "shopify" &&
        p.proof && typeof p.proof === "object" && !Array.isArray(p.proof) &&
        (p.proof as Record<string, unknown>).platformRef === image.mediaId && (p.proof as Record<string, unknown>).url === image.url);
      const observed = d.operation?.observed_pair as { shopify?: { assets?: Array<{ evidenceId: string }> } } | undefined;
      if (matches.length > 1 && Array.isArray(observed?.shopify?.assets)) {
        const ids = new Set(observed.shopify.assets.map(a => a.evidenceId)); matches = matches.filter(p => ids.has(String(p.evidence_id)));
      }
      if (matches.length !== 1) fail("MEDIA_RUNTIME_REGISTERED_SOURCE_REQUIRED");
      const p = matches[0], proof = p.proof as Record<string, unknown>;
      if (proof.width !== image.width || proof.height !== image.height) fail("MEDIA_RUNTIME_REGISTERED_SOURCE_CHANGED");
      await (dependencies.readBytes ?? readVerifiedMediaSourceBytes)({ identity: id, evidenceId: String(p.evidence_id), url: image.url,
        sha256: String(proof.decodedSha256), mime: proof.mime as MediaDecodeReceipt["mime"], width: image.width, height: image.height,
        byteLength: Number(proof.byteLength) }, deadline);
      check();
      receipts.set(image.mediaId, { identity: id, side: "shopify", mediaId: image.mediaId, imageId: image.imageId,
        url: image.url, width: image.width, height: image.height, platformUpdatedAt: image.updatedAt,
        decodedSha256: String(proof.decodedSha256), byteLength: Number(proof.byteLength), mime: proof.mime as MediaDecodeReceipt["mime"],
        key: String(p.asset_key), contentId: String(p.content_id), evidenceId: String(p.evidence_id),
        ...(proof.operationId ? { importReceiptId: String(proof.operationId) } : {}) });
    }));
  }
  const last = await read(id, deadline); check(); sameIdentity(last.identity, id);
  if (last.fingerprint !== first.fingerprint) fail("MEDIA_RUNTIME_SOURCE_CHANGED_DURING_READ");
  return mediaReadToSnapshot(first, image => receipts.get(image.mediaId) ?? null);
}

/** Concrete fresh source/target observations for persisted storage and Gallery
 * phases. Sources are re-read around the target read, under the worker's lease. */
export function createMediaRuntimeObserver(discovery: MediaOperationDiscovery, dependencies: Dependencies = {}) {
  const d = structuredClone(discovery), now = dependencies.now ?? Date.now;
  return async (identity: MediaIdentity, target: "gallery" | "shopify", deadline: number): Promise<MediaRpcGuard> => {
    sameIdentity(identity, d.identity);
    if (!d.enabled || !Number.isFinite(deadline) || now() >= deadline) fail("MEDIA_RUNTIME_OBSERVATION_UNAVAILABLE");
    const gallery = dependencies.readGallery ?? readGalleryMediaSnapshot;
    if (target === "shopify") {
      const before = await gallery(identity, deadline);
      sameIdentity(before.identity, identity); if (before.side !== "gallery") fail("MEDIA_RUNTIME_SOURCE_SIDE_INVALID");
      const fingerprint = mediaSnapshotFingerprint(before), raw = await (dependencies.readRaw ?? readShopifyMediaTransport)(identity, deadline);
      const after = await gallery(identity, deadline); sameIdentity(after.identity, identity);
      if (after.side !== "gallery" || mediaSnapshotFingerprint(after) !== fingerprint) fail("MEDIA_RUNTIME_SOURCE_CHANGED_DURING_READ");
      if (now() >= deadline) fail("MEDIA_RUNTIME_TIME_BUDGET");
      return { sourceFingerprint: fingerprint, target: raw, observedAt: new Date(now()).toISOString() };
    }
    const before = await readRegisteredShopifyMedia(d, deadline, dependencies), current = await gallery(identity, deadline);
    const after = await (dependencies.readReady ?? readReadyShopifyMedia)(identity, deadline); sameIdentity(after.identity, identity);
    sameIdentity(current.identity, identity);
    if (current.side !== "gallery" || after.fingerprint !== before.revision) fail("MEDIA_RUNTIME_SOURCE_CHANGED_DURING_READ");
    if (now() >= deadline) fail("MEDIA_RUNTIME_TIME_BUDGET");
    return { sourceFingerprint: mediaSnapshotFingerprint(before), target: current, observedAt: new Date(now()).toISOString() };
  };
}
