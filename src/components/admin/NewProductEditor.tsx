"use client";

import { useEffect, useRef, useState } from "react";
import ProductDescriptionEditor from "@/components/admin/ProductDescriptionEditor";
import type { CreationIntentInput, CreationIntentRecord } from "@/lib/shopify/creation-intent";
import { createCreationEditorRequestGate } from "@/lib/shopify/creation-editor-requests";
import type { CarouselItem } from "@/lib/carousel/types";

const API = "/api/admin/shopify/creation-intents";
const REASONS: Record<string, string> = {
  store_sku: "מק״ט החנות", brand: "מותג", title: "כותרת מוצר", description: "תיאור מוצר",
  media: "תמונת מוצר אמיתית", media_alt: "תיאור לתמונה", selling_price: "מחיר מכירה",
  media_limit: "בחירת עד 10 תמונות ליצירה בחנות; כל תמונות המקור נשמרו",
  currency: "מטבע החנות", tax_policy: "החלטת מס", shipping_policy: "החלטת משלוח", store_intent: "יעד השמירה",
  manufacturer_mapping_receipt: "התאמת מק״ט יצרן מאומתת", inventory: "מלאי מאומת ב-Shopify",
  publication_not_supported_v1: "הפרסום הציבורי אינו מופעל במסלול הזה",
};
type SavedRow = { id: string; title: string | null; sku: string | null; frozen_at: string | null };
type Readiness = { draftBlockers: string[]; publicBlockers: string[] };
function blank(): CreationIntentInput { return {
  galleryItemId: crypto.randomUUID(), shopifySku: null, manufacturerSku: null, identityMappingReceiptId: null,
  brand: null, category: null, copy: { title: null, description: null, descriptionHtml: null, seoTitle: null, seoDescription: null },
  media: [], commerce: { sellingPrice: null, currency: null, compareAtPrice: null, barcode: null, taxable: null,
    requiresShipping: null, inventory: { status: "unknown" }, storeIntent: "undecided" }, sourceReferences: [],
}; }
const nullable = (value: string) => value === "" ? null : value;
export default function NewProductEditor({ adminToken, initialId, createOnOpen = false, onClose }: {
  adminToken?: string; initialId?: string; createOnOpen?: boolean; onClose?: () => void;
}) {
  const [token, setToken] = useState(adminToken ?? "");
  const [connected, setConnected] = useState(false), [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false);
  const [items, setItems] = useState<SavedRow[]>([]), [input, setInput] = useState<CreationIntentInput | null>(null);
  const [record, setRecord] = useState<CreationIntentRecord | null>(null), [frozen, setFrozen] = useState(false);
  const [readiness, setReadiness] = useState<Readiness | null>(null), [notice, setNotice] = useState("");
  const [stage, setStage] = useState("");
  const [importedSource, setImportedSource] = useState<CarouselItem | null>(null);
  const requestGate = useRef(createCreationEditorRequestGate());
  const initialDraft = useRef<CreationIntentInput | null>(null);
  const requestFailed = (error: unknown) => setNotice(error instanceof Error ? error.message : "הבקשה נכשלה");
  async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(path, { method, cache: "no-store", headers: { "x-admin-token": token,
      ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "לא ניתן לשמור כרגע");
    return data;
  }
  async function connect() {
    setBusy(true); setNotice("");
    await requestGate.current.run(() => request(API), data => { setItems(data.items); setEnabled(data.enabled); setConnected(true); }, requestFailed, () => setBusy(false));
  }
  async function createNew(prepared = blank()) {
    setBusy(true); setNotice("");
    await requestGate.current.run(() => request(API, "PUT", { input: prepared, expectedRevision: null }), data => {
      setInput(data.record.input); setRecord(data.record); setReadiness(data.readiness); setFrozen(false); setStage("saved_local");
      setImportedSource(null);
      setItems(rows => [{ id: data.record.input.galleryItemId, title: null, sku: null, frozen_at: null }, ...rows]);
    }, requestFailed, () => setBusy(false));
  }
  useEffect(() => {
    if (!adminToken) return;
    if (!initialDraft.current) initialDraft.current = blank();
    const gate = requestGate.current;
    let active = true;
    void (async () => {
      setBusy(true);
      try {
        const list = await request(API); if (!active) return;
        setItems(list.items); setEnabled(list.enabled); setConnected(true);
        if (initialId) await load(initialId);
        else if (list.enabled && createOnOpen) await createNew(initialDraft.current!);
      } catch (error) { if (active) requestFailed(error); }
      finally { if (active) setBusy(false); }
    })();
    return () => { active = false; gate.invalidate(); };
    // The parent keys the editor by the chosen pending UUID; no identity changes in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken, initialId, createOnOpen]);
  async function load(id: string) {
    setBusy(true); setNotice("");
    await requestGate.current.run(() => request(`${API}?id=${encodeURIComponent(id)}`), data => {
      if (!data.item) throw new Error("הטיוטה לא נמצאה");
      setRecord(data.item.record); setInput(data.item.record.input); setFrozen(data.item.frozen); setReadiness(data.readiness);
      setStage(data.creation?.stage ?? "saved_local"); setNotice(data.creation?.last_error ?? "");
      setImportedSource(data.sourceImport?.raw_source ?? null);
    }, requestFailed, () => setBusy(false));
  }
  async function save() {
    if (!input) return;
    setBusy(true); setNotice("");
    await requestGate.current.run(() => request(API, "PUT", { input, expectedRevision: record?.revision ?? null }), data => {
      setRecord(data.record); setInput(data.record.input); setReadiness(data.readiness); setFrozen(data.frozen);
      setStage(data.creation?.stage ?? "saved_local");
      setNotice(data.creationError ? `הטיוטה נשמרה. היצירה בחנות ממתינה: ${data.creationError}` : data.creation
        ? "הטיוטה נשמרה והטיפול בחנות התחיל. היא אינה מפורסמת ללקוחות." : "הטיוטה נשמרה. אפשר להשלים את הפרטים בהמשך.");
      setItems(rows => [{ id: data.record.input.galleryItemId, title: data.record.input.copy.title, sku: data.record.input.shopifySku,
        frozen_at: data.frozen ? new Date().toISOString() : null }, ...rows.filter(row => row.id !== data.record.input.galleryItemId)]);
    }, requestFailed, () => setBusy(false));
  }
  async function resume() {
    if (!record || !frozen || !enabled || busy) return;
    setBusy(true); setNotice("");
    await requestGate.current.run(() => request(API, "POST", { id: record.input.galleryItemId, expectedRevision: record.revision }), data => {
      setStage(data.stage); setNotice("המשך הטיפול באותה טיוטה התבקש. לא נוצרה בקשה למוצר נוסף.");
    }, requestFailed, () => setBusy(false));
  }
  async function uploadImage(file: File) {
    if (!input || frozen || busy || input.media.length >= 10) return;
    const itemId = input.galleryItemId;
    setBusy(true); setNotice("");
    await requestGate.current.run(async () => {
      const body = new FormData(); body.append("file", file); body.append("folder", `items/${itemId}/angles`);
      const response = await fetch("/api/admin/upload", { method: "POST", headers: { "x-admin-token": token }, body });
      const data = await response.json(); if (!response.ok || typeof data.publicUrl !== "string") throw new Error(data.error ?? "העלאת התמונה נכשלה");
      return data.publicUrl as string;
    }, url => setInput(current => current?.galleryItemId === itemId
      ? { ...current, media: [...current.media, { url, alt: null }] } : current), requestFailed, () => setBusy(false));
  }
  useEffect(() => {
    if (!frozen || !record || !connected || ["draft_ready", "review"].includes(stage)) return;
    let active = true, count = 0;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      if (++count > 40) { clearInterval(timer); return; }
      try {
        const response = await fetch(`${API}?id=${encodeURIComponent(record.input.galleryItemId)}`, {
          cache: "no-store", headers: { "x-admin-token": token }, signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json();
        if (active) { setStage(data.creation?.stage ?? "reserved"); if (data.creation?.last_error) setNotice(data.creation.last_error); }
      } catch { /* Saved intent remains visible; refresh is read-only. */ }
    }, 3000);
    return () => { active = false; clearInterval(timer); controller.abort(); };
  }, [connected, frozen, record, stage, token]);
  const patchCopy = (patch: Partial<CreationIntentInput["copy"]>) => setInput(current => current && ({ ...current, copy: { ...current.copy, ...patch } }));
  const patchCommerce = (patch: Partial<CreationIntentInput["commerce"]>) => setInput(current => current && ({ ...current, commerce: { ...current.commerce, ...patch } }));
  return <section dir="rtl" aria-label="עריכת מוצר חדש" style={{ maxWidth: 920, margin: "auto", padding: 24, background: "#fff", color: "#211d17", lineHeight: 1.7 }}>
    <style>{`.creation-form label{display:flex;flex-direction:column;gap:6px;margin:14px 0}.creation-form input,.creation-form select,.creation-form textarea{min-height:44px;padding:9px;border:1px solid #887e6f;border-radius:6px;background:white;color:#211d17}.creation-form button{min-height:44px;padding:9px 18px;border:1px solid #887e6f;border-radius:6px;margin:6px;background:#f1ece3;color:#211d17}.creation-form button:disabled{opacity:.5}.creation-form fieldset{border:1px solid #c6bdaf;padding:18px;margin:20px 0}.creation-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px}`}</style>
    <div className="creation-form">
      {onClose ? <button disabled={busy} onClick={onClose}>חזרה לרשימת המוצרים</button> : <a href="/admin">חזרה לניהול הגלריה</a>}<h1>מוצר חדש — טיוטה לחנות</h1>
      <p>אפשר לשמור פרטים חלקיים. מוצר חדש ייווצר בחנות כטיוטה פרטית בלבד, לאחר אימות הזהות והתמונות.</p>
      {!connected ? <form onSubmit={event => { event.preventDefault(); void connect(); }}>
        <label>סיסמת מנהל<input type="password" autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)} /></label>
        <button disabled={busy || !token} type="submit">כניסה</button></form> : <>
        {!enabled && <p role="status">מסלול יצירת הטיוטות עדיין אינו מופעל. המוצרים הקיימים אינם משתנים.</p>}
        <label>טיוטות שמורות<select disabled={busy} value={input?.galleryItemId ?? ""} onChange={event => { if (event.target.value) void load(event.target.value); }}>
          <option value="">בחירת טיוטה</option>{items.map(row => <option key={row.id} value={row.id}>{row.title ?? "טיוטה ללא כותרת"} · {row.sku ?? "ללא מק״ט"}</option>)}
        </select></label>
        <button disabled={busy || !enabled} onClick={() => void createNew()}>טיוטה חדשה</button>
        {input && <>
          {importedSource && <details><summary>פרטים שנשמרו מהייבוא</summary>
            <p>מק״ט יצרן: <bdi>{importedSource.catalogNumber}</bdi>. נתוני המקור נשמרים בנפרד מהחלטות המחיר והמלאי של החנות.</p>
            <dl>{[["צבע", importedSource.color], ["מידות", importedSource.dimensions], ["משקל מקור", importedSource.weight]]
              .filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            {importedSource.techSpecs?.specs.map((group, index) => <section key={index}><h3>{group.heading}</h3><dl>
              {group.items.map((row, rowIndex) => <div key={rowIndex}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></section>)}
          </details>}
          <fieldset disabled={busy || frozen || !enabled}><legend>פרטי המוצר</legend>
            <div className="creation-grid">
              <label>מק״ט מדויק בחנות<input dir="ltr" value={input.shopifySku ?? ""} readOnly={Boolean(record?.input.shopifySku)} onChange={event => setInput({ ...input, shopifySku: nullable(event.target.value) })} /></label>
              <label>מק״ט יצרן, אם ידוע<input dir="ltr" value={input.manufacturerSku ?? ""} readOnly={Boolean(record?.input.manufacturerSku)} onChange={event => setInput({ ...input, manufacturerSku: nullable(event.target.value) })} /></label>
              <label>מותג<select value={input.brand ?? ""} onChange={event => setInput({ ...input, brand: nullable(event.target.value) as CreationIntentInput["brand"] })}>
                <option value="">לא נבחר</option>{["Mandarina Duck", "Bric's", "Samsonite"].map(brand => <option key={brand}>{brand}</option>)}</select></label>
              <label>קטגוריה<select value={input.category ?? ""} onChange={event => setInput({ ...input, category: nullable(event.target.value) as CreationIntentInput["category"] })}>
                <option value="">לא סווג</option><option value="carryon">טרולי</option><option value="suitcase">מזוודה</option></select></label>
            </div>
            <label>כותרת<input value={input.copy.title ?? ""} onChange={event => patchCopy({ title: nullable(event.target.value) })} /></label>
            <label>תיאור ללקוח</label>{busy || frozen || !enabled ? <p style={{ whiteSpace: "pre-wrap" }}>{input.copy.description ?? "טרם הוזן"}</p>
              : <ProductDescriptionEditor text={input.copy.description ?? ""} html={input.copy.descriptionHtml}
                onChange={({ text, html }) => patchCopy({ description: text, descriptionHtml: html })} />}
            {input.copy.description === null && <button type="button" onClick={() => patchCopy({ description: "", descriptionHtml: "" })}>שמירת תיאור ריק במפורש</button>}
            <label>כותרת SEO<input value={input.copy.seoTitle ?? ""} onChange={event => patchCopy({ seoTitle: event.target.value })} /></label>
            <label>תיאור SEO<textarea value={input.copy.seoDescription ?? ""} onChange={event => patchCopy({ seoDescription: event.target.value })} /></label>
            <label>כתובות מקור לבדיקה — אחת בשורה<textarea dir="ltr" value={input.sourceReferences.join("\n")} onChange={event => setInput({ ...input, sourceReferences: event.target.value.split("\n").filter(Boolean) })} /></label>
            {input.manufacturerSku && input.manufacturerSku !== input.shopifySku && <label>מזהה אסמכתת התאמה מאומתת<input dir="ltr" value={input.identityMappingReceiptId ?? ""} onChange={event => setInput({ ...input, identityMappingReceiptId: nullable(event.target.value) })} />
              <small>קישור למקור אינו אסמכתת אימות. המערכת בודקת רשומה קיימת שנוצרה בתהליך אימות נפרד.</small></label>}
          </fieldset>
          <fieldset disabled={busy || frozen || !enabled}><legend>תמונות המוצר והצבע המדויקים</legend>
            <label>העלאת תמונת מוצר<input type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/gif" disabled={input.media.length >= 10}
              onChange={event => { const file = event.target.files?.[0]; if (file) void uploadImage(file); event.target.value = ""; }} /></label>
            {input.media.map((media, index) => <div key={index} className="creation-grid">
              <label>כתובת תמונה {index + 1}<input type="url" dir="ltr" value={media.url} onChange={event => setInput({ ...input, media: input.media.map((m, i) => i === index ? { ...m, url: event.target.value } : m) })} /></label>
              <label>תיאור התמונה<input value={media.alt ?? ""} onChange={event => setInput({ ...input, media: input.media.map((m, i) => i === index ? { ...m, alt: nullable(event.target.value) } : m) })} /></label>
              <button onClick={() => setInput({ ...input, media: input.media.filter((_, i) => i !== index) })}>הסרת תמונה {index + 1}</button></div>)}
            <button disabled={input.media.length >= 10} onClick={() => setInput({ ...input, media: [...input.media, { url: "", alt: null }] })}>הוספת תמונה</button>
            <p>תמונה צריכה להיות בקובץ מאומת באחסון הגלריה או ב-Shopify. כתובת בלבד אינה אישור לזהות המוצר.</p>
          </fieldset>
          <fieldset disabled={busy || frozen || !enabled}><legend>החלטות מכירה של החנות</legend><div className="creation-grid">
            <label>מחיר מכירה<input dir="ltr" inputMode="decimal" value={input.commerce.sellingPrice ?? ""} onChange={event => patchCommerce({ sellingPrice: nullable(event.target.value) })} /></label>
            <label>מטבע החנות<input dir="ltr" maxLength={3} value={input.commerce.currency ?? ""} onChange={event => patchCommerce({ currency: nullable(event.target.value) })} /></label>
            <label>מחיר השוואה, אם קיים<input dir="ltr" inputMode="decimal" value={input.commerce.compareAtPrice ?? ""} onChange={event => patchCommerce({ compareAtPrice: nullable(event.target.value) })} /></label>
            <label>ברקוד, אם קיים<input dir="ltr" value={input.commerce.barcode ?? ""} onChange={event => patchCommerce({ barcode: nullable(event.target.value) })} /></label>
            <label>מס<select value={input.commerce.taxable === null ? "" : String(input.commerce.taxable)} onChange={event => patchCommerce({ taxable: event.target.value === "" ? null : event.target.value === "true" })}>
              <option value="">טרם הוחלט</option><option value="true">חייב במס</option><option value="false">פטור ממס</option></select></label>
            <label>מוצר פיזי למשלוח<select value={input.commerce.requiresShipping ? "true" : ""} onChange={event => patchCommerce({ requiresShipping: event.target.value === "true" ? true : null })}>
              <option value="">טרם הוחלט</option><option value="true">כן</option></select></label>
            <label>יעד השמירה<select value={input.commerce.storeIntent} onChange={event => patchCommerce({ storeIntent: event.target.value as CreationIntentInput["commerce"]["storeIntent"] })}>
              <option value="undecided">שמירה מקומית בינתיים</option><option value="draft">הכנת טיוטה בחנות</option><option value="publish_when_ready">טיוטה כעת; פרסום בעתיד כשהכול מוכן</option></select></label>
          </div><p>לא נקבע מלאי ולא מתבצע פרסום ללקוחות במסלול הזה.</p></fieldset>
          <button disabled={busy || frozen || !enabled} onClick={() => void save()}>שמירת הטיוטה</button>
          {record && <button disabled={busy} onClick={() => void load(record.input.galleryItemId)}>רענון מצב</button>}
          {frozen && !["draft_ready", "review"].includes(stage) && <button disabled={busy || !enabled} onClick={() => void resume()}>המשך טיפול בטיוטה השמורה</button>}
          {frozen && <p>הפרטים הוקפאו כדי למנוע יצירה כפולה. מצב: <bdi>{stage}</bdi>. טיוטה מוכנה עדיין אינה מוצר ציבורי.</p>}
          {readiness && <section aria-label="מוכנות המוצר"><h2>מה חסר</h2>
            <p>{readiness.draftBlockers.length ? readiness.draftBlockers.map(reason => REASONS[reason] ?? reason).join(" · ") : "פרטי הבסיס נשמרו; יש להשלים את אימות המקורות והתמונות בשרת."}</p>
            <p>לפרסום ציבורי: {readiness.publicBlockers.map(reason => REASONS[reason] ?? reason).join(" · ")}</p></section>}
        </>}
      </>}
      <p role="status" aria-live="polite">{notice}</p>
    </div>
  </section>;
}
