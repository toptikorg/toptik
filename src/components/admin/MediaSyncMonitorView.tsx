import styles from "./MediaSyncMonitor.module.css";
import { explainMediaCode, mediaVerdict, sectionFresh, STATUS_TEXT, UNKNOWN_TEXT,
  type MediaSyncMonitorPayload, type QueueCounts, type Unknown } from "@/lib/shopify/media-sync-monitor";
import { assessReading, explainLivenessRule, LIVENESS_STATE_TEXT, type LivenessState } from "@/lib/shopify/media-liveness";

type Props = { payload: MediaSyncMonitorPayload | null; failure: Unknown | null; loading: boolean; now: number; onRefresh?: () => void };
const UNKNOWN_VALUE = "לא ידוע";
const format = new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Jerusalem" });
function When({ value }: { value: string }) { return <time dateTime={value}>{format.format(new Date(value))}</time>; }

const VERDICT = {
  unknown: { label: "מצב לא ידוע", tone: "unknown" },
  attention: { label: "דורש טיפול", tone: "danger" },
  in_progress: { label: "בתהליך", tone: "progress" },
  queue_complete: { label: "תור התמונות הסתיים", tone: "complete" },
} as const;

function Counts({ title, counts, known }: { title: string; counts: QueueCounts | null; known: boolean }) {
  const rows: [string, keyof QueueCounts][] = [["ממתינים", "pending"], ["בעיבוד", "processing"], ["דורשי בדיקה", "review"], ["שגיאות", "failed"], ["הסתיימו", "complete"]];
  return <div className={styles.card}>
    <h3 className={styles.cardTitle}>{title}</h3>
    <dl className={styles.counts}>
      {rows.map(([label, key]) => <div key={key} className={styles.count}>
        <dt>{label}</dt><dd>{known && counts ? counts[key].toLocaleString("he-IL") : UNKNOWN_VALUE}</dd>
      </div>)}
    </dl>
  </div>;
}

