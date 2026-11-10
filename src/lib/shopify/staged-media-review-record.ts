import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MediaIdentity } from "./media-sync-core";
import type { ReviewedMediaEntry } from "./reviewed-media-guard";
import { reviewIdentity } from "./reviewed-media-record";

// A "staged Gallery review receipt" approves ONE image that an administrator uploaded from the editor
// to an ordinary (single-variant) product, after looking at it. It is deliberately a separate record
// type from the native MediaImage review in reviewed-media-record.ts: that schema stays strict (Shopify
// CDN URL, existing MediaImage GID), this one only ever describes an item-owned Storage upload that was
// copied, without overwrite, to a content-addressed path.
//
// Pure module: no I/O. The server flow that creates and stores these records is staged-media-upload.ts.

export const STAGED_STORAGE_ORIGIN = "https://ekgpaoavsavrtbhlbwdg.supabase.co";
const PUBLIC_PREFIX = "/storage/v1/object/public/carousel-media/";
export type StagedUploadMime = "image/jpeg" | "image/png" | "image/webp";
const EXTENSIONS: Record<StagedUploadMime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const STAGED_UPLOAD_MIMES = Object.keys(EXTENSIONS) as StagedUploadMime[];
export const MAX_STAGED_BYTES = 8 * 1024 * 1024;
export const MAX_STAGED_NOTE = 300;

export type StagedGalleryReviewRecord = {
  version: 1;
  kind: "staged_gallery_upload";
  identity: MediaIdentity;
  /** Eligibility approval the identity was read from, kept as audit evidence. */
  approvalId: string;
  /** The administrator's upload (items/<itemId>/(cover|angles)/<uuid>.<ext>); never trusted as the image. */
  uploadPath: string;
  /** Content-addressed copy that the Gallery row will reference; the bytes are fixed by the path itself. */
  stagedPath: string;
  imageUrl: string;
  decodedSha256: string;
  mime: StagedUploadMime;
  width: number;
  height: number;
  byteLength: number;
  note: string;
  actorId: string;
  reviewedAt: string;
  reviewedExactSkuColor: true;
};
export type SignedStagedGalleryReview = { record: StagedGalleryReviewRecord; signature: string };

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DOMAIN = "toptik:staged-gallery-media-review:v1\n";
const fail = (): never => { throw new Error("STAGED_MEDIA_RECORD_INVALID"); };
const row = (x: unknown): Record<string, unknown> => !x || typeof x !== "object" || Array.isArray(x) ? fail() : x as Record<string, unknown>;
const keys = (x: Record<string, unknown>, expected: string[]) => {
  if (Object.keys(x).sort().join("|") !== [...expected].sort().join("|")) fail();
};
const text = (x: unknown, limit: number) => {
  if (typeof x !== "string" || !x.trim() || x !== x.trim() || x.length > limit || /[\u0000-\u001f\u007f]/.test(x)) fail();
  return x as string;
};
const integer = (x: unknown, min: number, max: number) => {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < min || x > max) fail();
  return x as number;
};

export function stagedStoragePath(itemId: string, sha256: string, mime: StagedUploadMime): string {
  if (!UUID.test(itemId) || !HASH.test(sha256) || !Object.hasOwn(EXTENSIONS, mime)) fail();
  return `sync-staged/${itemId}/${sha256}.${EXTENSIONS[mime]}`;
}
export function stagedPublicUrl(path: string): string {
  return STAGED_STORAGE_ORIGIN + PUBLIC_PREFIX + path;
}

/** The only accepted source: an upload made by the editor for exactly this card. Returns the storage path
 * (without the public prefix) or null. No query, fragment, port, credentials, encoded separators or other folder. */
export function stagedUploadPath(itemId: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || !UUID.test(itemId)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== STAGED_STORAGE_ORIGIN || url.username || url.password || url.port || url.search || url.hash ||
      /%/.test(url.pathname) || /[\s\\]/.test(value) || !url.pathname.startsWith(PUBLIC_PREFIX)) return null;
  const path = url.pathname.slice(PUBLIC_PREFIX.length);
  const match = /^items\/([a-f0-9-]{36})\/(cover|angles)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[A-Za-z0-9]{1,8}$/i.exec(path);
  return match && match[1].toLowerCase() === itemId.toLowerCase() && url.href === value ? path : null;
}

