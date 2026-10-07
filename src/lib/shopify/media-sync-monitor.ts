// Read-only view model for the media synchronization monitor. Shared by the
// admin route (building a sanitized payload) and the client (validating it).
// Nothing here can enqueue, approve, reset or retry work.

export type QueueCounts = { pending: number; processing: number; review: number; failed: number; complete: number };
export type ReasonRow = { status: string; code: string | null; products: number; oldestUpdatedAt: string | null; newestUpdatedAt: string | null };
export type ItemRow = { sku: string | null; status: string; code: string | null; updatedAt: string; attempts: number };
type Section<T> = { available: true; observedAt: string; data: T } | { available: false };
export type MediaSyncMonitorPayload = {
  version: 1; fetchedAt: string; liveVerified: false;
  queues: Section<{ copy: QueueCounts; media: QueueCounts; mediaOperations: { open: number; conflict: number };
    coverage: { approvedProducts: number; missingMediaBaseline: number; missingMediaQueue: number }; runtime: { copy: boolean; media: boolean } }>;
  reasons: Section<ReasonRow[]>;
  items: Section<{ openTotal: number; limit: number; rows: ItemRow[] }>;
};

/** Older than this, a reading is shown as unknown, never as "no problems". */
export const MEDIA_MONITOR_STALE_MS = 15 * 60 * 1000;
export const MEDIA_MONITOR_ITEM_LIMIT = 50;
const CODE = /^(MEDIA|SYNC_COPY)_[A-Z0-9_]{1,90}$/;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const QUEUE_STATUSES = ["pending", "processing", "review", "failed", "done"] as const;

function object(v: unknown): Record<string, unknown> | null { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; }
function count(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function time(v: unknown): v is string { return typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v)); }
function code(v: unknown): string | null { return typeof v === "string" && CODE.test(v) ? v : v == null ? null : "MEDIA_ERROR_UNRECOGNIZED"; }
function empty(): QueueCounts { return { pending: 0, processing: 0, review: 0, failed: 0, complete: 0 }; }

// ---------- server side: build a sanitized payload from existing read RPCs ----------

/** Splits the existing combined status rows into separate text and media lanes. */
export function laneCounts(queues: unknown): { copy: QueueCounts; media: QueueCounts; mediaOperations: { open: number; conflict: number } } | null {
  if (!Array.isArray(queues)) return null;
  const copy = empty(), media = empty(), mediaOperations = { open: 0, conflict: 0 };
  const map: Record<string, Record<string, keyof QueueCounts>> = {
    copy_inbox: { processed: "complete", pending: "pending", processing: "processing", review: "review", failed: "failed" },
    copy_outbox: { synced: "complete", pending: "pending", processing: "processing", review: "review", failed: "failed" },
    media: { done: "complete", pending: "pending", processing: "processing", review: "review", failed: "failed" },
  };
  for (const value of queues) {
    const row = object(value);
    if (!row || typeof row.lane !== "string" || typeof row.status !== "string" || !count(row.count)) return null;
    if (row.lane === "media_operations") {
      if (["reserved", "running", "uncertain"].includes(row.status)) mediaOperations.open += row.count;
      else if (row.status === "conflict") mediaOperations.conflict += row.count;
      else if (row.status !== "verified") return null;
      continue;
    }
    const lane = map[row.lane];
    if (!lane) continue; // specifications / commerce are other lanes, not shown here
    const key = lane[row.status]; if (!key) return null;
    (row.lane === "media" ? media : copy)[key] += row.count;
  }
  return { copy, media, mediaOperations };
}

export function reasonRows(input: unknown): ReasonRow[] | null {
  const queue = object(input)?.queue;
  if (!Array.isArray(queue) || queue.length > 500) return null;
  const rows: ReasonRow[] = [];
  for (const value of queue) {
    const row = object(value);
    if (!row || typeof row.status !== "string" || !(QUEUE_STATUSES as readonly string[]).includes(row.status) || !count(row.products)) return null;
    rows.push({ status: row.status, code: code(row.last_error), products: row.products,
      oldestUpdatedAt: time(row.oldest_updated_at) ? row.oldest_updated_at : null, newestUpdatedAt: time(row.newest_updated_at) ? row.newest_updated_at : null });
  }
  return rows;
}

