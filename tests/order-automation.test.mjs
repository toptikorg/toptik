import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import bidiFactory from "bidi-js";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const toModule = (source) => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

test("Shopify order webhooks verify HMAC, shop, topic and delivery id", async () => {
  let source = await read("src/lib/orders/webhook-security.ts");
  source = source.replace(/^import[^;]+;\s*$/gm, "");
  const key = `__order_crypto_${Math.random().toString(36).slice(2)}`;
  globalThis[key] = { createHmac, timingSafeEqual };
  const mod = await toModule(`const { createHmac, timingSafeEqual } = globalThis["${key}"];\n${source}`);
  const previous = { ...process.env };
  process.env.SHOPIFY_WEBHOOK_SECRET = "test-secret";
  process.env.SHOPIFY_SHOP_DOMAIN = "toptikcoil.myshopify.com";
  try {
    const rawBody = JSON.stringify({ id: 1062, admin_graphql_api_id: "gid://shopify/Order/1062" });
    const signature = createHmac("sha256", "test-secret").update(rawBody).digest("base64");
    const base = { rawBody, signature, deliveryId: "delivery-1", topic: "orders/paid", shopDomain: "toptikcoil.myshopify.com" };
    assert.equal(mod.verifyOrderWebhook(base).ok, true);
    assert.deepEqual(mod.verifyOrderWebhook({ ...base, signature: "bad" }), { ok: false, reason: "bad_signature" });
    assert.deepEqual(mod.verifyOrderWebhook({ ...base, shopDomain: "other.myshopify.com" }), { ok: false, reason: "wrong_shop" });
    assert.deepEqual(mod.verifyOrderWebhook({ ...base, topic: "orders/create" }), { ok: false, reason: "unsupported_topic" });
  } finally {
    process.env = previous;
    delete globalThis[key];
  }
});

test("outbound email has RTL HTML and a stable RFC message id", async () => {
  let source = await read("src/lib/orders/email.ts");
  source = source.replace(/^import[^;]+;\s*$/gm, "");
  const key = `__order_email_${Math.random().toString(36).slice(2)}`;
  globalThis[key] = { createHash, randomBytes };
  const mod = await toModule(`const { createHash, randomBytes } = globalThis["${key}"];\n${source}`);
  const order = {
    id: "gid://shopify/Order/1062", name: "#1062", createdAt: "2026-10-23T07:46:02Z",
    cancelledAt: null, financialStatus: "PAID", fulfillmentStatus: "UNFULFILLED", riskRecommendation: "ACCEPT",
    customerName: "לקוח בדיקה", email: "customer@example.com", phone: "0500000000", requiresShipping: true,
    deliveryType: "SHIPPING", shippingMethod: "משלוח חינם", pickupLocation: null,
    total: { amount: "650", currencyCode: "ILS" }, tax: null, refunded: { amount: "0", currencyCode: "ILS" },
    payment: { id: "payment", gateway: "PayPal", formattedGateway: "PayPal", processedAt: null },
    paymentTerms: null,
    shippingAddress: { name: "לקוח בדיקה", phone: "0500000000", address1: "רחוב 1", address2: null, city: "תל אביב", zip: "1234567", country: "ישראל" },
    billingAddress: null, items: [{ title: "מוצר בדיקה בצבע כחול", variantTitle: null, sku: "SKU1", quantity: 1, unitPrice: { amount: "650", currencyCode: "ILS" }, totalPrice: { amount: "650", currencyCode: "ILS" } }],
  };
  const html = mod.orderEmailHtml(order, { id: "doc", number: "30007", type: "IR", amount: 650, currency: "ILS", createdAt: "2026-10-23T08:00:00Z" });
  assert.match(html, /<html lang="he" dir="rtl">/);
  assert.match(html, /תאריך ההזמנה/);
  assert.match(html, /SKU1/);
  assert.match(html, /customer@example\.com/);
  assert.match(html, /חשבונית מס\/קבלה/);
  assert.match(html, /30007/);
  const raw = mod.buildMimeMessage({ from: "service@toptik.co.il", to: "toptikltd@gmail.com", subject: "בדיקה", html, attachments: [], messageId: "<toptik-order-1062@mail.toptik.co.il>" });
  assert.match(raw, /Message-ID: <toptik-order-1062@mail\.toptik\.co\.il>/);
  assert.throws(() => mod.buildMimeMessage({ from: "a@example.com\r\nBcc: x@example.com", to: "b@example.com", subject: "x", html: "x", attachments: [] }), /EMAIL_HEADER_INVALID/);
  assert.throws(() => mod.buildMimeMessage({ from: "a@example.com", to: "b@example.com", subject: "x", html: "x", attachments: [{ filename: "../invoice.pdf", contentType: "application/pdf", bytes: new Uint8Array() }] }), /EMAIL_ATTACHMENT_FILENAME_INVALID/);
  delete globalThis[key];
});

