import { createHash } from "node:crypto";
import { MAX_EXISTING_MEDIA_PIXELS } from "./existing-media-limits";
import { parseTransportMedia, type TransportMedia } from "./media-transport-read";
import { assertGroupMediaBinding, assertGroupMediaReady, groupMediaFingerprint, type GroupMediaBinding, type GroupMediaSnapshot } from "./group-media-policy";

/** Resolved from a private, decoded, immutable upload receipt. Browser URL/JSON alone is not proof. */
export type GroupStagedMediaSource = { itemId: string; receiptId: string; sha256: string;
  mime: "image/jpeg" | "image/png" | "image/webp"; byteLength: number; width: number; height: number; url: string };
export type GroupOwnedMediaReceipt = { productGid: string; itemId: string; operationId: string; createPhaseIndex: number; filename: string; sourceSha256: string;
  mime: GroupStagedMediaSource["mime"]; receiptId: string; media: TransportMedia; decodedSha256: string; decodedByteLength: number };
export type GroupMediaPhaseInput =
  | { kind: "create_owned"; source: GroupStagedMediaSource; alt: string }
  | { kind: "product_attach"; owned: GroupOwnedMediaReceipt }
  | { kind: "variant_append"; variantId: string; mediaIds: string[] }
  | { kind: "variant_detach"; variantId: string; mediaIds: string[]; removalIntentId: string }
  | { kind: "variant_cover"; variantId: string; mediaId: string }
  | { kind: "product_detach"; mediaId: string; removalIntentId: string; protectedMediaIds: string[] }
  | { kind: "reorder"; mediaIds: string[]; protectedMediaIds: string[] };
