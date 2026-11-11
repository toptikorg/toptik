// Pure per-product liveness assessment for the media queue monitor. No I/O, no
// clock of its own: every function receives `now`. It never enqueues, retries,
// approves or resets anything. Its output is a detector finding at the moment
// the screen is opened or refreshed: not a proactive alert, not a recurring
// audit, and never a durable incident (see compareReadings).
//
// A "stuck" verdict rests on verified progress of the CURRENT episode (the one
// open operation), never on work_queue.updated_at alone, because this FIFO
// timestamp can intentionally survive a claim, keep or defer. Observation and guard
// refreshes, re-reads, lease acquisition and generation churn are bookkeeping,
// not progress. Historical verified activity of another operation never starts
// or resets the current episode's clock.

export type LivenessStatus = "pending" | "processing" | "review" | "failed";
export type LivenessEpisode = { id: string; status: string; nextStep: number; stateVersion: number; createdAt: string; updatedAt: string };
export type LivenessVerifiedSource = { kind: string; requestId: string | null; stepIndex: number | null; phaseIndex: number | null; at: string };
export type LivenessAttempt = { phase: string; status: string; createdAt: string };
export type LivenessProgress = { lastVerifiedAt: string | null; lastVerifiedSource: LivenessVerifiedSource | null; verifiedPhases: number; verifiedSteps: number;
  lastActivityAt: string | null; latestAttempt: LivenessAttempt | null };
/** One sanitized open queue row, as stored in the monitor payload. */
export type LivenessInput = {
  productGid: string; sku: string | null; status: LivenessStatus; code: string | null; updatedAt: string; attempts: number;
  /** Evidence only. A product may receive several signed events while the same operation is stuck, so this is never an identity. */
  generation: number;
  claimId: string | null; claimedAt: string | null; claimStaleAfter: string | null; inflightKeeps: number; routine: boolean;
  /** failed rows: when the existing SQL backoff lets the row be claimed again. */
  retryDueAt: string | null;
  episode: LivenessEpisode | null; episodeProgress: LivenessProgress | null;
  lastCompleted: { id: string; updatedAt: string } | null; lastObservedAt: string | null;
};
export type LivenessState = "healthy" | "waiting" | "stuck" | "blocked" | "unknown";
export type LivenessRule =
  | "IN_PROGRESS" | "SLOW_PROGRESS" | "NO_VERIFIED_PROGRESS" | "NOT_CLAIMED" | "PROVIDER_WAIT" | "IN_FLIGHT_CONTINUES"
  | "CLAIM_STALE_RECOVERY_PENDING" | "CLAIM_STALE_NOT_RECOVERED"
  | "FAILED_COOLDOWN" | "FAILED_NOT_RECLAIMED" | "FAILED_REQUIRES_HUMAN" | "REVIEW_REQUIRES_HUMAN"
  | "MISSING_CLOCK" | "CLOCK_SKEW" | "INVALID_ROW" | "READING_STALE";
export type LivenessAssessment = {
  productGid: string; sku: string | null; status: LivenessStatus; code: string | null; generation: number; attempts: number;
  state: LivenessState; rule: LivenessRule;
  /** Milliseconds since the anchor that defines this verdict, clamped at zero; null when there is no reliable anchor. */
  ageMs: number | null;
  /** The durable timestamp the verdict rests on, and what it is (an operation start, a verified phase, a claim, a queue touch). */
  anchorAt: string | null; anchorKind: "operation_start" | "verified_progress" | "claim" | "queue_touch" | "retry_due" | "last_completed" | null;
  /** Which evidence selected the anchor (ids and indexes), so the verdict can be explained and re-derived. */
  evidence: { episodeId: string | null; claimId: string | null; verifiedSource: LivenessVerifiedSource | null; lastCompletedId: string | null; lastObservedAt: string | null };
  /** For a cooling-down failure or a stale claim: when the existing SQL lets the scheduler act again. */
  dueAt: string | null;
  /** Deterministic candidate key for stuck/blocked verdicts, built from the most stable identity available (operation id, claim id, or the
   * failure/review timestamp that cannot move while the condition holds). It is a candidate: durable dedup needs persisted state. */
  candidateKey: string | null;
};

