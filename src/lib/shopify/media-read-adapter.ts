import { createHash } from "node:crypto";
import type { MediaIdentity, MediaSnapshot } from "./media-sync-core";
import { mediaSnapshotFingerprint } from "./media-sync-core";

export const MEDIA_API_VERSION = "2026-07";
export const MEDIA_PUBLICATION_ID = "gid://shopify/Publication/79538258170";
export type ShopifyMediaImage = {
  mediaId: string; imageId: string; url: string; width: number; height: number;
  alt: string | null; updatedAt: string; variantAssigned: boolean;
};
/** Complete associations, not decoded-image proof or permission to mutate a shared file. */
export type ShopifyMediaRead = {
  identity: MediaIdentity; updatedAt: string; images: ShopifyMediaImage[];
  variantMediaIds: string[]; variantImageId: string | null; variantImageUrl: string | null; fingerprint: string;
};
export type MediaDecodeReceipt = {
  identity: MediaIdentity; side: "shopify"; mediaId: string; imageId: string;
  url: string; width: number; height: number; platformUpdatedAt: string;
  decodedSha256: string; byteLength: number; mime: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  key: string; contentId: string; evidenceId: string;
  /** Required when Shopify recompression means content identity differs from decoded bytes. */
  importReceiptId?: string;
};
export type MediaReceiptResolver = (image: ShopifyMediaImage, identity: MediaIdentity) => MediaDecodeReceipt | null;

