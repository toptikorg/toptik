import { MAX_EXISTING_MEDIA_PIXELS } from "./existing-media-limits";
import { createHash } from "node:crypto";
import type { MediaIdentity } from "./media-sync-core";
import { mediaSnapshotFingerprint } from "./media-sync-core";

export type MediaTransportStatus = "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
export type TransportImage = { id: string; url: string; width: number; height: number };
export type TransportMedia = {
  mediaId: string; mediaContentType: "IMAGE"; status: MediaTransportStatus;
  fileStatus: MediaTransportStatus; updatedAt: string; alt: string | null; image: TransportImage | null;
};
/** Staging evidence, not a logical MediaSnapshot: old and new platform IDs may coexist. */
export type ShopifyMediaTransportRead = {
  side: "shopify"; identity: MediaIdentity; complete: true; revision: string;
  updatedAt: string; media: TransportMedia[]; variantMediaIds: string[];
  variantImage: { id: string; url: string } | null;
};
export const MEDIA_STATUSES = ["UPLOADED", "PROCESSING", "READY", "FAILED"] as const;
function fail(code: string): never { throw new Error(code); }
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MEDIA_TRANSPORT_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function gid(value: unknown, type: string): value is string {
  return typeof value === "string" && new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`).test(value);
}
function iso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
export function isShopifyMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\\\s]/.test(value) || !value.startsWith("https://cdn.shopify.com/")) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.port && !url.hash && url.pathname.startsWith("/s/files/") && !/%(?:2f|5c|2e)/i.test(url.pathname);
  } catch { return false; }
}
export function assertMediaTransportIdentity(identity: MediaIdentity) {
  mediaSnapshotFingerprint({ identity, side: "shopify", revision: "transport-identity", complete: true, assets: [] });
}
function connection(value: unknown, max = 250) {
  const c = obj(value);
  if (!Array.isArray(c.nodes) || c.nodes.length > max || obj(c.pageInfo).hasNextPage !== false) fail("MEDIA_TRANSPORT_INCOMPLETE");
  return c.nodes.map(obj);
}
export function parseTransportMedia(input: unknown): TransportMedia {
  const value = obj(input);
  if (!gid(value.id, "MediaImage") || value.mediaContentType !== "IMAGE") fail("MEDIA_TRANSPORT_TYPE_UNSUPPORTED");
  if (!MEDIA_STATUSES.includes(value.status as MediaTransportStatus) || !MEDIA_STATUSES.includes(value.fileStatus as MediaTransportStatus) ||
      !iso(value.updatedAt) || !(value.alt === null || (typeof value.alt === "string" && value.alt.length <= 512 &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.alt)))) fail("MEDIA_TRANSPORT_ASSET_INVALID");
  let image: TransportImage | null = null;
  if (value.image !== null) {
    const i = obj(value.image);
    if ((!gid(i.id, "ImageSource") && !gid(i.id, "ProductImage")) || !isShopifyMediaUrl(i.url) ||
        !Number.isInteger(i.width) || !Number.isInteger(i.height) || Number(i.width) < 1 || Number(i.height) < 1 ||
        Number(i.width) > 16000 || Number(i.height) > 16000 || Number(i.width) * Number(i.height) > MAX_EXISTING_MEDIA_PIXELS) fail("MEDIA_TRANSPORT_IMAGE_INVALID");
    image = { id: i.id, url: i.url, width: Number(i.width), height: Number(i.height) };
  }
  if (value.status === "READY" && value.fileStatus === "READY" && image === null) fail("MEDIA_TRANSPORT_IMAGE_INVALID");
  return { mediaId: value.id, mediaContentType: "IMAGE", status: value.status as MediaTransportStatus,
    fileStatus: value.fileStatus as MediaTransportStatus, updatedAt: value.updatedAt, alt: value.alt as string | null, image };
}
function tuple(id: MediaIdentity) { return [id.productId, id.variantId, id.itemId, id.exactGallerySku, id.exactShopifySku, id.productHandle]; }
function fingerprint(value: Omit<ShopifyMediaTransportRead, "revision">) {
  return createHash("sha256").update(JSON.stringify({ side: value.side, identity: tuple(value.identity), complete: value.complete,
    updatedAt: value.updatedAt, media: value.media.map(m => [m.mediaId, m.mediaContentType, m.status, m.fileStatus, m.updatedAt, m.alt,
      m.image ? [m.image.id, m.image.url, m.image.width, m.image.height] : null]),
    variantMediaIds: value.variantMediaIds, variantImage: value.variantImage ? [value.variantImage.id, value.variantImage.url] : null })).digest("hex");
}

/** Uses the same complete GraphQL selection as buildMediaReadRequest; preserves pending media. */
export function parseMediaTransportResponse(input: unknown, identity: MediaIdentity): ShopifyMediaTransportRead {
  assertMediaTransportIdentity(identity);
  const response = obj(input);
  if (Object.hasOwn(response, "errors") && (!Array.isArray(response.errors) || response.errors.length)) fail("MEDIA_TRANSPORT_GRAPHQL_ERROR");
  const product = obj(obj(response.data).product);
  if (product.id !== identity.productId || product.handle !== identity.productHandle || product.status !== "ACTIVE" ||
      product.publishedOnPublication !== true || !iso(product.updatedAt)) fail("MEDIA_TRANSPORT_IDENTITY_CHANGED");
  const variants = connection(product.variants, 2);
  if (variants.length !== 1 || variants[0].id !== identity.variantId || variants[0].sku !== identity.exactShopifySku) fail("MEDIA_TRANSPORT_VARIANT_CHANGED");
  const media = connection(product.media).map(parseTransportMedia), count = obj(product.mediaCount);
  if (count.precision !== "EXACT" || count.count !== media.length) fail("MEDIA_TRANSPORT_INCOMPLETE");
  if (new Set(media.map(m => m.mediaId)).size !== media.length) fail("MEDIA_TRANSPORT_DUPLICATE_ID");
  const variantMediaIds = connection(variants[0].media).map(m => {
    if (!gid(m.id, "MediaImage") || !media.some(asset => asset.mediaId === m.id)) fail("MEDIA_TRANSPORT_VARIANT_INVALID");
    return m.id;
  });
  if (new Set(variantMediaIds).size !== variantMediaIds.length) fail("MEDIA_TRANSPORT_VARIANT_INVALID");
  let variantImage: { id: string; url: string } | null = null;
  if (variants[0].image !== null) {
    const image = obj(variants[0].image);
    if ((!gid(image.id, "ProductImage") && !gid(image.id, "ImageSource")) || !isShopifyMediaUrl(image.url) ||
        !media.some(m => variantMediaIds.includes(m.mediaId) && m.image?.url === image.url)) fail("MEDIA_TRANSPORT_VARIANT_INVALID");
    variantImage = { id: image.id, url: image.url };
  }
  const result = { side: "shopify" as const, identity: structuredClone(identity), complete: true as const,
    updatedAt: product.updatedAt, media, variantMediaIds, variantImage };
  return { ...result, revision: fingerprint(result) };
}

/** Re-parse private stored readbacks too: a hash is not a substitute for shape validation. */
export function assertMediaTransportRead(read: ShopifyMediaTransportRead, expectedRevision = read.revision): void {
  if (!read || read.side !== "shopify" || read.complete !== true || !Array.isArray(read.media) || !Array.isArray(read.variantMediaIds)) fail("MEDIA_TRANSPORT_READ_INVALID");
  const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false } });
  const parsed = parseMediaTransportResponse({ data: { product: {
    id: read.identity?.productId, handle: read.identity?.productHandle, status: "ACTIVE", publishedOnPublication: true,
    updatedAt: read.updatedAt, mediaCount: { count: read.media.length, precision: "EXACT" },
    media: connection(read.media.map(m => ({ ...m, id: m.mediaId }))),
    variants: connection([{ id: read.identity?.variantId, sku: read.identity?.exactShopifySku, image: read.variantImage,
      media: connection(read.variantMediaIds.map(id => ({ id }))) }]),
  } } }, read.identity);
  if (parsed.revision !== read.revision || parsed.revision !== expectedRevision) fail("MEDIA_TRANSPORT_READ_CHANGED");
}
