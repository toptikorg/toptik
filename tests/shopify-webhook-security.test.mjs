import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync("src/lib/shopify/webhook-security.ts", "utf8")
  .replace('import "server-only";', "");
const { verifyProductWebhook } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

const secret = "test-secret-never-production";
const body = JSON.stringify({ id: 123, variants: [{ sku: "SKU-1" }] });
const signature = createHmac("sha256", secret).update(body).digest("base64");
const base = {
  rawBody: body,
  signature,
  deliveryId: "delivery-1",
  topic: "products/update",
  shopDomain: "toptikcoil.myshopify.com",
  secret,
  expectedShop: "toptikcoil.myshopify.com",
};

test("accepts a correctly signed product event for the configured shop", () => {
  const result = verifyProductWebhook(base);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.event.deliveryId, "delivery-1");
    assert.equal(result.event.topic, "products/update");
    assert.equal(result.event.payload.id, 123);
  }
});

test("rejects missing configuration, invalid HMAC, wrong shop, and unsupported topic", () => {
  assert.deepEqual(verifyProductWebhook({ ...base, secret: undefined }), { ok: false, reason: "unconfigured" });
  assert.deepEqual(verifyProductWebhook({ ...base, signature: "invalid" }), { ok: false, reason: "bad_signature" });
  assert.deepEqual(verifyProductWebhook({ ...base, shopDomain: "attacker.myshopify.com" }), { ok: false, reason: "wrong_shop" });
  assert.deepEqual(verifyProductWebhook({ ...base, topic: "orders/create" }), { ok: false, reason: "unsupported_topic" });
});

test("rejects unsigned, oversized, malformed, and structurally invalid payloads", () => {
  assert.deepEqual(verifyProductWebhook({ ...base, signature: null }), { ok: false, reason: "bad_signature" });
  assert.deepEqual(verifyProductWebhook({ ...base, rawBody: "x".repeat(1_000_001) }), { ok: false, reason: "too_large" });
  const malformed = "not-json";
  assert.deepEqual(verifyProductWebhook({ ...base, rawBody: malformed, signature: createHmac("sha256", secret).update(malformed).digest("base64") }), { ok: false, reason: "bad_payload" });
  const noId = "{}";
  assert.deepEqual(verifyProductWebhook({ ...base, rawBody: noId, signature: createHmac("sha256", secret).update(noId).digest("base64") }), { ok: false, reason: "bad_payload" });
});

test("the database inbox deduplicates delivery ids and keeps sync tables private", () => {
  const migration = readFileSync("supabase/migrations/20260930_shopify_gallery_sync_inbox.sql", "utf8");
  assert.match(migration, /delivery_id text not null unique/i);
  assert.match(migration, /alter table public\.shopify_webhook_events enable row level security/i);
  assert.match(migration, /Deliberately create no policies/i);
  assert.doesNotMatch(migration, /create policy/i);
});
