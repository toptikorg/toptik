"use client";

import Image from "next/image";
import { useRef, useState } from "react";

/** Shown for every new image the merchant uploaded to an ordinary product. The image must be seen, and the
 * exact model and color confirmed, before it can be saved. Confirming asks the page to have the server copy the
 * file to its permanent content-addressed place and record the approval; nothing reaches the store until the
 * catalog save. `sku` and `revision` are those of the SAVED card (what the server checks), not of local edits.
 * `onConfirm` resolves with an error text to show, or null when the upload was replaced by its approved copy. */
export default function StagedImageReview({ sku, revision, title, imageUrl, disabled, onConfirm }: {
  sku: string; revision: number | undefined; title: string; imageUrl: string; disabled?: boolean;
  onConfirm: (note: string) => Promise<string | null>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // A second click on a handler from the same render must not send a second request.
  const inFlight = useRef(false);
  const hasVersion = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 && Boolean(sku);

  async function confirm() {
    if (inFlight.current || !confirmed || busy || disabled || !hasVersion) return;
    inFlight.current = true;
    setBusy(true); setMessage(null);
    try {
      setMessage(await onConfirm(note.trim()));
    } catch {
      setMessage("אישור התמונה נכשל. לא נשלח דבר.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div role="group" aria-label="אישור תמונה חדשה" style={{ marginTop: 12, padding: 12, border: "2px solid #c9a227", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <strong>תמונה חדשה ממתינה לאישור</strong>
      <Image src={imageUrl} alt="התמונה שהועלתה, לבדיקה לפני שמירה" width={240} height={240} unoptimized style={{ objectFit: "contain", background: "#fff", border: "1px solid #ddd" }} />
      <p style={{ margin: 0 }}>
        לפני שהתמונה נשלחת לחנות, בדקו שזו התמונה של הדגם והצבע המדויקים: <bdi>{title}</bdi> · מק״ט <bdi dir="ltr">{sku}</bdi>.
      </p>
      <label className="checkbox-line">
        <input type="checkbox" checked={confirmed} disabled={busy || disabled || !hasVersion} onChange={event => setConfirmed(event.target.checked)} />
        <span>בדקתי את התמונה בעיניים: זו תמונה של הדגם והצבע האלה, לא של דגם או צבע אחר.</span>
      </label>
      <label>
        הערה לאישור (לא חובה)
        <input value={note} maxLength={300} disabled={busy || disabled} onChange={event => setNote(event.target.value)} />
      </label>
      <button type="button" onClick={() => void confirm()} disabled={!confirmed || busy || disabled || !hasVersion}>
        {busy ? "מכין את התמונה..." : "אשר את התמונה והכן לשמירה"}
      </button>
      {!hasVersion && <p role="alert" style={{ margin: 0 }}>גרסת הכרטיס חסרה. טענו מחדש לפני אישור התמונה.</p>}
      {message && <p role="alert" style={{ margin: 0 }}>{message}</p>}
    </div>
  );
}
