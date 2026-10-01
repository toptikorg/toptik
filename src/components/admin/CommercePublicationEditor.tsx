"use client";

import { useCallback, useEffect, useRef, useState } from "react";
type Status = { enabled: boolean; id: string; title?: string; sku?: string; currency?: string; status: string; frozen: boolean;
  revision: string | null; code?: string; commerce: null | { price: string | null; compareAtPrice: string | null; barcode: string | null; taxable: boolean | null; requiresShipping: boolean | null } };
type Row = { id: string; title: string; sku: string };
const API = "/api/admin/shopify/commerce";
const field = "w-full rounded border border-white/25 bg-black/30 p-2 text-white";
const messages: Record<string, string> = {
  FINALIZE_NOT_ENABLED: "הפרסום האוטומטי עדיין אינו מופעל.", FINALIZE_INTENT_CAS: "הנתונים עודכנו במקביל. יש לרענן לפני שמירה.",
  FINALIZE_DRAFT_READY_REQUIRED: "המוצר עדיין בהכנה. ניתן לרענן לאחר השלמת התמונות והזהות.",
  FINALIZE_READBACK_CONCURRENT_OR_UNCERTAIN: "נדרש לבדוק שינוי שבוצע במקביל לפני המשך הפרסום.",
};
export default function CommercePublicationEditor({ token, itemId }: { token?: string; itemId?: string }) {
  const [items, setItems] = useState<Row[]>([]), [selected, setSelected] = useState(itemId ?? ""), [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [price, setPrice] = useState("");
  const [compare, setCompare] = useState(""), [barcode, setBarcode] = useState(""), [tax, setTax] = useState("");
  const [shipping, setShipping] = useState(false), [publish, setPublish] = useState(false);
  const generation = useRef(0);
  const polls = useRef(0);
  const request = useCallback(async (url: string, method = "GET", body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(url, { method, signal, cache: "no-store", credentials: "same-origin",
      headers: { ...(token ? { "x-admin-token": token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(messages[result.error] ?? "לא ניתן להשלים כרגע. יש לרענן ולבדוק את מצב המוצר."); return result;
  }, [token]);
  useEffect(() => {
    const abort = new AbortController();
    if (!itemId) void request(API, "GET", undefined, abort.signal).then(data => setItems(data.items ?? [])).catch(error => { if (!abort.signal.aborted) setNotice(error.message); });
    return () => abort.abort();
  }, [itemId, request]);
  const load = useCallback(async (id: string, signal?: AbortSignal) => {
    const run = ++generation.current; setBusy(true); setNotice("");
    try {
      const data: Status = await request(`${API}?itemId=${encodeURIComponent(id)}`, "GET", undefined, signal);
      if (run !== generation.current || signal?.aborted) return;
      setStatus(data); setPrice(data.commerce?.price ?? ""); setCompare(data.commerce?.compareAtPrice ?? ""); setBarcode(data.commerce?.barcode ?? "");
      setTax(data.commerce?.taxable === null || data.commerce?.taxable === undefined ? "" : String(data.commerce.taxable));
      setShipping(data.commerce?.requiresShipping === true); setPublish(false);
    } catch (error) { if (run === generation.current && !signal?.aborted) setNotice(error instanceof Error ? error.message : "טעינת המוצר נכשלה"); }
    finally { if (run === generation.current && !signal?.aborted) setBusy(false); }
  }, [request]);
  useEffect(() => {
    const abort = new AbortController(), requestGeneration = generation; setStatus(null);
    polls.current = 0;
    if (selected) void load(selected, abort.signal);
    return () => { abort.abort(); requestGeneration.current++; };
  }, [selected, load]);
  useEffect(() => {
    if (!status?.enabled || !["pending", "preparing"].includes(status.status) || polls.current >= 60) return;
    const timer = setTimeout(() => { polls.current++; void load(selected); }, 5000);
    return () => clearTimeout(timer);
  }, [status, selected, load]);
  async function save() {
    if (!status || status.id !== selected || tax === "" || !publish || !shipping) return;
    const run = ++generation.current; setBusy(true); setNotice("");
    try {
      await request(API, "PUT", { itemId: selected, expectedRevision: status.revision, requestId: crypto.randomUUID(),
        values: { price, compareAtPrice: compare === "" ? null : compare, barcode: barcode === "" ? null : barcode,
          taxable: tax === "true", requiresShipping: true, publishWhenReady: true } });
      if (run !== generation.current) return;
      await load(selected); setNotice("הפרטים נשמרו. הפרסום ממשיך אוטומטית; יש לרענן כדי לראות את התוצאה.");
    } catch (error) { if (run === generation.current) setNotice(error instanceof Error ? error.message : "השמירה לא אושרה. יש לרענן לפני ניסיון נוסף."); }
    finally { if (run === generation.current) setBusy(false); }
  }
  async function resume() {
    setBusy(true); setNotice("");
    try { await request(API, "POST", { itemId: selected }); await load(selected); }
    catch (error) { setNotice(error instanceof Error ? error.message : "הבדיקה לא הושלמה"); }
    finally { setBusy(false); }
  }
  const frozen = busy || !status?.enabled || status.frozen;
  return <section dir="rtl" className="space-y-3 rounded-xl border border-white/20 bg-slate-950 p-4 text-white" aria-label="מחיר ופרסום מוצר חדש">
    <h2 className="text-lg font-semibold">מחיר ופרסום מוצר חדש</h2>
    {!itemId && <label className="block">מוצר בהכנה<select className={field} value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>
      <option value="">בחירת מוצר</option>{items.map(item => <option key={item.id} value={item.id}>{item.title} — {item.sku}</option>)}</select></label>}
    {status && <>
      <p>{status.title} {status.sku && <bdi>{status.sku}</bdi>}</p>
      <p role="status">{status.status === "bound" ? "המוצר פורסם ונקשר לגלריה." : status.status === "review" ? "נדרשת בדיקה לפני המשך הפרסום." : status.status === "pending" ? "הפרסום בתהליך." : status.status === "preparing" ? "המוצר והתמונות בהכנה." : "יש להשלים את פרטי המכירה."}</p>
      {!status.enabled && <p>הפרסום האוטומטי עדיין אינו מופעל.</p>}
      {status.status !== "bound" && <>
        <label className="block">מחיר מכירה ({status.currency ?? "מטבע החנות"})<input className={field} value={price} inputMode="decimal" disabled={frozen} onChange={e => setPrice(e.target.value)} /></label>
        <label className="block">מחיר קודם — אופציונלי<input className={field} value={compare} inputMode="decimal" disabled={frozen} onChange={e => setCompare(e.target.value)} /></label>
        <label className="block">ברקוד — אופציונלי<input className={field} value={barcode} dir="ltr" disabled={frozen} onChange={e => setBarcode(e.target.value)} /></label>
        <label className="block">חיוב מס<select className={field} value={tax} disabled={frozen} onChange={e => setTax(e.target.value)}><option value="">בחירה</option><option value="true">חייב במס לפי הגדרות החנות</option><option value="false">פטור ממס</option></select></label>
        <label className="flex gap-2"><input type="checkbox" checked={shipping} disabled={frozen} onChange={e => setShipping(e.target.checked)} />מוצר פיזי הדורש משלוח או איסוף</label>
        <p>המוצר יוצע למכירה ללא מעקב אחר כמויות מלאי באתר.</p>
        <label className="flex gap-2"><input type="checkbox" checked={publish} disabled={frozen} onChange={e => setPublish(e.target.checked)} />לפרסם בחנות ובגלריה לאחר אימות הפרטים והתמונות</label>
        <button type="button" className="rounded bg-white px-4 py-2 text-black disabled:opacity-50" disabled={frozen || !price || !shipping || !publish || tax === ""} onClick={() => void save()}>שמירה ופרסום</button>
      </>}
      <button type="button" disabled={busy} className="mr-3 underline disabled:opacity-50" onClick={() => void load(selected)}>רענון מצב</button>
      {status.enabled && status.status === "pending" && <button type="button" disabled={busy} className="mr-3 underline disabled:opacity-50" onClick={() => void resume()}>בדיקה והמשך</button>}
    </>}
    {notice && <p role="alert">{notice}</p>}
  </section>;
}
