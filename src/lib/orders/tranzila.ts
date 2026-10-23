import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import type { InvoiceDocument, PaidOrder } from "./types";

const BASE = "https://billing5.tranzila.com/api/documents_db";

function isoDate(date: Date) { return date.toISOString().slice(0, 10); }

function tranzilaHeaders() {
  const appKey = process.env.TRANZILA_API_APP_KEY;
  const secret = process.env.TRANZILA_API_SECRET;
  if (!appKey || !secret) throw new Error("TRANZILA_API_NOT_CONFIGURED");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(40).toString("hex");
  const accessToken = createHmac("sha256", `${secret}${timestamp}${nonce}`).update(appKey).digest("hex");
  return {
    "content-type": "application/json",
    "x-tranzila-api-app-key": appKey,
    "x-tranzila-api-request-time": timestamp,
    "x-tranzila-api-nonce": nonce,
    "x-tranzila-api-access-token": accessToken,
  };
}

function documentDate(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return `${raw.replace(" ", "T")}+03:00`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

export async function findTranzilaInvoice(order: PaidOrder): Promise<InvoiceDocument | null> {
  if (!order.email) return null;
  const terminal = process.env.TRANZILA_INVOICE_TERMINAL || "fxptoptik2000";
  const created = new Date(order.createdAt);
  const start = new Date(created); start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(created); end.setUTCDate(end.getUTCDate() + 2);
  const response = await fetch(`${BASE}/get_documents`, {
    method: "POST", signal: AbortSignal.timeout(12_000),
    headers: tranzilaHeaders(),
    body: JSON.stringify({ terminal_names: [terminal], client_email: order.email, start_date: isoDate(start), end_date: isoDate(end) }),
  });
  if (!response.ok) throw new Error(`TRANZILA_DOCUMENT_LIST_HTTP_${response.status}`);
  const data = await response.json() as { status_code?: number; documents?: Array<Record<string, unknown>> };
  if (data.status_code !== 0 || !Array.isArray(data.documents)) throw new Error("TRANZILA_DOCUMENT_LIST_REJECTED");
  const matches = data.documents.filter(document =>
    Number(document.total_charge_amount) === Number(order.total.amount) && document.currency === order.total.currencyCode &&
    String(document.action) === "1" && String(document.type) === "IR");
  if (matches.length > 1) throw new Error("TRANZILA_DOCUMENT_AMBIGUOUS");
  const document = matches[0];
  if (!document) return null;
  return { id: String(document.id), number: String(document.number), type: String(document.type),
    amount: Number(document.total_charge_amount), currency: String(document.currency), createdAt: documentDate(document.created_at) };
}

export async function downloadTranzilaInvoice(documentId: string): Promise<Uint8Array> {
  if (!/^\d+$/.test(documentId)) throw new Error("TRANZILA_DOCUMENT_ID_INVALID");
  const terminal = process.env.TRANZILA_INVOICE_TERMINAL || "fxptoptik2000";
  const response = await fetch(`${BASE}/get_document`, {
    method: "POST", signal: AbortSignal.timeout(15_000), headers: tranzilaHeaders(),
    body: JSON.stringify({ terminal_name: terminal, document_id: documentId, response_language: "heb" }),
  });
  if (!response.ok) throw new Error(`TRANZILA_DOCUMENT_HTTP_${response.status}`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/pdf")) throw new Error("TRANZILA_DOCUMENT_NOT_PDF");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 100 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new Error("TRANZILA_DOCUMENT_INVALID_PDF");
  return bytes;
}

