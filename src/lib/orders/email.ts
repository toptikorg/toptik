import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { InvoiceDocument, PaidOrder } from "./types";

export type EmailAttachment = { filename: string; contentType: string; bytes: Uint8Array };

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function b64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64").replace(/(.{76})/g, "$1\r\n");
}

function encodedHeader(value: string) { return `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`; }

function safeHeader(value: string) {
  if (/[\r\n]/.test(value)) throw new Error("EMAIL_HEADER_INVALID");
  return value;
}

function safeFilename(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned.startsWith(".")) throw new Error("EMAIL_ATTACHMENT_FILENAME_INVALID");
  return cleaned;
}

function addressValue(a: PaidOrder["shippingAddress"]) {
  return a ? [a.address1, a.address2, a.city, a.zip, a.country].filter(Boolean).join(", ") : "חסרה כתובת";
}

function money(amount: string | number, currency: string) {
  return `${Number(amount).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency === "ILS" ? "₪" : currency}`;
}

function formatDate(value: string | null) {
  if (!value) return "לא צוין";
  return new Intl.DateTimeFormat("he-IL", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Jerusalem" }).format(new Date(value));
}

function colorOrVariant(item: PaidOrder["items"][number]) {
  if (item.variantTitle && item.variantTitle !== "Default Title") return item.variantTitle;
  return item.title.match(/(?:בצבע|צבע)\s+(.+)$/)?.[1] || item.title.match(/[–—-]\s*([^–—-]+)$/)?.[1] || "לא צוין בנפרד";
}

function invoiceType(type: string) {
  return ({ IR: "חשבונית מס/קבלה", I: "חשבונית מס", R: "קבלה" } as Record<string, string>)[type] || type;
}

export function orderEmailHtml(order: PaidOrder, invoice: InvoiceDocument | null) {
  const isPickup = order.deliveryType === "PICK_UP" || !order.requiresShipping;
  const missing = [
    !order.email && "מייל לקוח", !order.phone && "טלפון לקוח",
    !isPickup && !order.shippingAddress && "כתובת משלוח",
    isPickup && !order.pickupLocation && "כתובת נקודת האיסוף",
    order.items.some(item => !item.sku) && "מק״ט באחד הפריטים",
  ].filter(Boolean);
  const items = order.items.map(item => `<div style="border:1px solid #d7dde3;border-radius:8px;padding:14px;margin:10px 0">
    <div style="font-size:20px;font-weight:700">${escapeHtml(item.title)}</div>
    <div><strong>דגם, צבע או גרסה:</strong> ${escapeHtml(colorOrVariant(item))}</div>
    <div><strong>מק״ט:</strong> ${escapeHtml(item.sku || "חסר")}</div>
    <div><strong>כמות:</strong> ${item.quantity}</div>
    <div><strong>מחיר ליחידה:</strong> ${escapeHtml(money(item.unitPrice.amount, item.unitPrice.currencyCode))}</div>
    <div><strong>מחיר שורה:</strong> ${escapeHtml(money(item.totalPrice.amount, item.totalPrice.currencyCode))}</div>
  </div>`).join("");
  const destination = isPickup
    ? `<div style="background:#fff7cc;padding:16px;border-radius:8px"><strong style="font-size:22px">איסוף עצמי</strong><br><strong>מקום האיסוף:</strong> ${escapeHtml(order.pickupLocation?.name || "חסר")}<br><strong>כתובת האיסוף:</strong> ${escapeHtml(addressValue(order.pickupLocation))}<br><strong>טלפון במקום:</strong> ${escapeHtml(order.pickupLocation?.phone || "לא צוין")}</div>`
    : `<div style="background:#eaf4ff;padding:16px;border-radius:8px"><strong style="font-size:22px">משלוח ללקוח</strong><br><strong>נמען:</strong> ${escapeHtml(order.shippingAddress?.name || order.customerName)}<br><strong>כתובת מלאה:</strong> ${escapeHtml(addressValue(order.shippingAddress))}<br><strong>שיטת משלוח:</strong> ${escapeHtml(order.shippingMethod || "לא צוינה")}</div>`;
  const terms = order.paymentTerms?.name || (order.financialStatus === "PAID" ? "תשלום מלא בעת ההזמנה" : "לא צוינו");
  const invoiceBlock = invoice
    ? `<div><strong>מסמך:</strong> ${escapeHtml(invoiceType(invoice.type))}<br><strong>מספר מסמך:</strong> ${escapeHtml(invoice.number)}<br><strong>תאריך הפקה:</strong> ${escapeHtml(formatDate(invoice.createdAt))}<br><strong>סכום במסמך:</strong> ${escapeHtml(money(invoice.amount, invoice.currency))}<br><strong>קובץ מקורי:</strong> מצורף למייל</div>`
    : `<div style="background:#fff1f2;color:#991b1b;padding:12px;border-radius:8px;font-weight:700">החשבונית המקורית עדיין לא נמצאה. טל קיבל התראה לטיפול. אין להתייחס לדף ההזמנה כחשבונית.</div>`;
  return `<!doctype html><html lang="he" dir="rtl"><body style="direction:rtl;text-align:right;font-family:Arial,sans-serif;color:#18212b;font-size:18px;line-height:1.55">
  <div style="max-width:720px;margin:auto;border:1px solid #d7dde3;border-radius:12px;padding:24px">
  <div style="background:#dcfce7;color:#166534;padding:16px;border-radius:8px;font-size:24px;font-weight:700">העסקה אושרה ושולמה</div>
  <h1 style="font-size:28px">הזמנה ${escapeHtml(order.name.replace(/^#/, ""))}, מוכנה לטיפול</h1>
  ${missing.length ? `<div style="background:#fee2e2;color:#991b1b;padding:14px;border-radius:8px;font-weight:700">עצור, חסר ${missing.join(" וגם ")}. אין לשלוח לפני בירור.</div>` : ""}
  <h2>למי מוסרים</h2>
  <p><strong>שם הלקוח:</strong> ${escapeHtml(order.customerName)}<br><strong>מייל:</strong> ${escapeHtml(order.email || "חסר")}<br><strong>טלפון:</strong> ${escapeHtml(order.phone || "חסר")}</p>
  ${destination}
  <h2>מה להכין</h2>${items}
  <h2>תשלום</h2>
  <p><strong>מצב:</strong> שולם ואושר<br><strong>סכום ששולם:</strong> ${escapeHtml(money(order.total.amount, order.total.currencyCode))}<br><strong>אופן תשלום:</strong> ${escapeHtml(order.payment.formattedGateway || order.payment.gateway)}<br><strong>מועד אישור התשלום:</strong> ${escapeHtml(formatDate(order.payment.processedAt))}<br><strong>תנאי תשלום:</strong> ${escapeHtml(terms)}<br><strong>תאריך ההזמנה:</strong> ${escapeHtml(formatDate(order.createdAt))}</p>
  <h2>חשבונית</h2>${invoiceBlock}
  <p><strong>מצורף גם דף טיפול בגודל A4 להדפסה.</strong></p>
  </div></body></html>`;
}

export function buildMimeMessage(input: { from: string; to: string; subject: string; html: string; attachments: EmailAttachment[]; messageId?: string }) {
  const boundary = `toptik_${randomBytes(16).toString("hex")}`;
  const from = safeHeader(input.from);
  const to = safeHeader(input.to);
  const subject = safeHeader(input.subject);
  const messageId = safeHeader(input.messageId || `<${createHash("sha256").update(`${to}\0${subject}`).digest("hex")}@mail.toptik.co.il>`);
  const parts = [
    `From: TopTik <${from}>`, `To: ${to}`, `Subject: ${encodedHeader(subject)}`, `Message-ID: ${messageId}`,
    "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    b64(Buffer.from(input.html, "utf8")),
  ];
  for (const attachment of input.attachments) {
    const filename = safeFilename(attachment.filename);
    parts.push(`--${boundary}`, `Content-Type: ${attachment.contentType}; name="${filename}"`,
      "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${filename}"`, "", b64(attachment.bytes));
  }
  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}

async function gmailAccessToken() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("GMAIL_OAUTH_NOT_CONFIGURED");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`GMAIL_TOKEN_HTTP_${response.status}`);
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error("GMAIL_TOKEN_MISSING");
  return data.access_token;
}

export async function sendGmail(rawMime: string) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${await gmailAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(rawMime).toString("base64url") }),
  });
  if (!response.ok) throw new Error(`GMAIL_SEND_HTTP_${response.status}`);
  const data = await response.json() as { id?: string };
  if (!data.id) throw new Error("GMAIL_MESSAGE_ID_MISSING");
  return data.id;
}

