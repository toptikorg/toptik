import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MediaIdentity } from "./media-sync-core";
import type { ReviewedMediaEntry } from "./reviewed-media-guard";

export type MediaReviewRecord = {
  version: 1; identity: MediaIdentity; mediaId: string; imageUrl: string;
  decodedSha256: string; sourceUrl: string; evidence: string;
  actorId: string; reviewedAt: string; reviewedExactSkuColor: true;
};
export type SignedMediaReview = { record: MediaReviewRecord; signature: string };
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DOMAIN = "toptik:exact-product-media-review:v1\n";
const fail = (): never => { throw new Error("MEDIA_REVIEW_RECORD_INVALID"); };
const row = (x: unknown): Record<string, unknown> => !x || typeof x !== "object" || Array.isArray(x) ? fail() : x as Record<string, unknown>;
const keys = (x: Record<string, unknown>, expected: string[]) => {
  if (Object.keys(x).sort().join("|") !== expected.sort().join("|")) fail();
};
const text = (x: unknown, limit: number) => {
  if (typeof x !== "string" || !x.trim() || x !== x.trim() || x.length > limit || /[\u0000-\u001f\u007f]/.test(x)) fail();
  return x as string;
};
export function reviewIdentity(input: unknown): MediaIdentity {
  const v = row(input);
  keys(v, ["productId", "variantId", "itemId", "exactGallerySku", "exactShopifySku", "productHandle"]);
  if (!/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(String(v.productId)) ||
      !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(String(v.variantId)) || !UUID.test(String(v.itemId))) fail();
  return { productId: text(v.productId, 100), variantId: text(v.variantId, 100), itemId: text(v.itemId, 36),
    exactGallerySku: text(v.exactGallerySku, 255), exactShopifySku: text(v.exactShopifySku, 255), productHandle: text(v.productHandle, 255) };
}
function url(value: unknown, shopify = false) {
  const s = text(value, 2048);
  let u: URL; try { u = new URL(s); } catch { return fail(); }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || /[\s\\]/.test(s) ||
      (shopify && (u.origin !== "https://cdn.shopify.com" || !u.pathname.startsWith("/s/files/") || /%(?:2e|2f|5c)/i.test(u.pathname)))) fail();
  return s;
}
export function reviewRecord(input: unknown): MediaReviewRecord {
  const v = row(input);
  keys(v, ["version", "identity", "mediaId", "imageUrl", "decodedSha256", "sourceUrl", "evidence", "actorId", "reviewedAt", "reviewedExactSkuColor"]);
  if (v.version !== 1 || v.reviewedExactSkuColor !== true || !HASH.test(String(v.decodedSha256)) ||
      !/^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/.test(String(v.mediaId)) || !UUID.test(String(v.actorId)) ||
      typeof v.reviewedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.reviewedAt) || !Number.isFinite(Date.parse(v.reviewedAt))) fail();
  return { version: 1, identity: reviewIdentity(v.identity), mediaId: text(v.mediaId, 100), imageUrl: url(v.imageUrl, true),
    decodedSha256: text(v.decodedSha256, 64), sourceUrl: url(v.sourceUrl), evidence: text(v.evidence, 1000),
    actorId: text(v.actorId, 36), reviewedAt: text(v.reviewedAt, 24), reviewedExactSkuColor: true };
}
function secret(value: string) { if (typeof value !== "string" || value.length < 32) throw new Error("MEDIA_REVIEW_SIGNING_UNAVAILABLE"); return value; }
export function signMediaReview(record: MediaReviewRecord, key: string): SignedMediaReview {
  const checked = reviewRecord(record);
  return { record: checked, signature: createHmac("sha256", secret(key)).update(DOMAIN + JSON.stringify(checked)).digest("hex") };
}
export function verifyMediaReview(input: unknown, identity: MediaIdentity, key: string): MediaReviewRecord {
  const v = row(input); keys(v, ["record", "signature"]);
  if (!HASH.test(String(v.signature))) fail();
  const signed = signMediaReview(reviewRecord(v.record), key);
  if (!timingSafeEqual(Buffer.from(signed.signature, "hex"), Buffer.from(String(v.signature), "hex")) ||
      JSON.stringify(signed.record.identity) !== JSON.stringify(reviewIdentity(identity))) fail();
  return signed.record;
}
export function reviewPrefix(identity: MediaIdentity) {
  return "v1/" + reviewIdentity(identity).itemId;
}
export function reviewPath(record: MediaReviewRecord) {
  const r = reviewRecord(record);
  return reviewPrefix(r.identity) + "/" + createHash("sha256").update(JSON.stringify([r.identity, r.mediaId, r.imageUrl, r.decodedSha256])).digest("hex") + ".json";
}
export function reviewEntry(record: MediaReviewRecord): ReviewedMediaEntry {
  const r = reviewRecord(record), i = r.identity;
  return { sku: i.exactGallerySku, shopifySku: i.exactShopifySku, productId: i.productId, variantId: i.variantId,
    galleryId: i.itemId, imageUrl: r.imageUrl, sourceUrl: r.sourceUrl, sourceImageSha256: null,
    decodedSha256: r.decodedSha256, evidence: r.evidence };
}
