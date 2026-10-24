import "server-only";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { fetchPaidOrder } from "./shopify-order";
import { createPackingPdf } from "./packing-pdf";
import { buildMimeMessage, orderEmailHtml, sendGmail, type EmailAttachment } from "./email";
import { downloadTranzilaInvoice, findTranzilaInvoice } from "./tranzila";
import type { PaidOrder } from "./types";

type Job = { order_gid: string; last_topic: string; attempts: number; state: string; sent_at: string | null };

function errorCode(error: unknown) {
  const raw = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  return /^[A-Z0-9_]{1,100}$/.test(raw) ? raw : "ORDER_AUTOMATION_ERROR";
}

function shipmentBlock(order: PaidOrder) {
  if (order.cancelledAt) return "ORDER_CANCELLED";
  if (order.financialStatus !== "PAID") return "ORDER_NOT_PAID";
  if (order.riskRecommendation !== "ACCEPT") return "ORDER_RISK_REVIEW";
  if (order.fulfillmentStatus !== "UNFULFILLED") return "ORDER_ALREADY_FULFILLED";
  if (!order.phone) return "ORDER_PHONE_MISSING";
  if (order.requiresShipping && !order.shippingAddress) return "ORDER_SHIPPING_ADDRESS_MISSING";
  return null;
}

function subject(order: PaidOrder) {
  const amount = Number(order.total.amount).toLocaleString("he-IL", { maximumFractionDigits: 2 });
  const ready = order.requiresShipping ? "מוכן למשלוח" : "מוכן לאיסוף";
  return `TopTik | הזמנה ${order.name.replace(/^#/, "")} | שולם ${amount} ${order.total.currencyCode === "ILS" ? "₪" : order.total.currencyCode} | ${ready}`;
}

function operationalSnapshot(order: PaidOrder) {
  return {
    orderName: order.name,
    createdAt: order.createdAt,
    requiresShipping: order.requiresShipping,
    deliveryType: order.deliveryType,
    shippingMethod: order.shippingMethod,
    pickupLocation: order.pickupLocation?.name ?? null,
    items: order.items.map(({ title, variantTitle, sku, quantity, unitPrice, totalPrice }) => ({ title, variantTitle, sku, quantity, unitPrice, totalPrice })),
  };
}

async function updateJob(orderGid: string, patch: Record<string, unknown>) {
  const { error } = await createSupabaseServiceRoleClient().from("toptik_order_automation_jobs")
    .update({ ...patch, locked_at: null, updated_at: new Date().toISOString() }).eq("order_gid", orderGid);
  if (error) throw new Error("ORDER_JOB_UPDATE_FAILED");
}

async function alertOwner(order: PaidOrder | null, code: string) {
  const to = process.env.ORDER_ALERT_EMAIL || "talns33@gmail.com";
  const from = process.env.GMAIL_SENDER || "service@toptik.co.il";
  const label = order?.name || "לא ידועה";
  const html = `<html lang="he" dir="rtl"><body style="direction:rtl;text-align:right;font-family:Arial,sans-serif"><h1>נדרשת בדיקה בהזמנה ${label}</h1><p>קוד טיפול: ${code}</p><p>לא נשלחה ליעקב הוראת משלוח רגילה.</p></body></html>`;
  return sendGmail(buildMimeMessage({ from, to, subject: `TopTik | נדרשת בדיקה בהזמנה ${label}`, html, attachments: [] }));
}