test("database and worker enforce idempotency and fail closed around email delivery", async () => {
  const migration = await read("supabase/migrations/20261023_order_automation.sql");
  const worker = await read("src/lib/orders/worker.ts");
  assert.match(migration, /delivery_id text primary key/);
  assert.match(migration, /on conflict \(delivery_id\) do nothing/);
  assert.match(migration, /state in \('pending','processing','retry','sending','held','sent','failed'\)/);
  assert.match(migration, /language plpgsql security invoker/);
  assert.doesNotMatch(migration, /security definer/i);
  assert.match(migration, /revoke all on function .* from public, anon, authenticated/);
  assert.match(migration, /excluded\.last_topic not in \('orders\/cancelled','refunds\/create'\)/);

  const preparing = worker.indexOf('state: "sending"');
  const sending = worker.indexOf("gmailMessageId = await sendGmail");
  const sent = worker.indexOf('state: "sent", gmail_message_id');
  const missingAlert = worker.indexOf('alertOwner(order, "INVOICE_MISSING_AFTER_WAIT")');
  assert.ok(preparing > 0 && preparing < sending, "job is durably marked sending before Gmail");
  assert.ok(sent > sending && sent < missingAlert, "successful send is durably recorded before a secondary alert");
  assert.match(worker, /GMAIL_DELIVERY_UNCERTAIN/);
  assert.match(worker, /operationalSnapshot\(order\)/);
  assert.match(worker, /לא נשלחה ליעקב הוראת משלוח רגילה/);
  assert.doesNotMatch(worker, /לא נשלחה לאבי הוראת משלוח רגילה/);
  assert.doesNotMatch(worker, /order_snapshot:\s*order[,}]/, "full customer PII is not persisted");
});

test("Tranzila document reads use the required server-side HMAC headers", async () => {
  const source = await read("src/lib/orders/tranzila.ts");
  assert.match(source, /TRANZILA_API_APP_KEY/);
  assert.match(source, /TRANZILA_API_SECRET/);
  assert.match(source, /randomBytes\(40\)\.toString\("hex"\)/);
  assert.match(source, /createHmac\("sha256", `\$\{secret\}\$\{timestamp\}\$\{nonce\}`\)\.update\(appKey\)\.digest\("hex"\)/);
  for (const header of ["x-tranzila-api-app-key", "x-tranzila-api-request-time", "x-tranzila-api-nonce", "x-tranzila-api-access-token"]) {
    assert.match(source, new RegExp(header));
  }
  assert.doesNotMatch(source, /TRANZILA_API_(?:APP_KEY|SECRET)\s*\|\|/);
});

test("Hebrew packing slip is generated as a valid PDF", async () => {
  let source = await read("src/lib/orders/packing-pdf.ts");
  source = source.replace(/^import[^;]+;\s*$/gm, "");
  const key = `__packing_pdf_${Math.random().toString(36).slice(2)}`;
  globalThis[key] = { readFile, path, PDFDocument, rgb, fontkit, bidiFactory };
  const mod = await toModule(`const { readFile, path, PDFDocument, rgb, fontkit, bidiFactory } = globalThis["${key}"];\n${source}`);
  const order = {
    id: "gid://shopify/Order/1062", name: "#1062", createdAt: "2026-10-23T07:46:02Z",
    cancelledAt: null, financialStatus: "PAID", fulfillmentStatus: "UNFULFILLED", riskRecommendation: "ACCEPT",
    customerName: "לקוח בדיקה", email: "customer@example.com", phone: "0500000000", requiresShipping: true,
    deliveryType: "SHIPPING", shippingMethod: "משלוח חינם", pickupLocation: null,
    total: { amount: "650", currencyCode: "ILS" }, tax: null, refunded: { amount: "0", currencyCode: "ILS" },
    payment: { id: "payment", gateway: "PayPal", formattedGateway: "PayPal", processedAt: null },
    paymentTerms: null,
    shippingAddress: { name: "לקוח בדיקה", phone: "0500000000", address1: "רחוב תמנע 22", address2: null, city: "תל אביב", zip: "6731522", country: "ישראל" },
    billingAddress: null, items: [{ title: "טרולי סמסונייט כחול", variantTitle: null, sku: "KO701005", quantity: 1, unitPrice: { amount: "650", currencyCode: "ILS" }, totalPrice: { amount: "650", currencyCode: "ILS" } }],
  };
  const bytes = await mod.createPackingPdf(order);
  assert.ok(bytes.length > 1_000);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-");
  delete globalThis[key];
});

test("monthly accountant report is verified-recipient only and never estimates fees", async () => {
  const source = await read("src/lib/orders/accountant-report.ts");
  const migration = await read("supabase/migrations/20261023_order_automation_accountant_reports.sql");
  const vercel = JSON.parse(await read("vercel.json"));
  assert.match(source, /ACCOUNTANT_EMAIL_VERIFIED !== "true"/);
  assert.match(source, /עמלת סליקה מאומתת/);
  assert.match(source, /לא בוצע חישוב משוער/);
  assert.match(source, /claim_toptik_accountant_month/);
  assert.match(migration, /report_month date primary key/);
  assert.match(migration, /security invoker/);
  assert.ok(vercel.crons.some(cron => cron.path === "/api/admin/orders/monthly-report"));
});

test("order automation installs only the fixed idempotent Shopify webhooks", async () => {
  const source = await read("src/lib/orders/shopify-webhooks.ts");
  const route = await read("src/app/api/admin/orders/automation/route.ts");
  assert.match(source, /https:\/\/landing\.toptik\.co\.il\/api\/webhooks\/shopify\/orders/);
  for (const topic of ["ORDERS_PAID", "ORDERS_UPDATED", "ORDERS_CANCELLED", "REFUNDS_CREATE"]) {
    assert.match(source, new RegExp(`"${topic}"`));
  }
  assert.match(source, /webhookSubscriptions\(first: 50, uri: \$uri\)/);
  assert.match(source, /if \(existing\.has\(topic\)\) continue/);
  assert.doesNotMatch(source, /process\.env\.[A-Z_]*WEBHOOK_URI/);
  assert.match(route, /ensureOrderWebhookSubscriptions\(\)/);
});

