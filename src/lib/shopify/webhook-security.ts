import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_WEBHOOK_BYTES = 1_000_000;
const PRODUCT_TOPICS = new Set([
  "products/create",
  "products/update",
  "products/delete",
]);

export type VerifiedProductWebhook = {
  deliveryId: string;
  topic: string;
  shopDomain: string;
  payload: Record<string, unknown>;
};

export type WebhookCheck =
  | { ok: true; event: VerifiedProductWebhook }
  | { ok: false; reason: "unconfigured" | "too_large" | "bad_signature" | "wrong_shop" | "unsupported_topic" | "bad_payload" };

function safeEqualBase64(received: string, expected: Buffer): boolean {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(received, "base64");
  } catch {
    return false;
  }
  return decoded.length === expected.length && timingSafeEqual(decoded, expected);
}

/** Verify Shopify's HMAC against the exact raw request body before parsing it. */
export function verifyProductWebhook(input: {
  rawBody: string;
  signature: string | null;
  deliveryId: string | null;
  topic: string | null;
  shopDomain: string | null;
  secret: string | undefined;
  expectedShop: string | undefined;
}): WebhookCheck {
  const { rawBody, signature, deliveryId, topic, shopDomain, secret, expectedShop } = input;
  if (!secret || !expectedShop) return { ok: false, reason: "unconfigured" };
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) return { ok: false, reason: "too_large" };
  if (!signature || !safeEqualBase64(signature, createHmac("sha256", secret).update(rawBody, "utf8").digest())) {
    return { ok: false, reason: "bad_signature" };
  }

  const normalizedShop = shopDomain?.trim().toLowerCase().replace(/\.$/, "");
  const normalizedExpectedShop = expectedShop.trim().toLowerCase().replace(/\.$/, "");
  if (!normalizedShop || normalizedShop !== normalizedExpectedShop) return { ok: false, reason: "wrong_shop" };
  if (!deliveryId?.trim() || !topic || !PRODUCT_TOPICS.has(topic)) return { ok: false, reason: "unsupported_topic" };

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "bad_payload" };
  const record = payload as Record<string, unknown>;
  if (typeof record.id !== "number" && typeof record.id !== "string") return { ok: false, reason: "bad_payload" };

  return {
    ok: true,
    event: {
      deliveryId: deliveryId.trim(),
      topic,
      shopDomain: normalizedShop,
      payload: record,
    },
  };
}
