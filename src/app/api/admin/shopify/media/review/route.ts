import { NextResponse, type NextRequest } from "next/server";
import { authorizeGalleryAdmin } from "@/lib/admin/gallery-access";
import { getCarouselPayload } from "@/lib/carousel/repository";
import { fetchShopifyMediaRead } from "@/lib/shopify/admin-api";
import { captureMediaSourceBytes } from "@/lib/shopify/media-source-bytes";
import { assertNotDeniedMedia } from "@/lib/shopify/reviewed-media-guard";
import { reviewIdentity, reviewRecord } from "@/lib/shopify/reviewed-media-record";
import { saveReviewedMedia } from "@/lib/shopify/reviewed-media-store";
import { scheduleMediaSyncWakeup } from "@/lib/shopify/media-schedule";
import { enqueueReviewedMedia } from "@/lib/shopify/media-status";

export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "syd1";
/** Register one image review at origin; does not copy images, edit products,
 * reset baselines, enable a sync lane or confer a gallery role. */
export async function POST(req: NextRequest) {
  const auth = await authorizeGalleryAdmin(req, { sessionMutation: true });
  if (!auth.ok) return auth.response;
  const deadline = Date.now() + 45000;
  try {
    if (!req.headers.get("content-type")?.startsWith("application/json")) throw new Error("MEDIA_REVIEW_INPUT_INVALID");
    const reader = req.body?.getReader(); if (!reader) throw new Error("MEDIA_REVIEW_INPUT_INVALID");
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 16384) { await reader.cancel(); throw new Error("MEDIA_REVIEW_INPUT_INVALID"); } chunks.push(part.value); }
    } finally { reader.releaseLock(); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join("|") !== ["identity", "mediaId", "imageUrl", "expectedSha256", "sourceUrl", "evidence", "reviewedExactSkuColor"].sort().join("|") ||
        input.reviewedExactSkuColor !== true || !/^[a-f0-9]{64}$/.test(input.expectedSha256)) throw new Error("MEDIA_REVIEW_INPUT_INVALID");
    const identity = reviewIdentity(input.identity);
    const record = reviewRecord({ version: 1, identity, mediaId: input.mediaId, imageUrl: input.imageUrl,
      decodedSha256: input.expectedSha256, sourceUrl: input.sourceUrl, evidence: input.evidence,
      actorId: auth.actorId, reviewedAt: new Date().toISOString(), reviewedExactSkuColor: true });
    const catalog = await getCarouselPayload({ includeInactive: true, rawAdmin: true });
    const item = catalog.items.find(i => i.id === identity.itemId);
    if (!item || item.catalogNumber !== identity.exactGallerySku ||
        `gid://shopify/ProductVariant/${item.shopifyLink?.variantId}` !== identity.variantId) throw new Error("MEDIA_REVIEW_IDENTITY_CHANGED");
    const before = await fetchShopifyMediaRead(identity, 8000, deadline);
    const image = before.images.find(i => i.mediaId === record.mediaId && i.url === record.imageUrl);
    if (!image) throw new Error("MEDIA_REVIEW_IDENTITY_CHANGED");
    const bytes = await captureMediaSourceBytes(identity, image.url, deadline);
    if (bytes.sha256 !== record.decodedSha256) throw new Error("MEDIA_REVIEW_BYTES_CHANGED");
    assertNotDeniedMedia(image.url, bytes.sha256);
    const after = await fetchShopifyMediaRead(identity, 8000, deadline);
    if (before.fingerprint !== after.fingerprint) throw new Error("MEDIA_REVIEW_IDENTITY_CHANGED");
    const result = await saveReviewedMedia(record, deadline);
    const queued = await enqueueReviewedMedia(identity.productId, deadline);
    scheduleMediaSyncWakeup();
    return NextResponse.json({ ...result, queued }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^MEDIA_[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : "MEDIA_REVIEW_FAILED";
    return NextResponse.json({ error: code }, { status: code.includes("INPUT") || code.includes("INVALID") ? 400 : 409, headers: { "Cache-Control": "no-store" } });
  }
}
