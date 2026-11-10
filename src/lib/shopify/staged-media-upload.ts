import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { captureMediaSourceBytes, type CapturedMediaBytes } from "./media-source-bytes";
import type { MediaIdentity } from "./media-sync-core";
import { assertNotDeniedMedia } from "./reviewed-media-guard";
import { saveStagedReview } from "./reviewed-media-store";
import { STAGED_UPLOAD_MIMES, stagedPublicUrl, stagedRecord, stagedStoragePath, stagedUploadPath, type StagedUploadMime } from "./staged-media-review-record";

export type StageReviewInput = {
  /** Derived on the server from the approved binding, never from the request. */
  identity: MediaIdentity;
  approvalId: string;
  uploadUrl: string;
  note: string;
  actorId: string;
};
export type StagedReviewResult = {
  stagedUrl: string; stagedPath: string; sha256: string; mime: StagedUploadMime;
  width: number; height: number; byteLength: number; replayed: boolean;
};
type Options = { capture?: typeof captureMediaSourceBytes; save?: typeof saveStagedReview; now?: () => number };
function fail(code: string): never { throw new Error(code); }

/**
 * Turn an administrator's editor upload into a reviewed, immutable Gallery source:
 * 1. only an upload made for exactly this card is accepted, and it is fully decoded first;
 * 2. the bytes are copied WITHOUT overwrite to a content-addressed path (the name is the SHA-256) and read back;
 * 3. one signed receipt binds that exact URL and SHA-256 to the exact product, variant, card and SKUs.
 * It never creates or changes anything in Shopify and never touches the Gallery row; the editor swaps the URL
 * in its own payload and the normal catalog save then passes the review guard for exactly this image.
 */
export async function stageReviewedGalleryUpload(db: SupabaseClient, input: StageReviewInput, deadline: number, options: Options = {}): Promise<StagedReviewResult> {
  const { identity } = input;
  const uploadPath = stagedUploadPath(identity.itemId, input.uploadUrl);
  if (!uploadPath || !Number.isFinite(deadline) || Date.now() >= deadline) fail("STAGED_MEDIA_UPLOAD_INVALID");
  const capture = options.capture ?? captureMediaSourceBytes;
  const original = await capture(identity, input.uploadUrl, deadline);
  if (!STAGED_UPLOAD_MIMES.includes(original.mime as StagedUploadMime)) fail("STAGED_MEDIA_FORMAT_INVALID");
  const mime = original.mime as StagedUploadMime;
  const stagedPath = stagedStoragePath(identity.itemId, original.sha256, mime), stagedUrl = stagedPublicUrl(stagedPath);
  // Known wrong-color renditions stay refused, by URL or by bytes, before anything is written.
  assertNotDeniedMedia(input.uploadUrl, original.sha256);
  assertNotDeniedMedia(stagedUrl, original.sha256);
  const remaining = deadline - Date.now();
  if (remaining < 1) fail("STAGED_MEDIA_TIME_BUDGET");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let upload: { error: unknown };
  try {
    // A timeout never authorizes a second upload or an overwrite: a later request re-checks the same
    // content-addressed location, which can only ever hold these exact bytes.
    upload = await Promise.race([
      db.storage.from("carousel-media").upload(stagedPath, original.bytes, { contentType: mime, upsert: false, cacheControl: "31536000" }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("STAGED_MEDIA_TIME_BUDGET")), Math.min(8000, remaining)); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
  // Storage versions report an existing object with different codes. A successful exact readback is the proof,
  // including when an earlier request already staged the same bytes.
  let stored: CapturedMediaBytes;
  try { stored = await capture(identity, stagedUrl, deadline); }
  catch { return fail(upload.error ? "STAGED_MEDIA_STORAGE_FAILED" : "STAGED_MEDIA_READBACK_MISMATCH"); }
  if (stored.sha256 !== original.sha256 || stored.byteLength !== original.byteLength || stored.mime !== mime ||
      stored.width !== original.width || stored.height !== original.height) fail("STAGED_MEDIA_READBACK_MISMATCH");
  const record = stagedRecord({
    version: 1, kind: "staged_gallery_upload", identity, approvalId: input.approvalId, uploadPath, stagedPath, imageUrl: stagedUrl,
    decodedSha256: stored.sha256, mime, width: stored.width, height: stored.height, byteLength: stored.byteLength, note: input.note,
    actorId: input.actorId, reviewedAt: new Date((options.now ?? Date.now)()).toISOString(), reviewedExactSkuColor: true,
  });
  const saved = await (options.save ?? saveStagedReview)(record, deadline);
  return { stagedUrl, stagedPath, sha256: stored.sha256, mime, width: stored.width, height: stored.height, byteLength: stored.byteLength, replayed: saved.replayed };
}
