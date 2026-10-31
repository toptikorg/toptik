import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const loadPolicy = async () => {
  const source = await read("src/lib/orders/health-policy.ts");
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
};

const healthyJob = now => ({
  order_gid: "gid://shopify/Order/1",
  state: "sent", attempts: 1, created_at: new Date(now - 5 * 60_000).toISOString(),
  updated_at: new Date(now - 60_000).toISOString(), locked_at: null,
  sent_at: new Date(now - 60_000).toISOString(), alert_sent_at: null,
  last_error_code: null, invoice_status: "attached",
});

test("order health is healthy only when worker, webhooks, Gmail, recipients and delivery are healthy", async () => {
  const { evaluateOrderHealth } = await loadPolicy();
  const now = Date.now();
  assert.deepEqual(evaluateOrderHealth({
    now, workerCompletedAt: new Date(now - 60_000).toISOString(), webhookCheckedAt: new Date(now - 60_000).toISOString(),
    gmailAuthorized: true, senderConfigured: true, recipientsConfigured: true, jobs: [healthyJob(now)],
    recentPaidOrders: [{ id: "gid://shopify/Order/1", createdAt: new Date(now - 5 * 60_000).toISOString() }],
  }), []);
});

test("monitor catches an unforeseen order failure through outcome invariants", async () => {
  const { evaluateOrderHealth } = await loadPolicy();
  const now = Date.now();
  const issues = evaluateOrderHealth({
    now, workerCompletedAt: new Date(now - 60_000).toISOString(), webhookCheckedAt: new Date(now - 60_000).toISOString(),
    gmailAuthorized: false, senderConfigured: false, recipientsConfigured: false,
    jobs: [{ ...healthyJob(now), state: "retry", sent_at: null, attempts: 4, created_at: new Date(now - 20 * 60_000).toISOString(), last_error_code: "GMAIL_TOKEN_HTTP_400", invoice_status: "attached" }],
    recentPaidOrders: [{ id: "gid://shopify/Order/1", createdAt: new Date(now - 20 * 60_000).toISOString() }],
  });
  for (const code of ["GMAIL_AUTH_UNHEALTHY", "GMAIL_SENDER_MISCONFIGURED", "ORDER_RECIPIENTS_MISCONFIGURED", "ORDER_EMAIL_SLA_BREACH", "ORDER_JOB_REPEATED_RETRY", "ORDER_GMAIL_ERROR"]) assert.ok(issues.includes(code), code);
});

test("monitor catches a stopped cron even when there are no new orders", async () => {
  const { evaluateOrderHealth } = await loadPolicy();
  const now = Date.now();
  const issues = evaluateOrderHealth({
    now, workerCompletedAt: new Date(now - 20 * 60_000).toISOString(), webhookCheckedAt: new Date(now - 20 * 60_000).toISOString(),
    gmailAuthorized: true, senderConfigured: true, recipientsConfigured: true, jobs: [], recentPaidOrders: [],
  });
  assert.deepEqual(issues, ["WEBHOOK_CHECK_STALE", "WORKER_HEARTBEAT_STALE"]);
});

test("monitor catches one paid Shopify order whose webhook never created a job", async () => {
  const { evaluateOrderHealth } = await loadPolicy();
  const now = Date.now();
  const issues = evaluateOrderHealth({
    now, workerCompletedAt: new Date(now - 60_000).toISOString(), webhookCheckedAt: new Date(now - 60_000).toISOString(),
    gmailAuthorized: true, senderConfigured: true, recipientsConfigured: true, jobs: [],
    recentPaidOrders: [{ id: "gid://shopify/Order/999", createdAt: new Date(now - 20 * 60_000).toISOString() }],
  });
  assert.deepEqual(issues, ["PAID_ORDER_WEBHOOK_MISSING"]);
});

test("production monitor checks the public order outcome health endpoint and preserves evidence", async () => {
  const smoke = await read("scripts/production-visual-smoke.mjs");
  const workflow = await read(".github/workflows/production-visual-monitor.yml");
  const shopifyOrder = await read("src/lib/orders/shopify-order.ts");
  const vercel = JSON.parse(await read("vercel.json"));
  assert.match(smoke, /api\/health\/order-automation/);
  assert.match(workflow, /order-health\.json/);
  assert.match(shopifyOrder, /financial_status:paid created_at:>=/);
  assert.match(shopifyOrder, /ORDER_HEALTH_ORDER_LIMIT/);
  assert.ok(vercel.crons.some(job => job.path === "/api/admin/orders/health" && job.schedule === "*\/5 * * * *"));
});
