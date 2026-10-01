"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BoundCommercePatch, BoundCommerceSnapshot } from "@/lib/shopify/commerce-existing";
type Command = { id: string; itemId: string; expectedHash: string; patch: BoundCommercePatch };
type Data = { enabled: boolean; snapshot: BoundCommerceSnapshot; expectedHash: string; pending: Command | null };
const API = "/api/admin/shopify/commerce-edit";
const field = "w-full rounded border border-white/25 bg-black/30 p-2 text-white";
const messages: Record<string, string> = {
  FINALIZE_EDIT_STALE: "המוצר השתנה בחנות מאז הטעינה. יש לרענן לפני שמירה.",
  FINALIZE_EDIT_BUSY: "המוצר מתעדכן כעת. אפשר לרענן בעוד רגע.",
  FINALIZE_EDIT_PENDING_EXISTS: "קיימת שמירה שממתינה לאימות. יש לרענן ולבדוק אותה לפני שינוי נוסף.",
  FINALIZE_EDIT_IDENTITY_CHANGED: "אין למוצר התאמה מאושרת לעריכת פרטי המכירה.",
};
export default function CommerceExistingEditor({ itemId, token }: { itemId: string; token?: string }) {
  const [opened, setOpened] = useState(false);
  const [data, setData] = useState<Data | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [price, setPrice] = useState(""), [compare, setCompare] = useState(""), [barcode, setBarcode] = useState("");
  const [taxable, setTaxable] = useState(false), [shipping, setShipping] = useState(false), [status, setStatus] = useState("ACTIVE");
  const current = useRef(itemId), generation = useRef(0), uncertain = useRef<Command | null>(null);
  const request = useCallback(async (method: string, command?: Command, signal?: AbortSignal) => {
    const response = await fetch(`${API}?itemId=${encodeURIComponent(itemId)}`, { method, signal, cache: "no-store", credentials: "same-origin",
      headers: { ...(token ? { "x-admin-token": token } : {}), ...(command ? { "content-type": "application/json" } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(messages[result.error] ?? "לא ניתן לאשר את השמירה. יש לרענן ולבדוק את מצב המוצר."); return result;
  }, [itemId, token]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const run = ++generation.current; setBusy(true); setNotice("");
    try {
      const value: Data = await request("GET", undefined, signal); if (run !== generation.current || signal?.aborted) return;
      setData(value); const f = value.snapshot.fields; setPrice(f.price); setCompare(f.compareAtPrice ?? ""); setBarcode(f.barcode ?? "");
      setTaxable(f.taxable); setShipping(f.requiresShipping); setStatus(f.status); uncertain.current = value.pending;
      if (value.pending) setNotice("שמירה קודמת ממתינה לאימות. הבדיקה תקרא את המצב בחנות בלי לשלוח אותה שוב.");
    } catch (error) { if (run === generation.current && !signal?.aborted) setNotice(error instanceof Error ? error.message : "טעינה נכשלה"); }
    finally { if (run === generation.current && !signal?.aborted) setBusy(false); }
  }, [request]);
  useEffect(() => {
    const abort = new AbortController(), gate = generation; current.current = itemId; uncertain.current = null; setData(null); if (opened) void load(abort.signal);
    return () => { abort.abort(); gate.current++; };
  }, [itemId, load, opened]);
  async function save(statusOnly = false, recovery = false) {
    if (!data) return;
    const selected = itemId, baseline = data.snapshot.fields;
    const wanted = statusOnly ? { status: status as typeof baseline.status } : { price: price === "" ? "" : Number(price).toFixed(2), compareAtPrice: compare === "" ? null : Number(compare).toFixed(2), barcode: barcode === "" ? null : barcode, taxable, requiresShipping: shipping };
    const patch = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => value !== baseline[key as keyof typeof baseline])) as BoundCommercePatch;
    const command = recovery ? uncertain.current : { id: crypto.randomUUID(), itemId, expectedHash: data.expectedHash, patch };
    if (!command || (!recovery && !Object.keys(patch).length)) { setNotice("לא שונו פרטים."); return; }
    uncertain.current = command; setBusy(true); setNotice("");
    try {
      const result = await request("PATCH", command); if (current.current !== selected) return;
      if (result.status === "confirmed") { uncertain.current = null; await load(); setNotice("הפרטים המעודכנים נקראו ואומתו בחנות. לפני שמירת כל הקטלוג יש לרענן את נתוני הגלריה."); }
      else if (result.status === "review") { uncertain.current = null; await load(); setNotice("זוהה שינוי מקביל או שהשמירה לא אושרה. מוצג המצב הנוכחי בחנות; לא נשלחה פעולה חוזרת."); }
      else { setData(old => old ? { ...old, pending: command } : old); setNotice("התוצאה עדיין אינה ודאית. יש לבדוק את המצב לפני שינוי נוסף."); }
    } catch (error) { if (current.current === selected) { setData(old => old ? { ...old, pending: command } : old); setNotice(error instanceof Error ? error.message : "תוצאת השמירה אינה ודאית."); } }
    finally { if (current.current === selected) setBusy(false); }
  }
  const locked = busy || !data?.enabled || Boolean(data.pending);
  return <section dir="rtl" className="space-y-3 rounded-xl border border-white/20 bg-slate-950 p-4 text-white" aria-label="פרטי מכירה בחנות">
    <button type="button" className="text-lg font-semibold underline" aria-expanded={opened} disabled={busy} onClick={() => setOpened(value => !value)}>פרטי מכירה בחנות</button>
    {opened && <>
    <p>הנתונים נטענים מ-Shopify. נשמרים רק השדות ששונו.</p>
    {data && <>
      {!data.enabled && <p>עריכת פרטי המכירה עדיין אינה מופעלת.</p>}
      <label className="block">מחיר ({data.snapshot.currency})<input className={field} inputMode="decimal" value={price} disabled={locked} onChange={e => setPrice(e.target.value)} /></label>
      <label className="block">מחיר קודם — אופציונלי<input className={field} inputMode="decimal" value={compare} disabled={locked} onChange={e => setCompare(e.target.value)} /></label>
      <label className="block">ברקוד<input className={field} dir="ltr" value={barcode} disabled={locked} onChange={e => setBarcode(e.target.value)} /></label>
      <label className="flex gap-2"><input type="checkbox" checked={taxable} disabled={locked} onChange={e => setTaxable(e.target.checked)} />חייב במס לפי הגדרות החנות</label>
      <label className="flex gap-2"><input type="checkbox" checked={shipping} disabled={locked} onChange={e => setShipping(e.target.checked)} />דורש משלוח או איסוף</label>
      <button type="button" disabled={locked || !price} className="rounded bg-white px-4 py-2 text-black disabled:opacity-50" onClick={() => void save()}>שמירת פרטי מכירה</button>
      <label className="block">מצב המוצר בחנות<select className={field} value={status} disabled={locked} onChange={e => setStatus(e.target.value)}><option value="ACTIVE">פעיל</option><option value="DRAFT">טיוטה — מוסתר ממכירה</option><option value="ARCHIVED">ארכיון — מוסתר ממכירה</option></select></label>
      <p>העברה לטיוטה או לארכיון מסתירה את אפשרות הרכישה. מצב פעיל יוצג למכירה רק אם המוצר מפורסם בערוץ החנות.</p>
      <button type="button" disabled={locked || status === data.snapshot.fields.status} className="underline disabled:opacity-50" onClick={() => void save(true)}>שמירת מצב מוצר</button>
      {data.pending && <button type="button" disabled={busy} className="mr-3 underline" onClick={() => void save(false, true)}>בדיקת השמירה הקודמת</button>}
    </>}
    <button type="button" disabled={busy} className="mr-3 underline" onClick={() => void load()}>רענון מהחנות</button>
    {notice && <p role="status">{notice}</p>}
    </>}
  </section>;
}