export default function MediaSyncMonitorView({ payload, failure, loading, now, onRefresh }: Props) {
  const verdict = mediaVerdict(payload, failure, now);
  const known = verdict.kind !== "unknown";
  const queues = known && payload?.queues.available ? payload.queues.data : null;
  const reasons = known && payload?.reasons.available && sectionFresh(payload.reasons.observedAt, now) ? payload.reasons.data.filter(r => r.status !== "done") : null;
  const items = known && payload?.items.available && sectionFresh(payload.items.observedAt, now) ? payload.items.data : null;
  // Liveness verdicts are computed here, with the viewer's clock, from the durable rows the server sanitized. Absent key = feature off.
  const liveness = known && payload?.liveness?.available ? assessReading(payload.liveness.data, payload.liveness.observedAt, now) : null;
  const livenessRows = liveness ? liveness.rows.filter(r => r.state !== "healthy") : [];
  const ago = (ms: number | null) => ms === null ? UNKNOWN_VALUE : ms < 60 * 1000 ? "פחות מדקה" : `${Math.floor(ms / 60000).toLocaleString("he-IL")} דק׳`;
  const v = VERDICT[verdict.kind];
  return <section className={styles.monitor} aria-labelledby="media-sync-monitor-title" aria-busy={loading}>
    <div className={styles.head}>
      <div>
        <h2 id="media-sync-monitor-title" className={styles.title}>מעקב סנכרון תמונות</h2>
        <p className={styles.note}>תצוגה לקריאה בלבד. אין במסך זה פעולות על התור, על האישורים או על המוצרים.</p>
      </div>
      {onRefresh && <button type="button" className={styles.refresh} onClick={onRefresh} disabled={loading}>{loading ? "טוען..." : "רענון התצוגה"}</button>}
    </div>

    <div className={`${styles.verdict} ${styles[v.tone]}`} role="status" aria-live="polite">
      <strong>{loading && !payload && !failure ? "טוען את מצב הסנכרון..." : v.label}</strong>
      {!(loading && !payload && !failure) && <p>
        {verdict.kind === "unknown" ? UNKNOWN_TEXT[verdict.reason] :
         verdict.kind === "attention" ? "יש תמונות שדורשות בדיקה או שנכשלו. פירוט בטבלה למטה." :
         verdict.kind === "in_progress" ? "יש תמונות שממתינות או נמצאות בעיבוד." :
         "אין עבודה פתוחה בתור התמונות. סיום התור אינו אימות שהתמונות מופיעות באתר החי."}
      </p>}
      {payload && <p className={styles.small}>נקרא בשרת: <When value={payload.fetchedAt} /></p>}
    </div>

    <div className={styles.live}>
      <strong>אימות באתר החי: לא נבדק במסך זה</strong>
      <p>המסך מציג את מצב התורים בלבד. גם תור שהסתיים אינו מוכיח שהתמונות מוצגות בגלריה ובחנות. יש לבדוק את העמודים החיים בנפרד.</p>
    </div>

    <div className={styles.lanes}>
      <Counts title="תור התמונות" counts={queues?.media ?? null} known={!!queues} />
      <Counts title="תור הטקסט (נפרד)" counts={queues?.copy ?? null} known={!!queues && queues.runtime.copy} />
    </div>
    {queues && !queues.runtime.copy && <p className={styles.unknownLine}>סנכרון הטקסט כבוי בסביבה זו. מצב תור הטקסט אינו ידוע.</p>}
    <dl className={styles.extra}>
      <div><dt>פעולות תמונה פתוחות</dt><dd>{queues ? queues.mediaOperations.open.toLocaleString("he-IL") : UNKNOWN_VALUE}</dd></div>
      <div><dt>התנגשויות שמחכות לבדיקה</dt><dd>{queues ? queues.mediaOperations.conflict.toLocaleString("he-IL") : UNKNOWN_VALUE}</dd></div>
      <div><dt>מוצרים ללא בסיס השוואה</dt><dd>{queues ? queues.coverage.missingMediaBaseline.toLocaleString("he-IL") : UNKNOWN_VALUE}</dd></div>
      <div><dt>מוצרים ללא שורת תור</dt><dd>{queues ? queues.coverage.missingMediaQueue.toLocaleString("he-IL") : UNKNOWN_VALUE}</dd></div>
    </dl>
    <p className={styles.small}>אותו מוצר יכול להיכלל בשתי ספירות החוסרים.</p>

    <h3 className={styles.sectionTitle}>סיבות עיכוב</h3>
    {!reasons ? <p className={styles.unknownLine}>סיכום הסיבות אינו זמין. {UNKNOWN_VALUE}.</p> :
      reasons.length === 0 ? <p>אין שורות פתוחות עם סיבת עיכוב.</p> :
      <ul className={styles.reasons}>{reasons.map(r => { const e = explainMediaCode(r.code); return <li key={`${r.status}:${r.code ?? "none"}`}>
        <strong>{e.title}</strong> <span className={styles.badge}>{STATUS_TEXT[r.status] ?? r.status}</span> <span>{r.products.toLocaleString("he-IL")} מוצרים</span>
        <p>{e.detail}</p>{e.code && <p className={styles.small}>קוד: <bdi dir="ltr">{e.code}</bdi></p>}
      </li>; })}</ul>}

    <h3 className={styles.sectionTitle} id="media-sync-items-title">מוצרים פתוחים בתור התמונות</h3>
    {!items ? <p className={styles.unknownLine}>פירוט המוצרים אינו זמין. {UNKNOWN_VALUE}.</p> :
      items.rows.length === 0 ? <p>{items.openTotal === 0 ? "אין מוצרים פתוחים בתור התמונות." : `יש ${items.openTotal} מוצרים פתוחים, אך הפירוט לא התקבל.`}</p> :
      <>
        {items.openTotal > items.rows.length && <p className={styles.small}>מוצגים {items.rows.length} הוותיקים מתוך {items.openTotal.toLocaleString("he-IL")} פתוחים.</p>}
        <div className={styles.tableWrap} role="region" aria-labelledby="media-sync-items-title" tabIndex={0}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>מוצרים פתוחים בתור התמונות, מהוותיק לחדש</caption>
            <thead><tr><th scope="col">מק״ט</th><th scope="col">מצב</th><th scope="col">עדכון אחרון</th><th scope="col">ניסיונות</th><th scope="col">סיבת העיכוב</th></tr></thead>
            <tbody>{items.rows.map((row, i) => { const e = explainMediaCode(row.code); return <tr key={`${row.sku ?? "unknown"}:${i}`}>
              <td data-label="מק״ט"><bdi dir="ltr">{row.sku ?? UNKNOWN_VALUE}</bdi></td>
              <td data-label="מצב">{STATUS_TEXT[row.status] ?? row.status}</td>
              <td data-label="עדכון אחרון"><When value={row.updatedAt} /></td>
              <td data-label="ניסיונות">{row.attempts.toLocaleString("he-IL")}</td>
              <td data-label="סיבת העיכוב"><strong>{e.title}</strong>{e.code && <> <bdi dir="ltr" className={styles.code}>{e.code}</bdi></>}<br /><span className={styles.small}>{e.detail}</span></td>
            </tr>; })}</tbody>
          </table>
        </div>
      </>}

    {payload?.liveness !== undefined && <>
      <h3 className={styles.sectionTitle} id="media-liveness-title">חיות לפי מוצר (ממצאי גלאי)</h3>
      <p className={styles.small}>מחושב בקריאה בלבד מהתקדמות מאומתת של הפעולה הנוכחית ומזמני התפיסה, לא מזמן העדכון של התור. אלה ממצאי גלאי בעת פתיחת המסך או רענון, לא התראה יזומה ולא ביקורת מחזורית. בדיקה חלקית אינה קובעת שכל הקטלוג תקין.</p>
      {!liveness ? <p className={styles.unknownLine}>נתוני החיות אינם זמינים. {UNKNOWN_VALUE}.</p> :
        liveness.stale ? <p className={styles.unknownLine}>קריאת החיות ישנה מדי. המצב אינו ידוע.</p> :
        <>
          <dl className={styles.extra}>
            {(["stuck", "blocked", "waiting", "healthy", "unknown"] as LivenessState[]).map(s => <div key={s}><dt>{LIVENESS_STATE_TEXT[s]}</dt><dd>{liveness.counts[s].toLocaleString("he-IL")}</dd></div>)}
          </dl>
          <p className={styles.small}>נבדקו {liveness.returned.toLocaleString("he-IL")} מתוך {liveness.openTotal.toLocaleString("he-IL")} שורות פתוחות בתור התמונות{liveness.hasMore ? "; יש עוד שורות שלא נבדקו" : ""}. מוצרים ללא שורת תור אינם נכללים.</p>
          {livenessRows.length === 0 ? <p>{liveness.hasMore ? "השורות שנבדקו מתקדמות; השאר לא נבדקו." : "כל השורות הפתוחות שנבדקו מתקדמות."}</p> :
            <div className={styles.tableWrap} role="region" aria-labelledby="media-liveness-title" tabIndex={0}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>מוצרים שאינם מתקדמים, לפי כלל שהופעל</caption>
                <thead><tr><th scope="col">מק״ט</th><th scope="col">חיות</th><th scope="col">מאז</th><th scope="col">ניסיון חוזר</th><th scope="col">הסבר</th></tr></thead>
                <tbody>{livenessRows.map(r => { const e = explainLivenessRule(r.rule), c = explainMediaCode(r.code); return <tr key={r.productGid}>
                  <td data-label="מק״ט"><bdi dir="ltr">{r.sku ?? UNKNOWN_VALUE}</bdi></td>
                  <td data-label="חיות"><span className={styles.badge}>{LIVENESS_STATE_TEXT[r.state]}</span> <span className={styles.small}>{STATUS_TEXT[r.status] ?? r.status}</span></td>
                  <td data-label="מאז">{ago(r.ageMs)}</td>
                  <td data-label="ניסיון חוזר">{r.dueAt ? <When value={r.dueAt} /> : "—"}</td>
                  <td data-label="הסבר"><strong>{e.title}</strong> <bdi dir="ltr" className={styles.code}>{r.rule}</bdi><br /><span className={styles.small}>{e.detail}{r.code && <> סיבת העיכוב: {c.title} (<bdi dir="ltr">{r.code}</bdi>).</>}</span></td>
                </tr>; })}</tbody>
              </table>
            </div>}
        </>}
    </>}
  </section>;
}
