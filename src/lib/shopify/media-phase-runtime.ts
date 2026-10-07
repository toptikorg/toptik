import "server-only";
import { discoverMediaTransportOperation } from "./media-transport-rpc";
import { runPersistedShopifyMediaPhase } from "./media-runtime";
import { runPersistedStorageMediaPhase } from "./media-storage-worker";
import { runPersistedGalleryMediaPhase } from "./media-gallery-worker";
import { createMediaRuntimeObserver } from "./media-runtime-observation";
import type { MediaTransportReference, MediaTransportResult } from "./media-transport-worker";

import { assertReviewedPersistedMedia } from "./reviewed-media-policy";

/** The private persisted reference selects an SQL-approved phase; HTTP callers
 * never provide snapshots, bytes, source URLs, GraphQL, bindings or permissions. */
export async function runPersistedMediaPhase(reference: MediaTransportReference, deadline: number): Promise<MediaTransportResult> {
  if (process.env.VERCEL_ENV !== "production" || process.env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") return { status: "disabled", executed: false };
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("MEDIA_RUNTIME_TIME_BUDGET");
  const ref = structuredClone(reference), stop = Math.min(deadline, Date.now() + 40000);
  const d = await discoverMediaTransportOperation(ref, stop - 1000);
  if (!d.enabled) return { status: "disabled", executed: false };
  await assertReviewedPersistedMedia(d, stop - 1000);
  const phases = d.transport.chain?.phases;
  if (!Array.isArray(phases)) throw new Error("MEDIA_RUNTIME_CHAIN_NOT_PREPARED");
  const phase = phases[ref.phaseIndex];
  if (phase === "stage_source" || phase === "gallery_upload") return runPersistedStorageMediaPhase(ref, stop, createMediaRuntimeObserver(d));
  if (phase === "gallery_cas") return runPersistedGalleryMediaPhase(ref, stop);
  if (["create_owned", "associate", "variant_reassign", "detach_old", "reorder"].includes(String(phase))) return runPersistedShopifyMediaPhase(ref, stop);
  throw new Error("MEDIA_RUNTIME_PHASE_INVALID");
}
