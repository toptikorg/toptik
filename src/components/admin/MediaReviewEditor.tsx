"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { prepareMediaReview, type MediaReviewPreview, type ReviewCatalogItem } from "@/lib/shopify/media-review-input";

export default function MediaReviewEditor({ catalog }: { catalog: ReviewCatalogItem[] }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<MediaReviewPreview[]>([]);
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const [accepted, setAccepted] = useState(false);
  const [registered, setRegistered] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  function showPreview() {
    setPreview([]); setLoaded({}); setRegistered({}); setAccepted(false); setMessage("");
    try { setPreview(prepareMediaReview(text, catalog)); }
    catch (e) { setMessage(e instanceof Error ? e.message : "לא ניתן להציג את התוכנית."); }
  }
  async function register() {
    if (sending.current || !accepted || !preview.length || preview.some(p => !loaded[p.key])) return;
    sending.current = true; setBusy(true); setMessage("");
    let completed = Object.values(registered).filter(Boolean).length;
    try {
      for (const entry of preview) {
        if (registered[entry.key]) continue;
        const response = await fetch("/api/admin/shopify/media/review", { method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json" }, body: JSON.stringify(entry.input) });
        const result = await response.json();
        if (!response.ok || result.registered !== true || result.mediaId !== entry.input.mediaId ||
            result.decodedSha256 !== entry.input.expectedSha256 || result.queued !== true) {
          const code = typeof result.error === "string" && /^MEDIA_[A-Z0-9_]{1,90}$/.test(result.error) ? result.error : "MEDIA_REVIEW_FAILED";
          throw new Error(`האישור לא הושלם עבור ${entry.item.sku}. קוד בדיקה: ${code}.`);
        }
        setRegistered(current => ({ ...current, [entry.key]: true })); completed++;
        setMessage(`נרשמו ${completed} מתוך ${preview.length} אישורים. הסנכרון עדיין בבדיקה.`);
      }
      setMessage(`כל ${completed} האישורים נרשמו ונשלחו לתור הסנכרון. יש לאמת את הופעת התמונות בגלריה, הרישום לבדו אינו אישור פרסום.`);
    } catch (e) { setMessage(`${completed} אישורים נרשמו. ${e instanceof Error ? e.message : "אירעה שגיאה. ניתן לנסות שוב את האישורים שנותרו."}`); }
    finally { sending.current = false; setBusy(false); }
  }
  return <section aria-label="בדיקת תמונות לפני סנכרון" style={{ maxWidth: 900 }}>
    <p>הדביקו תוכנית תמונות שנבדקה מול המק״ט, הצבע ומקור היצרן. הרישום מאשר לתור הסנכרון לבדוק את התמונות המדויקות.</p>
    <label htmlFor="media-review-plan">תוכנית אישור תמונות, עד 20 תמונות</label>
    <textarea id="media-review-plan" dir="ltr" rows={8} value={text} disabled={busy} style={{ width: "100%", maxWidth: "100%", marginBlock: 12 }}
      onChange={e => { setText(e.target.value); setPreview([]); setLoaded({}); setRegistered({}); setAccepted(false); setMessage(""); }} />
    <button type="button" disabled={busy || !text.trim()} onClick={showPreview}>הצגת התמונות לבדיקה</button>
    {preview.length > 0 && <>
      <ol style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", gap: 20, padding: 0, listStyle: "none", marginBlock: 24 }}>
        {preview.map(entry => <li key={entry.key} style={{ border: "1px solid #b7a77d", padding: 16, borderRadius: 8, overflowWrap: "anywhere" }}>
          <h2 style={{ fontSize: "1.1rem" }}>{entry.item.title}</h2>
          <p>מק״ט: <bdi>{entry.item.sku}</bdi></p><p>צבע מתועד: {entry.item.color || "יש לבדוק בתמונה ובמקור היצרן"}</p>
          <Image src={entry.input.imageUrl} alt={`תמונה לבדיקה עבור ${entry.item.title}, ${entry.item.sku}`} width={260} height={260} unoptimized
            style={{ width: "100%", height: 260, objectFit: "contain", background: "white" }}
            onLoad={e => { if (e.currentTarget.naturalWidth > 0) setLoaded(current => ({ ...current, [entry.key]: true })); }}
            onError={() => setLoaded(current => ({ ...current, [entry.key]: false }))} />
          <p>{loaded[entry.key] ? "התמונה נטענה" : "ממתין לטעינת התמונה"}</p>
          <p><a href={entry.input.sourceUrl} target="_blank" rel="noopener noreferrer">פתיחת מקור התמונה</a></p>
          <p dir="ltr">{entry.input.sourceUrl}</p>
          <details><summary>זהות מדויקת וראיית הבדיקה</summary><p dir="ltr">{entry.input.identity.productId}<br />{entry.input.identity.variantId}<br />{entry.input.mediaId}</p>
            <p dir="auto">{entry.input.evidence}</p><p dir="ltr">SHA256: {entry.input.expectedSha256}</p></details>
          {registered[entry.key] && <p>האישור נרשם ונשלח לסנכרון</p>}
        </li>)}
      </ol>
      <label style={{ display: "block", marginBlock: 16 }}><input type="checkbox" checked={accepted} disabled={busy}
        onChange={e => setAccepted(e.target.checked)} /> בדקתי שכל תמונה שייכת למק״ט ולצבע המוצגים, מול מקור היצרן.</label>
      <button type="button" disabled={busy || !accepted || preview.some(p => !loaded[p.key]) || preview.every(p => registered[p.key])} onClick={register}>
        {busy ? "רושם אישורים..." : "רישום האישורים ושליחה לסנכרון"}</button>
    </>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
