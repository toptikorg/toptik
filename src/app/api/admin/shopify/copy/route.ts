import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { fetchProductSnapshot, isShopifySyncConfigured } from "@/lib/shopify/admin-api";
import { assertVerifiedCopyApproval, assertVerifiedCopyIdentity, configuredShopifySyncMode, configuredSyncCanarySku, normalizeSyncSku } from "@/lib/shopify/sync-rules";
import { readVerifiedCopyEligibility } from "@/lib/shopify/copy-eligibility";
import { assertSafeDescriptionHtml, descriptionTextFromHtml, plainDescriptionToHtml } from "@/lib/shopify/description-document";
import { scheduleShopifySync } from "@/lib/shopify/schedule-sync";
import { isShopifyOwnedVariant, SHOPIFY_OWNED_MESSAGE } from "@/lib/shopify/variant-source-policy";

export const runtime = "nodejs";
export const maxDuration = 60;

const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(50000).optional(),
  descriptionHtml: z.string().max(250000).optional(),
  seoTitle: z.string().max(512).nullable().optional(),
  seoDescription: z.string().max(5000).nullable().optional(),
}).strict().refine(patch => Object.keys(patch).length > 0);
const requestSchema = z.object({
  itemId: z.string().uuid(),
  productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
  sku: z.string().min(2).max(64),
  copyUpdatedAt: z.string().datetime({ offset: true }),
  patch: patchSchema,
}).strict();

/** Existing approved copy only; never rewrite catalog metadata, settings or angles. */
export async function PATCH(request: NextRequest) {
  const denied = requireAdminToken(request);
  if (denied) return denied;
  if (!hasSupabaseAdminEnv() || !isShopifySyncConfigured()) {
    return NextResponse.json({ error: "Shopify sync is not configured" }, { status: 503 });
  }
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 1_000_000) return NextResponse.json({ error: "Request too large" }, { status: 413 });
    const parsed = requestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return NextResponse.json({ error: "SYNC_COPY_PATCH_INVALID" }, { status: 400 });
    const body = parsed.data;
    if (isShopifyOwnedVariant(body.itemId)) return NextResponse.json({ error: SHOPIFY_OWNED_MESSAGE }, { status: 409 });
    const mode = configuredShopifySyncMode(process.env.SHOPIFY_SYNC_MODE);
    if (mode === "disabled") throw new Error("SYNC_MODE_NOT_CONFIGURED");
    const canary = configuredSyncCanarySku(process.env.SHOPIFY_SYNC_CANARY_SKU);
    const catalogKey = normalizeSyncSku(body.sku);
    if (mode === "canary" && (!canary || catalogKey !== canary)) return NextResponse.json({ error: "SYNC_SKU_OUTSIDE_CANARY" }, { status: 409 });
    const supabase = createSupabaseServiceRoleClient();
    const approval = mode === "verified_catalog" ? await readVerifiedCopyEligibility(supabase, body.productId) : null;
    if (mode === "verified_catalog") assertVerifiedCopyApproval(approval);
    const [itemResult, bindingResult] = await Promise.all([
      supabase.from("carousel_items").select("id,catalog_number,title,description,description_html,seo_title,seo_description,copy_updated_at").eq("id", body.itemId).maybeSingle(),
      supabase.from("shopify_gallery_bindings").select("catalog_key,carousel_item_id,product_gid,variant_gid,product_handle").eq("product_gid", body.productId),
    ]);
    if (itemResult.error || bindingResult.error) throw new Error("SYNC_COPY_READ_FAILED");
    const item = itemResult.data;
    const bindings = bindingResult.data ?? [];
    const binding = bindings[0];
    if (!item || item.catalog_number !== body.sku || bindings.length !== 1 ||
        binding.catalog_key !== catalogKey || binding.carousel_item_id !== body.itemId) {
      return NextResponse.json({ error: "SYNC_BINDING_MISSING_OR_CONFLICTED" }, { status: 409 });
    }
    if (Date.parse(item.copy_updated_at) !== Date.parse(body.copyUpdatedAt)) {
      return NextResponse.json({ error: "SYNC_COPY_STALE_EDIT_RELOAD" }, { status: 409 });
    }
    const product = await fetchProductSnapshot(body.productId);
    if (!product || product.id !== body.productId || product.variants.length !== 1 ||
        product.variants[0].id !== binding.variant_gid || (mode === "canary" && product.variants[0].sku !== body.sku)) {
      return NextResponse.json({ error: "SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT" }, { status: 409 });
    }
    if (approval) assertVerifiedCopyIdentity(approval, binding, { id: body.itemId, catalog_number: item.catalog_number }, product);
    const copy = {
      title: body.patch.title ?? item.title,
      description: item.description ?? "",
      descriptionHtml: item.description_html ?? null,
      seoTitle: body.patch.seoTitle === undefined ? item.seo_title ?? null : body.patch.seoTitle,
      seoDescription: body.patch.seoDescription === undefined ? item.seo_description ?? null : body.patch.seoDescription,
    };
    if (body.patch.descriptionHtml !== undefined) {
      if (body.patch.descriptionHtml !== item.description_html) assertSafeDescriptionHtml(body.patch.descriptionHtml);
      copy.descriptionHtml = body.patch.descriptionHtml;
      copy.description = descriptionTextFromHtml(copy.descriptionHtml);
      if (body.patch.description !== undefined && body.patch.description !== copy.description) throw new Error("SYNC_DESCRIPTION_PAIR_MISMATCH");
    } else if (body.patch.description !== undefined && body.patch.description !== copy.description) {
      if (typeof item.description_html === "string") throw new Error("SYNC_DESCRIPTION_RICH_EDITOR_REQUIRED");
      copy.descriptionHtml = plainDescriptionToHtml(body.patch.description);
      copy.description = descriptionTextFromHtml(copy.descriptionHtml);
    }
    const { data, error } = await supabase.rpc(approval ? "patch_shopify_verified_copy" : "patch_shopify_canary_copy", {
      p_item_id: body.itemId, p_catalog_key: catalogKey, p_exact_sku: body.sku,
      p_product_gid: body.productId, p_variant_gid: binding.variant_gid,
      p_expected_version: body.copyUpdatedAt, p_copy: copy,
      ...(approval ? { p_exact_shopify_sku: approval.exact_shopify_sku } : {}),
    });
    if (error) {
      const code = /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SYNC_COPY_PATCH_FAILED";
      return NextResponse.json({ error: code }, { status: 409 });
    }
    scheduleShopifySync();
    return NextResponse.json({ ok: true, itemId: body.itemId, ...data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "SYNC_COPY_PATCH_FAILED";
    return NextResponse.json({ error: code }, { status: 400 });
  }
}
