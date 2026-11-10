import { NextResponse, type NextRequest } from "next/server";
import { authorizeGalleryAdmin } from "@/lib/admin/gallery-access";
import { getCarouselPayload } from "@/lib/carousel/repository";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { fetchShopifyMediaRead } from "@/lib/shopify/admin-api";
import { VERIFIED_COPY_COLUMNS } from "@/lib/shopify/copy-eligibility";
import { assertVerifiedCopyApproval, type VerifiedCopyEligibility } from "@/lib/shopify/sync-rules";
import { MAX_STAGED_NOTE } from "@/lib/shopify/staged-media-review-record";
import { stageReviewedGalleryUpload } from "@/lib/shopify/staged-media-upload";
import { isShopifyOwnedVariant } from "@/lib/shopify/variant-source-policy";

export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "syd1";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * An administrator looked at an image they uploaded in the editor for an ordinary product and confirms it is
 * the exact model and color. The server derives the identity from the approved binding (never from the
 * request), copies the decoded bytes to a content-addressed path without overwrite and stores one signed
 * receipt. This route writes nothing to Shopify and nothing to the Gallery catalog.
 */
export async function POST(req: NextRequest) {
  const auth = await authorizeGalleryAdmin(req, { sessionMutation: true });
  if (!auth.ok) return auth.response;
  const deadline = Date.now() + 45000;
  try {
    if (!req.headers.get("content-type")?.startsWith("application/json")) throw new Error("STAGED_MEDIA_INPUT_INVALID");
    const reader = req.body?.getReader();
    if (!reader) throw new Error("STAGED_MEDIA_INPUT_INVALID");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) { await reader.cancel(); throw new Error("STAGED_MEDIA_INPUT_INVALID"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    let input: Record<string, unknown>;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("STAGED_MEDIA_INPUT_INVALID"); }
    // reviewedCatalogNumber and expectedRevision say exactly which card the administrator was looking at when they
    // confirmed: the SKU printed next to the checkbox and the card version the editor had loaded.
    const allowed = ["itemId", "uploadUrl", "reviewedExactSkuColor", "reviewedCatalogNumber", "expectedRevision", "note"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) ||
        input.reviewedExactSkuColor !== true || typeof input.itemId !== "string" || !UUID.test(input.itemId) ||
        typeof input.uploadUrl !== "string" || input.uploadUrl.length > 2048 ||
        typeof input.reviewedCatalogNumber !== "string" || !input.reviewedCatalogNumber || input.reviewedCatalogNumber.length > 80 ||
        typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        (input.note !== undefined && (typeof input.note !== "string" || input.note.length > MAX_STAGED_NOTE || /[\u0000-\u001f\u007f]/.test(input.note)))) {
      throw new Error("STAGED_MEDIA_INPUT_INVALID");
    }
    const itemId = input.itemId.toLowerCase();
    // Shared multi-color products (FZT73, QMMM1) have their own reviewed group route; this one is for ordinary products.
    if (isShopifyOwnedVariant(itemId)) throw new Error("STAGED_MEDIA_OWNED_GROUP");
    const db = createSupabaseServiceRoleClient();
    const eligibility = await db.from("shopify_gallery_copy_eligibility").select(VERIFIED_COPY_COLUMNS).eq("carousel_item_id", itemId).limit(2);
    if (eligibility.error) throw new Error("STAGED_MEDIA_BINDING_READ_FAILED");
    if (eligibility.data?.length !== 1) throw new Error("STAGED_MEDIA_NOT_ELIGIBLE");
    const approval = eligibility.data[0] as unknown as VerifiedCopyEligibility;
    try { assertVerifiedCopyApproval(approval); } catch { throw new Error("STAGED_MEDIA_NOT_ELIGIBLE"); }
    const catalog = await getCarouselPayload({ includeInactive: true, rawAdmin: true });
    const item = catalog.items.find(row => row.id === itemId);
    if (!item || approval.carousel_item_id !== itemId || item.catalogNumber !== approval.exact_gallery_sku ||
        `gid://shopify/ProductVariant/${item.shopifyLink?.variantId}` !== approval.variant_gid) throw new Error("STAGED_MEDIA_IDENTITY_CHANGED");
    // The confirmation applies to the SKU the administrator was shown and to the card version they were editing.
    // If the card was re-bound or saved elsewhere since the editor loaded, nothing is staged; the later catalog
    // save would be refused by its own revision check anyway, this just refuses earlier and says why.
    if (input.reviewedCatalogNumber !== approval.exact_gallery_sku) throw new Error("STAGED_MEDIA_IDENTITY_CHANGED");
    if (item.editorRevision !== input.expectedRevision) throw new Error("STAGED_MEDIA_STALE_ITEM");
    const identity = { productId: approval.product_gid, variantId: approval.variant_gid, itemId, exactGallerySku: approval.exact_gallery_sku,
      exactShopifySku: approval.exact_shopify_sku, productHandle: approval.approved_product_handle };
    // The store must still describe exactly this product and variant (it throws on any identity or media inconsistency).
    try { await fetchShopifyMediaRead(identity, 8000, deadline); } catch { throw new Error("STAGED_MEDIA_IDENTITY_CHANGED"); }
    const result = await stageReviewedGalleryUpload(db, { identity, approvalId: approval.approval_id, uploadUrl: input.uploadUrl,
      note: typeof input.note === "string" ? input.note.trim() : "", actorId: auth.actorId }, deadline);
    return reply({ ok: true, ...result });
  } catch (error) {
    const code = error instanceof Error && /^(?:STAGED_MEDIA|MEDIA)_[A-Z0-9_]{1,90}$/.test(error.message) ? error.message : "STAGED_MEDIA_FAILED";
    return reply({ error: code }, code.includes("INPUT") || code.includes("INVALID") ? 400 : 409);
  }
}