async function processJob(job: Job) {
  if (["orders/cancelled", "refunds/create"].includes(job.last_topic)) {
    const order = await fetchPaidOrder(job.order_gid).catch(() => null);
    const messageId = await alertOwner(order, "ORDER_CHANGED_AFTER_PAYMENT");
    await updateJob(job.order_gid, {
      state: "held", last_error_code: "ORDER_CHANGED_AFTER_PAYMENT", alert_sent_at: new Date().toISOString(), alert_gmail_message_id: messageId,
      ...(order ? {
        order_name: order.name, financial_status: order.financialStatus,
        gross_amount: Number(order.total.amount), tax_amount: order.tax ? Number(order.tax.amount) : null,
        refunded_amount: Number(order.refunded.amount), currency: order.total.currencyCode,
      } : {}),
    });
    return "held";
  }
  const order = await fetchPaidOrder(job.order_gid);
  if (!order) throw new Error("ORDER_NOT_FOUND");
  const blocked = shipmentBlock(order);
  if (blocked) {
    const messageId = await alertOwner(order, blocked);
    await updateJob(job.order_gid, { state: "held", last_error_code: blocked, alert_sent_at: new Date().toISOString(), alert_gmail_message_id: messageId });
    return "held";
  }

  const invoice = await findTranzilaInvoice(order);
  if (!invoice && job.attempts < 4) {
    await updateJob(job.order_gid, { state: "retry", next_attempt_at: new Date(Date.now() + 2 * 60_000).toISOString(), last_error_code: "INVOICE_PENDING" });
    return "retry";
  }
  const attachments: EmailAttachment[] = [{
    filename: `TopTik-order-${order.name.replace(/\D/g, "")}.pdf`, contentType: "application/pdf", bytes: await createPackingPdf(order),
  }];
  if (invoice) attachments.push({ filename: `Tranzila-invoice-${invoice.number}.pdf`, contentType: "application/pdf", bytes: await downloadTranzilaInvoice(invoice.id) });

  const from = process.env.GMAIL_SENDER || "service@toptik.co.il";
  const to = process.env.ORDER_OPERATIONS_EMAIL || "toptikltd@gmail.com";
  const stableMessageId = `<toptik-order-${order.id.split("/").pop()}@mail.toptik.co.il>`;
  const prepared = {
    state: "sending", order_name: order.name, payment_transaction_gid: order.payment.id,
    payment_gateway: order.payment.formattedGateway || order.payment.gateway,
    gross_amount: Number(order.total.amount), tax_amount: order.tax ? Number(order.tax.amount) : null,
    refunded_amount: Number(order.refunded.amount), financial_status: order.financialStatus,
    currency: order.total.currencyCode, invoice_document_id: invoice?.id ?? null,
    invoice_number: invoice?.number ?? null, invoice_created_at: invoice?.createdAt ?? null,
    invoice_status: invoice ? "attached" : "missing", last_error_code: null,
    order_snapshot: operationalSnapshot(order), outbound_message_id: stableMessageId,
  };
  await updateJob(job.order_gid, prepared);
  let gmailMessageId: string;
  try {
    gmailMessageId = await sendGmail(buildMimeMessage({
      from, to, subject: subject(order), html: orderEmailHtml(order, invoice), attachments, messageId: stableMessageId,
    }));
  } catch (error) {
    const code = errorCode(error);
    const definitelyRejected = /^GMAIL_(?:TOKEN_.*|SEND_HTTP_4\d\d)$/.test(code);
    await updateJob(job.order_gid, {
      state: definitelyRejected ? "retry" : "held",
      next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      last_error_code: definitelyRejected ? code : "GMAIL_DELIVERY_UNCERTAIN",
    });
    return definitelyRejected ? "retry" : "held";
  }
  await updateJob(job.order_gid, {
    state: "sent", gmail_message_id: gmailMessageId, sent_at: new Date().toISOString(),
    invoice_status: invoice ? "attached" : "missing", last_error_code: null,
  });
  if (!invoice) {
    try {
      const alertMessageId = await alertOwner(order, "INVOICE_MISSING_AFTER_WAIT");
      await updateJob(job.order_gid, { invoice_status: "missing_alerted", alert_sent_at: new Date().toISOString(), alert_gmail_message_id: alertMessageId });
    } catch {
      await updateJob(job.order_gid, { invoice_status: "missing_alert_failed", last_error_code: "INVOICE_MISSING_ALERT_FAILED" });
    }
  }
  return "sent";
}

export async function runOrderAutomation(limit = 5) {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await supabase.rpc("claim_toptik_order_jobs", { p_limit: limit });
  if (error) throw new Error("ORDER_JOB_CLAIM_FAILED");
  const results: Array<{ orderGid: string; result: string }> = [];
  for (const job of (data || []) as Job[]) {
    try { results.push({ orderGid: job.order_gid, result: await processJob(job) }); }
    catch (error) {
      const code = errorCode(error);
      const terminal = job.attempts >= 8;
      await updateJob(job.order_gid, { state: terminal ? "failed" : "retry", next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(), last_error_code: code });
      results.push({ orderGid: job.order_gid, result: terminal ? "failed" : "retry" });
    }
  }
  return results;
}

