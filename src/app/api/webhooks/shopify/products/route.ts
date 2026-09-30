import { NextRequest, NextResponse } from "next/server";
import { verifyProductWebhook } from "@/lib/shopify/webhook-security";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shopify product webhook inbox. It authenticates and durably deduplicates
 * events; it intentionally does not edit gallery records in the HTTP request.
 * A separately configured worker must reconcile exact SKUs from this queue.
 */
export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 1_000_000) {
    return NextResponse.json({ error: "Webhook rejected" }, { status: 413 });
  }
  const rawBody = await request.text();
  const checked = verifyProductWebhook({
    rawBody,
    signature: request.headers.get("x-shopify-hmac-sha256"),
    deliveryId: request.headers.get("x-shopify-webhook-id"),
    topic: request.headers.get("x-shopify-topic"),
    shopDomain: request.headers.get("x-shopify-shop-domain"),
    secret: process.env.SHOPIFY_WEBHOOK_SECRET,
    expectedShop: process.env.SHOPIFY_SHOP_DOMAIN,
  });

  if (!checked.ok) {
    const status = checked.reason === "unconfigured"
      ? 503
      : checked.reason === "too_large"
        ? 413
        : checked.reason === "bad_signature" || checked.reason === "wrong_shop"
          ? 401
          : 400;
    return NextResponse.json({ error: "Webhook rejected" }, { status });
  }
  if (!hasSupabaseAdminEnv()) {
    return NextResponse.json({ error: "Webhook receiver unavailable" }, { status: 503 });
  }

  try {
    const supabase = createSupabaseServiceRoleClient();
    const { error } = await supabase.from("shopify_webhook_events").insert({
      delivery_id: checked.event.deliveryId,
      topic: checked.event.topic,
      shop_domain: checked.event.shopDomain,
      payload: checked.event.payload,
      status: "pending",
    });

    // Shopify retries deliveries. The unique delivery id makes an already
    // accepted event an idempotent success without replaying its payload.
    if (error?.code === "23505") return new NextResponse(null, { status: 200 });
    if (error) {
      console.error("Shopify webhook inbox insert failed", { code: error.code });
      return NextResponse.json({ error: "Webhook could not be queued" }, { status: 503 });
    }
    return new NextResponse(null, { status: 200 });
  } catch (error) {
    console.error("Shopify webhook receiver unavailable", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Webhook receiver unavailable" }, { status: 503 });
  }
}