export function itemRows(input: unknown): { observedAt: string; openTotal: number; limit: number; rows: ItemRow[] } | null {
  const data = object(input);
  if (!data || !time(data.observedAt) || !count(data.openTotal) || !count(data.limit) || !Array.isArray(data.items) || data.items.length > data.limit) return null;
  const rows: ItemRow[] = [];
  for (const value of data.items) {
    const row = object(value);
    if (!row || typeof row.status !== "string" || !["pending", "processing", "review", "failed"].includes(row.status) || !time(row.updated_at) || !count(row.attempts)) return null;
    rows.push({ sku: typeof row.sku === "string" && SKU.test(row.sku) ? row.sku : null, status: row.status, code: code(row.last_error), updatedAt: row.updated_at, attempts: row.attempts });
  }
  return { observedAt: data.observedAt, openTotal: data.openTotal, limit: data.limit, rows };
}

/** Each source is independent: one failing read makes only its section unknown. */
export function buildMonitorPayload(input: { fetchedAt: string; combined: unknown; combinedValid: boolean; runtime: { copy: boolean; media: boolean };
  status: unknown; items: unknown }): MediaSyncMonitorPayload {
  const combined = object(input.combined), cov = object(combined?.coverage), lanes = input.combinedValid ? laneCounts(combined?.queues) : null;
  const coverage = cov && ["approvedProducts", "missingMediaBaseline", "missingMediaQueue"].every(k => count(cov[k])) ?
    { approvedProducts: cov.approvedProducts as number, missingMediaBaseline: cov.missingMediaBaseline as number, missingMediaQueue: cov.missingMediaQueue as number } : null;
  const reasons = reasonRows(input.status), statusAt = object(input.status)?.observedAt, items = itemRows(input.items);
  return { version: 1, fetchedAt: input.fetchedAt, liveVerified: false,
    queues: lanes && coverage && time(combined?.observedAt) ? { available: true, observedAt: combined!.observedAt as string, data: { ...lanes, coverage, runtime: { ...input.runtime } } } : { available: false },
    reasons: reasons && time(statusAt) ? { available: true, observedAt: statusAt, data: reasons } : { available: false },
    items: items ? { available: true, observedAt: items.observedAt, data: { openTotal: items.openTotal, limit: items.limit, rows: items.rows } } : { available: false } };
}

// ---------- client side: validate, order and explain ----------

export function parseMonitorPayload(input: unknown): MediaSyncMonitorPayload | null {
  const p = object(input);
  if (!p || p.version !== 1 || p.liveVerified !== false || !time(p.fetchedAt)) return null;
  const section = (v: unknown, ok: (d: unknown) => boolean) => {
    const s = object(v); if (!s) return null;
    if (s.available === false) return { available: false as const };
    return s.available === true && time(s.observedAt) && ok(s.data) ? s : null;
  };
  const queues = section(p.queues, d => { const q = object(d), cov = object(q?.coverage), rt = object(q?.runtime);
    const counts = (c: unknown) => { const o = object(c); return !!o && ["pending", "processing", "review", "failed", "complete"].every(k => count(o[k])); };
    return !!q && counts(q.copy) && counts(q.media) && !!object(q.mediaOperations) && count(object(q.mediaOperations)!.open) && count(object(q.mediaOperations)!.conflict) &&
      !!cov && ["approvedProducts", "missingMediaBaseline", "missingMediaQueue"].every(k => count(cov[k])) && !!rt && typeof rt.copy === "boolean" && typeof rt.media === "boolean"; });
  const reasons = section(p.reasons, d => Array.isArray(d) && d.every(r => { const o = object(r); return !!o && typeof o.status === "string" && (o.code === null || (typeof o.code === "string" && CODE.test(o.code))) && count(o.products); }));
  const items = section(p.items, d => { const o = object(d); return !!o && count(o.openTotal) && count(o.limit) && Array.isArray(o.rows) && o.rows.length <= o.limit &&
    o.rows.every(r => { const x = object(r); return !!x && typeof x.status === "string" && time(x.updatedAt) && count(x.attempts) && (x.code === null || (typeof x.code === "string" && CODE.test(x.code))) && (x.sku === null || (typeof x.sku === "string" && SKU.test(x.sku))); }); });
  if (!queues || !reasons || !items) return null;
  return p as unknown as MediaSyncMonitorPayload;
}

/** A later request always wins; an older observation can never replace a newer one. */
export function shouldAccept(current: { seq: number; observedAt: number } | null, incoming: { seq: number; observedAt: number }): boolean {
  if (!current) return true;
  return incoming.seq > current.seq && incoming.observedAt >= current.observedAt;
}

export type Unknown = "unauthorized" | "connection" | "invalid" | "stale" | "disabled" | "unavailable";
export const UNKNOWN_TEXT: Record<Unknown, string> = {
  unauthorized: "אין הרשאה לקרוא את מצב הסנכרון. יש להתחבר כמנהל.",
  connection: "לא ניתן להתחבר לשרת. המצב אינו ידוע.",
  invalid: "התקבלה תשובה לא תקינה. המצב אינו ידוע.",
  stale: "המידע ישן מדי. המצב העדכני אינו ידוע.",
  disabled: "סנכרון התמונות כבוי בסביבה זו. המצב אינו ידוע.",
  unavailable: "נתוני התור לא זמינים כרגע. המצב אינו ידוע.",
};