const HASH = /^[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function fail(code: string): never { throw new Error(code); }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("MEDIA_RESPONSE_INVALID");
  return input as Record<string, unknown>;
}
function gid(value: unknown, type: string): value is string {
  return typeof value === "string" && new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`).test(value);
}
function iso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function identityTuple(value: MediaIdentity) {
  return [value.productId, value.variantId, value.itemId, value.exactGallerySku, value.exactShopifySku, value.productHandle];
}
function validateIdentity(identity: MediaIdentity): void {
  // Reuse the reconciliation boundary without claiming any media was observed.
  mediaSnapshotFingerprint({ identity, side: "shopify", revision: "identity-validation", complete: true, assets: [] });
}
function connection(input: unknown, max = 250): Record<string, unknown>[] {
  const value = object(input);
  if (!Array.isArray(value.nodes) || value.nodes.length > max || object(value.pageInfo).hasNextPage !== false) fail("MEDIA_RESPONSE_INCOMPLETE");
  return value.nodes.map(object);
}
function imageUrl(input: unknown): input is string {
  if (typeof input !== "string" || input.length > 2048 || /[\\\s]/.test(input) || !input.startsWith("https://cdn.shopify.com/")) return false;
  try {
    const url = new URL(input);
    return !url.username && !url.password && !url.port && !url.hash && url.pathname.startsWith("/s/files/") &&
      !/%(?:2f|5c|2e)/i.test(url.pathname);
  } catch { return false; }
}
function parsedFingerprint(value: Omit<ShopifyMediaRead, "fingerprint">): string {
  return createHash("sha256").update(JSON.stringify({ identity: identityTuple(value.identity), updatedAt: value.updatedAt,
    images: value.images.map(i => [i.mediaId, i.imageId, i.url, i.width, i.height, i.alt, i.updatedAt, i.variantAssigned]),
    variantMediaIds: value.variantMediaIds, variantImageId: value.variantImageId, variantImageUrl: value.variantImageUrl })).digest("hex");
}

export function buildMediaReadRequest(identity: MediaIdentity) {
  validateIdentity(identity);
  return { apiVersion: MEDIA_API_VERSION, query: `query TopTikMediaRead($id: ID!, $publicationId: ID!) {
    product(id: $id) {
      id handle status updatedAt publishedOnPublication(publicationId: $publicationId)
      mediaCount { count precision }
      media(first: 250, sortKey: POSITION) {
        nodes { id mediaContentType status alt ... on MediaImage { fileStatus updatedAt image { id url width height } } }
        pageInfo { hasNextPage }
      }
      variants(first: 2) {
        nodes { id sku image { id url } media(first: 250) { nodes { id } pageInfo { hasNextPage } } }
        pageInfo { hasNextPage }
      }
    }
  }`, variables: { id: identity.productId, publicationId: MEDIA_PUBLICATION_ID } };
}

/** Fail closed on pagination/mixed media/processing and keep variant assignments for safe writes. */
export function parseMediaReadResponse(input: unknown, identity: MediaIdentity): ShopifyMediaRead {
  validateIdentity(identity);
  const response = object(input);
  if (Object.hasOwn(response, "errors") && (!Array.isArray(response.errors) || response.errors.length)) fail("MEDIA_GRAPHQL_ERROR");
  const product = object(object(response.data).product);
  if (product.id !== identity.productId || product.handle !== identity.productHandle || product.status !== "ACTIVE" ||
      product.publishedOnPublication !== true || !iso(product.updatedAt)) fail("MEDIA_IDENTITY_OR_PUBLICATION_CHANGED");
  const variants = connection(product.variants, 2);
  if (variants.length !== 1 || variants[0].id !== identity.variantId || variants[0].sku !== identity.exactShopifySku) fail("MEDIA_VARIANT_CHANGED");
  const media = connection(product.media), count = object(product.mediaCount);
  if (count.precision !== "EXACT" || count.count !== media.length) fail("MEDIA_RESPONSE_INCOMPLETE");
  const variantMediaIds = connection(variants[0].media).map(m => {
    if (!gid(m.id, "MediaImage")) fail("MEDIA_VARIANT_ASSOCIATION_INVALID");
    return m.id;
  });
  if (new Set(variantMediaIds).size !== variantMediaIds.length) fail("MEDIA_VARIANT_ASSOCIATION_INVALID");
  const variantImageId = variants[0].image === null ? null : object(variants[0].image).id;
  const variantImageUrl = variants[0].image === null ? null : object(variants[0].image).url;
  if (variantImageId !== null && ((!gid(variantImageId, "ProductImage") && !gid(variantImageId, "ImageSource")) ||
      !imageUrl(variantImageUrl))) fail("MEDIA_VARIANT_ASSOCIATION_INVALID");
  const images = media.map(m => {
    if (!gid(m.id, "MediaImage") || m.mediaContentType !== "IMAGE") fail("MEDIA_UNSUPPORTED_ASSET_TYPE");
    if (m.status !== "READY" || m.fileStatus !== "READY" || m.image === null) fail("MEDIA_ASSET_NOT_READY");
    if (!iso(m.updatedAt) || !(m.alt === null || (typeof m.alt === "string" && m.alt.length <= 512 &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(m.alt)))) fail("MEDIA_IMAGE_INVALID");
    const image = object(m.image);
    if ((!gid(image.id, "ImageSource") && !gid(image.id, "ProductImage")) || !imageUrl(image.url) || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
        Number(image.width) < 1 || Number(image.height) < 1 || Number(image.width) > 16000 || Number(image.height) > 16000 ||
        Number(image.width) * Number(image.height) > 16_000_000) fail("MEDIA_IMAGE_INVALID");
    return { mediaId: m.id, imageId: image.id, url: image.url, width: Number(image.width), height: Number(image.height),
      alt: m.alt, updatedAt: m.updatedAt, variantAssigned: variantMediaIds.includes(m.id) } as ShopifyMediaImage;
  });
  if (new Set(images.map(i => i.mediaId)).size !== images.length || new Set(images.map(i => i.imageId)).size !== images.length ||
      variantMediaIds.some(id => !images.some(i => i.mediaId === id)) ||
      (variantImageId !== null && !images.some(i => i.variantAssigned && i.url === variantImageUrl))) fail("MEDIA_VARIANT_ASSOCIATION_INVALID");
  // GraphQL MediaImage.image uses ImageSource; variant.image can use ProductImage.
  // Keep both opaque IDs. Never manufacture correspondence from their numeric suffix.
  const value = { identity: structuredClone(identity), updatedAt: product.updatedAt, images, variantMediaIds,
    variantImageId: variantImageId as string | null, variantImageUrl: variantImageUrl as string | null };
  return { ...value, fingerprint: parsedFingerprint(value) };
}

/** Only private, exact decoded-image receipts can establish cross-system keys/content. */
export function mediaReadToSnapshot(read: ShopifyMediaRead, resolve: MediaReceiptResolver): MediaSnapshot {
  validateIdentity(read.identity);
  if (parsedFingerprint(read) !== read.fingerprint) fail("MEDIA_READ_TAMPERED");
  const assets = read.images.map(image => {
    const receipt = resolve(structuredClone(image), structuredClone(read.identity));
    if (!receipt || !receipt.identity || JSON.stringify(identityTuple(receipt.identity)) !== JSON.stringify(identityTuple(read.identity)) ||
        receipt.side !== "shopify" || receipt.mediaId !== image.mediaId || receipt.imageId !== image.imageId || receipt.url !== image.url ||
        receipt.width !== image.width || receipt.height !== image.height || receipt.platformUpdatedAt !== image.updatedAt ||
        !HASH.test(receipt.decodedSha256) || !HASH.test(receipt.contentId) || !KEY.test(receipt.key) || !KEY.test(receipt.evidenceId) ||
        !Number.isInteger(receipt.byteLength) || receipt.byteLength < 1 || receipt.byteLength > 8 * 1024 * 1024 ||
        !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(receipt.mime) ||
        (receipt.contentId !== receipt.decodedSha256 && (typeof receipt.importReceiptId !== "string" || !KEY.test(receipt.importReceiptId)))) {
      fail("MEDIA_DECODE_PROVENANCE_REQUIRED");
    }
    return { key: receipt.key, contentId: receipt.contentId, alt: image.alt ?? "", evidenceId: receipt.evidenceId };
  });
  const snapshot: MediaSnapshot = { identity: structuredClone(read.identity), side: "shopify", complete: true,
    revision: read.fingerprint, assets };
  mediaSnapshotFingerprint(snapshot);
  return snapshot;
}
