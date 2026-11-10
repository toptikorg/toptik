import "server-only";
import { configuredShopifyDomain, shopifyAdminGraphql } from "./admin-api";
import { verifyOnboardingImage } from "./onboarding-worker";
import { parseTransportMedia } from "./media-transport-read";
import { groupOwnedFilename, type GroupMediaPhaseRequest, type GroupOwnedMediaReceipt } from "./group-media-transport";

const FILE_FIELDS = "id fileStatus alt ... on MediaImage { mediaContentType status updatedAt image { id url width height } }";
export const GROUP_MEDIA_FILE_LOOKUP_QUERY = `query TopTikGroupOwnedFile($query: String!) { files(first: 2, query: $query) { nodes { ${FILE_FIELDS} } pageInfo { hasNextPage } } }`;
export const GROUP_MEDIA_FILE_NODE_QUERY = `query TopTikGroupOwnedFileNode($id: ID!) { node(id: $id) { ... on MediaImage { ${FILE_FIELDS} } } }`;
export const GROUP_MEDIA_JOB_QUERY = "query TopTikGroupMediaJob($id: ID!) { job(id: $id) { id done } }";
function fail(code: string): never { throw new Error(code); }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) fail("GROUP_MEDIA_RESPONSE_INVALID"); return v as Record<string, unknown>; }
function config() {
  if (configuredShopifyDomain() !== "toptikcoil.myshopify.com" || (process.env.SHOPIFY_API_VERSION?.trim() || "2026-07") !== "2026-07") fail("GROUP_MEDIA_CONFIG_MISMATCH");
}
async function query(query: string, variables: Record<string, unknown>, deadline: number) {
  config(); if (!Number.isFinite(deadline) || Date.now() >= deadline) fail("GROUP_MEDIA_TIME_BUDGET");
  const stop = Math.min(deadline, Date.now() + 10_000);
  const result = await shopifyAdminGraphql<unknown>(query, variables, stop - Date.now(), stop);
  if (Date.now() >= stop) fail("GROUP_MEDIA_TIME_BUDGET");
  return object(result);
}
/** Low-level transport. Call only after a durable one-shot begin permit; runtime re-reads the graph. */
export async function sendGroupMediaMutation(request: GroupMediaPhaseRequest, deadline: number): Promise<Record<string, unknown>> {
  if (request.readOnlyNoop) fail("GROUP_MEDIA_NOOP_EXECUTION_FORBIDDEN");
  if (process.env.VERCEL_ENV !== "production" || process.env.SHOPIFY_MEDIA_SYNC !== "enabled_v1") fail("GROUP_MEDIA_DISABLED");
  const data = await query(request.query, request.variables, deadline);
  const field = request.input.kind === "create_owned" ? "fileCreate" : request.input.kind === "reorder" ? "productReorderMedia" :
    request.input.kind === "variant_append" ? "productVariantAppendMedia" : request.input.kind === "variant_detach" ? "productVariantDetachMedia" :
      request.input.kind === "variant_cover" ? "productVariantsBulkUpdate" : "fileUpdate";
  const payload = object(data[field]), errors = payload[request.input.kind === "reorder" ? "mediaUserErrors" : "userErrors"];
  if (!Array.isArray(errors)) fail("GROUP_MEDIA_ACK_INVALID");
  if (errors.length) {
    const providerCodes = errors.map(error => error && typeof error === "object" && "code" in error ? String(error.code) : "")
      .filter(code => /^[A-Z][A-Z0-9_]{0,79}$/.test(code)).slice(0, 10);
    throw Object.assign(new Error("GROUP_MEDIA_WRITE_REJECTED"), { providerCodes });
  }
  if (request.input.kind === "reorder") {
    const job = object(payload.job); if (typeof job.id !== "string" || !/^gid:\/\/shopify\/Job\/[1-9]\d*$/.test(job.id)) fail("GROUP_MEDIA_ACK_INVALID");
    return { jobId: job.id };
  }
  if (request.input.kind === "create_owned" || request.input.kind === "product_attach" || request.input.kind === "product_detach") {
    if (!Array.isArray(payload.files) || payload.files.length !== 1) fail("GROUP_MEDIA_ACK_INVALID");
    const media = parseTransportMedia(payload.files[0]);
    const expected = request.input.kind === "product_attach" ? request.input.owned.media.mediaId : request.input.kind === "product_detach" ? request.input.mediaId : null;
    if (expected && media.mediaId !== expected) fail("GROUP_MEDIA_ACK_INVALID");
    return { mediaId: media.mediaId };
  }
  if (!Array.isArray(payload.productVariants) || payload.productVariants.length !== 1 || object(payload.productVariants[0]).id !== request.input.variantId) fail("GROUP_MEDIA_ACK_INVALID");
  return { variantId: request.input.variantId };
}
export async function readGroupMediaJob(jobId: string, deadline: number): Promise<boolean> {
  if (!/^gid:\/\/shopify\/Job\/[1-9]\d*$/.test(jobId)) fail("GROUP_MEDIA_ACK_INVALID");
  const job = object((await query(GROUP_MEDIA_JOB_QUERY, { id: jobId }, deadline)).job);
  if (job.id !== jobId || typeof job.done !== "boolean") fail("GROUP_MEDIA_ACK_INVALID");
  return job.done;
}
/** Find/decode a created file without another create. Recompression establishes private lineage,
 * not equality with the staged SHA. The complete source product is re-read after this download. */
