import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { verifyOrderWebhook } from "@/lib/orders/webhook-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function refundMoney(topic: string, payload: Record<string, unknown>) {
  if (topic !== "refunds/create") return { amount: null, currency: null };
  const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
  let currency: string | null = null;
  let amount = 0;
  let found = false;
  for (const value of transactions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const transaction = value as Record<string, unknown>;
    if (String(transaction.status || "").toLowerCase() !== "success") continue;
    const number = Number(transaction.amount);
    const code = typeof transaction.currency === "string" ? transaction.currency : null;
    if (!Number.isFinite(number) || number < 0 || !code || (currency && currency !== code)) return { amount: null, currency: null };
    amount += number; currency = code; found = true;
  }
  return found ? { amount, currency } : { amount: null, currency: null };
}

export async function POST(request: NextRequest) {
  if (Number(request.headers.get("content-length") || 0) > 1_000_000) {
    return NextResponse.json({ error: "Webhook rejected" }, { status: 413 });
  }
  const rawBody = await request.text();
  const checked = verifyOrderWebhook({
    rawBody,
    signature: request.headers.get("x-shopify-hmac-sha256"),
    deliveryId: request.headers.get("x-shopify-webhook-id"),
    topic: request.headers.get("x-shopify-topic"),
    shopDomain: request.headers.get("x-shopify-shop-domain"),
  });
  if (!checked.ok) {
    const status = checked.reason === "unconfigured" ? 503 : checked.reason === "too_large" ? 413 :
      checked.reason === "bad_signature" || checked.reason === "wrong_shop" ? 401 : 400;
    return NextResponse.json({ error: "Webhook rejected" }, { status });
  }
  const supabase = createSupabaseServiceRoleClient();
  const event = checked.event;
  const orderGid = event.topic === "refunds/create"
    ? typeof event.payload.order_id === "number" ? `gid://shopify/Order/${event.payload.order_id}` : null
    : event.orderGid;
  if (!orderGid) return NextResponse.json({ error: "Webhook rejected" }, { status: 400 });
  const refund = refundMoney(event.topic, event.payload);
  const { error } = await supabase.rpc("enqueue_toptik_order_event", {
    p_delivery_id: event.deliveryId,
    p_topic: event.topic,
    p_shop_domain: event.shopDomain,
    p_order_gid: orderGid,
    p_payload_sha256: createHash("sha256").update(rawBody).digest("hex"),
    p_refund_amount: refund.amount,
    p_refund_currency: refund.currency,
  });
  if (error) {
    console.error("Order webhook queue failed", { code: error.code });
    return NextResponse.json({ error: "Webhook could not be queued" }, { status: 503 });
  }
  return new NextResponse(null, { status: 200 });
}

