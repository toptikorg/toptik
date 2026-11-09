import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { captureMediaSourceBytes, type CapturedMediaBytes } from "./media-source-bytes";
import type { MediaIdentity } from "./media-sync-core";
import type { GroupMediaBinding } from "./group-media-policy";
import type { GroupStagedMediaSource } from "./group-media-transport";

type Options = { capture?: typeof captureMediaSourceBytes; randomId?: () => string };
const origin = "https://ekgpaoavsavrtbhlbwdg.supabase.co";
const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
function fail(code: string): never { throw new Error(code); }

/** Uploads are untrusted until fully decoded, content-addressed without upsert and read back.
 * This creates a private operation receipt, not a Shopify file or publication. */
export async function stageOwnedMediaUpload(db: SupabaseClient, binding: GroupMediaBinding, itemId: string,
  uploadUrl: string, deadline: number, options: Options = {}): Promise<GroupStagedMediaSource> {
  const variant = binding.variants.find(row => row.itemId === itemId);
  if (!variant || !Number.isFinite(deadline) || Date.now() >= deadline) fail("OWNED_MEDIA_UPLOAD_INVALID");
  let url: URL;
  try { url = new URL(uploadUrl); } catch { return fail("OWNED_MEDIA_UPLOAD_INVALID"); }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || /%(?:2f|5c|2e)/i.test(url.pathname) ||
    !url.pathname.startsWith(`/storage/v1/object/public/carousel-media/items/${itemId}/owned-drafts/`)) fail("OWNED_MEDIA_UPLOAD_INVALID");
  const identity: MediaIdentity = { productId: binding.productGid, productHandle: binding.handle, variantId: variant.variantGid,
    itemId, exactGallerySku: variant.sku, exactShopifySku: variant.sku };
  const capture = options.capture ?? captureMediaSourceBytes;
  const original = await capture(identity, uploadUrl, deadline);
  if (!Object.hasOwn(extensions, original.mime)) fail("OWNED_MEDIA_UPLOAD_FORMAT_INVALID");
  const mime = original.mime as GroupStagedMediaSource["mime"];
  const path = `sync-owned/${itemId}/${original.sha256}.${extensions[mime]}`;
  const stagedUrl = `${origin}/storage/v1/object/public/carousel-media/${path}`;
  const remaining = deadline - Date.now();
  if (remaining < 1) fail("OWNED_MEDIA_TIME_BUDGET");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let upload: { error: unknown };
  try {
    // Timeout does not authorize overwriting or a second upload. A later request
    // rechecks the same content-addressed location, never a fresh random path.
    upload = await Promise.race([
      db.storage.from("carousel-media").upload(path, original.bytes, { contentType: mime, upsert: false, cacheControl: "31536000" }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("OWNED_MEDIA_TIME_BUDGET")), Math.min(8000, remaining)); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
  // Storage versions use different duplicate error codes. A successful exact
  // readback is the proof, including when a previous upload already landed.
  let stored: CapturedMediaBytes;
  try { stored = await capture(identity, stagedUrl, deadline); }
  catch { return fail(upload.error ? "OWNED_MEDIA_UPLOAD_STORAGE_FAILED" : "OWNED_MEDIA_UPLOAD_READBACK_MISMATCH"); }
  if (stored.sha256 !== original.sha256 || stored.byteLength !== original.byteLength || stored.mime !== mime ||
    stored.width !== original.width || stored.height !== original.height) fail("OWNED_MEDIA_UPLOAD_READBACK_MISMATCH");
  return { itemId, receiptId: (options.randomId ?? randomUUID)(), sha256: stored.sha256, mime,
    width: stored.width, height: stored.height, byteLength: stored.byteLength, url: stagedUrl };
}
