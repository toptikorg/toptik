import { createHash } from "node:crypto";
import { parseTransportMedia, type TransportMedia } from "./media-transport-read";
import { MEDIA_API_VERSION, MEDIA_PUBLICATION_ID } from "./media-read-adapter";

/** All bound cards of this product. Unbound native variants remain in the observed graph, protected. */
export type GroupMediaBinding = { productGid: string; handle: string;
  variants: { itemId: string; variantGid: string; sku: string }[] };
export type GroupNativeVariant = { variantGid: string; sku: string; image: { id: string; url: string } | null; mediaIds: string[] };
export type GroupMediaSnapshot = { schemaVersion: 1; binding: GroupMediaBinding;
  product: { productGid: string; handle: string; status: "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED";
    publishedOnPublication: boolean; updatedAt: string };
  /** Complete global product order, not an invented per-color Shopify collection. */
  media: TransportMedia[]; variants: GroupNativeVariant[]; fingerprint: string };
const GID = (type: string) => new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
function fail(code: string): never { throw new Error(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("GROUP_MEDIA_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 255): string {
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) fail("GROUP_MEDIA_RESPONSE_INVALID");
  return value;
}
function complete(value: unknown): Record<string, unknown>[] {
  const connection = object(value);
  if (!Array.isArray(connection.nodes) || connection.nodes.length > 250 || object(connection.pageInfo).hasNextPage !== false) fail("GROUP_MEDIA_INCOMPLETE");
  return connection.nodes.map(object);
}
function unique(values: string[], code = "GROUP_MEDIA_IDENTITY_CONFLICT") { if (new Set(values).size !== values.length) fail(code); }
export function assertGroupMediaBinding(binding: GroupMediaBinding): void {
  if (!binding || !GID("Product").test(binding.productGid) || !binding.handle || binding.handle !== binding.handle.trim() ||
      binding.handle.length > 255 || CONTROL.test(binding.handle) || !Array.isArray(binding.variants) || !binding.variants.length || binding.variants.length > 250) fail("GROUP_MEDIA_BINDING_INVALID");
  for (const row of binding.variants) if (!row || !UUID.test(row.itemId) || !GID("ProductVariant").test(row.variantGid) ||
    !row.sku || row.sku !== row.sku.trim() || row.sku.length > 255 || CONTROL.test(row.sku)) fail("GROUP_MEDIA_BINDING_INVALID");
  unique(binding.variants.map(v => v.itemId)); unique(binding.variants.map(v => v.variantGid)); unique(binding.variants.map(v => v.sku));
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Copy/price-only product updatedAt drift is not a media edit. Every media/association field is. */
export function groupMediaFingerprint(snapshot: Omit<GroupMediaSnapshot, "fingerprint">): string {
  const p = snapshot.product;
  return createHash("sha256").update(stable({ schemaVersion: snapshot.schemaVersion, binding: snapshot.binding,
    product: { productGid: p.productGid, handle: p.handle, status: p.status, publishedOnPublication: p.publishedOnPublication },
    media: snapshot.media, variants: snapshot.variants })).digest("hex");
}
export function buildGroupMediaReadRequest(binding: GroupMediaBinding) {
  assertGroupMediaBinding(binding);
  return { apiVersion: MEDIA_API_VERSION, query: `query TopTikGroupMediaRead($id: ID!, $publicationId: ID!) {
    product(id: $id) { id handle status updatedAt publishedOnPublication(publicationId: $publicationId)
      mediaCount { count precision }
      media(first: 50, sortKey: POSITION) { nodes { id mediaContentType status alt
        ... on MediaImage { fileStatus updatedAt image { id url width height } } } pageInfo { hasNextPage endCursor } }
      variants(first: 10) { nodes { id sku image { id url }
        media(first: 20) { nodes { id } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } }
    }
  }`, variables: { id: binding.productGid, publicationId: MEDIA_PUBLICATION_ID } };
}
export function buildGroupMediaPageRequest(binding: GroupMediaBinding, kind: "media" | "variants", after: string) {
  assertGroupMediaBinding(binding);
  const selection = kind === "media" ? `media(first: 50, after: $after, sortKey: POSITION) { nodes { id mediaContentType status alt
      ... on MediaImage { fileStatus updatedAt image { id url width height } } } pageInfo { hasNextPage endCursor } }` :
    `variants(first: 10, after: $after) { nodes { id sku image { id url }
      media(first: 20) { nodes { id } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } }`;
  return { query: `query TopTikGroup${kind === "media" ? "Images" : "Variants"}Page($id: ID!, $after: String!) { product(id: $id) { id handle ${selection} } }`, variables: { id: binding.productGid, after } };
}
export const GROUP_VARIANT_MEDIA_PAGE_QUERY = `query TopTikGroupVariantMediaPage($id: ID!, $after: String!) {
  productVariant(id: $id) { id sku product { id handle } media(first: 50, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }
}`;
/** Keeps processing assets for uncertain-write recovery. Readiness is a separate mutation preflight. */
export function parseGroupMediaResponse(input: unknown, binding: GroupMediaBinding): GroupMediaSnapshot {
  assertGroupMediaBinding(binding);
  const response = object(input);
  if (Object.hasOwn(response, "errors") && (!Array.isArray(response.errors) || response.errors.length)) fail("GROUP_MEDIA_GRAPHQL_ERROR");
  const p = object(object(response.data).product), count = object(p.mediaCount);
  if (p.id !== binding.productGid || p.handle !== binding.handle || !["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"].includes(String(p.status)) ||
      typeof p.publishedOnPublication !== "boolean" || typeof p.updatedAt !== "string" || !Number.isFinite(Date.parse(p.updatedAt))) fail("GROUP_MEDIA_IDENTITY_CONFLICT");
  const rawMedia = complete(p.media);
  if (count.precision !== "EXACT" || count.count !== rawMedia.length) fail("GROUP_MEDIA_INCOMPLETE");
  const media = rawMedia.map(parseTransportMedia);
  unique(media.map(m => m.mediaId)); unique(media.flatMap(m => m.image ? [m.image.url] : []), "GROUP_MEDIA_AMBIGUOUS_IMAGE");
  const variants = complete(p.variants).map(v => {
    if (typeof v.id !== "string" || !GID("ProductVariant").test(v.id)) fail("GROUP_MEDIA_IDENTITY_CONFLICT");
    const mediaIds = complete(v.media).map(m => {
      if (typeof m.id !== "string" || !media.some(image => image.mediaId === m.id)) fail("GROUP_MEDIA_ASSOCIATION_INVALID");
      return m.id;
    });
    unique(mediaIds, "GROUP_MEDIA_ASSOCIATION_INVALID");
    let image: GroupNativeVariant["image"] = null;
    if (v.image !== null) {
      const raw = object(v.image);
      if (typeof raw.id !== "string" || (!GID("ProductImage").test(raw.id) && !GID("ImageSource").test(raw.id)) ||
          typeof raw.url !== "string" || media.filter(m => m.image?.url === raw.url).length !== 1) fail("GROUP_MEDIA_ASSOCIATION_INVALID");
      image = { id: raw.id, url: raw.url };
    }
    return { variantGid: v.id, sku: text(v.sku), image, mediaIds };
  });
  if (!variants.length) fail("GROUP_MEDIA_IDENTITY_CONFLICT");
  unique(variants.map(v => v.variantGid));
  for (const bound of binding.variants) {
    const native = variants.find(v => v.variantGid === bound.variantGid);
    if (!native || native.sku !== bound.sku || variants.filter(v => v.sku === bound.sku).length !== 1) fail("GROUP_MEDIA_IDENTITY_CONFLICT");
  }
  const graph: Omit<GroupMediaSnapshot, "fingerprint"> = { schemaVersion: 1, binding: structuredClone(binding),
    product: { productGid: binding.productGid, handle: binding.handle, status: p.status as GroupMediaSnapshot["product"]["status"],
      publishedOnPublication: p.publishedOnPublication, updatedAt: p.updatedAt }, media, variants };
  return { ...graph, fingerprint: groupMediaFingerprint(graph) };
}
export function assertGroupMediaReady(snapshot: GroupMediaSnapshot): void {
  if (snapshot.product.status !== "ACTIVE" || !snapshot.product.publishedOnPublication) fail("GROUP_MEDIA_SOURCE_UNPUBLISHED");
  if (!snapshot.media.length || snapshot.media.some(m => m.status !== "READY" || m.fileStatus !== "READY" || !m.image)) fail("GROUP_MEDIA_NOT_READY");
}
