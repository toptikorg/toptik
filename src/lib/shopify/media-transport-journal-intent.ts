import type { MediaTransportRequest } from "./media-transport-requests";
import type { ShopifyMediaTransportRead } from "./media-transport-read";
import { assertMediaTransportRead } from "./media-transport-read";
import { createHash } from "node:crypto";

function fail(): never { throw new Error("MEDIA_TRANSPORT_INTENT_INVALID"); }
function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).length !== expected.length || expected.some(k => !Object.hasOwn(value, k))) fail();
}
function one(value: unknown) { if (!Array.isArray(value) || value.length !== 1) fail(); return object(value[0]); }

/** Exact RPC request schema. This is generated server-side from the deterministic builder. */
export function buildMediaJournalIntent(request: MediaTransportRequest, before: ShopifyMediaTransportRead, sourceEvidenceId?: string): Record<string, unknown> {
  assertMediaTransportRead(before, request.context.targetRevision);
  const { mutationSha256, ...body } = request;
  const identityKeys = ["productId", "variantId", "itemId", "exactGallerySku", "exactShopifySku", "productHandle"] as const;
  if (createHash("sha256").update(JSON.stringify(body)).digest("hex") !== mutationSha256 ||
      identityKeys.some(key => before.identity[key] !== request.context.identity[key])) fail();
  const v = request.variables;
  if (request.phase === "create_owned") {
    keys(v, ["files"]); const file = one(v.files);
    keys(file, ["contentType", "originalSource", "alt", "filename", "duplicateResolutionMode"]);
    if (file.contentType !== "IMAGE" || file.duplicateResolutionMode !== "RAISE_ERROR" || typeof sourceEvidenceId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(sourceEvidenceId)) fail();
    return { mutationSha256, sourceEvidenceId, filename: file.filename,
      duplicateResolutionMode: file.duplicateResolutionMode, stagedSourceUrl: file.originalSource };
  }
  if (request.phase === "associate" || request.phase === "detach_old" || request.phase === "detach_reference") {
    keys(v, ["files"]); const file = one(v.files), field = request.phase === "associate" ? "referencesToAdd" : "referencesToRemove";
    keys(file, ["id", field]);
    if (!Array.isArray(file[field]) || file[field].length !== 1 || file[field][0] !== before.identity.productId) fail();
    return { mutationSha256, productGid: before.identity.productId, mediaGid: file.id };
  }
  if (request.phase === "variant_reassign") {
    keys(v, ["productId", "variants"]); const variant = one(v.variants); keys(variant, ["id", "mediaId"]);
    if (v.productId !== before.identity.productId || variant.id !== before.identity.variantId) fail();
    return { mutationSha256, variantGid: variant.id, mediaGid: variant.mediaId };
  }
  if (request.phase === "reorder") {
    keys(v, ["id", "moves"]); if (v.id !== before.identity.productId || !Array.isArray(v.moves) || v.moves.length > 250) fail();
    const mediaGids = before.media.map(m => m.mediaId);
    for (const input of v.moves) {
      const move = object(input); keys(move, ["id", "newPosition"]);
      if (typeof move.id !== "string" || typeof move.newPosition !== "string" || !/^(0|[1-9]\d*)$/.test(move.newPosition)) fail();
      const index = mediaGids.indexOf(move.id), position = Number(move.newPosition);
      if (index < 0 || position >= mediaGids.length) fail();
      mediaGids.splice(index, 1); mediaGids.splice(position, 0, move.id);
    }
    return { mutationSha256, mediaGids };
  }
  return fail();
}

export function mediaJournalPhase(request: MediaTransportRequest) {
  return request.phase === "detach_reference" ? "detach_old" : request.phase;
}
