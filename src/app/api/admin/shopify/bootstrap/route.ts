import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { configuredShopifyDomain, fetchShopifyBootstrapProducts, isShopifySyncConfigured } from "@/lib/shopify/admin-api";
import { scheduleShopifySync } from "@/lib/shopify/schedule-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One-time bootstrap for existing Shopify products; all joins remain exact-SKU only. */
export async function POST(request: NextRequest) {
  const denied = requireAdminToken(request);
  if (denied) return denied;
  if (!hasSupabaseAdminEnv() || !isShopifySyncConfigured()) {
    return NextResponse.json({ error: "Shopify sync is not configured" }, { status: 503 });
  }
  try {
    const products = await fetchShopifyBootstrapProducts(5000);
    const supabase = createSupabaseServiceRoleClient();
    const domain = configuredShopifyDomain();
    let queued = 0;
    for (let index = 0; index < products.length; index += 100) {
      const batch = products.slice(index, index + 100).map(product => ({
        delivery_id: product.deliveryId,
        topic: "products/update" as const,
        shop_domain: domain,
        payload: { id: product.id, updated_at: product.updatedAt, source: "bootstrap" },
        status: "pending" as const,
      }));
      const { data, error } = await supabase.from("shopify_webhook_events")
        .upsert(batch, { onConflict: "delivery_id", ignoreDuplicates: true }).select("id");
      if (error) throw new Error("SYNC_BOOTSTRAP_QUEUE_WRITE_FAILED");
      queued += data?.length ?? 0;
    }
    scheduleShopifySync();
    return NextResponse.json({ scanned: products.length, queued, truncatedAtLimit: products.length === 5000 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "SYNC_BOOTSTRAP_FAILED";
    console.error("POST /api/admin/shopify/bootstrap failed", { code });
    return NextResponse.json({ error: "Shopify catalog bootstrap failed", code }, { status: 503 });
  }
}
