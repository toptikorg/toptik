import "server-only";
import { shopifyAdminGraphql } from "./admin-api";
import { verifyOnboardingImage } from "./onboarding-worker";
import type { MediaIdentity } from "./media-sync-core";
import type { DecodedMediaImage } from "./media-decode-reader";
import { buildMediaReadRequest, parseMediaReadResponse, MEDIA_API_VERSION, MEDIA_PUBLICATION_ID, type ShopifyMediaRead } from "./media-read-adapter";
import { assertMediaTransportRead, parseMediaTransportResponse, parseTransportMedia, onlyForwardProductTimestampDrift, PRODUCT_TIMESTAMP_TOLERANT_PHASES,
  type ShopifyMediaTransportRead, type TransportMedia } from "./media-transport-read";
import { buildOwnedMediaCreate, buildOwnedMediaAssociate, buildMediaVariantReassign, buildMediaReferenceDetach,
  buildMediaReorder, buildOwnedMediaRecoveryRead, buildOwnedMediaNodeRead, ownedMediaFilename,
  parseOwnedMediaRecovery, parseMediaTransportAcknowledgement,
  type MediaTransportRequest, type MediaTransportContext, type StagedMediaSource, type OwnedMediaReceipt } from "./media-transport-requests";

/** Load these proofs from the private journal; neither HTTP bodies nor browser proofs are authority. */
export type ShopifyMediaExecutionEvidence = { before: ShopifyMediaTransportRead } & (
  { phase: "create_owned"; source: StagedMediaSource; alt: string } |
  { phase: "associate"; owned: OwnedMediaReceipt } |
  { phase: "variant_reassign"; owned: OwnedMediaReceipt; oldMediaId: string } |
  { phase: "detach_old" | "detach_reference"; oldMediaId: string } |
  { phase: "reorder"; desiredIds: string[] }
);
export type DecodedOwnedShopifyMedia = { filename: string; media: TransportMedia; decoded: DecodedMediaImage };

function fail(code: string): never { throw new Error(code); }
function checkDeadline(deadline: number) {
  if (!Number.isFinite(deadline)) fail("MEDIA_TIME_BUDGET_INVALID");
  if (Date.now() >= deadline) fail("MEDIA_TIME_BUDGET");
}
function config(mutation = false) {
  if (process.env.SHOPIFY_SHOP_DOMAIN?.trim().toLowerCase() !== "toptikcoil.myshopify.com" ||
      process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID?.trim() !== MEDIA_PUBLICATION_ID ||
      (process.env.SHOPIFY_API_VERSION?.trim() || MEDIA_API_VERSION) !== MEDIA_API_VERSION) fail("MEDIA_CONFIG_MISMATCH");
  if (mutation && (process.env.VERCEL_ENV !== "production" || process.env.SHOPIFY_MEDIA_SYNC !== "enabled_v1")) fail("MEDIA_DISABLED");
}
function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MEDIA_TRANSPORT_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}
function same(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
    return JSON.stringify(value);
  };
  return stable(a) === stable(b);
}

/** Shared transport validates HTTP/redirects and the WHOLE GraphQL envelope, then returns data.
 * It also rechecks this absolute deadline after OAuth; no mutation starts after token wait expiry.
 * Do not add retries here: a thrown mutation request is uncertain, even after HTTP failure. */
async function call(query: string, variables: Record<string, unknown>, deadline: number, mutation = false) {
  config(mutation); checkDeadline(deadline);
  const stopAt = Math.min(deadline, Date.now() + (mutation ? 15_000 : 8_000));
  const data = await shopifyAdminGraphql<unknown>(query, variables, stopAt - Date.now(), stopAt);
  checkDeadline(deadline);
  return { data: object(data) };
}

/** Keeps pending/failed associations; an incomplete list never means an image was removed. */
export async function readShopifyMediaTransport(identity: MediaIdentity, deadline: number): Promise<ShopifyMediaTransportRead> {
  const expected = structuredClone(identity), request = buildMediaReadRequest(expected);
  return parseMediaTransportResponse(await call(request.query, request.variables, deadline), expected);
}

/** A complete READY-only observation; pending media can never imply removal. */
export async function readReadyShopifyMedia(identity: MediaIdentity, deadline: number): Promise<ShopifyMediaRead> {
  const expected = structuredClone(identity), request = buildMediaReadRequest(expected);
  return parseMediaReadResponse(await call(request.query, request.variables, deadline), expected);
}

/** Rebuilds exact known mutation text AND variables. A matching caller-provided hash alone is insufficient. */
export function rebuildShopifyMediaMutation(request: MediaTransportRequest, evidence: ShopifyMediaExecutionEvidence): MediaTransportRequest {
  if (!request || !evidence || request.phase !== evidence.phase) fail("MEDIA_TRANSPORT_PROOF_PHASE_MISMATCH");
  assertMediaTransportRead(evidence.before, request.context.targetRevision);
  if (!same(evidence.before.identity, request.context.identity)) fail("MEDIA_TRANSPORT_IDENTITY_MISMATCH");
  const context = structuredClone(request.context);
  let rebuilt: MediaTransportRequest;
  switch (evidence.phase) {
    case "create_owned": rebuilt = buildOwnedMediaCreate(context, evidence.source, evidence.alt); break;
    case "associate": rebuilt = buildOwnedMediaAssociate(context, evidence.before, evidence.owned); break;
    case "variant_reassign": rebuilt = buildMediaVariantReassign(context, evidence.before, evidence.oldMediaId, evidence.owned); break;
    case "detach_old": case "detach_reference": rebuilt = buildMediaReferenceDetach(context, evidence.before, evidence.oldMediaId, evidence.phase); break;
    case "reorder": rebuilt = buildMediaReorder(context, evidence.before, evidence.desiredIds); break;
    default: return fail("MEDIA_TRANSPORT_PHASE_INVALID");
  }
  if (!same(request, rebuilt)) fail("MEDIA_TRANSPORT_REQUEST_NOT_CANONICAL");
  return rebuilt;
}

