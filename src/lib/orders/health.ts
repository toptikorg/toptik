import "server-only";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { checkGmailAuthorization } from "./email";
import { evaluateOrderHealth, type OrderHealthJob } from "./health-policy";
import { fetchRecentPaidOrders } from "./shopify-order";

const HEALTH_ROW_ID = true;

function safeErrorCode(error: unknown) {
  const raw = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  return /^[A-Z0-9_]{1,100}$/.test(raw) ? raw : "ORDER_HEALTH_ERROR";
}

export async function markOrderWorkerStarted() {
  const now = new Date().toISOString();
  const { error } = await createSupabaseServiceRoleClient().from("toptik_order_automation_health").upsert({
    id: HEALTH_ROW_ID,
    last_worker_started_at: now,
    last_worker_error_code: null,
    updated_at: now,
  });
  if (error) throw new Error("ORDER_HEALTH_HEARTBEAT_WRITE_FAILED");
}

export async function markOrderWorkerCompleted(webhookChecked: boolean) {
  const now = new Date().toISOString();
  const { error } = await createSupabaseServiceRoleClient().from("toptik_order_automation_health").update({
    last_worker_completed_at: now,
    last_worker_error_code: null,
    ...(webhookChecked ? { last_webhook_check_at: now } : {}),
    updated_at: now,
  }).eq("id", HEALTH_ROW_ID);
  if (error) throw new Error("ORDER_HEALTH_HEARTBEAT_WRITE_FAILED");
}

export async function markOrderWorkerFailed(error: unknown) {
  const now = new Date().toISOString();
  await createSupabaseServiceRoleClient().from("toptik_order_automation_health").update({
    last_worker_error_code: safeErrorCode(error),
    updated_at: now,
  }).eq("id", HEALTH_ROW_ID);
}

function configuredRecipients() {
  const recipients = (process.env.ORDER_OPERATIONS_EMAIL || "").split(",").map(value => value.trim().toLowerCase());
  return ["toptikltd@gmail.com", "service@toptik.co.il"].every(required => recipients.includes(required));
}

export async function runOrderHealthAudit() {
  const startedAt = new Date().toISOString();
  const supabase = createSupabaseServiceRoleClient();
  const { error: startError } = await supabase.from("toptik_order_automation_health")
    .upsert({ id: HEALTH_ROW_ID, last_audit_started_at: startedAt, updated_at: startedAt });
  if (startError) throw new Error("ORDER_HEALTH_AUDIT_WRITE_FAILED");

  const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const [{ data: heartbeat, error: heartbeatError }, { data: jobs, error: jobsError }, recentPaidOrders] = await Promise.all([
    supabase.from("toptik_order_automation_health").select("last_worker_completed_at,last_worker_error_code,last_webhook_check_at").eq("id", HEALTH_ROW_ID).single(),
    supabase.from("toptik_order_automation_jobs").select("order_gid,state,attempts,created_at,updated_at,locked_at,sent_at,alert_sent_at,last_error_code,invoice_status").gte("created_at", cutoff),
    fetchRecentPaidOrders(cutoff),
  ]);
  if (heartbeatError || jobsError) throw new Error("ORDER_HEALTH_READ_FAILED");

  let gmailAuthorized = true;
  try { await checkGmailAuthorization(); }
  catch { gmailAuthorized = false; }

  const issues = evaluateOrderHealth({
    now: Date.now(),
    workerCompletedAt: heartbeat?.last_worker_completed_at ?? null,
    webhookCheckedAt: heartbeat?.last_webhook_check_at ?? null,
    gmailAuthorized,
    senderConfigured: (process.env.GMAIL_SENDER || "").trim().toLowerCase() === "info@toptik.co.il",
    recipientsConfigured: configuredRecipients(),
    jobs: (jobs || []) as OrderHealthJob[],
    recentPaidOrders,
  });
  if (heartbeat?.last_worker_error_code) issues.push("WORKER_LAST_RUN_FAILED");
  const uniqueIssues = [...new Set(issues)].sort();
  const completedAt = new Date().toISOString();
  const { error: writeError } = await supabase.from("toptik_order_automation_health").update({
    last_audit_completed_at: completedAt,
    audit_status: uniqueIssues.length ? "unhealthy" : "healthy",
    issue_codes: uniqueIssues,
    updated_at: completedAt,
  }).eq("id", HEALTH_ROW_ID);
  if (writeError) throw new Error("ORDER_HEALTH_AUDIT_WRITE_FAILED");
  return { status: uniqueIssues.length ? "unhealthy" as const : "healthy" as const, checkedAt: completedAt, issueCodes: uniqueIssues };
}

export async function markOrderAuditFailed(error: unknown) {
  const now = new Date().toISOString();
  await createSupabaseServiceRoleClient().from("toptik_order_automation_health").upsert({
    id: HEALTH_ROW_ID,
    last_audit_completed_at: now,
    audit_status: "unhealthy",
    issue_codes: ["HEALTH_AUDIT_FAILED", safeErrorCode(error)],
    updated_at: now,
  });
}

