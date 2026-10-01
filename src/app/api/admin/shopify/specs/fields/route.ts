import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireGalleryAdmin } from "@/lib/admin/gallery-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { typedSpecSyncEnabled, typedSpecClearsEnabled, withTypedSpecLease, readTypedState, freshTypedShopify, editTypedSpecs, typedSpecDefinitions } from "@/lib/shopify/typed-spec-worker";
import { scheduleTypedSpecSync } from "@/lib/shopify/schedule-typed-spec-sync";

export const runtime = "nodejs";
export const maxDuration = 60;
const productId = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/);
const patch = z.object({
  productId, variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/), itemId: z.string().uuid(),
  exactGallerySku: z.string().min(2).max(64), exactShopifySku: z.string().min(2).max(64), productHandle: z.string().min(1).max(255),
  requestId: z.string().uuid(), changes: z.record(z.string(), z.unknown()), versions: z.record(z.string(), z.number().int().positive()),
}).strict();
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) => reply({ error: error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SPEC_REQUEST_FAILED" }, 409);

/** Authenticated observation only; current Shopify values never initialize or advance baselines. */
export async function GET(request: NextRequest) {
  const denied = await requireGalleryAdmin(request); if (denied) return denied;
  if (!typedSpecSyncEnabled()) return reply({ error: "SPEC_DISABLED" }, 404);
  const requestedProduct = request.nextUrl.searchParams.get("productId");
  const requestedItem = request.nextUrl.searchParams.get("itemId");
  const parsedProduct = productId.safeParse(requestedProduct);
  const parsedItem = z.string().uuid().safeParse(requestedItem);
  if (!parsedProduct.success && !parsedItem.success) return reply({ error: "SPEC_IDENTITY_INVALID" }, 400);
  try {
    const db = createSupabaseServiceRoleClient();
    let resolvedProduct = parsedProduct.success ? parsedProduct.data : "";
    if (parsedItem.success) {
      const { data, error } = await db.from("shopify_gallery_bindings")
        .select("product_gid").eq("carousel_item_id", parsedItem.data);
      if (error || data?.length !== 1 || !productId.safeParse(data[0].product_gid).success
        || (resolvedProduct && data[0].product_gid !== resolvedProduct)) throw new Error("SPEC_IDENTITY_INVALID");
      resolvedProduct = data[0].product_gid;
    }
    return await withTypedSpecLease(db, resolvedProduct, async owner => {
      const state = await readTypedState(db, resolvedProduct, owner);
      if (parsedItem.success && state.identity.itemId !== parsedItem.data) throw new Error("SPEC_IDENTITY_CHANGED");
      const shopify = await freshTypedShopify(state);
      return reply({ enabled: true, clearsEnabled: typedSpecClearsEnabled(), initialized: state.fields.length === 19, identity: state.identity, fields: state.fields,
        shopify: shopify.document, shopifyUpdatedAt: shopify.updatedAt, definitions: typedSpecDefinitions() });
    });
  } catch (error) { return failure(error); }
}

/** Single explicitly approved product, typed changed fields only; never a catalog replacement. */
export async function PATCH(request: NextRequest) {
  const denied = await requireGalleryAdmin(request); if (denied) return denied;
  if (!typedSpecSyncEnabled()) return reply({ error: "SPEC_DISABLED" }, 404);
  try {
    const raw = await request.text(); if (Buffer.byteLength(raw) > 500_000) return reply({ error: "SPEC_REQUEST_TOO_LARGE" }, 413);
    let json: unknown; try { json = JSON.parse(raw); } catch { return reply({ error: "SPEC_EDIT_INVALID" }, 400); }
    const parsed = patch.safeParse(json); if (!parsed.success) return reply({ error: "SPEC_EDIT_INVALID" }, 400);
    const input = parsed.data;
    const result = await editTypedSpecs(createSupabaseServiceRoleClient(), input.productId, input.requestId, input.changes, input.versions,
      { itemId: input.itemId, variantGid: input.variantId, gallerySku: input.exactGallerySku, exactSku: input.exactShopifySku, productHandle: input.productHandle });
    scheduleTypedSpecSync();
    return reply({ ok: true, queued: true, productId: input.productId, result }, 202);
  } catch (error) { return failure(error); }
}
