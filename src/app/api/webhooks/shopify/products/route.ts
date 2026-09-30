import { NextRequest, NextResponse } from "next/server";
import { verifyProductWebhook } from "@/lib/shopify/webhook-security";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { hasSupabaseAdminEnv } from "@/lib/supabase/env";
import { scheduleShopifySync } from "@/lib/shopify/schedule-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const MAX_WEBHOOK_BYTES = 1_000_000;

async function readBoundedBody(request: NextRequest): Promise<{ body: string; tooLarge: boolean }> {
  const reader = request.body?.getReader();
  if (!reader) return { body: "", tooLarge: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      return { body: "", tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(bytes), tooLarge: false };
}

/**
 * Shopify product webhook inbox. It authenticates and durably deduplicates
 * events; it intentionally does not edit gallery records in the HTTP request.
 * The scheduled worker reconciles exact SKU bindings and customer-visible copy.
 */
export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 1_000_000) {
    return NextResponse.json({ error: "Webhook rejected" }, { status: 413 });
  }
  const { body: rawBody, tooLarge } = await readBoundedBody(request);
  if (tooLarge) return NextResponse.json({ error: "Webhook rejected" }, { status: 413 });
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
    if (error?.code === "23505") {
      scheduleShopifySync();
      return new NextResponse(null, { status: 200 });
    }
    if (error) {
      console.error("Shopify webhook inbox insert failed", { code: error.code });
      return NextResponse.json({ error: "Webhook could not be queued" }, { status: 503 });
    }
    scheduleShopifySync();
    return new NextResponse(null, { status: 200 });
  } catch (error) {
    console.error("Shopify webhook receiver unavailable", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Webhook receiver unavailable" }, { status: 503 });
  }
}