export type MediaVerdict = { kind: "unknown"; reason: Unknown } | { kind: "attention" } | { kind: "in_progress" } | { kind: "queue_complete" };
export function mediaVerdict(payload: MediaSyncMonitorPayload | null, failure: Unknown | null, now: number): MediaVerdict {
  if (failure) return { kind: "unknown", reason: failure };
  if (!payload) return { kind: "unknown", reason: "invalid" };
  if (!payload.queues.available) return { kind: "unknown", reason: "unavailable" };
  const observed = Date.parse(payload.queues.observedAt);
  if (now - observed > MEDIA_MONITOR_STALE_MS || observed - now > 2 * 60 * 1000) return { kind: "unknown", reason: "stale" };
  const q = payload.queues.data;
  if (!q.runtime.media) return { kind: "unknown", reason: "disabled" };
  if (q.media.review + q.media.failed + q.mediaOperations.conflict > 0) return { kind: "attention" };
  if (q.media.pending + q.media.processing + q.mediaOperations.open > 0 || q.coverage.missingMediaBaseline + q.coverage.missingMediaQueue > 0 || !q.coverage.approvedProducts) return { kind: "in_progress" };
  return { kind: "queue_complete" };
}

export const STATUS_TEXT: Record<string, string> = { pending: "ממתין", processing: "בעיבוד", review: "דורש בדיקה", failed: "שגיאה", done: "הסתיים" };

type Explanation = { title: string; detail: string };
const EXPLAIN: Record<string, Explanation> = {
  MEDIA_REVIEW_REQUIRED: { title: "תמונה ממתינה לאישור", detail: "יש לאשר שהתמונה שייכת למק״ט ולצבע המדויקים במסך אישור התמונות. עד אז היא לא תישלח." },
  MEDIA_REVIEW_REJECTED: { title: "התמונה נדחתה", detail: "נמצאה התאמה למוצר או לצבע שגויים. הסנכרון של תמונה זו נעצר." },
  MEDIA_TARGET_MAPPING_REQUIRED: { title: "נדרש שיוך תמונה", detail: "לא ניתן לקבוע בוודאות לאיזו תמונה בצד השני היא מתאימה. נדרשת בדיקה ידנית." },
  MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED: { title: "התאוששות נדרשת", detail: "העלאה קודמת לא הסתיימה בוודאות והקובץ לא נמצא. נדרש אישור התאוששות של מנהל לפני העלאה נוספת." },
  MEDIA_STORAGE_OBJECT_PRESENT_UNREADABLE: { title: "הקובץ קיים אך עדיין לא ניתן לקריאה", detail: "האחסון מדווח שהקובץ קיים, אבל קריאתו נכשלה. המערכת תבדוק שוב בקריאה בלבד, בלי להעלות מחדש." },
  MEDIA_STORAGE_OBJECT_NOT_READABLE_AFTER_UPLOAD: { title: "הקובץ עדיין לא נקרא אחרי ההעלאה", detail: "ההעלאה נשלחה, אך הקובץ עוד לא נקרא בהצלחה. המערכת תבדוק שוב בקריאה בלבד." },
  MEDIA_STORAGE_REPAIR_REQUIRES_REVIEW: { title: "ההתאוששות דורשת בדיקה", detail: "אישור ההתאוששות נוצל או פג תוקף בלי תוצאה מאומתת. אין העלאה נוספת אוטומטית." },
  MEDIA_TRANSPORT_FINAL_SNAPSHOT_MISMATCH: { title: "שינוי מקביל", detail: "התמונות השתנו בזמן הסנכרון. השינוי נשמר ונדרשת בדיקה לפני המשך." },
  MEDIA_GALLERY_CAS_REJECTION_UNRECORDED: { title: "דחיית שמירה לא נרשמה", detail: "השמירה בגלריה נדחתה ולא ניתן היה לתעד זאת. נדרשת בדיקה טכנית." },
  MEDIA_SOURCE_BYTES_CHANGED: { title: "תמונת המקור השתנתה", detail: "הקובץ במקור שונה מזה שנבדק. נדרשת בדיקה מחדש לפני העלאה." },
  MEDIA_REVIEW_BYTES_CHANGED: { title: "התמונה שונה מזו שאושרה", detail: "הקובץ הנוכחי שונה מהקובץ שאושר. נדרש אישור מחדש." },
  MEDIA_STORAGE_CONFIGURATION_INVALID: { title: "הגדרות האחסון אינן תקינות", detail: "לא נשלחה העלאה. יש לבדוק את הגדרות השרת." },
  MEDIA_STORAGE_DNS_UNSAFE: { title: "כתובת האחסון אינה בטוחה", detail: "לא נשלחה העלאה. יש לבדוק את הגדרות השרת." },
  MEDIA_QUEUE_IN_FLIGHT_CONTINUES: { title: "העבודה מתקדמת", detail: "שלב אומת והמוצר ממשיך בהפעלה הבאה בלי לחזור לסוף התור." },
  MEDIA_ERROR_UNRECOGNIZED: { title: "קוד לא מוכר", detail: "השרת החזיר קוד שאינו מוכר למסך זה. יש להעביר לבדיקה טכנית." },
};
export function explainMediaCode(value: string | null): Explanation & { code: string | null } {
  if (value === null) return { code: null, title: "לא נרשמה סיבה", detail: "השורה לא כוללת קוד עיכוב. אם היא ממתינה זמן רב, יש לבדוק אותה." };
  const known = EXPLAIN[value];
  if (known) return { code: value, ...known };
  if (/^MEDIA_TRANSPORT_NOT_SENT_/.test(value)) return { code: value, title: "ההעלאה לא נשלחה", detail: "תנאי מוקדם נכשל לפני השליחה. הדבר תועד ונדרשת בדיקה." };
  if (/TIME_BUDGET$/.test(value)) return { code: value, title: "זמן ההפעלה הסתיים", detail: "העבודה תיבדק שוב בהפעלה הבאה." };
  if (/LEASE/.test(value)) return { code: value, title: "עבודה מקבילה על אותו מוצר", detail: "מוצר זה טופל בו זמנית. הוא ייבדק שוב." };
  if (/RPC_FAILED|NETWORK|READ_FAILED/.test(value)) return { code: value, title: "כשל חיבור זמני", detail: "ייבדק שוב בהפעלה הבאה." };
  return { code: value, title: "קוד שאינו מתורגם", detail: "יש להעביר את הקוד לבדיקה טכנית." };
}

