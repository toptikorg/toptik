import "server-only";
import type { MediaIdentity, MediaSnapshot } from "./media-sync-core";
import { mediaSnapshotFingerprint } from "./media-sync-core";
import { loadMediaRuntimeJob } from "./media-runtime-job";
import { readMediaRuntimeScopes } from "./media-runtime-access";
import { readGalleryMediaSnapshot } from "./media-gallery-transport";
import { createMediaTransportRpc } from "./media-transport-rpc";
import { readShopifyMediaTransport, executeShopifyMediaTransport, readDecodedOwnedShopifyMedia } from "./media-shopify-transport";
import { runMediaTransportPhase, type MediaTransportReference, type MediaTransportResult, type MediaTransportPhaseJob } from "./media-transport-worker";
import { recoverShopifyMediaPhase } from "./media-transport-recovery";

type GalleryReader = (identity: MediaIdentity, deadline: number) => Promise<MediaSnapshot>;
function fail(code: string): never { throw new Error(code); }
function fixedIdentity(left: MediaIdentity, right: MediaIdentity) {
  const keys = ["productId", "variantId", "itemId", "exactGallerySku", "exactShopifySku", "productHandle"] as const;
  if (keys.some(key => left[key] !== right[key])) fail("MEDIA_RUNTIME_IDENTITY_CHANGED");
}

/** Narrow worker for an already-prepared private Shopify phase. The Gallery reader is a
 * service adapter, never a supplied HTTP snapshot. The queue owns planning/preparation.
 * No caller can choose a query, URL, GraphQL variables, image key, permit or request hash. */
export async function runPersistedShopifyMediaPhase(reference: MediaTransportReference, deadline: number,
  readGallery: GalleryReader = readGalleryMediaSnapshot): Promise<MediaTransportResult> {
  if (process.env.VERCEL_ENV !== "production" || process.env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") return { status: "disabled", executed: false };
  if (!Number.isFinite(deadline) || Date.now() >= deadline) fail("MEDIA_RUNTIME_TIME_BUDGET");
  const ref = structuredClone(reference);
  const stopAt = Math.min(deadline, Date.now() + 30_000);
  const loaded = await loadMediaRuntimeJob(ref, stopAt - 1000, { readScopes: readMediaRuntimeScopes });
  if (loaded.status !== "ready") return { status: loaded.status, executed: false };
  const { identity, job, evidence, expectedContentId } = loaded;
  const rpc = createMediaTransportRpc(identity.productId);
  const sameReference = (value: MediaTransportReference) => {
    if (value.operationId !== ref.operationId || value.step !== ref.step || value.phaseIndex !== ref.phaseIndex) fail("MEDIA_RUNTIME_REFERENCE_CHANGED");
  };
  const observe = async (observedJob: MediaTransportPhaseJob, until: number) => {
    fixedIdentity(observedJob.request.context.identity, identity);
    const before = await readGallery(identity, until);
    if (before.side !== "gallery") fail("MEDIA_RUNTIME_SOURCE_SIDE_INVALID");
    fixedIdentity(before.identity, identity);
    const sourceFingerprint = mediaSnapshotFingerprint(before);
    const target = await readShopifyMediaTransport(identity, until);
    const after = await readGallery(identity, until);
    fixedIdentity(after.identity, identity);
    if (after.side !== "gallery" || mediaSnapshotFingerprint(after) !== sourceFingerprint) fail("MEDIA_RUNTIME_SOURCE_CHANGED_DURING_READ");
    if (Date.now() >= until) fail("MEDIA_RUNTIME_TIME_BUDGET");
    return { sourceFingerprint, target, observedAt: new Date().toISOString() };
  };
  return runMediaTransportPhase(ref, stopAt, {
    now: Date.now,
    load: async ref => { sameReference(ref); return job; },
    acquire: async (productId, until) => { if (productId !== identity.productId) fail("MEDIA_RUNTIME_IDENTITY_CHANGED"); return rpc.acquire(until); },
    release: async (productId, owner, until) => { if (productId !== identity.productId) fail("MEDIA_RUNTIME_IDENTITY_CHANGED"); await rpc.release(owner, until); },
    observe,
    begin: async (ref, owner, attempt, intent, guard, until) => { sameReference(ref); return rpc.begin(ref, owner, attempt, intent, guard, until); },
    execute: (request, until) => executeShopifyMediaTransport(request, evidence, until),
    uncertain: async (ref, owner, receipt, until) => { sameReference(ref); await rpc.uncertain(ref, owner, receipt, until); },
    conflict: async (ref, owner, code, guard, until) => { sameReference(ref); await rpc.conflict(ref, owner, code, guard, until); },
    recover: async (ref, owner, recoverJob, until) => {
      sameReference(ref);
      return recoverShopifyMediaPhase(ref, owner, recoverJob, evidence, expectedContentId, until, {
        now: Date.now, readJournal: (r, o, d) => rpc.read(r, o, d), observe,
        readDecodedOwned: readDecodedOwnedShopifyMedia,
        accept: (r, o, id, hash, guard, artifact, d) => rpc.accept(r, o, id, hash, guard, artifact, d),
      });
    },
  });
}
