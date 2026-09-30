"use client";
import { useEffect, useState } from "react";
type Definition = { key: string; labelHe: string; type: string; unit?: string };
type Observation = { cell: { state: string; value?: unknown }; revision: string | null };
type Product = { productGid: string; gallerySku: string; shopifySku: string };
type Loaded = { initialized: boolean; fields: Record<string, { gallery: Observation; shopify: Observation; galleryVersion: number }> };
const unitLabels: Record<string, string> = { centimeters: "ס״מ", liters: "ליטר", kilograms: "ק״ג" };
function display(observation?: Observation): string {
  if (!observation || observation.cell.state !== "value") return "";
  const value = observation.cell.value;
  if (typeof value === "object" && value && "decimal" in value) return String(value.decimal);
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}
async function api(path = "", method = "GET", payload?: unknown) {
  const response = await fetch(`/api/panel/shopify/specs${path}`, { method, cache: "no-store", headers: payload ? { "content-type": "application/json" } : undefined, body: payload ? JSON.stringify(payload) : undefined });
  const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "SPEC_REQUEST_FAILED"); return body;
}
export default function TypedSpecsEditor() {
  const [products, setProducts] = useState<Product[]>([]), [definitions, setDefinitions] = useState<Definition[]>([]);
  const [selected, setSelected] = useState(""), [loaded, setLoaded] = useState<Loaded | null>(null), [edited, setEdited] = useState<Record<string, string>>({});
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; api().then(data => { if (live) { setProducts(data.products); setDefinitions(data.definitions); } }).catch(error => { if (live) setMessage(error.message === "SPEC_DISABLED" ? "סנכרון המפרט עדיין לא הופעל." : "לא ניתן לטעון את המפרט כעת."); }); return () => { live = false; }; }, []);
  async function load(productId: string) {
    setBusy(true); setMessage(""); setLoaded(null); setEdited({}); setSelected(productId);
    try { if (productId) setLoaded(await api(`?productId=${encodeURIComponent(productId)}`)); }
    catch { setMessage("לא ניתן לטעון את המוצר. נסו שוב לאחר סיום העדכון."); } finally { setBusy(false); }
  }
  async function initialize() { setBusy(true); try { await api("", "POST", { action: "initialize", productId: selected, requestId: crypto.randomUUID() }); await load(selected); } catch { setMessage("לא ניתן להכין את המפרט לעריכה."); } finally { setBusy(false); } }
  async function save() {
    if (!loaded) return; setBusy(true); setMessage("");
    try {
      const changes: Record<string, unknown> = {}, versions: Record<string, number> = {};
      for (const [key, text] of Object.entries(edited)) {
        const definition = definitions.find(item => item.key === key)!;
        if (!text.trim()) throw new Error("EMPTY");
        changes[key] = definition.unit ? { value: text, unit: definition.unit } : definition.type === "boolean" ? text === "true" : definition.type === "json" ? JSON.parse(text) : definition.type === "number_integer" ? Number(text) : text;
        versions[key] = loaded.fields[key].galleryVersion;
      }
      await api("", "PATCH", { productId: selected, requestId: crypto.randomUUID(), changes, versions });
      await load(selected); setMessage("השדות נשמרו ונשלחו לעדכון אוטומטי בחנות.");
    } catch { setMessage("השמירה לא הושלמה. בדקו את הערכים או טענו מחדש אם המוצר השתנה. ערך ריק אינו מוחק מפרט קיים."); }
    finally { setBusy(false); }
  }
  return <main dir="rtl" className="mx-auto max-w-4xl space-y-8 p-6 text-white">
    <header><h1 className="text-2xl font-semibold">מפרט מוצרים</h1><p className="mt-3 text-sm text-white/70">עריכת נתונים מפורשים בלבד. משקל עצמי נפרד ממשקל המשלוח. שדות שלא נערכו נשארים כפי שהם.</p></header>
    <label className="block">מוצר<select aria-label="מוצר לעריכת מפרט" disabled={busy} value={selected} onChange={event => void load(event.target.value)} className="mt-2 block min-h-11 w-full rounded bg-zinc-900 p-3"><option value="">בחרו מוצר מאושר</option>{products.map(product => <option key={product.productGid} value={product.productGid}>{product.gallerySku}</option>)}</select></label>
    <p role="status" aria-live="polite">{message}</p>
    {loaded && !loaded.initialized && <section><p>הכנת העריכה תשמור את המצב הקיים בשני האתרים, בלי להחליף נתונים.</p><button disabled={busy} onClick={() => void initialize()} className="mt-4 min-h-11 rounded border p-3">הכנת המפרט לעריכה</button></section>}
    {loaded?.initialized && <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-6">
      {definitions.map(definition => { const text = edited[definition.key] ?? display(loaded.fields[definition.key]?.gallery); return <section key={definition.key} className="rounded border border-white/15 p-4">
        <label htmlFor={`spec-${definition.key}`} className="font-medium">{definition.labelHe}{definition.unit ? ` (${unitLabels[definition.unit] ?? definition.unit})` : ""}</label>
        {definition.type === "boolean" ? <select id={`spec-${definition.key}`} disabled={busy} value={text} onChange={event => setEdited(old => ({ ...old, [definition.key]: event.target.value }))} className="mt-2 block min-h-11 w-full bg-zinc-900 p-2"><option value="" disabled>לא הוזן</option><option value="true">כן</option><option value="false">לא</option></select> :
          <textarea id={`spec-${definition.key}`} disabled={busy} value={text} rows={definition.type === "json" ? 5 : definition.type === "multi_line_text_field" ? 3 : 1} onChange={event => setEdited(old => ({ ...old, [definition.key]: event.target.value }))} className="mt-2 block min-h-11 w-full rounded bg-zinc-900 p-3" />}
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-white/60">בחנות: {display(loaded.fields[definition.key]?.shopify) || "לא הוזן"}</p>
      </section>; })}
      <button disabled={busy || !Object.keys(edited).length} type="submit" className="min-h-11 rounded bg-amber-400 px-6 py-3 text-black disabled:opacity-50">שמירת השדות ששונו</button>
    </form>}
  </main>;
}
