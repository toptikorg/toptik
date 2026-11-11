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
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** At most four exact reviews for ONE product. No media/product/baseline writes.
 * Validate every source before storing any record. Immutable per-image readbacks
 * remain authoritative; a partial failure never claims a complete registration. */
export async function POST(req: NextRequest) {
  const auth = await authorizeGalleryAdmin(req, { sessionMutation: true });
  if (!auth.ok) return auth.response;
  const deadline = Date.now() + 45000;
  const registered: Awaited<ReturnType<typeof saveReviewedMedia>>[] = [];
  let attemptedMediaId: string | null = null;
  let queueAttempted = false;
  let observation: { mediaId: string; expectedSha256: string; observedSha256: string; mime: string; byteLength: number; width: number; height: number } | null = null;
  try {
    if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return reply({ error: "MEDIA_REVIEW_INPUT_INVALID" }, 415);
    const length = req.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) return reply({ error: "MEDIA_REVIEW_INPUT_LIMIT" }, 413);
    const reader = req.body?.getReader(); if (!reader) throw new Error("MEDIA_REVIEW_INPUT_INVALID");
    const chunks: Uint8Array[] = []; let size = 0;
    const bodyDeadline = Date.now() + 5000;
    try {
      while (true) {
        const ms = bodyDeadline - Date.now(); if (ms <= 0) throw new Error("MEDIA_REVIEW_TIME_BUDGET");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const part = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("MEDIA_REVIEW_TIME_BUDGET")), ms);
        })]).finally(() => { if (timer) clearTimeout(timer); });
        if (part.done) break;
        size += part.value.byteLength; if (size > 65536) throw new Error("MEDIA_REVIEW_INPUT_LIMIT");
        chunks.push(part.value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("MEDIA_REVIEW_INPUT_INVALID"); }
    if (!Array.isArray(input) || input.length < 1 || input.length > 4) throw new Error("MEDIA_REVIEW_INPUT_INVALID");
    const records = input.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join("|") !== ["identity", "mediaId", "imageUrl", "expectedSha256", "sourceUrl", "evidence", "reviewedExactSkuColor"].sort().join("|") ||
          value.reviewedExactSkuColor !== true || typeof value.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedSha256)) throw new Error("MEDIA_REVIEW_INPUT_INVALID");
      return reviewRecord({ version: 1, identity: reviewIdentity(value.identity), mediaId: value.mediaId, imageUrl: value.imageUrl,
        decodedSha256: value.expectedSha256, sourceUrl: value.sourceUrl, evidence: value.evidence,
        actorId: auth.actorId, reviewedAt: new Date().toISOString(), reviewedExactSkuColor: true });
    });
    const identity = records[0].identity;
    if (records.some(record => JSON.stringify(record.identity) !== JSON.stringify(identity)) ||
        new Set(records.map(record => record.mediaId)).size !== records.length ||
        new Set(records.map(record => record.imageUrl)).size !== records.length) throw new Error("MEDIA_REVIEW_INPUT_INVALID");
    const catalog = await getCarouselPayload({ includeInactive: true, rawAdmin: true });
    const item = catalog.items.find(i => i.id === identity.itemId);
    if (!item || !item.isActive || !item.shopifyLink?.isPublished || item.catalogNumber !== identity.exactGallerySku ||
        `gid://shopify/ProductVariant/${item.shopifyLink?.variantId}` !== identity.variantId) throw new Error("MEDIA_REVIEW_IDENTITY_CHANGED");
    const before = await fetchShopifyMediaRead(identity, 8000, deadline);
    for (const record of records) {
      const image = before.images.find(i => i.mediaId === record.mediaId && i.url === record.imageUrl);
      if (!image) throw new Error("MEDIA_REVIEW_IDENTITY_CHANGED");
      assertNotDeniedMedia(image.url);
      const bytes = await captureMediaSourceBytes(identity, image.url, deadline);
      if (bytes.sha256 !== record.decodedSha256) {
        observation = { mediaId: image.mediaId, expectedSha256: record.decodedSha256, observedSha256: bytes.sha256,
          mime: bytes.mime, byteLength: bytes.byteLength, width: bytes.width, height: bytes.height };
        throw new Error("MEDIA_REVIEW_BYTES_CHANGED");
      }
      assertNotDeniedMedia(image.url, bytes.sha256);
    }
    const after = await fetchShopifyMediaRead(identity, 8000, deadline);
    if (before.fingerprint !== after.fingerprint) throw new Error("MEDIA_REVIEW_IDENTITY_CHANGED");
    for (const record of records) {
      attemptedMediaId = record.mediaId;
      registered.push(await saveReviewedMedia(record, deadline));
      attemptedMediaId = null;
    }
    queueAttempted = true;
    const queued = await enqueueReviewedMedia(identity.productId, deadline);
    scheduleMediaSyncWakeup();
    return reply({ complete: true, registered, queued, syncVerified: false });
  } catch (error) {
    const code = error instanceof Error && /^MEDIA_[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : "MEDIA_REVIEW_FAILED";
    return reply({ error: code, complete: false, registered, attemptedMediaId, queued: queueAttempted ? null : false, syncVerified: false,
      ...(observation ? { observation } : {}) },
      code === "MEDIA_REVIEW_INPUT_LIMIT" ? 413 : code.includes("INPUT") || code.includes("INVALID") ? 400 : 409);
  }
}
