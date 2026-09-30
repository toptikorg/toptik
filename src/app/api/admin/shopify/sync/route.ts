import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { isShopifySyncConfigured } from "@/lib/shopify/admin-api";
import { drainShopifySyncQueues } from "@/lib/shopify/sync-worker";
import { configuredSyncCanarySku, shopifyProductGid } from "@/lib/shopify/sync-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Admin/cron worker for Shopify-visible product copy and SEO fields. */
export async function POST(request: NextRequest) {
  const denied = requireAdminToken(request, { allowCron: true });
  if (denied) return denied;
  if (!hasSupabaseAdminEnv() || !isShopifySyncConfigured()) {
    return NextResponse.json({ error: "Shopify sync is not configured" }, { status: 503 });
  }
  try {
    const result = await drainShopifySyncQueues(createSupabaseServiceRoleClient());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
      ? error.message
      : "SYNC_WORKER_FAILED";
    console.error("POST /api/admin/shopify/sync failed", { code });
    return NextResponse.json({ error: "Shopify sync worker failed", code }, { status: 503 });
  }
}

/** Return bounded private review and exact-canary delivery metadata, never bodies. */
export async function GET(request: NextRequest) {
  const runWorker = request.nextUrl.searchParams.get("run") === "1";
  const denied = requireAdminToken(request, { allowCron: runWorker });
  if (denied) return denied;
  if (!hasSupabaseAdminEnv()) {
    return NextResponse.json({ error: "Supabase admin env not configured" }, { status: 503 });
  }
  try {
    const supabase = createSupabaseServiceRoleClient();
    if (runWorker) {
      if (!isShopifySyncConfigured()) return NextResponse.json({ error: "Shopify sync is not configured" }, { status: 503 });
      const result = await drainShopifySyncQueues(supabase);
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    const [{ data: events, error: eventsError }, { data: outbox, error: outboxError }] = await Promise.all([
      supabase.from("shopify_webhook_events")
        .select("id,topic,status,attempts,received_at,last_error")
        .in("status", ["review", "failed"])
        .order("received_at", { ascending: false })
        .limit(50),
      supabase.from("shopify_gallery_content_outbox")
        .select("id,catalog_key,status,attempts,created_at,last_error")
        .in("status", ["review", "failed"])
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    if (eventsError || outboxError) throw new Error("SYNC_REVIEW_QUEUE_READ_FAILED");
    const canarySku = configuredSyncCanarySku(process.env.SHOPIFY_SYNC_CANARY_SKU);
    let canaryProductId: string | null = null;
    let canaryEvents: Array<{
      id: string; delivery_id: string; topic: string; received_at: string;
      processed_at: string | null; status: string; product_id: string; event_updated_at: string | null;
    }> = [];
    if (canarySku) {
      const { data: binding, error: bindingError } = await supabase.from("shopify_gallery_bindings")
        .select("product_gid").eq("catalog_key", canarySku).maybeSingle();
      if (bindingError) throw new Error("SYNC_CANARY_STATUS_READ_FAILED");
      if (binding) {
        canaryProductId = shopifyProductGid(binding.product_gid);
        if (!canaryProductId) throw new Error("SYNC_CANARY_STATUS_IDENTITY_INVALID");
        // Select only scalar identity/version metadata from JSON. Webhook content and
        // shop identifiers never enter the status response or this read result.
        const { data: deliveries, error: deliveriesError } = await supabase.from("shopify_webhook_events")
          .select("id,delivery_id,topic,received_at,processed_at,status,product_id:payload->>id,event_updated_at:payload->>updated_at")
          .in("payload->>id", [canaryProductId, canaryProductId.split("/").at(-1)!])
          .order("received_at", { ascending: false })
          .limit(25);
        if (deliveriesError) throw new Error("SYNC_CANARY_STATUS_READ_FAILED");
        canaryEvents = (deliveries ?? []).flatMap(row => {
          const productId = shopifyProductGid(row.product_id);
          return productId && productId === canaryProductId ? [{
            id: row.id, delivery_id: row.delivery_id, topic: row.topic,
            received_at: row.received_at, processed_at: row.processed_at,
            status: row.status, product_id: productId, event_updated_at: row.event_updated_at,
          }] : [];
        });
      }
    }
    return NextResponse.json({ events: events ?? [], outbox: outbox ?? [], canaryProductId, canaryEvents },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Shopify sync review queue unavailable" }, { status: 503 });
  }
}
