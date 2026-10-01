"use client";

import { useEffect, useRef, useState } from "react";

type Definition = { key: string; labelHe: string; type: string; unit?: string };
type Observation = { cell: { state: string; value?: unknown } };
type Field = { key: string; galleryVersion: number; currentGallery: Observation };
type Context = {
  initialized: boolean; clearsEnabled?: boolean;
  identity: { productGid: string; variantGid: string; itemId: string; gallerySku: string; exactSku: string; productHandle: string };
  definitions: Definition[]; fields: Field[];
};
const unitLabel: Record<string, string> = { centimeters: "ס״מ", kilograms: "ק״ג", liters: "ליטר" };

function inputValue(observation: Observation): string {
  if (observation.cell.state !== "value") return "";
  const value = observation.cell.value;
  if (value && typeof value === "object" && "decimal" in value) return String(value.decimal);
  if (Array.isArray(value)) return value.flatMap(section => section.items.map((item: { label: string; value: string }) => `${item.label}: ${item.value}`)).join("\n");
  return String(value ?? "");
}

export default function TypedSpecificationEditor({ itemId, token }: { itemId: string; token: string }) {
  const [context, setContext] = useState<Context | null>(null);
  const [clears, setClears] = useState<Record<string, boolean>>({});
  const currentItem = useRef(itemId), generation = useRef(0);
  useEffect(() => { currentItem.current = itemId; generation.current++; setContext(null); setClears({}); }, [itemId]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function load() {
    const run = ++generation.current; setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/admin/shopify/specs/fields?itemId=${encodeURIComponent(itemId)}`, { headers: { "x-admin-token": token }, cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "סנכרון המפרט עדיין אינו פעיל." : "המפרט המסונכרן אינו זמין למוצר הזה כרגע.");
      const data: Context = await response.json();
      if (run !== generation.current || currentItem.current !== itemId) return;
      setClears({}); setContext(data); setValues(Object.fromEntries(data.fields.map(field => [field.key, inputValue(field.currentGallery)])));
      if (!data.initialized) setMessage("חיבור המוצר לסנכרון המפרט טרם הושלם.");
    } catch (error) { if (run === generation.current) setMessage(error instanceof Error ? error.message : "טעינת המפרט נכשלה."); }
    finally { if (run === generation.current) setBusy(false); }
  }
  async function save() {
    if (!context || context.identity.itemId !== itemId) return;
    const selected = itemId;
    setBusy(true); setMessage("");
    try {
      const changes: Record<string, unknown> = {}, versions: Record<string, number> = {};
      for (const definition of context.definitions) {
        const field = context.fields.find(row => row.key === definition.key);
        if (!field) continue;
        if (clears[definition.key]) { if (!context.clearsEnabled) throw new Error("מחיקה מפורשת עדיין אינה פעילה."); changes[definition.key] = null; versions[definition.key] = field.galleryVersion; continue; }
        if (values[definition.key] === inputValue(field.currentGallery)) continue;
        const value = (values[definition.key] ?? "").trim();
        if (!value) throw new Error(`אין להשאיר את השדה ${definition.labelHe} ריק לאחר שכבר נשמר.`);
        changes[definition.key] = definition.unit ? { value, unit: definition.unit }
          : definition.type === "boolean" ? value === "true"
          : definition.type === "json" ? [{ heading: "פרטים נוספים", items: value.split("\n").filter(line => line.trim()).map(line => {
            const split = line.indexOf(":");
            if (split < 1 || !line.slice(split + 1).trim()) throw new Error("בפרטים נוספים יש להזין שם: ערך בכל שורה.");
            return { label: line.slice(0, split).trim(), value: line.slice(split + 1).trim() };
          }) }] : value;
        versions[definition.key] = field.galleryVersion;
      }
      if (!Object.keys(changes).length) { setMessage("אין שינויים לשמירה."); return; }
      const identity = context.identity;
      const response = await fetch("/api/admin/shopify/specs/fields", { method: "PATCH", headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ productId: identity.productGid, variantId: identity.variantGid, itemId: identity.itemId,
          exactGallerySku: identity.gallerySku, exactShopifySku: identity.exactSku, productHandle: identity.productHandle,
          requestId: crypto.randomUUID(), changes, versions }) });
      if (!response.ok) throw new Error(response.status === 409 ? "המוצר השתנה מאז הטעינה. רעננו את המפרט לפני שמירה נוספת." : "שמירת המפרט נכשלה.");
      if (currentItem.current !== selected) return;
      await load(); setMessage("המפרט נשמר בגלריה ונשלח לסנכרון עם החנות.");
    } catch (error) { if (currentItem.current === selected) setMessage(error instanceof Error ? error.message : "שמירת המפרט נכשלה."); }
    finally { if (currentItem.current === selected) setBusy(false); }
  }
  return <details style={{ gridColumn: "1 / -1" }}>
    <summary>מפרט מסונכרן עם החנות</summary>
    <button type="button" disabled={busy} onClick={load}>{context ? "רענון המפרט" : "טעינת המפרט לעריכה"}</button>
    {context?.initialized && <>
      <div className="admin-item-grid">
        {context.definitions.map(definition => <div key={definition.key}><label>
          {definition.labelHe}{definition.unit ? ` (${unitLabel[definition.unit] ?? definition.unit})` : ""}
          {definition.type === "boolean" ? <select disabled={busy || Boolean(clears[definition.key])} value={values[definition.key] ?? ""} onChange={event => setValues(current => ({ ...current, [definition.key]: event.target.value }))}>
            <option value="">לא הוגדר</option><option value="true">כן</option><option value="false">לא</option>
          </select> : ["multi_line_text_field", "json"].includes(definition.type) ?
            <textarea rows={3} disabled={busy || Boolean(clears[definition.key])} value={values[definition.key] ?? ""} onChange={event => setValues(current => ({ ...current, [definition.key]: event.target.value }))} placeholder={definition.type === "json" ? "שם: ערך" : undefined} /> :
            <input disabled={busy || Boolean(clears[definition.key])} value={values[definition.key] ?? ""} inputMode={definition.unit ? "decimal" : definition.type === "number_integer" ? "numeric" : "text"}
              onChange={event => setValues(current => ({ ...current, [definition.key]: event.target.value }))} />}
          </label>
          {context.clearsEnabled && <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={Boolean(clears[definition.key])} onChange={event => setClears(previous => ({ ...previous, [definition.key]: event.target.checked }))} />הסרה מפורשת של ערך זה מהתצוגה בשני האתרים</label>}
        </div>)}
      </div>
      <button type="button" disabled={busy} onClick={save}>שמירת המפרט וסנכרון לחנות</button>
    </>}
    {message && <p role="status">{message}</p>}
  </details>;
}