/** Initial detector policy, not a proven SLO. The scheduler wakes every 5 minutes (vercel.json), so 15 minutes is three missed ticks. */
export const LIVENESS_THRESHOLDS = {
  progressWaitMs: 15 * 60 * 1000,
  stuckMs: 30 * 60 * 1000,
  idleMs: 15 * 60 * 1000,
  /** Grace after retry_due_at / claim_stale_after before the scheduler is called out: one tick. */
  schedulerGraceMs: 5 * 60 * 1000,
  readingStaleMs: 15 * 60 * 1000,
  futureSkewMs: 2 * 60 * 1000,
} as const;
export type LivenessThresholds = typeof LIVENESS_THRESHOLDS;
export const LIVENESS_SCOPE = "open_work_queue_rows_only";

const PRODUCT = /^gid:\/\/shopify\/Product\/[1-9]\d*$/;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const CODE = /^MEDIA_[A-Z0-9_]{1,90}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
const OPEN_STATUSES = ["pending", "processing", "review", "failed"] as const;
// The read returns only the current open operation; terminal operations are history, not an episode.
const OPERATION_STATUSES = ["reserved", "running", "uncertain"] as const;
const ATTEMPT_STATUSES = ["started", "uncertain", "verified", "conflict"] as const;
/** Codes the scheduler is expected to retry on its own; everything else on a failed row needs a person. */
const TRANSIENT = /(TIME_BUDGET$|LEASE|RPC_FAILED|NETWORK|READ_FAILED)/;
/** Durable waits the runtime records on a pending row: a provider or storage condition it re-checks itself. Not a failure. */
const PROVIDER_WAIT = /^MEDIA_STORAGE_OBJECT_/;