/** Call ONLY after the private SQL one-shot permit, under its still-owned product lease.
 * One external mutation maximum; acknowledgement is not proof of completed synchronization. */
export async function executeShopifyMediaTransport(request: MediaTransportRequest, evidence: ShopifyMediaExecutionEvidence,
  deadline: number): Promise<{ data: Record<string, unknown> }> {
  config(true); checkDeadline(deadline);
  const frozen = structuredClone(evidence), rebuilt = rebuildShopifyMediaMutation(structuredClone(request), frozen);
  const fresh = await readShopifyMediaTransport(rebuilt.context.identity, deadline);
  // Same single exception as the worker's post-begin recheck: a forward product updatedAt
  // bump only, and only for phases whose SQL readback ignores product updatedAt.
  if (fresh.revision !== frozen.before.revision && !(PRODUCT_TIMESTAMP_TOLERANT_PHASES.includes(rebuilt.phase) &&
      onlyForwardProductTimestampDrift(fresh, frozen.before))) fail("MEDIA_TRANSPORT_CHANGED_BEFORE_CALL");
  config(true); checkDeadline(deadline);
  const envelope = await call(rebuilt.query, rebuilt.variables, deadline, true);
  parseMediaTransportAcknowledgement(envelope, rebuilt);
  return envelope;
}

/** Absence/pending is a recovery result, NEVER permission to repeat fileCreate. */
export async function findOwnedShopifyMedia(context: MediaTransportContext, sourceSha256: string,
  mime: StagedMediaSource["mime"], deadline: number): Promise<TransportMedia | null> {
  const request = buildOwnedMediaRecoveryRead(structuredClone(context), sourceSha256, mime);
  return parseOwnedMediaRecovery(await call(request.query, request.variables, deadline), request.filename);
}

export async function readOwnedShopifyMediaNode(mediaGid: string, deadline: number): Promise<TransportMedia | null> {
  const request = buildOwnedMediaNodeRead(mediaGid), envelope = await call(request.query, request.variables, deadline);
  if (!Object.hasOwn(envelope.data, "node")) fail("MEDIA_TRANSPORT_RESPONSE_INVALID");
  if (envelope.data.node === null) return null;
  const media = parseTransportMedia(envelope.data.node);
  if (media.mediaId !== mediaGid) fail("MEDIA_TRANSPORT_MEDIA_ID_CHANGED");
  return media;
}

/** Reuses the existing real DNS/public-host/8MiB/sharp verifier unchanged. No transformed URLs.
 * Filename + decoded bytes are observations; private source lineage still authorizes ownership.
 * Shopify may recompress: decoded.sha256 must NOT be equated with the staged source hash. */
export async function readDecodedOwnedShopifyMedia(context: MediaTransportContext, sourceSha256: string,
  mime: StagedMediaSource["mime"], mediaGid: string | null, deadline: number): Promise<DecodedOwnedShopifyMedia | null> {
  config(); checkDeadline(deadline);
  const filename = ownedMediaFilename(context, sourceSha256, mime);
  const first = mediaGid === null ? await findOwnedShopifyMedia(context, sourceSha256, mime, deadline) :
    await readOwnedShopifyMediaNode(mediaGid, deadline);
  if (!first) return null;
  if (first.status !== "READY" || first.fileStatus !== "READY" || !first.image) fail("MEDIA_TRANSPORT_NOT_READY");
  if (new URL(first.image.url).pathname.split("/").at(-1) !== filename) fail("MEDIA_TRANSPORT_RECOVERY_FILENAME_MISMATCH");
  checkDeadline(deadline);
  const decoded = await verifyOnboardingImage({ id: first.mediaId, alt: first.alt, mediaContentType: "IMAGE", status: "READY",
    image: { url: first.image.url, width: first.image.width, height: first.image.height, altText: first.alt } }, deadline);
  checkDeadline(deadline);
  if (decoded.mediaGid !== first.mediaId || decoded.url !== first.image.url || decoded.width !== first.image.width || decoded.height !== first.image.height ||
      !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(decoded.mime) || !/^[a-f0-9]{64}$/.test(decoded.sha256) ||
      !Number.isInteger(decoded.byteLength) || decoded.byteLength < 1 || decoded.byteLength > 8 * 1024 * 1024) fail("MEDIA_DECODE_EVIDENCE_INVALID");
  const last = await readOwnedShopifyMediaNode(first.mediaId, deadline);
  if (!same(first, last)) fail("MEDIA_CHANGED_DURING_DECODE");
  return { filename, media: first, decoded };
}
