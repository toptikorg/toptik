"use client";

import { useEffect, useRef, useState } from "react";
import { verifyKlDiagnosticDownload } from "@/lib/shopify/media-diagnostic-download";

export default function MediaDiagnosticDownload() {
  const attempted = useRef(false), urls = useRef<string[]>([]), active = useRef(true), controller = useRef<AbortController | null>(null);
  const [used, setUsed] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [download, setDownload] = useState<{ image: string; receipt: string; filename: string; details: string } | null>(null);
  useEffect(() => {
    active.current = true; const allocated = urls.current;
    return () => { active.current = false; controller.current?.abort(); for (const url of allocated) URL.revokeObjectURL(url); };
  }, []);
  async function capture() {
    if (attempted.current) return;
    attempted.current = true; setUsed(true); setBusy(true); setMessage("מכין תצפית אבחונית אחת...");
    const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 45000);
    try {
      const response = await fetch("/api/admin/shopify/media/diagnostic/kl966005-bytes", { method: "POST", credentials: "same-origin",
        cache: "no-store", signal: abort.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: "3e20d7c1-5828-5f0d-b4b9-215dfe192a1c", mediaId: "gid://shopify/MediaImage/40701188604154" }) });
      const verified = await verifyKlDiagnosticDownload(response);
      if (!active.current) return;
      const details = JSON.stringify(verified.receipt, null, 2);
      const image = URL.createObjectURL(new Blob([verified.bytes], { type: verified.mime }));
      const receipt = URL.createObjectURL(new Blob([details], { type: "application/json" }));
      urls.current.push(image, receipt);
      setDownload({ image, receipt, filename: verified.filename, details });
      setMessage("הקובץ התקבל ואומתו חתימתו וגודלו. אפשר להוריד את התמונה ואת קבלת הבדיקה.");
    } catch { if (active.current) setMessage("הייצוא לא הושלם. לא נשלחת בקשה חוזרת אוטומטית. יש לבדוק את הכשל לפני ניסיון נוסף."); }
    finally { clearTimeout(timeout); if (active.current) setBusy(false); }
  }
  return <section aria-label="ייצוא אבחוני KL966005" style={{ maxWidth: 850 }}>
    <p>תמונה 3 של KL966005 בלבד. זו תצפית חדשה לקריאה ובדיקה, ללא רישום תמונות או שינוי נתוני מוצר.</p>
    <button type="button" disabled={used || busy} onClick={capture}>{busy ? "מכין קובץ..." : "הכנת קובץ אבחוני אחד"}</button>
    <p role="status" aria-live="polite">{message}</p>
    {download && <div>
      <p><a href={download.image} download={download.filename}>הורדת התמונה האבחונית</a></p>
      <p><a href={download.receipt} download="KL966005-diagnostic-receipt.json">הורדת קבלת הבדיקה</a></p>
      <details><summary>נתוני הקובץ והבדיקה</summary><pre dir="ltr" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{download.details}</pre></details>
    </div>}
  </section>;
}
