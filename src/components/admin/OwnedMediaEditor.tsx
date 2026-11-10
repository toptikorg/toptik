"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  moveOwnedEditorImage, ownedMediaDraftChanged, ownedMediaEditorCommand, removeOwnedEditorImage,
  type OwnedEditorImage, type OwnedMediaEditorCommand, type OwnedMediaEditorData, type OwnedMediaEditorResult,
} from "@/lib/shopify/owned-media-editor-state";

type Props = { itemId: string; token: string; disabled: boolean; onDelivered: () => Promise<void>; onBusyChange: (busy: boolean) => void };
const endpoint = "/api/admin/shopify/owned/media";

/** Separate media draft: a copy save cannot discard an unsent upload/order edit. */
export default function OwnedMediaEditor({ itemId, token, disabled, onDelivered, onBusyChange }: Props) {
  const [opened, setOpened] = useState(false);
  const [data, setData] = useState<OwnedMediaEditorData | null>(null);
  const [images, setImages] = useState<OwnedEditorImage[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const busyRef = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const pending = useRef<OwnedMediaEditorCommand | { requestId: string; itemId: string } | null>(null);
  const dirty = data ? ownedMediaDraftChanged(data, images, assignments) : false;
  const locked = busy || disabled || !data?.enabled || Boolean(pending.current || data?.pending);
  useEffect(() => () => {
    generation.current++;
    if (busyRef.current) { busyRef.current = false; busyCallback.current(false); }
  }, [itemId]);
  function setWorking(value: boolean) { busyRef.current = value; setBusy(value); busyCallback.current(value); }

  async function request<T>(method: "GET" | "POST", body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(method === "GET" ? `${endpoint}?itemId=${encodeURIComponent(itemId)}` : endpoint, {
      method, cache: "no-store", signal,
      headers: { "x-admin-token": token, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(value?.message || "הבדיקה בחנות לא הושלמה. העריכה נשמרה במסך; אין לשלוח שינוי חדש עד לאימות המצב.");
    if (!value) throw new Error("תשובת הסנכרון לא תקינה.");
    return value as T;
  }

  async function load() {
    const current = ++generation.current;
    setWorking(true); setNotice("");
    try {
      const fresh = await request<OwnedMediaEditorData>("GET");
      if (current !== generation.current) return;
      setData(fresh); setImages(fresh.images); setAssignments({});
      pending.current = fresh.pending ? { requestId: fresh.pending.requestId, itemId } : null;
      if (fresh.pending) setNotice(fresh.pending.message);
      else if (!fresh.enabled) setNotice(fresh.reason || "שיוך התמונות עדיין ממתין לבדיקה. לא נשלח שינוי.");
    } catch (error) { if (current === generation.current) setNotice(error instanceof Error ? error.message : "טעינת התמונות נכשלה."); }
    finally { if (current === generation.current) setWorking(false); }
  }

  async function save(resume = false) {
    if (!data || busy) return;
    let command = pending.current;
    if (!resume) {
      try { command = ownedMediaEditorCommand(data, images, assignments, crypto.randomUUID()); }
      catch (error) { setNotice(error instanceof Error ? error.message : "העריכה לא תקינה."); return; }
    }
    if (!command) return;
    // Retain the same operation identity on timeout or lost responses. Resume asks
    // the durable journal to read back first; it never submits a fresh operation.
    pending.current = command;
    const current = ++generation.current;
    setWorking(true); setNotice("שומר את התמונות בחנות ובודק את התוצאה...");
    try {
      const result = await request<OwnedMediaEditorResult>("POST", resume ? { action: "resume", requestId: command.requestId, itemId } : { action: "edit", ...command });
      if (current !== generation.current) return;
      if (result.requestId !== command.requestId) throw new Error("מזהה הפעולה בתשובה אינו תואם. יש לבדוק את הסנכרון לפני שינוי נוסף.");
      setNotice(result.message);
      if (result.notRecorded) {
        pending.current = null;
        setData(previous => previous ? { ...previous, pending: null } : previous);
      } else if (result.status === "done") {
        pending.current = null;
        await onDelivered();
        const fresh = await request<OwnedMediaEditorData>("GET");
        if (current !== generation.current) return;
        setData(fresh); setImages(fresh.images); setAssignments({});
        pending.current = fresh.pending ? { requestId: fresh.pending.requestId, itemId } : null;
      } else {
        setData(previous => previous ? { ...previous, pending: { requestId: command.requestId, status: result.status === "review" ? "review" : "pending", message: result.message } } : previous);
      }
    } catch (error) {
      if (current === generation.current) {
        setData(previous => previous ? { ...previous, pending: { requestId: command.requestId, status: "pending", message: "התוצאה ממתינה לאימות." } } : previous);
        setNotice(error instanceof Error ? error.message : "תוצאת השמירה אינה ודאית. יש לבדוק לפני שינוי נוסף.");
      }
    } finally { if (current === generation.current) setWorking(false); }
  }

  async function upload(file: File) {
    if (locked || !data) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024 || !file.size) {
      setNotice("יש לבחור תמונת JPEG, PNG או WebP עד 8MB."); return;
    }
    const current = ++generation.current;
    setWorking(true); setNotice("מעלה תמונה לטיוטה. היא תישלח לחנות רק בשמירה.");
    try {
      const form = new FormData(); form.append("file", file); form.append("folder", `items/${itemId}/owned-drafts`);
      const response = await fetch("/api/admin/upload", { method: "POST", headers: { "x-admin-token": token }, body: form });
      const value = await response.json().catch(() => null);
      if (!response.ok || typeof value?.publicUrl !== "string") throw new Error("העלאת התמונה נכשלה.");
      if (current !== generation.current) return;
      setImages(previous => [...previous, { key: crypto.randomUUID(), mediaId: null, url: value.publicUrl, alt: "" }]);
      setNotice("התמונה נוספה לטיוטה. כתבו תיאור נגיש ושמרו בחנות.");
    } catch (error) { if (current === generation.current) setNotice(error instanceof Error ? error.message : "ההעלאה נכשלה."); }
    finally { if (current === generation.current) setWorking(false); }
  }

  return <section className="admin-item-angles" dir="rtl" aria-label="סנכרון תמונות הצבע" style={{ marginTop: 16 }}>
    <button type="button" disabled={busy || disabled} aria-expanded={opened} onClick={() => {
      if (opened) { setOpened(false); return; }
      setOpened(true); if (!data) void load();
    }}>ניהול תמונות הצבע בחנות ובגלריה</button>
    {opened && <>
      <p>התמונה הראשונה היא הראשית. הסרה מנתקת תמונה מהמוצר הזה בלבד. קובץ שמשמש מוצר או צבע אחר נשמר.</p>
      {data && <>
        <ol style={{ display: "flex", flexWrap: "wrap", gap: 12, paddingInlineStart: 24 }}>
          {images.map((image, index) => <li key={image.key} style={{ width: 170 }}>
            <Image unoptimized src={image.url} alt={image.alt || "תמונת מוצר בטיוטה"} width={96} height={96} style={{ objectFit: "contain" }} />
            <label style={{ display: "block" }}>תיאור נגיש
              <input value={image.alt} maxLength={512} disabled={locked || image.mediaId !== null} style={{ width: "100%" }} onChange={event => setImages(previous => previous.map(row => row.key === image.key ? { ...row, alt: event.target.value } : row))} />
            </label>
            <div role="group" aria-label={`סידור תמונה ${index + 1}`} style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              <button type="button" disabled={locked || index === 0} onClick={() => setImages(previous => moveOwnedEditorImage(previous, image.key, -1))}>הקדם</button>
              <button type="button" disabled={locked || index === images.length - 1} onClick={() => setImages(previous => moveOwnedEditorImage(previous, image.key, 1))}>דחה</button>
              <button type="button" disabled={locked || index === 0} onClick={() => setImages(previous => moveOwnedEditorImage(previous, image.key, "cover"))}>ראשית</button>
              <button type="button" disabled={locked || images.length < 2} onClick={() => setImages(previous => removeOwnedEditorImage(previous, image.key))}>הסר</button>
            </div>
          </li>)}
        </ol>
        <p>לתיאור נגיש של תמונה קיימת השתמשו בשדות תיאור התמונה שבכרטיס ובכפתור שמור בחנות.</p>
        <label className="admin-batch-upload">הוסף תמונה
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={locked || images.length >= 20} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file);
          }} />
        </label>
        {data.unassigned.length > 0 && <fieldset disabled={locked}>
          <legend>תמונות חדשות בחנות שדורשות שיוך לצבע</legend>
          {data.unassigned.map(image => <div key={image.mediaId}>
            <Image unoptimized src={image.url} alt={image.alt || "תמונה ממתינה לשיוך"} width={80} height={80} style={{ objectFit: "contain" }} />
            {data.variants.map(variant => <label key={variant.itemId} style={{ display: "inline-block", margin: 6 }}>
              <input type="checkbox" checked={assignments[image.mediaId]?.includes(variant.itemId) ?? false} onChange={event => {
                const checked = event.currentTarget.checked;
                setAssignments(previous => {
                  const existing = previous[image.mediaId] ?? [];
                  return { ...previous, [image.mediaId]: checked ? [...existing, variant.itemId] : existing.filter(id => id !== variant.itemId) };
                });
                if (variant.itemId === itemId) {
                  setImages(current => checked
                    ? current.some(row => row.mediaId === image.mediaId) ? current : [...current, { key: image.mediaId, mediaId: image.mediaId, url: image.url, alt: image.alt }]
                    : current.filter(row => row.mediaId !== image.mediaId));
                }
              }} />{variant.label} ({variant.sku})
            </label>)}
          </div>)}
        </fieldset>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <button type="button" disabled={locked || !dirty} onClick={() => void save()}>שמור תמונות בחנות ובגלריה</button>
          {(pending.current || data.pending) && <button type="button" disabled={busy || disabled} onClick={() => void save(true)}>בדוק והמשך את אותה פעולה</button>}
          <button type="button" disabled={busy || disabled || dirty || Boolean(pending.current || data.pending)} onClick={() => void load()}>טען מצב עדכני</button>
          {dirty && !pending.current && !data.pending && <button type="button" disabled={busy || disabled} onClick={() => {
            if (window.confirm("לבטל את טיוטת התמונות שבמסך ולטעון את המצב העדכני מהחנות?")) void load();
          }}>בטל טיוטת תמונות וטען מחדש</button>}
        </div>
      </>}
      {notice && <p role="status" aria-live="polite">{notice}</p>}
    </>}
  </section>;
}
