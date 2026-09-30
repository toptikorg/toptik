import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { configuredShopifyDomain, fetchProductSnapshot, isShopifySyncConfigured } from "@/lib/shopify/admin-api";
import { scheduleShopifySync } from "@/lib/shopify/schedule-sync";
import { configuredSyncCanarySku, isSyncCanarySku, shopifyProductGid } from "@/lib/shopify/sync-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Queue one exact canary product; production bootstrap never scans the catalog. */
export async function POST(request: NextRequest) {
  const denied = requireAdminToken(request);
  if (denied) return denied;
  if (!hasSupabaseAdminEnv() || !isShopifySyncConfigured()) {
    return NextResponse.json({ error: "Shopify sync is not configured" }, { status: 503 });
  }
  try {
    const canarySku = configuredSyncCanarySku(process.env.SHOPIFY_SYNC_CANARY_SKU);
    if (!canarySku) return NextResponse.json({ error: "Single-SKU canary is not configured" }, { status: 503 });
    const body = await request.json().catch(() => null) as { productId?: unknown } | null;
    const productGid = typeof body?.productId === "string" ? shopifyProductGid(body.productId) : null;
    if (!productGid) return NextResponse.json({ error: "A Shopify product ID is required" }, { status: 400 });
    const product = await fetchProductSnapshot(productGid);
    if (!product) return NextResponse.json({ error: "Shopify product was not found" }, { status: 404 });
    const canaryVariants = product.variants.filter(variant => isSyncCanarySku(variant.sku, canarySku));
    if (canaryVariants.length !== 1) {
      return NextResponse.json({ error: "Product must contain exactly one variant for the configured canary SKU" }, { status: 409 });
    }
    const supabase = createSupabaseServiceRoleClient();
    const domain = configuredShopifyDomain();
    const { data, error } = await supabase.from("shopify_webhook_events").upsert({
      delivery_id: "canary-bootstrap:" + product.id + ":" + product.updatedAt + ":" + canarySku,
      topic: "products/update",
      shop_domain: domain,
      payload: { id: product.id, updated_at: product.updatedAt, source: "single-sku-canary" },
      status: "pending",
    }, { onConflict: "delivery_id", ignoreDuplicates: true }).select("id");
    if (error) throw new Error("SYNC_BOOTSTRAP_QUEUE_WRITE_FAILED");
    scheduleShopifySync();
    return NextResponse.json({ productId: product.id, canarySku, queued: data?.length ?? 0 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_BOOTSTRAP_FAILED";
    console.error("POST /api/admin/shopify/bootstrap failed", { code });
    return NextResponse.json({ error: "Shopify catalog bootstrap failed", code }, { status: 503 });
  }
}
