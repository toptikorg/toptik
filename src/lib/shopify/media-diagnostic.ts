import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { fetchShopifyMediaRead } from "./admin-api";
import { VERIFIED_COPY_COLUMNS } from "./copy-eligibility";
import { assertVerifiedCopyApproval, type VerifiedCopyEligibility } from "./sync-rules";
import { reviewIdentity } from "./reviewed-media-record";
import { assertNotDeniedMedia } from "./reviewed-media-guard";
import { isShopifyOwnedVariant } from "./variant-source-policy";
import { captureMediaSourceBytes } from "./media-source-bytes";
import { readMediaStatus } from "./media-status";
import type { MediaIdentity } from "./media-sync-core";

export type MediaDiagnosticInput = { itemId: string; mediaId: string };
type Db = Pick<SupabaseClient, "from">;
type Dependencies = { now?: () => number; readNative?: typeof fetchShopifyMediaRead;
  capture?: typeof captureMediaSourceBytes; deny?: typeof assertNotDeniedMedia; status?: typeof readMediaStatus };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MEDIA_ID = /^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/;
function fail(code: string): never { throw new Error(code); }

/** No URL, product identity, proof or expected checksum is accepted from the caller. */
export function parseMediaDiagnosticInput(input: unknown): MediaDiagnosticInput {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join("|") !== "itemId|mediaId") fail("MEDIA_DIAGNOSTIC_INPUT_INVALID");
  const value = input as Record<string, unknown>;
  if (typeof value.itemId !== "string" || !UUID.test(value.itemId) ||
      typeof value.mediaId !== "string" || value.mediaId.length > 100 || !MEDIA_ID.test(value.mediaId)) fail("MEDIA_DIAGNOSTIC_INPUT_INVALID");
  return { itemId: value.itemId.toLowerCase(), mediaId: value.mediaId };
}

