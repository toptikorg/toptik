import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

const TOPICS = new Set(["orders/paid", "orders/updated", "orders/cancelled", "refunds/create"]);

function equalSignature(received: string, expected: Buffer) {
  try {
    const decoded = Buffer.from(received, "base64");
    return decoded.length === expected.length && timingSafeEqual(decoded, expected);
  } catch { return false; }
}

export function verifyOrderWebhook(input: {
  rawBody: string; signature: string | null; deliveryId: string | null;
  topic: string | null; shopDomain: string | null;
}) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const expectedShop = process.env.SHOPIFY_SHOP_DOMAIN?.trim().toLowerCase();
  if (!secret || !expectedShop) return { ok: false as const, reason: "unconfigured" };
  if (Buffer.byteLength(input.rawBody, "utf8") > 1_000_000) return { ok: false as const, reason: "too_large" };
  const signature = input.signature;
  if (!signature || !equalSignature(signature, createHmac("sha256", secret).update(input.rawBody).digest())) {
    return { ok: false as const, reason: "bad_signature" };
  }
  const shop = input.shopDomain?.trim().toLowerCase().replace(/\.$/, "");
  if (shop !== expectedShop.replace(/\.$/, "")) return { ok: false as const, reason: "wrong_shop" };
  if (!input.deliveryId?.trim() || !input.topic || !TOPICS.has(input.topic)) {
    return { ok: false as const, reason: "unsupported_topic" };
  }
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(input.rawBody) as Record<string, unknown>; }
  catch { return { ok: false as const, reason: "bad_payload" }; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false as const, reason: "bad_payload" };
  const id = payload.id;
  const gid = payload.admin_graphql_api_id;
  const orderGid = typeof gid === "string" && /^gid:\/\/shopify\/(?:Order|Refund)\/[1-9]\d*$/.test(gid)
    ? gid
    : typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? `gid://shopify/${input.topic === "refunds/create" ? "Refund" : "Order"}/${id}`
      : null;
  if (!orderGid) return { ok: false as const, reason: "bad_payload" };
  return { ok: true as const, event: { deliveryId: input.deliveryId.trim(), topic: input.topic, shopDomain: shop, orderGid, payload } };
}