function object(v: unknown): Record<string, unknown> | null { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; }
function count(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function time(v: unknown): v is string { return typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v)); }
function nullableTime(v: unknown): v is string | null { return v === null || time(v); }
function nullableId(v: unknown): v is string | null { return v === null || (typeof v === "string" && ID.test(v)); }
function parse(v: string | null | undefined): number | null { if (v == null) return null; const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
function code(v: unknown): string | null { return typeof v === "string" && CODE.test(v) ? v : v == null ? null : "MEDIA_ERROR_UNRECOGNIZED"; }
function index(v: unknown): number | null { return count(v) ? v : null; }

// ---------- validation ----------

export function validLivenessEpisode(v: unknown): v is LivenessEpisode {
  const o = object(v);
  return !!o && typeof o.id === "string" && ID.test(o.id) && (OPERATION_STATUSES as readonly string[]).includes(String(o.status)) &&
    count(o.nextStep) && count(o.stateVersion) && time(o.createdAt) && time(o.updatedAt);
}
export function validLivenessAttempt(v: unknown): v is LivenessAttempt {
  const o = object(v);
  return !!o && typeof o.phase === "string" && o.phase.length > 0 && o.phase.length <= 40 && (ATTEMPT_STATUSES as readonly string[]).includes(String(o.status)) && time(o.createdAt);
}
function validSource(v: unknown): v is LivenessVerifiedSource {
  const o = object(v);
  return !!o && typeof o.kind === "string" && o.kind.length > 0 && o.kind.length <= 40 && nullableId(o.requestId) &&
    (o.stepIndex === null || count(o.stepIndex)) && (o.phaseIndex === null || count(o.phaseIndex)) && time(o.at);
}
export function validLivenessProgress(v: unknown): v is LivenessProgress {
  const o = object(v);
  return !!o && nullableTime(o.lastVerifiedAt) && (o.lastVerifiedSource === null || validSource(o.lastVerifiedSource)) && count(o.verifiedPhases) && count(o.verifiedSteps) &&
    nullableTime(o.lastActivityAt) && (o.latestAttempt === null || validLivenessAttempt(o.latestAttempt)) &&
    // a verified time without a source, or a source without a time, is not evidence
    ((o.lastVerifiedAt === null) === (o.lastVerifiedSource === null)) &&
    (o.lastVerifiedAt === null || (validSource(o.lastVerifiedSource) && Date.parse(o.lastVerifiedAt as string) === Date.parse(o.lastVerifiedSource.at)));
}
/** A sanitized row (camelCase), as it travels inside the monitor payload. */
export function validLivenessRow(v: unknown): v is LivenessInput {
  const o = object(v), lc = object(o?.lastCompleted);
  return !!o && typeof o.productGid === "string" && PRODUCT.test(o.productGid) && (o.sku === null || (typeof o.sku === "string" && SKU.test(o.sku))) &&
    (OPEN_STATUSES as readonly string[]).includes(String(o.status)) && (o.code === null || (typeof o.code === "string" && CODE.test(o.code))) &&
    time(o.updatedAt) && count(o.attempts) && count(o.generation) && nullableId(o.claimId) && nullableTime(o.claimedAt) && nullableTime(o.claimStaleAfter) &&
    count(o.inflightKeeps) && typeof o.routine === "boolean" && nullableTime(o.retryDueAt) &&
    (o.episode === null || validLivenessEpisode(o.episode)) && (o.episodeProgress === null || validLivenessProgress(o.episodeProgress)) &&
    ((o.episode === null) === (o.episodeProgress === null)) &&
    (o.lastCompleted === null || (!!lc && typeof lc.id === "string" && ID.test(lc.id) && time(lc.updatedAt))) && nullableTime(o.lastObservedAt);
}

/** A bounded snapshot cannot claim completeness with invalid counts, rows, or duplicate identities. */
export function validLivenessSection(v: unknown): v is { openTotal: number; limit: number; rows: LivenessInput[] } {
  const o = object(v);
  if (!o || !count(o.openTotal) || !count(o.limit) || o.limit < 1 || o.limit > 100 || !Array.isArray(o.rows) ||
      o.rows.length > o.limit || o.rows.length > o.openTotal || !o.rows.every(validLivenessRow)) return false;
  return new Set(o.rows.map(row => row.productGid)).size === o.rows.length;
}

/** Server side: sanitize the raw read_toptik_media_liveness result (snake_case). Any doubt makes the whole section null. */
export function livenessRows(input: unknown): { observedAt: string; openTotal: number; limit: number; rows: LivenessInput[] } | null {
  const data = object(input);
  if (!data || !time(data.observedAt) || !count(data.openTotal) || !count(data.limit) || data.limit < 1 || data.limit > 100 ||
      !Array.isArray(data.items) || data.items.length > data.limit || data.items.length > data.openTotal) return null;
  if (data.scope !== undefined && data.scope !== LIVENESS_SCOPE) return null;
  const rows: LivenessInput[] = [];
  for (const value of data.items) {
    const r = object(value); if (!r) return null;
    const ep = object(r.episode), pr = object(r.episode_progress), src = object(pr?.last_verified_source), at = object(pr?.latest_attempt), lc = object(r.last_completed);
    if ((r.episode !== null && !ep) || (r.episode_progress !== null && !pr) || (r.last_completed !== null && !lc) ||
        (pr && pr.last_verified_source !== null && !src) || (pr && pr.latest_attempt !== null && !at) ||
        (src && ((src.step_index != null && !count(src.step_index)) || (src.phase_index != null && !count(src.phase_index))))) return null;
    const row = {
      productGid: r.product_gid, sku: typeof r.sku === "string" && SKU.test(r.sku) ? r.sku : null, status: r.status, code: code(r.last_error),
      updatedAt: r.updated_at, attempts: r.attempts, generation: r.generation,
      claimId: r.claim_id ?? null, claimedAt: r.claimed_at ?? null, claimStaleAfter: r.claim_stale_after ?? null, inflightKeeps: r.inflight_keeps, routine: r.routine,
      retryDueAt: r.retry_due_at ?? null,
      episode: ep ? { id: ep.id, status: ep.status, nextStep: ep.next_step, stateVersion: ep.state_version, createdAt: ep.created_at, updatedAt: ep.updated_at } : null,
      episodeProgress: pr ? {
        lastVerifiedAt: pr.last_verified_at ?? null,
        lastVerifiedSource: src ? { kind: src.kind, requestId: src.request_id ?? null, stepIndex: index(src.step_index), phaseIndex: index(src.phase_index), at: src.at } : null,
        verifiedPhases: pr.verified_phases, verifiedSteps: pr.verified_steps, lastActivityAt: pr.last_activity_at ?? null,
        latestAttempt: at ? { phase: at.phase, status: at.status, createdAt: at.created_at } : null } : null,
      lastCompleted: lc ? { id: lc.id, updatedAt: lc.updated_at } : null, lastObservedAt: r.last_observed_at ?? null,
    };
    if (!validLivenessRow(row)) return null;
    rows.push(row);
  }
  if (!validLivenessSection({ openTotal: data.openTotal, limit: data.limit, rows })) return null;
  return { observedAt: data.observedAt, openTotal: data.openTotal, limit: data.limit, rows };
}

// ---------- assessment ----------

type Anchor = { at: string | null; kind: LivenessAssessment["anchorKind"] };
function build(row: LivenessInput, state: LivenessState, rule: LivenessRule, anchor: Anchor, now: number, dueAt: string | null, key: string | null): LivenessAssessment {
  const at = parse(anchor.at), ageMs = at === null ? null : Math.max(0, now - at);
  return { productGid: row.productGid, sku: row.sku, status: row.status, code: row.code, generation: row.generation, attempts: row.attempts, state, rule, ageMs,
    anchorAt: anchor.at, anchorKind: anchor.at === null ? null : anchor.kind,
    evidence: { episodeId: row.episode?.id ?? null, claimId: row.claimId, verifiedSource: row.episodeProgress?.lastVerifiedSource ?? null,
      lastCompletedId: row.lastCompleted?.id ?? null, lastObservedAt: row.lastObservedAt },
    dueAt, candidateKey: state === "stuck" || state === "blocked" ? key : null };
}
const NONE: Anchor = { at: null, kind: null };

/** One row, one verdict. Every branch names the rule it applied, so the explanation can be shown verbatim and the verdict re-derived. */
export function assessLiveness(row: LivenessInput, now: number, t: LivenessThresholds = LIVENESS_THRESHOLDS): LivenessAssessment {
  if (!validLivenessRow(row) || !Number.isFinite(now)) return build(row, "unknown", "INVALID_ROW", NONE, now, null, null);
  const future = [row.updatedAt, row.claimedAt, row.episode?.createdAt, row.episodeProgress?.lastVerifiedAt, row.lastCompleted?.updatedAt]
    .map(parse).some(v => v !== null && v - now > t.futureSkewMs);
  if (future) return build(row, "unknown", "CLOCK_SKEW", NONE, now, null, null);
  const gid = row.productGid;
  if (row.status === "review") return build(row, "blocked", "REVIEW_REQUIRES_HUMAN", { at: row.updatedAt, kind: "queue_touch" }, now, null, `media:${gid}:review:${row.code ?? "-"}:${row.updatedAt}`);
  if (row.status === "failed") {
    if (row.code !== null && !TRANSIENT.test(row.code)) return build(row, "blocked", "FAILED_REQUIRES_HUMAN", { at: row.updatedAt, kind: "queue_touch" }, now, null, `media:${gid}:failed:${row.code}:${row.updatedAt}`);
    const due = parse(row.retryDueAt);
    if (due === null) return build(row, "unknown", "MISSING_CLOCK", NONE, now, null, null);
    if (now - due <= t.schedulerGraceMs) return build(row, "waiting", "FAILED_COOLDOWN", { at: row.updatedAt, kind: "queue_touch" }, now, row.retryDueAt, null);
    return build(row, "stuck", "FAILED_NOT_RECLAIMED", { at: row.retryDueAt, kind: "retry_due" }, now, row.retryDueAt, `media:${gid}:failed-due:${row.retryDueAt}`);
  }
  const episode = row.episode && ["reserved", "running", "uncertain"].includes(row.episode.status) ? row.episode : null;
  const started = episode ? parse(episode.createdAt)! : null;
  const verified = episode ? parse(row.episodeProgress?.lastVerifiedAt) : null;
  const episodeAnchor: Anchor = episode && started !== null
    ? verified !== null && verified >= started ? { at: row.episodeProgress!.lastVerifiedAt, kind: "verified_progress" } : { at: episode.createdAt, kind: "operation_start" }
    : NONE;
  if (row.status === "processing") {
    const claimed = parse(row.claimedAt), stale = parse(row.claimStaleAfter);
    if (claimed === null || stale === null) return build(row, "unknown", "MISSING_CLOCK", NONE, now, null, null);
    const claimKey = `media:${gid}:claim:${row.claimId ?? row.claimedAt}`;
    if (now - stale > t.schedulerGraceMs) return build(row, "stuck", "CLAIM_STALE_NOT_RECOVERED", { at: row.claimedAt, kind: "claim" }, now, row.claimStaleAfter, claimKey);
    if (episode && now - parse(episodeAnchor.at)! > t.stuckMs) return build(row, "stuck", "NO_VERIFIED_PROGRESS", episodeAnchor, now, row.claimStaleAfter, `media:${gid}:op:${episode.id}:NO_VERIFIED_PROGRESS`);
    if (now > stale) return build(row, "waiting", "CLAIM_STALE_RECOVERY_PENDING", { at: row.claimedAt, kind: "claim" }, now, row.claimStaleAfter, null);
    if (episode && now - parse(episodeAnchor.at)! > t.progressWaitMs) return build(row, "waiting", "SLOW_PROGRESS", episodeAnchor, now, row.claimStaleAfter, null);
    if (episode) return build(row, "healthy", "IN_PROGRESS", episodeAnchor, now, row.claimStaleAfter, null);
    return build(row, "healthy", "IN_PROGRESS", { at: row.claimedAt, kind: "claim" }, now, null, null);
  }
  // Pending queue updated_at is a FIFO position, not reliable claim or progress evidence.
  if (episode) {
    // Only this operation's verified readbacks/steps count. Its own start is the floor; nothing older can anchor it.
    const anchor = episodeAnchor;
    const age = now - parse(anchor.at)!;
    if (age > t.stuckMs) return build(row, "stuck", "NO_VERIFIED_PROGRESS", anchor, now, null, `media:${gid}:op:${episode.id}:NO_VERIFIED_PROGRESS`);
    if (row.code !== null && PROVIDER_WAIT.test(row.code)) return build(row, "waiting", "PROVIDER_WAIT", anchor, now, null, null);
    if (row.code === "MEDIA_QUEUE_IN_FLIGHT_CONTINUES" || row.inflightKeeps > 0) return build(row, age > t.progressWaitMs ? "waiting" : "healthy", age > t.progressWaitMs ? "SLOW_PROGRESS" : "IN_FLIGHT_CONTINUES", anchor, now, null, null);
    if (age > t.progressWaitMs) return build(row, "waiting", "SLOW_PROGRESS", anchor, now, null, null);
    return build(row, "healthy", "IN_PROGRESS", anchor, now, null, null);
  }
  if (row.code !== null && PROVIDER_WAIT.test(row.code)) return build(row, "waiting", "PROVIDER_WAIT", { at: row.updatedAt, kind: "queue_touch" }, now, null, null);
  // No open operation: a just-completed operation explains a pending row (a new generation waiting for its first planning), nothing older does.
  const completed = parse(row.lastCompleted?.updatedAt);
  if (completed !== null && now - completed <= t.progressWaitMs) return build(row, "healthy", "IN_PROGRESS", { at: row.lastCompleted!.updatedAt, kind: "last_completed" }, now, null, null);
  // Touched recently, no open operation, no recent completion: there is no reliable start for the current work. Say so; do not alarm.
  return build(row, "unknown", "MISSING_CLOCK", NONE, now, null, null);
}

export type LivenessCounts = Record<LivenessState, number>;
export type LivenessReading = { observedAt: string; stale: boolean; scope: string; openTotal: number; returned: number; hasMore: boolean; complete: boolean;
  counts: LivenessCounts; rows: LivenessAssessment[] };

/** A whole reading. A stale reading (older than readingStaleMs, or from the future) makes every row unknown, never "no problems".
 * A reading that returned fewer rows than are open is not complete and can never establish that the whole queue is healthy. */
export function assessReading(section: { openTotal: number; limit: number; rows: LivenessInput[] }, observedAt: string, now: number,
  t: LivenessThresholds = LIVENESS_THRESHOLDS): LivenessReading {
  if (!validLivenessSection(section)) return { observedAt, stale: true, scope: LIVENESS_SCOPE, openTotal: 0, returned: 0, hasMore: true, complete: false,
    counts: { healthy: 0, waiting: 0, stuck: 0, blocked: 0, unknown: 0 }, rows: [] };
  const observed = Date.parse(observedAt);
  const stale = !Number.isFinite(observed) || now - observed > t.readingStaleMs || observed - now > t.futureSkewMs;
  const at = Number.isFinite(observed) ? observed : now;
  const rows = section.rows.map(r => stale ? build(r, "unknown", "READING_STALE", NONE, at, null, null) : assessLiveness(r, at, t));
  const counts: LivenessCounts = { healthy: 0, waiting: 0, stuck: 0, blocked: 0, unknown: 0 };
  for (const r of rows) counts[r.state]++;
  const returned = section.rows.length, hasMore = section.openTotal > returned;
  return { observedAt, stale, scope: LIVENESS_SCOPE, openTotal: section.openTotal, returned, hasMore, complete: !stale && !hasMore, counts, rows };
}

/** Transition candidates between two readings the caller holds. Without persisted incident state nothing here is a durable
 * dedup or a recovery claim: "closed" only means the candidate key is absent from the later reading. */
export function compareReadings(previousKeys: readonly string[], current: readonly LivenessAssessment[]): { opened: string[]; ongoing: string[]; closedCandidates: string[] } {
  const before = new Set(previousKeys), now = new Set(current.map(r => r.candidateKey).filter((k): k is string => k !== null));
  return { opened: [...now].filter(k => !before.has(k)), ongoing: [...now].filter(k => before.has(k)), closedCandidates: [...before].filter(k => !now.has(k)) };
}

// ---------- plain-language explanations ----------

export const LIVENESS_STATE_TEXT: Record<LivenessState, string> = { healthy: "מתקדם", waiting: "ממתין", stuck: "תקוע", blocked: "חסום", unknown: "לא ידוע" };
const RULE_TEXT: Record<LivenessRule, { title: string; detail: string }> = {
  IN_PROGRESS: { title: "מתקדם", detail: "נרשמה התקדמות מאומתת לאחרונה בפעולה הנוכחית, או שהעבודה החלה זה עתה." },
  SLOW_PROGRESS: { title: "ההתקדמות איטית", detail: "בפעולה הנוכחית לא נרשם שלב מאומת במשך יותר משלושה מחזורי הפעלה. ייתכן שהמוצר ממתין לתורו." },
  NO_VERIFIED_PROGRESS: { title: "אין התקדמות מאומתת", detail: "יש פעולה פתוחה, ולא נרשם בה שלב מאומת זמן רב. נדרשת בדיקה טכנית, בלי הפעלה ידנית." },
  NOT_CLAIMED: { title: "המתזמן לא נגע במוצר", detail: "השורה ממתינה ואף הפעלה לא תפסה אותה במשך כמה מחזורים. יש לבדוק את המתזמן, לא את המוצר." },
  PROVIDER_WAIT: { title: "ממתין לאחסון או לספק", detail: "המערכת רשמה תנאי שהיא בודקת מחדש לבד. זו המתנה מתועדת, לא כשל." },
  IN_FLIGHT_CONTINUES: { title: "ממשיך בהפעלה הבאה", detail: "שלב אומת והמוצר שומר את מקומו בתור להמשך." },
  CLAIM_STALE_RECOVERY_PENDING: { title: "תפיסה ישנה, ממתין להתאוששות", detail: "המוצר בעיבוד מעבר לזמן העבודה הרגיל. המערכת משחררת תפיסה ישנה אוטומטית בהפעלה הבאה." },
  CLAIM_STALE_NOT_RECOVERED: { title: "תפיסה ישנה לא שוחררה", detail: "המוצר מסומן בעיבוד זמן רב, וההתאוששות האוטומטית לא התרחשה בזמן. נדרשת בדיקה טכנית." },
  FAILED_COOLDOWN: { title: "ממתין לניסיון חוזר", detail: "השגיאה זמנית. המערכת תנסה שוב אוטומטית במועד שמוצג, בלי התערבות. זו המתנה, לא כשל." },
  FAILED_NOT_RECLAIMED: { title: "מועד הניסיון החוזר עבר", detail: "המועד לניסיון חוזר חלף ואף הפעלה לא תפסה את המוצר. יש לבדוק את המתזמן." },
  FAILED_REQUIRES_HUMAN: { title: "שגיאה שדורשת אדם", detail: "השגיאה אינה זמנית, ולכן לא תהיה חזרה אוטומטית. נדרשת בדיקה." },
  REVIEW_REQUIRES_HUMAN: { title: "ממתין להכרעה אנושית", detail: "המוצר ממתין לאישור או לבדיקה. המערכת לא תמשיך לבד." },
  MISSING_CLOCK: { title: "אין נקודת התחלה אמינה", detail: "לא ניתן לקבוע מתי העבודה הנוכחית התחילה (אין פעולה פתוחה או זמן תפיסה או מועד ניסיון). המצב אינו ידוע, ולא נקבע שהמוצר תקוע." },
  CLOCK_SKEW: { title: "חותמת זמן מהעתיד", detail: "נתון מהשרת מאוחר מהשעון המקומי. המצב אינו ידוע." },
  INVALID_ROW: { title: "נתון לא תקין", detail: "השורה שהתקבלה אינה שלמה. המצב אינו ידוע." },
  READING_STALE: { title: "הקריאה ישנה", detail: "הנתונים ישנים מדי כדי לקבוע מצב. המצב אינו ידוע." },
};
export function explainLivenessRule(rule: LivenessRule): { title: string; detail: string } { return RULE_TEXT[rule]; }