/** All methods used here are bounded SELECTs. No lease, private journal or media workflow is opened. */
async function readBinding(db: Db, itemId: string, deadline: number, now: () => number, readStatus: typeof readMediaStatus) {
  const signal = () => {
    const remaining = deadline - now();
    if (!Number.isFinite(deadline) || remaining <= 0) fail("MEDIA_DIAGNOSTIC_TIME_BUDGET");
    return AbortSignal.timeout(Math.min(5000, remaining));
  };
  const approved = await db.from("shopify_gallery_copy_eligibility").select(VERIFIED_COPY_COLUMNS)
    .eq("carousel_item_id", itemId).limit(2).abortSignal(signal());
  if (now() >= deadline) fail("MEDIA_DIAGNOSTIC_TIME_BUDGET");
  if (approved.error) fail("MEDIA_DIAGNOSTIC_BINDING_READ_FAILED");
  if (!Array.isArray(approved.data) || approved.data.length !== 1) fail("MEDIA_DIAGNOSTIC_NOT_ELIGIBLE");
  const approval = approved.data[0] as VerifiedCopyEligibility;
  try { assertVerifiedCopyApproval(approval); } catch { fail("MEDIA_DIAGNOSTIC_NOT_ELIGIBLE"); }
  let identity: MediaIdentity;
  try { identity = reviewIdentity({ productId: approval.product_gid, variantId: approval.variant_gid, itemId: approval.carousel_item_id,
    exactGallerySku: approval.exact_gallery_sku, exactShopifySku: approval.exact_shopify_sku, productHandle: approval.approved_product_handle }); }
  catch { fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED"); }
  if (identity.itemId !== itemId) fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED");
  const bindings = await db.from("shopify_gallery_bindings")
    .select("catalog_key,carousel_item_id,product_gid,variant_gid,product_handle,is_published")
    .eq("product_gid", identity.productId).limit(2).abortSignal(signal());
  if (now() >= deadline) fail("MEDIA_DIAGNOSTIC_TIME_BUDGET");
  if (bindings.error) fail("MEDIA_DIAGNOSTIC_BINDING_READ_FAILED");
  if (!Array.isArray(bindings.data) || bindings.data.length !== 1) fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED");
  const binding = bindings.data[0];
  if (binding.catalog_key !== approval.catalog_key || binding.carousel_item_id !== itemId || binding.product_gid !== identity.productId ||
      binding.variant_gid !== identity.variantId || binding.product_handle !== identity.productHandle || binding.is_published !== true) {
    fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED");
  }
  const card = await db.from("carousel_items").select("id,catalog_number,is_active,editor_revision")
    .eq("id", itemId).limit(2).abortSignal(signal());
  if (now() >= deadline) fail("MEDIA_DIAGNOSTIC_TIME_BUDGET");
  if (card.error) fail("MEDIA_DIAGNOSTIC_BINDING_READ_FAILED");
  if (!Array.isArray(card.data) || card.data.length !== 1) fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED");
  const row = card.data[0];
  if (row.id !== itemId || row.is_active !== true || row.catalog_number !== identity.exactGallerySku ||
      !Number.isSafeInteger(row.editor_revision) || row.editor_revision < 0) fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED");
  const links = await db.from("shopify_gallery_public_links").select("catalog_key,product_handle,variant_id,is_published")
    .eq("catalog_key", approval.catalog_key).limit(2).abortSignal(signal());
  if (now() >= deadline) fail("MEDIA_DIAGNOSTIC_TIME_BUDGET");
  if (links.error) fail("MEDIA_DIAGNOSTIC_BINDING_READ_FAILED");
  if (!Array.isArray(links.data) || links.data.length !== 1) fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED");
  const link = links.data[0];
  if (link.catalog_key !== approval.catalog_key || link.is_published !== true ||
      link.product_handle !== identity.productHandle || `gid://shopify/ProductVariant/${link.variant_id}` !== identity.variantId) {
    fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED");
  }
  // Existing service-only observability RPC, not a planning/read lease. Never call its enqueue sibling.
  const status = await readStatus(identity.productId, deadline);
  if (now() >= deadline) fail("MEDIA_DIAGNOSTIC_TIME_BUDGET");
  const product = status?.product;
  if (!product || product.catalogKey !== approval.catalog_key || product.copyEnabled !== true || product.mediaEnabled !== true ||
      !Number.isSafeInteger(product.baselineVersion) || product.baselineVersion < 1) fail("MEDIA_DIAGNOSTIC_MEDIA_LANE_DISABLED");
  let registered: MediaIdentity;
  try { registered = reviewIdentity(product.identity); } catch { fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED"); }
  if (JSON.stringify(registered) !== JSON.stringify(identity)) fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED");
  return { identity, stamp: JSON.stringify([approval, binding, row, link, registered, product.baselineVersion]) };
}

/** Reuse the diagnostic's bounded, server-owned identity and eligibility checks
 * for ordinary review registration, without reading the whole Gallery catalog. */
export async function readMediaReviewBinding(db: Db, itemId: string, deadline: number) {
  if (!UUID.test(itemId) || isShopifyOwnedVariant(itemId)) fail("MEDIA_DIAGNOSTIC_NOT_ELIGIBLE");
  return readBinding(db, itemId, deadline, Date.now, readMediaStatus);
}

/** Capture one current native photo using the unmodified production Node/Sharp path.
 * This observation creates no proof, review, baseline, registration, queue event or permission. */
async function readDiagnosticCapture(db: Db, input: MediaDiagnosticInput, deadline: number, dependencies: Dependencies = {}, expected?: { identity: MediaIdentity; url: string }) {
  const command = parseMediaDiagnosticInput(input), now = dependencies.now ?? Date.now;
  const check = () => { if (!Number.isFinite(deadline) || now() >= deadline) fail("MEDIA_DIAGNOSTIC_TIME_BUDGET"); };
  check();
  if (isShopifyOwnedVariant(command.itemId)) fail("MEDIA_DIAGNOSTIC_OWNED_GROUP_UNSUPPORTED");
  const status = dependencies.status ?? readMediaStatus;
  const binding = await readBinding(db, command.itemId, deadline, now, status);
  if (expected && Object.entries(expected.identity).some(([key, value]) => binding.identity[key as keyof MediaIdentity] !== value)) {
    fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED");
  }
  const read = dependencies.readNative ?? fetchShopifyMediaRead, deny = dependencies.deny ?? assertNotDeniedMedia;
  check();
  // This reader independently requires ACTIVE, Online Store publication, the exact single variant and a complete ready media graph.
  const before = await read(binding.identity, 8000, deadline);
  check();
  if (JSON.stringify(before.identity) !== JSON.stringify(binding.identity)) fail("MEDIA_DIAGNOSTIC_IDENTITY_CHANGED");
  const images = before.images.filter(image => image.mediaId === command.mediaId);
  if (images.length !== 1) fail("MEDIA_DIAGNOSTIC_MEDIA_NOT_CURRENT");
  const image = images[0];
  if (expected && image.url !== expected.url) fail("MEDIA_DIAGNOSTIC_SOURCE_CHANGED");
  deny(image.url);
  const captured = await (dependencies.capture ?? captureMediaSourceBytes)(binding.identity, image.url, deadline);
  check();
  deny(image.url, captured.sha256);
  const after = await read(binding.identity, 8000, deadline);
  check();
  if (before.fingerprint !== after.fingerprint || JSON.stringify(after.identity) !== JSON.stringify(binding.identity)) {
    fail("MEDIA_DIAGNOSTIC_SOURCE_CHANGED");
  }
  const fresh = await readBinding(db, command.itemId, deadline, now, status);
  check();
  if (fresh.stamp !== binding.stamp) fail("MEDIA_DIAGNOSTIC_BINDING_CHANGED");
  const result = { readOnly: true, scope: "ordinary_current_native_image", observedAt: new Date(now()).toISOString(), identity: binding.identity,
    native: { mediaId: image.mediaId, imageId: image.imageId, imageUrl: image.url, width: image.width, height: image.height, platformUpdatedAt: image.updatedAt,
      productUpdatedAt: before.updatedAt, fingerprint: before.fingerprint },
    observation: { sha256: captured.sha256, mime: captured.mime, width: captured.width, height: captured.height, byteLength: captured.byteLength },
    runtime: { node: process.versions.node, sharp: sharp.versions.sharp, vips: sharp.versions.vips,
      requestProfile: "captureMediaSourceBytes_runtime_default_headers" },
    baselineComparison: "unavailable", baselineComparisonReason: "READ_ONLY_PROOF_ACCESS_NOT_EXPOSED" };
  return { result, captured };
}

/** Existing metadata endpoint deliberately never exports source bytes. */
export async function readMediaDiagnostic(db: Db, input: MediaDiagnosticInput, deadline: number, dependencies: Dependencies = {}) {
  return (await readDiagnosticCapture(db, input, deadline, dependencies)).result;
}

/** Temporary diagnostic scope. No caller-selected identity, URL, checksum or region. */
const KL966005_EXPORT = {
  identity: { itemId: "3e20d7c1-5828-5f0d-b4b9-215dfe192a1c", productId: "gid://shopify/Product/9382883918074",
    variantId: "gid://shopify/ProductVariant/50148815929594", productHandle: "samsonite-intuo-55-easy-access-citrus-kl966005",
    exactGallerySku: "KL966005", exactShopifySku: "KL966005" },
  mediaId: "gid://shopify/MediaImage/40701188604154",
  url: "https://cdn.shopify.com/s/files/1/0622/8082/7130/files/03-002c093ef078.jpg?v=1787391069",
} as const;

/** One new observation only. Never a review, proof, accepted checksum or historical recovery. */
export async function readKl966005DiagnosticBytes(db: Db, input: MediaDiagnosticInput, deadline: number, dependencies: Dependencies = {}) {
  const command = parseMediaDiagnosticInput(input);
  if (command.itemId !== KL966005_EXPORT.identity.itemId || command.mediaId !== KL966005_EXPORT.mediaId) {
    fail("MEDIA_DIAGNOSTIC_EXPORT_SCOPE_INVALID");
  }
  const { result, captured } = await readDiagnosticCapture(db, command, deadline, dependencies, KL966005_EXPORT);
  // Verify the response body, not merely the producer's metadata; never return the visual signature.
  const bytes = Uint8Array.from(captured.bytes);
  if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.length !== captured.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== captured.sha256 ||
      !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(captured.mime)) {
    fail("MEDIA_DIAGNOSTIC_EXPORT_BYTES_INVALID");
  }
  if ((dependencies.now ?? Date.now)() >= deadline) fail("MEDIA_DIAGNOSTIC_TIME_BUDGET");
  return { metadata: result, bytes };
}