export function stagedRecord(input: unknown): StagedGalleryReviewRecord {
  const v = row(input);
  keys(v, ["version", "kind", "identity", "approvalId", "uploadPath", "stagedPath", "imageUrl", "decodedSha256", "mime", "width", "height",
    "byteLength", "note", "actorId", "reviewedAt", "reviewedExactSkuColor"]);
  if (v.version !== 1 || v.kind !== "staged_gallery_upload" || v.reviewedExactSkuColor !== true || !HASH.test(String(v.decodedSha256)) ||
      !UUID.test(String(v.actorId)) || !STAGED_UPLOAD_MIMES.includes(v.mime as StagedUploadMime) ||
      typeof v.reviewedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.reviewedAt) || !Number.isFinite(Date.parse(v.reviewedAt)) ||
      typeof v.note !== "string" || v.note.length > MAX_STAGED_NOTE || /[\u0000-\u001f\u007f]/.test(v.note) || v.note !== v.note.trim()) fail();
  const identity = reviewIdentity(v.identity);
  const mime = v.mime as StagedUploadMime;
  const sha = text(v.decodedSha256, 64);
  const uploadPath = text(v.uploadPath, 300);
  const stagedPath = stagedStoragePath(identity.itemId, sha, mime);
  if (stagedUploadPath(identity.itemId, stagedPublicUrl(uploadPath)) !== uploadPath || v.stagedPath !== stagedPath ||
      v.imageUrl !== stagedPublicUrl(stagedPath)) fail();
  return { version: 1, kind: "staged_gallery_upload", identity, approvalId: text(v.approvalId, 100), uploadPath, stagedPath,
    imageUrl: stagedPublicUrl(stagedPath), decodedSha256: sha, mime, width: integer(v.width, 1, 16000), height: integer(v.height, 1, 16000),
    byteLength: integer(v.byteLength, 1, MAX_STAGED_BYTES), note: v.note as string, actorId: text(v.actorId, 36),
    reviewedAt: text(v.reviewedAt, 24), reviewedExactSkuColor: true };
}

function secret(value: string) {
  if (typeof value !== "string" || value.length < 32) throw new Error("STAGED_MEDIA_SIGNING_UNAVAILABLE");
  return value;
}
export function signStagedReview(record: StagedGalleryReviewRecord, key: string): SignedStagedGalleryReview {
  const checked = stagedRecord(record);
  return { record: checked, signature: createHmac("sha256", secret(key)).update(DOMAIN + JSON.stringify(checked)).digest("hex") };
}
/** The native review signs a different domain string, so a record of one kind can never verify as the other. */
export function verifyStagedReview(input: unknown, key: string): StagedGalleryReviewRecord {
  const v = row(input);
  keys(v, ["record", "signature"]);
  if (!HASH.test(String(v.signature))) fail();
  const signed = signStagedReview(stagedRecord(v.record), key);
  if (!timingSafeEqual(Buffer.from(signed.signature, "hex"), Buffer.from(String(v.signature), "hex"))) fail();
  return signed.record;
}

export function stagedReviewPrefix(itemId: string): string {
  if (!UUID.test(itemId)) fail();
  return "staged-v1/" + itemId;
}
export function stagedReviewPath(record: StagedGalleryReviewRecord): string {
  const r = stagedRecord(record);
  return stagedReviewPrefix(r.identity.itemId) + "/" +
    createHash("sha256").update(JSON.stringify([r.identity, r.imageUrl, r.decodedSha256])).digest("hex") + ".json";
}

/** The guards compare entries by item, SKUs, product, variant, exact URL and decoded SHA-256. Nothing about the
 * upload path, filename, alt text or order is part of the approval. */
export function stagedReviewEntry(record: StagedGalleryReviewRecord): ReviewedMediaEntry {
  const r = stagedRecord(record), i = r.identity;
  return { sku: i.exactGallerySku, shopifySku: i.exactShopifySku, productId: i.productId, variantId: i.variantId,
    galleryId: i.itemId, imageUrl: r.imageUrl, sourceUrl: null, sourceImageSha256: null, decodedSha256: r.decodedSha256, evidence: r.note || "staged Gallery upload reviewed in the editor" };
}
