export const ORDER_DELIVERY_SLA_MS = 15 * 60_000;
export const ORDER_WORKER_HEARTBEAT_SLA_MS = 12 * 60_000;

export type OrderHealthJob = {
  order_gid: string;
  state: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  locked_at: string | null;
  sent_at: string | null;
  alert_sent_at: string | null;
  last_error_code: string | null;
  invoice_status: string;
};

export type OrderHealthInput = {
  now: number;
  workerCompletedAt: string | null;
  webhookCheckedAt: string | null;
  gmailAuthorized: boolean;
  senderConfigured: boolean;
  recipientsConfigured: boolean;
  jobs: OrderHealthJob[];
  recentPaidOrders: Array<{ id: string; createdAt: string }>;
};

function age(now: number, value: string | null) {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? now - parsed : Number.POSITIVE_INFINITY;
}

export function evaluateOrderHealth(input: OrderHealthInput) {
  const issues = new Set<string>();
  if (age(input.now, input.workerCompletedAt) > ORDER_WORKER_HEARTBEAT_SLA_MS) issues.add("WORKER_HEARTBEAT_STALE");
  if (age(input.now, input.webhookCheckedAt) > ORDER_WORKER_HEARTBEAT_SLA_MS) issues.add("WEBHOOK_CHECK_STALE");
  if (!input.gmailAuthorized) issues.add("GMAIL_AUTH_UNHEALTHY");
  if (!input.senderConfigured) issues.add("GMAIL_SENDER_MISCONFIGURED");
  if (!input.recipientsConfigured) issues.add("ORDER_RECIPIENTS_MISCONFIGURED");

  for (const job of input.jobs) {
    const open = ["pending", "processing", "retry", "sending"].includes(job.state);
    if (open && !job.sent_at && age(input.now, job.created_at) > ORDER_DELIVERY_SLA_MS) issues.add("ORDER_EMAIL_SLA_BREACH");
    if (job.state === "failed") issues.add("ORDER_JOB_FAILED");
    if (job.attempts >= 3 && open) issues.add("ORDER_JOB_REPEATED_RETRY");
    if (job.last_error_code?.startsWith("GMAIL_")) issues.add("ORDER_GMAIL_ERROR");
    if (job.state === "held" && (!job.alert_sent_at || job.last_error_code === "GMAIL_DELIVERY_UNCERTAIN")) issues.add("ORDER_JOB_UNALERTED_HOLD");
    if (job.sent_at && ["missing", "missing_alerted", "missing_alert_failed"].includes(job.invoice_status)) issues.add("ORDER_INVOICE_MISSING");
  }
  const jobIds = new Set(input.jobs.map(job => job.order_gid));
  if (input.recentPaidOrders.some(order => age(input.now, order.createdAt) > ORDER_DELIVERY_SLA_MS && !jobIds.has(order.id))) {
    issues.add("PAID_ORDER_WEBHOOK_MISSING");
  }
  return [...issues].sort();
}
