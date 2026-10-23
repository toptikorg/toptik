import "server-only";
import * as XLSX from "xlsx";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { buildMimeMessage, sendGmail } from "./email";

function monthBounds(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("REPORT_MONTH_INVALID");
  const start = new Date(`${month}-01T00:00:00.000Z`);
  if (Number.isNaN(start.valueOf()) || start.toISOString().slice(0, 7) !== month) throw new Error("REPORT_MONTH_INVALID");
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end };
}

function reportWorkbook(rows: Array<Record<string, unknown>>, refunds: Array<Record<string, unknown>>) {
  const workbook = XLSX.utils.book_new();
  const sales = rows.map(row => ({
    "מספר הזמנה": row.order_name,
    "תאריך טיפול": row.sent_at || row.updated_at,
    "סכום ברוטו": row.gross_amount,
    "מע״מ לפי המסמך": row.tax_amount,
    "מטבע": row.currency,
    "אמצעי תשלום": row.payment_gateway,
    "מספר חשבונית": row.invoice_number,
    "תאריך חשבונית": row.invoice_created_at,
    "סכום שהוחזר": row.refunded_amount,
    "עמלת סליקה מאומתת": row.payment_fee,
    "מקור העמלה": row.fee_source,
    "נטו מאומת": row.net_amount,
    "מצב": row.state,
  }));
  const refundRows = refunds.map(row => ({
    "מזהה הזמנה": row.order_gid,
    "תאריך אירוע": row.received_at,
    "סכום החזר": row.refund_amount,
    "מטבע": row.refund_currency,
    "מזהה מסירה": row.delivery_id,
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sales), "עסקאות");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(refundRows), "החזרים");
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

export async function sendPreviousMonthAccountantReport(monthOverride?: string) {
  const recipient = process.env.ACCOUNTANT_EMAIL?.trim();
  if (!recipient || process.env.ACCOUNTANT_EMAIL_VERIFIED !== "true") return { status: "not_configured" };
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const month = monthOverride || previous.toISOString().slice(0, 7);
  const { start, end } = monthBounds(month);
  const supabase = createSupabaseServiceRoleClient();
  const { data: claimed, error: claimError } = await supabase.rpc("claim_toptik_accountant_month", { p_month: `${month}-01`, p_recipient: recipient });
  if (claimError) throw new Error("ACCOUNTANT_REPORT_CLAIM_FAILED");
  if (!claimed) return { status: "already_claimed" };
  const [jobsResult, refundsResult] = await Promise.all([
    supabase.from("toptik_order_automation_jobs").select("order_name,sent_at,updated_at,gross_amount,tax_amount,currency,payment_gateway,invoice_number,invoice_created_at,refunded_amount,payment_fee,fee_source,net_amount,state").gte("updated_at", start.toISOString()).lt("updated_at", end.toISOString()).order("updated_at"),
    supabase.from("toptik_order_automation_events").select("order_gid,received_at,refund_amount,refund_currency,delivery_id").eq("topic", "refunds/create").gte("received_at", start.toISOString()).lt("received_at", end.toISOString()).order("received_at"),
  ]);
  if (jobsResult.error || refundsResult.error) throw new Error("ACCOUNTANT_REPORT_READ_FAILED");
  const bytes = reportWorkbook(jobsResult.data || [], refundsResult.data || []);
  const subject = `TopTik | דוח עסקאות לרואה החשבון | ${month}`;
  const html = `<html lang="he" dir="rtl"><body style="direction:rtl;text-align:right;font-family:Arial,sans-serif"><h1>דוח TopTik לחודש ${month}</h1><p>מצורף דוח העסקאות, החשבוניות, ההחזרים והעמלות הידועות למערכת.</p><p>תאים ריקים בעמלה או בנטו פירושם שלא התקבל נתון רשמי מספק הסליקה, ולא בוצע חישוב משוער.</p></body></html>`;
  try {
    const gmailId = await sendGmail(buildMimeMessage({
      from: process.env.GMAIL_SENDER || "service@toptik.co.il", to: recipient, subject, html,
      attachments: [{ filename: `TopTik-accountant-${month}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes }],
      messageId: `<toptik-accountant-${month}@mail.toptik.co.il>`,
    }));
    await supabase.from("toptik_accountant_monthly_reports").update({ state: "sent", gmail_message_id: gmailId, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("report_month", `${month}-01`);
    return { status: "sent", rows: jobsResult.data?.length || 0, refunds: refundsResult.data?.length || 0 };
  } catch (error) {
    await supabase.from("toptik_accountant_monthly_reports").update({ state: "held", last_error_code: "ACCOUNTANT_GMAIL_UNCERTAIN", updated_at: new Date().toISOString() }).eq("report_month", `${month}-01`);
    throw error;
  }
}