export async function observeGroupOwnedFile(request: GroupMediaPhaseRequest, receiptId: string, deadline: number): Promise<GroupOwnedMediaReceipt | null> {
  if (request.input.kind !== "create_owned") fail("GROUP_MEDIA_PHASE_INVALID");
  const { source, alt } = request.input;
  const filename = groupOwnedFilename(request.operationId, request.phaseIndex, source.sha256, source.mime);
  const files = object((await query(GROUP_MEDIA_FILE_LOOKUP_QUERY, { query: `filename:${filename}` }, deadline)).files);
  if (!Array.isArray(files.nodes) || files.nodes.length > 2 || object(files.pageInfo).hasNextPage !== false) fail("GROUP_MEDIA_OWNED_FILE_AMBIGUOUS");
  const matches = files.nodes.map(parseTransportMedia).filter(m => m.image && new URL(m.image.url).pathname.split("/").at(-1) === filename);
  if (matches.length > 1) fail("GROUP_MEDIA_OWNED_FILE_AMBIGUOUS");
  if (!matches.length) return null;
  const media = matches[0];
  if (media.status !== "READY" || media.fileStatus !== "READY" || !media.image) return null;
  if ((media.alt ?? "") !== alt) fail("GROUP_MEDIA_OWNED_FILE_CHANGED");
  const decoded = await verifyOnboardingImage({ id: media.mediaId, alt: media.alt, mediaContentType: "IMAGE", status: "READY",
    image: { url: media.image.url, width: media.image.width, height: media.image.height, altText: media.alt } }, deadline);
  if (decoded.mediaGid !== media.mediaId || decoded.url !== media.image.url || decoded.width !== media.image.width || decoded.height !== media.image.height ||
      !/^[a-f0-9]{64}$/.test(decoded.sha256) || !Number.isSafeInteger(decoded.byteLength) || decoded.byteLength < 1 || decoded.byteLength > 8 * 1024 * 1024) fail("GROUP_MEDIA_DECODE_INVALID");
  const last = (await query(GROUP_MEDIA_FILE_NODE_QUERY, { id: media.mediaId }, deadline)).node;
  if (JSON.stringify(parseTransportMedia(last)) !== JSON.stringify(media)) fail("GROUP_MEDIA_OWNED_FILE_CHANGED");
  return { productGid: request.binding.productGid, itemId: source.itemId, operationId: request.operationId, createPhaseIndex: request.phaseIndex, filename, sourceSha256: source.sha256,
    mime: source.mime, receiptId, media, decodedSha256: decoded.sha256, decodedByteLength: decoded.byteLength };
}