export type GroupMediaPhaseRequest = { apiVersion: "2026-07"; operationId: string; phaseIndex: number;
  binding: GroupMediaBinding; beforeFingerprint: string; input: GroupMediaPhaseInput;
  query: string; variables: Record<string, unknown>; readOnlyNoop?: true; requestHash: string };
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MEDIA = /^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
const FILE_FIELDS = "id fileStatus alt ... on MediaImage { mediaContentType status updatedAt image { id url width height } }";
function fail(code: string): never { throw new Error(code); }
function timestampMicros(value: string): bigint | null {
  // Shopify DateTime is ISO 8601. Preserve fractions through PostgreSQL's
  // microsecond resolution instead of truncating a backward step with Date.parse.
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const wholeMillis = Date.parse(parts[1] + parts[3]);
  return Number.isFinite(wholeMillis) ? BigInt(wholeMillis) * BigInt(1000) + BigInt((parts[2] ?? "").padEnd(6, "0")) : null;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
function ids(values: string[], allowEmpty = false) {
  if (!Array.isArray(values) || (!allowEmpty && !values.length) || values.length > 250 || new Set(values).size !== values.length || values.some(id => !MEDIA.test(id))) fail("GROUP_MEDIA_PHASE_INVALID");
}
function sourceValid(source: GroupStagedMediaSource, binding: GroupMediaBinding) {
  if (!source || !binding.variants.some(v => v.itemId === source.itemId) || !UUID.test(source.receiptId) || !HASH.test(source.sha256) ||
      !Object.hasOwn(EXT, source.mime) || !Number.isSafeInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || source.width < 1 || source.height < 1 ||
      source.width > 16000 || source.height > 16000 || source.width * source.height > MAX_EXISTING_MEDIA_PIXELS ||
      source.url !== `https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/sync-owned/${source.itemId}/${source.sha256}.${EXT[source.mime]}`) fail("GROUP_MEDIA_STAGED_PROOF_REQUIRED");
}
export function groupOwnedFilename(operationId: string, phaseIndex: number, sha256: string, mime: GroupStagedMediaSource["mime"]) {
  if (!UUID.test(operationId) || !Number.isInteger(phaseIndex) || phaseIndex < 0 || phaseIndex > 1000 || !HASH.test(sha256) || !Object.hasOwn(EXT, mime)) fail("GROUP_MEDIA_PHASE_INVALID");
  return `toptik-group-${operationId.replaceAll("-", "")}-${phaseIndex}-${sha256.slice(0, 16)}.${EXT[mime]}`;
}
function assertOwned(owned: GroupOwnedMediaReceipt, operationId: string, binding: GroupMediaBinding) {
  if (!owned || owned.productGid !== binding.productGid || !binding.variants.some(v => v.itemId === owned.itemId) || owned.operationId !== operationId || !UUID.test(owned.receiptId) || !HASH.test(owned.decodedSha256) ||
      !Number.isSafeInteger(owned.decodedByteLength) || owned.decodedByteLength < 1 || owned.decodedByteLength > 8 * 1024 * 1024) fail("GROUP_MEDIA_OWNED_PROOF_REQUIRED");
  const media = parseTransportMedia({ ...owned.media, id: owned.media?.mediaId });
  if (media.status !== "READY" || media.fileStatus !== "READY" || !media.image ||
      owned.filename !== groupOwnedFilename(operationId, owned.createPhaseIndex, owned.sourceSha256, owned.mime) ||
      new URL(media.image.url).pathname.split("/").at(-1) !== owned.filename) fail("GROUP_MEDIA_OWNED_PROOF_REQUIRED");
}

/** Canonical request builder. Authorization, provenance and one-shot permits remain server/SQL owned. */
export function buildGroupMediaPhase(input: { operationId: string; phaseIndex: number; before: GroupMediaSnapshot; phase: GroupMediaPhaseInput }): GroupMediaPhaseRequest {
  const { operationId, phaseIndex, before, phase } = structuredClone(input);
  assertGroupMediaBinding(before.binding); assertGroupMediaReady(before);
  if (!UUID.test(operationId) || !Number.isInteger(phaseIndex) || phaseIndex < 0 || phaseIndex > 1000 ||
      before.fingerprint !== groupMediaFingerprint(before)) fail("GROUP_MEDIA_PHASE_INVALID");
  let query: string, variables: Record<string, unknown>, readOnlyNoop = false;
  if (phase.kind === "create_owned") {
    sourceValid(phase.source, before.binding);
    if (typeof phase.alt !== "string" || phase.alt.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(phase.alt)) fail("GROUP_MEDIA_ALT_INVALID");
    query = `mutation TopTikGroupCreateMedia($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { ${FILE_FIELDS} } userErrors { code field message } } }`;
    variables = { files: [{ contentType: "IMAGE", originalSource: phase.source.url, alt: phase.alt,
      filename: groupOwnedFilename(operationId, phaseIndex, phase.source.sha256, phase.source.mime), duplicateResolutionMode: "RAISE_ERROR" }] };
  } else if (phase.kind === "product_attach") {
    assertOwned(phase.owned, operationId, before.binding);
    if (before.media.length >= 250 || before.media.some(m => m.mediaId === phase.owned.media.mediaId)) fail("GROUP_MEDIA_ALREADY_ATTACHED");
    query = `mutation TopTikGroupAttachMedia($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { ${FILE_FIELDS} } userErrors { code field message } } }`;
    variables = { files: [{ id: phase.owned.media.mediaId, referencesToAdd: [before.binding.productGid] }] };
  } else if (phase.kind === "variant_append" || phase.kind === "variant_detach" || phase.kind === "variant_cover") {
    if (!before.binding.variants.some(v => v.variantGid === phase.variantId)) fail("GROUP_MEDIA_VARIANT_NOT_BOUND");
    const variant = before.variants.find(v => v.variantGid === phase.variantId);
    if (!variant) fail("GROUP_MEDIA_IDENTITY_CONFLICT");
    if (phase.kind === "variant_cover") {
      if (!before.media.some(m => m.mediaId === phase.mediaId && m.image)) fail("GROUP_MEDIA_COVER_NOT_ON_PRODUCT");
      readOnlyNoop = variant.image?.url === before.media.find(m => m.mediaId === phase.mediaId)?.image?.url;
      if (!readOnlyNoop && variant.mediaIds.length > 1) fail("GROUP_MEDIA_VARIANT_MEMBERSHIP_REVIEW");
      query = `mutation TopTikGroupVariantCover($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) { productVariants { id image { id url } } userErrors { code field message } } }`;
      variables = { productId: before.binding.productGid, variants: [{ id: phase.variantId, mediaId: phase.mediaId }] };
    } else {
      ids(phase.mediaIds);
      if (phase.mediaIds.some(id => !before.media.some(m => m.mediaId === id))) fail("GROUP_MEDIA_MEMBERSHIP_CHANGED");
      if (phase.kind === "variant_append" && phase.mediaIds.some(id => variant.mediaIds.includes(id))) fail("GROUP_MEDIA_ALREADY_ASSIGNED");
      if (phase.kind === "variant_append" && (phase.mediaIds.length !== 1 || variant.mediaIds.length !== 0)) fail("GROUP_MEDIA_VARIANT_SINGLE_IMAGE_REQUIRED");
      if (phase.kind === "variant_detach" && (!UUID.test(phase.removalIntentId) || phase.mediaIds.some(id => !variant.mediaIds.includes(id)) ||
          phase.mediaIds.some(id => before.media.find(m => m.mediaId === id)?.image?.url === variant.image?.url))) fail("GROUP_MEDIA_VARIANT_IMAGE_PROTECTED");
      const suffix = phase.kind === "variant_append" ? "Append" : "Detach";
      query = `mutation TopTikGroupVariant${suffix}($productId: ID!, $variantMedia: [ProductVariant${suffix}MediaInput!]!) { productVariant${suffix}Media(productId: $productId, variantMedia: $variantMedia) { productVariants { id } userErrors { code field message } } }`;
      variables = { productId: before.binding.productGid, variantMedia: [{ variantId: phase.variantId, mediaIds: phase.mediaIds }] };
    }
  } else if (phase.kind === "product_detach") {
    ids(phase.protectedMediaIds, true);
    const old = before.media.find(m => m.mediaId === phase.mediaId);
    if (!old || !UUID.test(phase.removalIntentId)) fail("GROUP_MEDIA_REMOVAL_INTENT_REQUIRED");
    if (before.media.length < 2 || phase.protectedMediaIds.includes(phase.mediaId) || before.variants.some(v => v.mediaIds.includes(phase.mediaId) || (old.image && v.image?.url === old.image.url))) fail("GROUP_MEDIA_REFERENCE_PROTECTED");
    query = `mutation TopTikGroupDetachMedia($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { ${FILE_FIELDS} } userErrors { code field message } } }`;
    variables = { files: [{ id: phase.mediaId, referencesToRemove: [before.binding.productGid] }] };
  } else if (phase.kind === "reorder") {
    ids(phase.mediaIds); ids(phase.protectedMediaIds, true);
    const current = before.media.map(m => m.mediaId);
    if (phase.mediaIds.length !== current.length || phase.mediaIds.some(id => !current.includes(id)) ||
        !same(current.filter(id => phase.protectedMediaIds.includes(id)), phase.mediaIds.filter(id => phase.protectedMediaIds.includes(id)))) fail("GROUP_MEDIA_ORDER_CONFLICT");
    const working = [...current], moves: { id: string; newPosition: string }[] = [];
    phase.mediaIds.forEach((id, position) => { const oldPosition = working.indexOf(id);
      if (oldPosition !== position) { moves.push({ id, newPosition: String(position) }); working.splice(oldPosition, 1); working.splice(position, 0, id); } });
    readOnlyNoop = !moves.length;
    query = `mutation TopTikGroupReorderMedia($id: ID!, $moves: [MoveInput!]!) { productReorderMedia(id: $id, moves: $moves) { job { id } mediaUserErrors { code field message } } }`;
    variables = { id: before.binding.productGid, moves };
  } else return fail("GROUP_MEDIA_PHASE_INVALID");
  const request = { apiVersion: "2026-07" as const, operationId, phaseIndex, binding: before.binding, beforeFingerprint: before.fingerprint, input: phase, query, variables,
    ...(readOnlyNoop ? { readOnlyNoop: true as const } : {}) };
  return { ...request, requestHash: createHash("sha256").update(stable(request)).digest("hex") };
}

/** Return verified only for this phase's complete native delta. An ack is never passed here. */
export function verifyGroupMediaPhase(request: GroupMediaPhaseRequest, before: GroupMediaSnapshot, observed: GroupMediaSnapshot): "verified" | "pending" | "review" {
  if (!same(buildGroupMediaPhase({ operationId: request.operationId, phaseIndex: request.phaseIndex, before, phase: request.input }), request) ||
      observed.fingerprint !== groupMediaFingerprint(observed) || !same(observed.binding, before.binding) ||
      !same({ ...observed.product, updatedAt: "" }, { ...before.product, updatedAt: "" })) return "review";
  if (request.readOnlyNoop) return observed.fingerprint === before.fingerprint ? "verified" : "review";
  if (observed.fingerprint === before.fingerprint) return "pending";
  const phase = request.input;
  if (phase.kind === "create_owned") return "review"; // Its product graph must remain unchanged; the file needs separate decoded proof.
  let expectedMedia = before.media;
  const expectedVariants = structuredClone(before.variants);
  if (phase.kind === "product_attach") {
    const added = observed.media.find(m => m.mediaId === phase.owned.media.mediaId);
    if (!added) return "review";
    if (added.status !== "READY" || added.fileStatus !== "READY") {
      return same(observed.media.filter(m => m.mediaId !== added.mediaId), before.media) && same(observed.variants, before.variants) ? "pending" : "review";
    }
    if (!same({ ...added, updatedAt: "" }, { ...phase.owned.media, updatedAt: "" })) return "review";
    expectedMedia = [...before.media, added];
  } else if (phase.kind === "product_detach") expectedMedia = before.media.filter(m => m.mediaId !== phase.mediaId);
  else if (phase.kind === "reorder") expectedMedia = phase.mediaIds.map(id => before.media.find(m => m.mediaId === id)!);
  else {
    const expected = expectedVariants.find(v => v.variantGid === phase.variantId)!;
    if (phase.kind === "variant_append") expected.mediaIds.push(...phase.mediaIds);
    if (phase.kind === "variant_detach") expected.mediaIds = expected.mediaIds.filter(id => !phase.mediaIds.includes(id));
    if (phase.kind === "variant_cover") {
      const image = before.media.find(m => m.mediaId === phase.mediaId)!.image!;
      const actual = observed.variants.find(v => v.variantGid === phase.variantId)?.image;
      if (!actual || actual.url !== image.url) return "review";
      expected.image = actual;
      // productVariantsBulkUpdate(mediaId) replaces the one native association.
      // The other per-color angles remain in the explicit private registry.
      expected.mediaIds = [phase.mediaId];
    }
  }
  if (phase.kind === "reorder") {
    // Shopify advances updatedAt on photos whose positions moved or shifted.
    // This is a phase-local comparison, not a weaker source fingerprint. Every
    // other field and every unchanged-position photo remain byte-for-byte strict.
    const oldPositions = new Map(before.media.map((media, position) => [media.mediaId, position]));
    const mediaMatch = expectedMedia.length === observed.media.length && expectedMedia.every((media, position) => {
      const actual = observed.media[position];
      if (!actual || media.mediaId !== actual.mediaId) return false;
      if (oldPositions.get(media.mediaId) === position) return same(media, actual);
      const oldTime = timestampMicros(media.updatedAt), actualTime = timestampMicros(actual.updatedAt);
      return oldTime !== null && actualTime !== null && actualTime >= oldTime &&
        same({ ...media, updatedAt: "" }, { ...actual, updatedAt: "" });
    });
    return mediaMatch && same(expectedVariants, observed.variants) ? "verified" : "review";
  }
  return same(expectedMedia, observed.media) && same(expectedVariants, observed.variants) ? "verified" : "review";
}
