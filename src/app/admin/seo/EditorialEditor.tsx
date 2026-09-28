"use client";
import { useState } from "react";
import Link from "next/link";
import type { ProductEditorial } from "@/lib/carousel/editorial-schema";
type Row = { id: string; catalogNumber: string | null; editorial: ProductEditorial; showroomUrl: string };
export default function EditorialEditor() {
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("טענו את הקטלוג בעזרת החיבור הקיים לניהול.");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    const activeToken = token || window.localStorage.getItem("toptik_admin_token") || "";
    try {
      const res = await fetch("/api/admin/editorial", { headers: { "x-admin-token": activeToken }, cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 401 ? "יש להתחבר לניהול הגלריה או להזין את קוד הניהול הקיים." : "טעינת הקטלוג נכשלה.");
      const data = await res.json();
      setToken(activeToken); setRows(data.items); setSelected(null); setStatus(`נטענו ${data.items.length} מוצרים. כל שמירה משנה תוכן של מוצר אחד בלבד.`);
    } catch (e) { setStatus(e instanceof Error ? e.message : "הטעינה נכשלה"); }
    finally { setBusy(false); }
  }
  function field(key: keyof ProductEditorial, value: string | boolean) {
    setSelected(row => row ? { ...row, editorial: { ...row.editorial, [key]: value } } : null);
  }
  async function save() {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/editorial", { method: "PUT", headers: { "Content-Type": "application/json", "x-admin-token": token }, body: JSON.stringify({ id: selected.id, editorial: selected.editorial }) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "השמירה נכשלה");
      setRows(all => all.map(row => row.id === selected.id ? { ...selected, editorial: data.editorial } : row));
      setStatus("השמירה והקריאה החוזרת אומתו. העדכון מופיע בחלון הראווה לאחר רענון, לכל היותר בתוך כשתי דקות. Shopify לא השתנה.");
    } catch (e) { setStatus(e instanceof Error ? e.message : "השמירה נכשלה"); }
    finally { setBusy(false); }
  }
  return <main className="admin-page" dir="rtl">
    <header className="admin-header"><h1>תוכן ו־SEO של חלון הראווה</h1><Link href="/admin">לניהול הגלריה</Link></header>
    <p>תיאור ענייני המבוסס על מפרט היצרן: למי המוצר מתאים, מה הוא פותר ומה כדאי לבדוק. ללא תרגום אוטומטי. תמונות, מלאי, עריכות אקסל ונתוני החנות אינם משתנים כאן.</p>
    <label>קוד ניהול, רק אם אין חיבור קיים <input type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" /></label>
    <button onClick={load} disabled={busy}>טעינת מוצרי חלון הראווה</button><p role="status">{status}</p>
    <label>חיפוש לפי שם או מק״ט <input value={query} onChange={e => setQuery(e.target.value)} /></label>
    <label>בחירת מוצר <select value={selected?.id ?? ""} onChange={e => setSelected(structuredClone(rows.find(r => r.id === e.target.value) ?? null))}>
      <option value="">בחרו מוצר</option>{rows.filter(r => `${r.catalogNumber} ${r.editorial.title}`.toLowerCase().includes(query.toLowerCase())).map(r => <option key={r.id} value={r.id}>{r.catalogNumber} · {r.editorial.title}</option>)}
    </select></label>
    {selected && <section className="editorial-form">
      <p>מזהה קבוע: <bdi>{selected.id}</bdi> · <a href={selected.showroomUrl} target="_blank" rel="noopener noreferrer">צפייה בעמוד החי</a></p>
      <label>שם המוצר <input value={selected.editorial.title} maxLength={160} onChange={e=>field("title",e.target.value)} /></label>
      <label>תיאור ללקוח <textarea rows={9} value={selected.editorial.description} maxLength={2500} onChange={e=>field("description",e.target.value)} /></label>
      <label>Page title <input value={selected.editorial.pageTitle} maxLength={120} onChange={e=>field("pageTitle",e.target.value)} /><small>{selected.editorial.pageTitle.length} תווים</small></label>
      <label>Meta description <textarea rows={3} value={selected.editorial.metaDescription} maxLength={200} onChange={e=>field("metaDescription",e.target.value)} /><small>{selected.editorial.metaDescription.length} תווים</small></label>
      <label><input type="checkbox" checked={selected.editorial.indexable} onChange={e=>field("indexable",e.target.checked)} /> התוכן נבדק ומוכן לאינדוקס</label>
      <p>מקורות לבדיקה: {selected.editorial.sourceUrls.map(url=><a key={url} href={url} target="_blank" rel="noopener noreferrer">{url} </a>)}</p>
      <button onClick={save} disabled={busy}>שמירת התוכן וה־SEO של המוצר</button>
    </section>}
  </main>;
}