// ---------- client side: loading and response ordering ----------

export type MonitorResult = { kind: "ok"; payload: MediaSyncMonitorPayload } | { kind: "error"; failure: Unknown };
/** One bounded read-only GET. Any doubt becomes an explicit unknown reason. */
export async function loadMediaSyncMonitor(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<MonitorResult> {
  let response: Response;
  try { response = await fetchImpl("/api/admin/shopify/media/monitor", { method: "GET", credentials: "same-origin", cache: "no-store", signal }); }
  catch { return { kind: "error", failure: "connection" }; }
  if (response.status === 401 || response.status === 403) return { kind: "error", failure: "unauthorized" };
  if (!response.ok) return { kind: "error", failure: response.status >= 500 ? "unavailable" : "invalid" };
  let body: unknown;
  try { body = await response.json(); } catch { return { kind: "error", failure: "invalid" }; }
  const payload = parseMonitorPayload(body);
  return payload ? { kind: "ok", payload } : { kind: "error", failure: "invalid" };
}

export type MonitorState = { latestSeq: number; acceptedSeq: number; observedAt: number; payload: MediaSyncMonitorPayload | null; failure: Unknown | null };
export const initialMonitorState: MonitorState = { latestSeq: 0, acceptedSeq: 0, observedAt: 0, payload: null, failure: null };
export function startMonitorRequest(state: MonitorState): { state: MonitorState; seq: number } {
  const seq = state.latestSeq + 1; return { seq, state: { ...state, latestSeq: seq } };
}
/** Responses may resolve in any order. Only the latest request may change the
 * view, and an older observation never replaces a newer one. A failure of the
 * latest request hides the old figures and shows an unknown state. */
export function applyMonitorResult(state: MonitorState, seq: number, result: MonitorResult): MonitorState {
  if (seq !== state.latestSeq) return state;
  if (result.kind === "error") return { ...state, acceptedSeq: seq, payload: null, failure: result.failure };
  const observedAt = Date.parse(result.payload.fetchedAt);
  if (!shouldAccept({ seq: state.acceptedSeq, observedAt: state.observedAt }, { seq, observedAt })) return state;
  return { ...state, acceptedSeq: seq, observedAt, payload: result.payload, failure: null };
}
/** A section is trusted only while fresh. */
export function sectionFresh(observedAt: string, now: number): boolean {
  const at = Date.parse(observedAt); return Number.isFinite(at) && now - at <= MEDIA_MONITOR_STALE_MS && at - now <= 2 * 60 * 1000;
}
