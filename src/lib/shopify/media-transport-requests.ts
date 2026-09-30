import { createHash } from "node:crypto";
import type { MediaIdentity } from "./media-sync-core";
import type { ShopifyMediaTransportRead, TransportMedia } from "./media-transport-read";
import { assertMediaTransportIdentity, assertMediaTransportRead, parseTransportMedia } from "./media-transport-read";

export type MediaTransportContext = {
  /** step is the stable logical asset step, not the individual HTTP phase number. */
  identity: MediaIdentity; operationId: string; step: number; sourceFingerprint: string; targetRevision: string;
};
export type MediaTransportRequest = {
  apiVersion: "2026-07"; phase: "create_owned" | "associate" | "variant_reassign" | "detach_old" | "detach_reference" | "reorder";
  context: MediaTransportContext; query: string; variables: Record<string, unknown>; mutationSha256: string;
};
/** Trusted private upload/decode receipt. Never construct from browser supplied proof fields. */
export type StagedMediaSource = {
  identity: MediaIdentity; contentSha256: string; mime: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  byteLength: number; width: number; height: number; url: string; receiptId: string;
};
/** Created-file receipt and subsequent READY/decode evidence are persisted before association. */
export type OwnedMediaReceipt = {
  identity: MediaIdentity; operationId: string; step: number; sourceFingerprint: string;
  filename: string; sourceSha256: string; mime: StagedMediaSource["mime"]; alt: string;
  media: TransportMedia; decodedSha256: string; decodedByteLength: number; receiptId: string;
};
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" } as const;
function fail(code: string): never { throw new Error(code); }
function tuple(id: MediaIdentity) { return [id.productId, id.variantId, id.itemId, id.exactGallerySku, id.exactShopifySku, id.productHandle]; }
function sameIdentity(a: MediaIdentity, b: MediaIdentity) {
  assertMediaTransportIdentity(a); assertMediaTransportIdentity(b);
  if (JSON.stringify(tuple(a)) !== JSON.stringify(tuple(b))) fail("MEDIA_TRANSPORT_IDENTITY_MISMATCH");
}
function contextValid(context: MediaTransportContext) {
  assertMediaTransportIdentity(context.identity);
  if (!UUID.test(context.operationId) || !Number.isInteger(context.step) || context.step < 0 || context.step > 1000 ||
      !HASH.test(context.sourceFingerprint) || !HASH.test(context.targetRevision)) fail("MEDIA_TRANSPORT_CONTEXT_INVALID");
}
function altValid(alt: string) {
  if (typeof alt !== "string" || alt.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(alt)) fail("MEDIA_TRANSPORT_ALT_INVALID");
}
function validBytes(count: number) { return Number.isInteger(count) && count > 0 && count <= 8 * 1024 * 1024; }
function extension(mime: StagedMediaSource["mime"]) {
  if (!Object.hasOwn(EXTENSIONS, mime)) fail("MEDIA_TRANSPORT_MIME_INVALID");
  return EXTENSIONS[mime];
}
export function ownedMediaFilename(context: MediaTransportContext, sha256: string, mime: StagedMediaSource["mime"]) {
  contextValid(context);
  if (!HASH.test(sha256)) fail("MEDIA_TRANSPORT_DIGEST_INVALID");
  return `toptik-sync-${context.operationId.replaceAll("-", "")}-${context.step}-${sha256.slice(0, 16)}.${extension(mime)}`;
}
export function stagedMediaUrl(identity: MediaIdentity, sha256: string, mime: StagedMediaSource["mime"]) {
  assertMediaTransportIdentity(identity);
  if (!HASH.test(sha256)) fail("MEDIA_TRANSPORT_DIGEST_INVALID");
  return `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/sync-media/${identity.itemId}/${sha256}.${extension(mime)}`;
}
function makeRequest(context: MediaTransportContext, phase: MediaTransportRequest["phase"], query: string, variables: Record<string, unknown>): MediaTransportRequest {
  contextValid(context);
  const request = { apiVersion: "2026-07" as const, phase, context: structuredClone(context), query, variables: structuredClone(variables) };
  return { ...request, mutationSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex") };
}
function fresh(context: MediaTransportContext, read: ShopifyMediaTransportRead) {
  contextValid(context); sameIdentity(context.identity, read.identity); assertMediaTransportRead(read, context.targetRevision);
}
function ready(media: TransportMedia) {
  parseTransportMedia({ ...media, id: media.mediaId });
  if (media.status !== "READY" || media.fileStatus !== "READY" || !media.image) fail("MEDIA_TRANSPORT_NOT_READY");
}
function owned(context: MediaTransportContext, receipt: OwnedMediaReceipt) {
  contextValid(context); sameIdentity(context.identity, receipt.identity); ready(receipt.media); altValid(receipt.alt);
  if (receipt.operationId !== context.operationId || receipt.step !== context.step || receipt.sourceFingerprint !== context.sourceFingerprint ||
      receipt.filename !== ownedMediaFilename(context, receipt.sourceSha256, receipt.mime) || !HASH.test(receipt.decodedSha256) ||
      !validBytes(receipt.decodedByteLength) || !KEY.test(receipt.receiptId) || (receipt.media.alt ?? "") !== receipt.alt ||
      new URL(receipt.media.image!.url).pathname.split("/").at(-1) !== receipt.filename) fail("MEDIA_TRANSPORT_OWNERSHIP_REQUIRED");
}
const FILE_FIELDS = "id fileStatus alt ... on MediaImage { mediaContentType status updatedAt image { id url width height } }";

/** Pure request construction is not execution authority. Persist a one-shot SQL permit first. */
export function buildOwnedMediaCreate(context: MediaTransportContext, source: StagedMediaSource, alt: string): MediaTransportRequest {
  contextValid(context); sameIdentity(context.identity, source.identity); altValid(alt);
  if (!KEY.test(source.receiptId) || !validBytes(source.byteLength) || !Number.isInteger(source.width) || !Number.isInteger(source.height) ||
      source.width < 1 || source.height < 1 || source.width > 16000 || source.height > 16000 || source.width * source.height > 16_000_000 ||
      source.url !== stagedMediaUrl(context.identity, source.contentSha256, source.mime)) fail("MEDIA_TRANSPORT_STAGED_SOURCE_REQUIRED");
  return makeRequest(context, "create_owned", `mutation TopTikCreateOwnedMedia($files: [FileCreateInput!]!) {
    fileCreate(files: $files) { files { ${FILE_FIELDS} } userErrors { code field message } }
  }`, { files: [{ contentType: "IMAGE", originalSource: source.url, alt,
    filename: ownedMediaFilename(context, source.contentSha256, source.mime), duplicateResolutionMode: "RAISE_ERROR" }] });
}

export function buildOwnedMediaAssociate(context: MediaTransportContext, read: ShopifyMediaTransportRead, receipt: OwnedMediaReceipt) {
  fresh(context, read); owned(context, receipt);
  if (read.media.length >= 250 || read.media.some(m => m.mediaId === receipt.media.mediaId)) fail("MEDIA_TRANSPORT_ALREADY_ASSOCIATED_OR_FULL");
  return makeRequest(context, "associate", `mutation TopTikAssociateOwnedMedia($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) { files { ${FILE_FIELDS} } userErrors { code field message } }
  }`, { files: [{ id: receipt.media.mediaId, referencesToAdd: [context.identity.productId] }] });
}

export function buildMediaVariantReassign(context: MediaTransportContext, read: ShopifyMediaTransportRead, oldMediaId: string, receipt: OwnedMediaReceipt) {
  fresh(context, read); owned(context, receipt);
  const replacement = read.media.find(m => m.mediaId === receipt.media.mediaId);
  if (!replacement || JSON.stringify(replacement) !== JSON.stringify(receipt.media) ||
      read.variantMediaIds.length !== 1 || read.variantMediaIds[0] !== oldMediaId || !read.variantImage ||
      !read.media.some(m => m.mediaId === oldMediaId && m.image?.url === read.variantImage!.url)) fail("MEDIA_TRANSPORT_VARIANT_REASSIGN_CONFLICT");
  return makeRequest(context, "variant_reassign", `mutation TopTikReassignVariantMedia($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
      productVariants { id image { id url } } userErrors { code field message }
    }
  }`, { productId: context.identity.productId, variants: [{ id: context.identity.variantId, mediaId: receipt.media.mediaId }] });
}

/** Association removal only. Global fileDelete and shared-file content/alt updates are absent. */
export function buildMediaReferenceDetach(context: MediaTransportContext, read: ShopifyMediaTransportRead, oldMediaId: string,
  phase: "detach_old" | "detach_reference") {
  fresh(context, read);
  const old = read.media.find(m => m.mediaId === oldMediaId);
  if (!old) fail("MEDIA_TRANSPORT_DETACH_ABSENT");
  ready(old);
  if (!read.media.some(m => m.mediaId !== oldMediaId && m.status === "READY" && m.fileStatus === "READY" && m.image)) fail("MEDIA_TRANSPORT_LAST_IMAGE_PROTECTED");
  if (read.variantMediaIds.includes(oldMediaId) || (old.image && old.image.url === read.variantImage?.url)) fail("MEDIA_TRANSPORT_VARIANT_IMAGE_PROTECTED");
  if (phase !== "detach_old" && phase !== "detach_reference") fail("MEDIA_TRANSPORT_PHASE_INVALID");
  return makeRequest(context, phase, `mutation TopTikDetachProductMedia($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) { files { ${FILE_FIELDS} } userErrors { code field message } }
  }`, { files: [{ id: oldMediaId, referencesToRemove: [context.identity.productId] }] });
}

export function buildMediaReorder(context: MediaTransportContext, read: ShopifyMediaTransportRead, desiredIds: string[], allowReadOnlyNoop = false) {
  fresh(context, read); read.media.forEach(ready);
  const current = read.media.map(m => m.mediaId);
  if (!Array.isArray(desiredIds) || desiredIds.length !== current.length || new Set(desiredIds).size !== desiredIds.length ||
      desiredIds.some(id => !current.includes(id))) fail("MEDIA_TRANSPORT_REORDER_MEMBERSHIP_CHANGED");
  const working = [...current], moves: { id: string; newPosition: string }[] = [];
  desiredIds.forEach((id, position) => {
    const index = working.indexOf(id);
    if (index !== position) { moves.push({ id, newPosition: String(position) }); working.splice(index, 1); working.splice(position, 0, id); }
  });
  // Empty moves are ONLY a proposal for SQL's verifiedNoop readback path, never an outbound mutation.
  if (!moves.length && !allowReadOnlyNoop) fail("MEDIA_TRANSPORT_NOOP");
  return makeRequest(context, "reorder", `mutation TopTikReorderProductMedia($id: ID!, $moves: [MoveInput!]!) {
    productReorderMedia(id: $id, moves: $moves) { job { id } mediaUserErrors { code field message } }
  }`, { id: context.identity.productId, moves });
}

/** A lost create response permits lookup only, never a second create. Search results need decode and private provenance. */
export function buildOwnedMediaRecoveryRead(context: MediaTransportContext, sha256: string, mime: StagedMediaSource["mime"]) {
  const filename = ownedMediaFilename(context, sha256, mime);
  return { apiVersion: "2026-07", query: `query TopTikRecoverOwnedMedia($query: String!) {
    files(first: 2, query: $query) { nodes { ${FILE_FIELDS} } pageInfo { hasNextPage } }
  }`, variables: { query: `filename:"${filename}"` }, filename };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MEDIA_TRANSPORT_ACK_INVALID");
  return value as Record<string, unknown>;
}
function data(input: unknown) {
  const response = object(input);
  if (Object.hasOwn(response, "errors") && (!Array.isArray(response.errors) || response.errors.length)) fail("MEDIA_TRANSPORT_GRAPHQL_ERROR");
  return object(response.data);
}
/** Pending file recovery candidates are not ownership/bytes proof and cannot authorize association. */
export function parseOwnedMediaRecovery(input: unknown, expectedFilename: string): TransportMedia | null {
  if (!/^toptik-sync-[a-f0-9]{32}-\d{1,4}-[a-f0-9]{16}\.(jpg|png|webp|avif)$/.test(expectedFilename)) fail("MEDIA_TRANSPORT_FILENAME_INVALID");
  const files = object(data(input).files);
  if (!Array.isArray(files.nodes) || files.nodes.length > 1 || object(files.pageInfo).hasNextPage !== false) fail("MEDIA_TRANSPORT_RECOVERY_AMBIGUOUS");
  if (files.nodes.length === 0) return null; // Absence is not permission to retry fileCreate.
  const media = parseTransportMedia(files.nodes[0]);
  // Pending processing can omit image/filename. Hold and read again; don't claim this result.
  if (!media.image) fail("MEDIA_TRANSPORT_RECOVERY_PENDING");
  if (new URL(media.image.url).pathname.split("/").at(-1) !== expectedFilename) fail("MEDIA_TRANSPORT_RECOVERY_FILENAME_MISMATCH");
  return media;
}

export function buildOwnedMediaNodeRead(mediaId: string) {
  if (!/^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/.test(mediaId)) fail("MEDIA_TRANSPORT_MEDIA_ID_INVALID");
  return { apiVersion: "2026-07", query: `query TopTikReadOwnedMedia($id: ID!) {
    node(id: $id) { ... on MediaImage { id mediaContentType status fileStatus alt updatedAt image { id url width height } } }
  }`, variables: { id: mediaId } };
}

/** Only acknowledgement: every phase still needs complete readback and private journal acceptance. */
export function parseMediaTransportAcknowledgement(input: unknown, request: MediaTransportRequest): { media?: TransportMedia; jobId?: string; variantId?: string } {
  const recomputed = makeRequest(request.context, request.phase, request.query, request.variables);
  if (request.apiVersion !== "2026-07" || request.mutationSha256 !== recomputed.mutationSha256) fail("MEDIA_TRANSPORT_REQUEST_CHANGED");
  const root = data(input), key = request.phase === "create_owned" ? "fileCreate" : request.phase === "reorder" ? "productReorderMedia" :
    request.phase === "variant_reassign" ? "productVariantsBulkUpdate" : "fileUpdate";
  const payload = object(root[key]), errors = payload[request.phase === "reorder" ? "mediaUserErrors" : "userErrors"];
  if (!Array.isArray(errors) || errors.length) fail("MEDIA_TRANSPORT_MUTATION_UNCONFIRMED");
  if (request.phase === "reorder") {
    const jobId = object(payload.job).id;
    if (typeof jobId !== "string" || !/^gid:\/\/shopify\/Job\/[A-Za-z0-9-]{1,100}$/.test(jobId)) fail("MEDIA_TRANSPORT_ACK_INVALID");
    return { jobId }; // Async job acceptance is not a completed order update.
  }
  if (request.phase === "variant_reassign") {
    if (!Array.isArray(payload.productVariants) || payload.productVariants.length !== 1 ||
        object(payload.productVariants[0]).id !== request.context.identity.variantId) fail("MEDIA_TRANSPORT_ACK_INVALID");
    return { variantId: request.context.identity.variantId };
  }
  if (!Array.isArray(payload.files) || payload.files.length !== 1) fail("MEDIA_TRANSPORT_ACK_INVALID");
  const media = parseTransportMedia(payload.files[0]);
  if (request.phase !== "create_owned" && media.mediaId !== object((request.variables.files as unknown[])[0]).id) fail("MEDIA_TRANSPORT_ACK_INVALID");
  return { media };
}
