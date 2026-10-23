import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import bidiFactory from "bidi-js";
import type { PaidOrder } from "./types";

const FONT_PATH = path.join(process.cwd(), "node_modules", "@fontsource", "noto-sans-hebrew", "files", "noto-sans-hebrew-hebrew-400-normal.woff");
const bidi = bidiFactory();
const PAGE = { width: 595.28, height: 841.89, margin: 46 };

function visual(text: string) {
  if (!text) return "";
  return bidi.getReorderedString(text, bidi.getEmbeddingLevels(text, "rtl"));
}

function money(amount: string, currency: string) {
  return `${Number(amount).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency === "ILS" ? "₪" : currency}`;
}

function addressLines(order: PaidOrder) {
  const isPickup = order.deliveryType === "PICK_UP" || !order.requiresShipping;
  const address = isPickup ? order.pickupLocation : order.shippingAddress;
  if (!address) return ["כתובת לא נמסרה"];
  return [
    [address.address1, address.address2].filter(Boolean).join(", "),
    [address.city, address.zip].filter(Boolean).join(" "),
    address.country,
  ].filter((line): line is string => Boolean(line));
}

function drawRight(page: PDFPage, font: PDFFont, text: string, y: number, size = 13, color = rgb(0.08, 0.08, 0.1)) {
  const shown = visual(text);
  page.drawText(shown, { x: PAGE.width - PAGE.margin - font.widthOfTextAtSize(shown, size), y, size, font, color });
}

function drawDivider(page: PDFPage, y: number) {
  page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.width - PAGE.margin, y }, thickness: 1, color: rgb(0.82, 0.82, 0.84) });
}

export async function createPackingPdf(order: PaidOrder): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await readFile(FONT_PATH), { subset: true });
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;
  drawRight(page, font, "TopTik, דף טיפול בהזמנה", y, 22, rgb(0.05, 0.22, 0.35));
  y -= 34;
  drawRight(page, font, `הזמנה ${order.name.replace(/^#/, "")} | שולם ${money(order.total.amount, order.total.currencyCode)}`, y, 17);
  y -= 22;
  drawRight(page, font, `תאריך: ${new Intl.DateTimeFormat("he-IL", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Jerusalem" }).format(new Date(order.createdAt))}`, y, 11);
  y -= 22; drawDivider(page, y); y -= 28;

  drawRight(page, font, "פרטי הלקוח והמסירה", y, 16, rgb(0.05, 0.22, 0.35)); y -= 25;
  drawRight(page, font, `שם: ${order.customerName}`, y); y -= 21;
  drawRight(page, font, `מייל: ${order.email || "חסר"}`, y); y -= 21;
  drawRight(page, font, `טלפון: ${order.phone || "חסר, אין לשלוח לפני בירור"}`, y, 13, order.phone ? rgb(0.08, 0.08, 0.1) : rgb(0.75, 0.08, 0.08)); y -= 21;
  for (const line of addressLines(order)) { drawRight(page, font, line, y); y -= 20; }
  const isPickup = order.deliveryType === "PICK_UP" || !order.requiresShipping;
  drawRight(page, font, `אופן מסירה: ${isPickup ? "איסוף עצמי" : "משלוח"}`, y); y -= 20;
  if (isPickup) { drawRight(page, font, `מקום האיסוף: ${order.pickupLocation?.name || "חסר"}`, y); y -= 20; }
  drawRight(page, font, `שיטה: ${order.shippingMethod || "לא צוינה"}`, y); y -= 24;
  drawDivider(page, y); y -= 28;

  drawRight(page, font, "פריטים", y, 16, rgb(0.05, 0.22, 0.35)); y -= 27;
  for (const item of order.items) {
    const parts = [item.title, item.variantTitle && item.variantTitle !== "Default Title" ? item.variantTitle : null].filter(Boolean).join(" | ");
    drawRight(page, font, `${item.quantity} יח׳ | ${parts}`, y, 13); y -= 19;
    drawRight(page, font, `מק״ט: ${item.sku || "לא צוין"}`, y, 11, rgb(0.3, 0.3, 0.32)); y -= 24;
    drawRight(page, font, `מחיר ליחידה: ${money(item.unitPrice.amount, item.unitPrice.currencyCode)} | סה״כ: ${money(item.totalPrice.amount, item.totalPrice.currencyCode)}`, y, 11); y -= 24;
  }
  drawDivider(page, y); y -= 28;
  drawRight(page, font, "מצב תשלום: שולם", y, 15, rgb(0.02, 0.45, 0.2)); y -= 24;
  drawRight(page, font, `סכום ששולם: ${money(order.total.amount, order.total.currencyCode)}`, y, 15); y -= 30;
  drawRight(page, font, `אופן תשלום: ${order.payment.formattedGateway || order.payment.gateway}`, y, 12); y -= 22;
  drawRight(page, font, "לפני מסירה: ודא התאמת דגם, צבע, מק״ט וכמות.", y, 12);
  page.drawText("TopTik | toptik.co.il", { x: PAGE.margin, y: 28, size: 9, font, color: rgb(0.45, 0.45, 0.47) });
  return pdf.save();
}

