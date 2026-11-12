import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { stripTypeScriptTypes } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const dataUrl = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64');
const livenessUrl = dataUrl(stripTypeScriptTypes(read('src/lib/shopify/media-liveness.ts')));
const libUrl = dataUrl(stripTypeScriptTypes(read('src/lib/shopify/media-sync-monitor.ts')).replace('"./media-liveness"', JSON.stringify(livenessUrl)));
const lib = await import(libUrl);
const liveness = await import(livenessUrl);
// Real presentational component, compiled with the project's TypeScript; CSS module class names are identity-mapped.
const cssUrl = dataUrl('export default new Proxy({}, { get: (_, k) => String(k) });');
const viewCode = ts.transpileModule(read('src/components/admin/MediaSyncMonitorView.tsx'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime'))).replace('"./MediaSyncMonitor.module.css"', JSON.stringify(cssUrl))
  .replace('"@/lib/shopify/media-sync-monitor"', JSON.stringify(libUrl)).replace('"@/lib/shopify/media-liveness"', JSON.stringify(livenessUrl));
const View = (await import(dataUrl(viewCode))).default;
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const render = props => renderToStaticMarkup(createElement(View, { loading: false, failure: null, payload: null, now: NOW, ...props }));

const NOW = Date.parse('2026-10-07T14:00:00Z'), AT = '2026-10-07T13:58:00Z';
const runtime = { copy: true, media: true };
const combined = (extra = []) => ({ observedAt: AT, coverage: { approvedProducts: 400, missingCopyBaseline: 0, missingMediaBaseline: 0, missingMediaQueue: 0, missingSpecBaseline: 0, missingSpecQueue: 0 },
  queues: [{ lane: 'copy_inbox', status: 'processed', count: 120 }, { lane: 'copy_outbox', status: 'pending', count: 2 }, { lane: 'media', status: 'done', count: 300 },
    { lane: 'specifications', status: 'complete', count: 400 }, { lane: 'media_operations', status: 'verified', count: 50 }, ...extra] });
const status = (rows = []) => ({ observedAt: AT, queue: rows, product: null });
const items = (rows = [], openTotal = rows.length) => ({ observedAt: AT, limit: 50, openTotal, items: rows });
// Raw read_toptik_media_liveness rows (snake_case, as the database returns them); verdicts are computed by the view with NOW.
const minutes = n => new Date(NOW - n * 60 * 1000).toISOString();
const livenessItem = (o = {}) => ({ product_gid: 'gid://shopify/Product/501', sku: 'LIVE-501', status: 'pending', last_error: null, updated_at: AT, attempts: 2, generation: 3,
  claim_id: null, claimed_at: null, claim_stale_after: null, inflight_keeps: 0, routine: false, retry_due_at: null, episode: null, episode_progress: null, last_completed: null, last_observed_at: AT, ...o });
const episodeOf = (createdMin, verifiedMin = null) => ({
  episode: { id: 'op-' + createdMin, status: 'running', next_step: 0, state_version: 1, created_at: minutes(createdMin), updated_at: minutes(createdMin) },
  episode_progress: { last_verified_at: verifiedMin === null ? null : minutes(verifiedMin),
    last_verified_source: verifiedMin === null ? null : { kind: 'transport_readback', request_id: null, step_index: 0, phase_index: 1, at: minutes(verifiedMin) },
    verified_phases: verifiedMin === null ? 0 : 1, verified_steps: 0, last_activity_at: minutes(1), latest_attempt: null } });
const livenessRaw = (rows = [], openTotal = rows.length) => ({ observedAt: AT, limit: 50, openTotal, items: rows, scope: 'open_work_queue_rows_only' });
const payload = (o = {}) => lib.buildMonitorPayload({ fetchedAt: AT, runtime, combined: combined(o.extra), combinedValid: true,
  status: status(o.reasons ?? []), items: items(o.items ?? [], o.openTotal), ...o.override });

test('text and media lanes are counted separately from the existing combined status rows', () => {
  const p = payload({ extra: [{ lane: 'media', status: 'pending', count: 7 }, { lane: 'media', status: 'processing', count: 1 }, { lane: 'media', status: 'review', count: 3 },
    { lane: 'media', status: 'failed', count: 2 }, { lane: 'copy_inbox', status: 'failed', count: 4 }, { lane: 'media_operations', status: 'uncertain', count: 5 }, { lane: 'media_operations', status: 'conflict', count: 1 }] });
  assert.equal(p.queues.available, true);
  assert.deepEqual(p.queues.data.media, { pending: 7, processing: 1, review: 3, failed: 2, complete: 300 });
  assert.deepEqual(p.queues.data.copy, { pending: 2, processing: 0, review: 0, failed: 4, complete: 120 });
  assert.deepEqual(p.queues.data.mediaOperations, { open: 5, conflict: 1 });
  assert.equal(p.liveVerified, false);
  assert.ok(lib.parseMonitorPayload(JSON.parse(JSON.stringify(p))));
});

test('item rows: SKU, update time and reason are sanitized; provider text never passes through', () => {
  const p = payload({ items: [
    { sku: 'P10FZT59001', status: 'pending', last_error: 'MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED', updated_at: '2026-10-07T10:00:00Z', attempts: 8 },
    { sku: 'bad sku <script>', status: 'failed', last_error: 'connection refused at 10.0.0.1 key=secret', updated_at: '2026-10-07T11:00:00Z', attempts: 1 },
    { sku: null, status: 'review', last_error: null, updated_at: '2026-10-07T12:00:00Z', attempts: 0 }] });
  assert.deepEqual(p.items.data.rows.map(r => [r.sku, r.code]), [['P10FZT59001', 'MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED'], [null, 'MEDIA_ERROR_UNRECOGNIZED'], [null, null]]);
  assert.ok(!JSON.stringify(p).includes('secret') && !JSON.stringify(p).includes('<script>'));
});

test('one failing or malformed source makes only its own section unavailable', () => {
  for (const override of [{ combined: null, combinedValid: false }, { status: null }, { items: null }, { items: { observedAt: AT, limit: 1, openTotal: 2, items: [{}, {}] } }, { combined: { observedAt: AT, queues: [{ lane: 'media', status: 'weird', count: 1 }], coverage: combined().coverage }, combinedValid: true },
    { liveness: null }, { liveness: livenessRaw([{}]) }, { liveness: { ...livenessRaw([livenessItem()]), scope: 'everything' } }, { liveness: { ...livenessRaw([livenessItem(), livenessItem()]), limit: 1 } }]) {
    const p = payload({ override: { liveness: livenessRaw([livenessItem()]), ...override } });
    const off = Object.entries({ queues: p.queues, reasons: p.reasons, items: p.items, liveness: p.liveness }).filter(([, s]) => !s.available).map(([k]) => k);
    assert.equal(off.length, 1, JSON.stringify(override)); assert.ok(lib.parseMonitorPayload(JSON.parse(JSON.stringify(p))));
  }
});

test('liveness section: absent on older payloads, unavailable when its read fails, sanitized camelCase rows otherwise; a malformed stored section invalidates the payload', () => {
  const without = payload();
  assert.equal('liveness' in without, false); assert.ok(lib.parseMonitorPayload(JSON.parse(JSON.stringify(without))));
  const unavailable = payload({ override: { liveness: null } });
  assert.deepEqual(unavailable.liveness, { available: false }); assert.ok(lib.parseMonitorPayload(JSON.parse(JSON.stringify(unavailable))));
  const p = payload({ override: { liveness: livenessRaw([livenessItem({ ...episodeOf(40, 35), last_error: 'connection refused key=secret' }),
    livenessItem({ product_gid: 'gid://shopify/Product/502', sku: 'bad <sku>' })], 80) } });
  assert.equal(p.liveness.available, true); assert.equal(p.liveness.observedAt, AT);
  assert.deepEqual([p.liveness.data.openTotal, p.liveness.data.limit, p.liveness.data.rows.length], [80, 50, 2]);
  assert.deepEqual([p.liveness.data.rows[0].sku, p.liveness.data.rows[0].code, p.liveness.data.rows[0].episode.id, p.liveness.data.rows[0].episodeProgress.verifiedPhases], ['LIVE-501', 'MEDIA_ERROR_UNRECOGNIZED', 'op-40', 1]);
  assert.equal(p.liveness.data.rows[1].sku, null); assert.ok(!JSON.stringify(p).includes('secret') && !JSON.stringify(p).includes('<sku>'));
  const stored = JSON.parse(JSON.stringify(p));
  assert.ok(lib.parseMonitorPayload(stored));
  assert.deepEqual(stored.liveness.data.rows.map(liveness.validLivenessRow), [true, true]);
  assert.equal(liveness.assessLiveness(stored.liveness.data.rows[0], NOW).rule, 'NO_VERIFIED_PROGRESS', 'the stored rows feed the detector unchanged');
  assert.equal(lib.parseMonitorPayload({ ...stored, liveness: { ...stored.liveness, data: { ...stored.liveness.data, rows: [{ productGid: 'x' }] } } }), null, 'a malformed row');
  assert.equal(lib.parseMonitorPayload({ ...stored, liveness: { ...stored.liveness, data: { ...stored.liveness.data, limit: 1 } } }), null, 'more rows than the limit');
  assert.equal(lib.parseMonitorPayload({ ...stored, liveness: { available: true } }), null, 'available without data');
  for (const patch of [{openTotal: 1}, {limit: 0}, {limit: 101}, {rows: [stored.liveness.data.rows[0], stored.liveness.data.rows[0]]},
    {rows: [{...stored.liveness.data.rows[0], episode: 'corrupted'}]}]) {
    assert.equal(lib.parseMonitorPayload({...stored, liveness: {...stored.liveness, data: {...stored.liveness.data, ...patch}}}), null, JSON.stringify(patch));
  }
  for (const input of [{...livenessRaw([livenessItem()]), openTotal: 0}, {...livenessRaw([]), limit: 0}, {...livenessRaw([]), limit: 101},
    livenessRaw([livenessItem(), livenessItem()]), livenessRaw([livenessItem({episode: 'corrupted', episode_progress: 'corrupted'})])]) {
    assert.deepEqual(payload({override: {liveness: input}}).liveness, {available: false});
  }
});

test('verdict: attention, in progress and queue complete are distinct; completion never implies live verification', () => {
  assert.equal(lib.mediaVerdict(payload({ extra: [{ lane: 'media', status: 'failed', count: 1 }] }), null, NOW).kind, 'attention');
  assert.equal(lib.mediaVerdict(payload({ extra: [{ lane: 'media_operations', status: 'conflict', count: 1 }] }), null, NOW).kind, 'attention');
  assert.equal(lib.mediaVerdict(payload({ extra: [{ lane: 'media', status: 'pending', count: 1 }] }), null, NOW).kind, 'in_progress');
  assert.equal(lib.mediaVerdict(payload({ extra: [{ lane: 'media_operations', status: 'running', count: 1 }] }), null, NOW).kind, 'in_progress');
  const missing = payload(); missing.queues.data.coverage.missingMediaBaseline = 1;
  assert.equal(lib.mediaVerdict(missing, null, NOW).kind, 'in_progress');
  assert.equal(lib.mediaVerdict(payload(), null, NOW).kind, 'queue_complete');
  assert.equal(payload().liveVerified, false);
});

test('no permission, connection failure, stale, future, disabled or unavailable data is unknown, never zero problems', () => {
  for (const failure of ['unauthorized', 'connection', 'invalid']) assert.deepEqual(lib.mediaVerdict(payload(), failure, NOW), { kind: 'unknown', reason: failure });
  assert.equal(lib.mediaVerdict(payload(), null, NOW + 16 * 60 * 1000).reason, 'stale');
  assert.equal(lib.mediaVerdict(payload(), null, Date.parse(AT) - 10 * 60 * 1000).reason, 'stale');
  assert.equal(lib.mediaVerdict(lib.buildMonitorPayload({ fetchedAt: AT, runtime: { copy: true, media: false }, combined: combined(), combinedValid: true, status: status(), items: items() }), null, NOW).reason, 'disabled');
  assert.equal(lib.mediaVerdict(payload({ override: { combined: null, combinedValid: false } }), null, NOW).reason, 'unavailable');
  assert.equal(lib.mediaVerdict(null, null, NOW).reason, 'invalid');
});

test('loader classifies HTTP and network outcomes without guessing', async () => {
  const ok = JSON.parse(JSON.stringify(payload()));
  const respond = (status, body, json = true) => async () => new Response(json ? JSON.stringify(body) : body, { status, headers: { 'content-type': 'application/json' } });
  assert.equal((await lib.loadMediaSyncMonitor(respond(200, ok))).kind, 'ok');
  for (const [impl, failure] of [[respond(401, {}), 'unauthorized'], [respond(403, {}), 'unauthorized'], [async () => { throw new TypeError('fetch failed'); }, 'connection'],
    [respond(503, {}), 'unavailable'], [respond(400, {}), 'invalid'], [respond(200, '<html>', false), 'invalid'], [respond(200, { ...ok, liveVerified: true }), 'invalid'], [respond(200, { ...ok, version: 2 }), 'invalid']])
    assert.deepEqual(await lib.loadMediaSyncMonitor(impl), { kind: 'error', failure });
  let seen; await lib.loadMediaSyncMonitor(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify(ok), { status: 200 }); });
  assert.equal(seen.url, '/api/admin/shopify/media/monitor'); assert.equal(seen.init.method, 'GET'); assert.equal(seen.init.cache, 'no-store');
});

test('responses arriving out of order: only the latest request wins, older observations never replace newer ones', () => {
  const older = { kind: 'ok', payload: { ...payload(), fetchedAt: '2026-10-07T13:00:00Z' } }, newer = { kind: 'ok', payload: { ...payload(), fetchedAt: '2026-10-07T13:59:00Z' } };
  let s = lib.initialMonitorState; const a = lib.startMonitorRequest(s); s = a.state; const b = lib.startMonitorRequest(s); s = b.state;
  s = lib.applyMonitorResult(s, b.seq, newer); assert.equal(s.payload.fetchedAt, newer.payload.fetchedAt);
  const after = lib.applyMonitorResult(s, a.seq, older); assert.equal(after, s);
  // Superseded request that resolves first is ignored too.
  let t = lib.initialMonitorState; const c = lib.startMonitorRequest(t); t = c.state; const d = lib.startMonitorRequest(t); t = d.state;
  t = lib.applyMonitorResult(t, c.seq, newer); assert.equal(t.payload, null); t = lib.applyMonitorResult(t, d.seq, older); assert.equal(t.payload.fetchedAt, older.payload.fetchedAt);
  // Latest failure hides earlier figures and shows unknown.
  const e = lib.startMonitorRequest(t); t = lib.applyMonitorResult(e.state, e.seq, { kind: 'error', failure: 'connection' });
  assert.equal(t.payload, null); assert.equal(t.failure, 'connection');
  // Same-sequence replay of an older observation cannot win.
  assert.equal(lib.shouldAccept({ seq: 2, observedAt: 200 }, { seq: 3, observedAt: 100 }), false);
});

test('plain Hebrew explanations for the key codes; unknown codes are flagged, not hidden', () => {
  assert.equal(lib.explainMediaCode('MEDIA_REVIEW_REQUIRED').title, 'תמונה ממתינה לאישור');
  assert.equal(lib.explainMediaCode('MEDIA_AMBIGUOUS_INSERT_ORDER').title, 'סדר התמונות דורש בדיקה');
  assert.equal(lib.explainMediaCode('MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED').title, 'התאוששות נדרשת');
  assert.equal(lib.explainMediaCode('MEDIA_STORAGE_OBJECT_PRESENT_UNREADABLE').title, 'הקובץ קיים אך עדיין לא ניתן לקריאה');
  assert.equal(lib.explainMediaCode('MEDIA_PLANNING_TIME_BUDGET').title, 'זמן ההפעלה הסתיים');
  assert.equal(lib.explainMediaCode('MEDIA_QUEUE_DEFERRED_TIME_BUDGET').title, 'זמן ההפעלה הסתיים');
  assert.equal(lib.explainMediaCode('MEDIA_QUEUE_IN_FLIGHT_CONTINUES').title, 'העבודה מתקדמת');
  assert.equal(lib.explainMediaCode('MEDIA_SOMETHING_NEW').code, 'MEDIA_SOMETHING_NEW');
  assert.equal(lib.explainMediaCode(null).code, null);
});

const counts = html => [...html.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]+)<\/dd>/g)].map(m => [m[1], m[2]]);
test('render: ambiguous insertion order is explained across reasons, item rows and liveness without losing its code', () => {
  const html = render({ payload: payload({ extra: [{ lane: 'media', status: 'review', count: 1 }],
    reasons: [{ status: 'review', last_error: 'MEDIA_AMBIGUOUS_INSERT_ORDER', products: 1, oldest_updated_at: AT, newest_updated_at: AT }],
    items: [{ sku: 'MONITOR-1', status: 'review', last_error: 'MEDIA_AMBIGUOUS_INSERT_ORDER', updated_at: AT, attempts: 1 }],
    override: { liveness: livenessRaw([livenessItem({ status: 'review', last_error: 'MEDIA_AMBIGUOUS_INSERT_ORDER' })]) } }) });
  assert.equal([...html.matchAll(/סדר התמונות דורש בדיקה/g)].length, 3, 'all three consumers explain the same diagnostic');
  assert.equal([...html.matchAll(/נדרשת בדיקה לפני שינוי הסדר/g)].length, 2, 'the reasons and item rows include full detail');
  assert.equal([...html.matchAll(/MEDIA_AMBIGUOUS_INSERT_ORDER/g)].length, 3, 'each consumer preserves the diagnostic code');
  assert.doesNotMatch(html, /קוד שאינו מתורגם/);
});
test('render: success shows separate lanes, reasons, SKU rows and the live-site caveat; read-only controls only', () => {
  const html = render({ payload: payload({ extra: [{ lane: 'media', status: 'review', count: 3 }], reasons: [{ status: 'review', last_error: 'MEDIA_REVIEW_REQUIRED', products: 3, oldest_updated_at: AT, newest_updated_at: AT }],
    items: [{ sku: 'P10FZT59001', status: 'review', last_error: 'MEDIA_REVIEW_REQUIRED', updated_at: AT, attempts: 2 }] }), onRefresh: () => {} });
  assert.match(html, /תור התמונות/); assert.match(html, /תור הטקסט \(נפרד\)/); assert.match(html, /דורש טיפול/);
  assert.match(html, /אימות באתר החי: לא נבדק במסך זה/); assert.match(html, /P10FZT59001/); assert.match(html, /תמונה ממתינה לאישור/);
  assert.match(html, /<th scope="col">מק״ט<\/th>/); assert.match(html, /<caption/); assert.match(html, /role="status"/); assert.match(html, /tabindex="0"/);
  assert.equal((html.match(/<button/g) ?? []).length, 1); assert.match(html, /רענון התצוגה/);
  assert.doesNotMatch(html, /אישור גורף|איפוס|הפעלה חוזרת|retry|reset/i);
});
test('render: queue complete states explicitly that it is not a live verification', () => {
  const html = render({ payload: payload() });
  assert.match(html, /תור התמונות הסתיים/); assert.match(html, /אינו אימות שהתמונות מופיעות באתר החי/); assert.match(html, /אין מוצרים פתוחים בתור התמונות/);
});
for (const [name, props] of [['connection failure', { failure: 'connection' }], ['no permission', { failure: 'unauthorized' }], ['stale data', { payload: payload(), now: NOW + 60 * 60 * 1000 }],
  ['missing queues', { payload: payload({ override: { combined: null, combinedValid: false } }) }]]) test(`render: ${name} shows unknown everywhere, never zero errors`, () => {
  const html = render(props);
  assert.match(html, /מצב לא ידוע/);
  assert.equal(counts(html).length, 14, 'all 10 lane counts and 4 separate extra figures are rendered');
  for (const [label, value] of counts(html)) assert.equal(value, 'לא ידוע', label);
  assert.doesNotMatch(html, /אין מוצרים פתוחים|תור התמונות הסתיים/);
  assert.match(html, /פירוט המוצרים אינו זמין/);
});
test('render: missing item details stay unknown while fresh queue counts still show', () => {
  const html = render({ payload: payload({ override: { items: null } }) });
  assert.match(html, /פירוט המוצרים אינו זמין/); assert.ok(counts(html).some(([l, v]) => l === 'הסתיימו' && v === '300'));
});
test('render: a partial list says how many of the open products are shown', () => {
  const html = render({ payload: payload({ extra: [{ lane: 'media', status: 'pending', count: 120 }], items: [{ sku: 'ABC-1', status: 'pending', last_error: null, updated_at: AT, attempts: 0 }], openTotal: 120 }) });
  assert.match(html, /מוצגים 1 הוותיקים מתוך 120 פתוחים/); assert.match(html, /לא נרשמה סיבה/);
});

test('render: overlapping missing baseline and queue counts are shown separately, never summed as products', () => {
  const p = payload(); p.queues.data.coverage.missingMediaBaseline = 3; p.queues.data.coverage.missingMediaQueue = 3;
  const html = render({ payload: p }), displayed = new Map(counts(html));
  assert.equal(displayed.get('מוצרים ללא בסיס השוואה'), '3');
  assert.equal(displayed.get('מוצרים ללא שורת תור'), '3');
  assert.match(html, /אותו מוצר יכול להיכלל בשתי ספירות החוסרים/);
  assert.doesNotMatch(html, /ללא בסיס השוואה או ללא שורת תור/);
});
test('render: disabled copy runtime hides only copy counts and explicitly explains that lane', () => {
  const p = payload(); p.queues.data.runtime.copy = false;
  const html = render({ payload: p }), displayed = counts(html);
  assert.equal(displayed[4][1], '300');
  assert.deepEqual(displayed.slice(5, 10).map(([, v]) => v), Array(5).fill('לא ידוע'));
  assert.match(html, /סנכרון הטקסט כבוי בסביבה זו/);
  assert.equal(lib.mediaVerdict(p, null, NOW).kind, 'queue_complete');
});
test('not-sent budget and lease holds require review, not a promised automatic retry', () => {
  for (const code of ['MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET', 'MEDIA_TRANSPORT_NOT_SENT_PRECONDITION', 'MEDIA_TRANSPORT_NOT_SENT_LEASE']) {
    const explanation = lib.explainMediaCode(code);
    assert.equal(explanation.title, 'ההעלאה לא נשלחה');
    assert.match(explanation.detail, /נדרשת בדיקה/);
    assert.doesNotMatch(explanation.detail, /בהפעלה הבאה|ייבדק שוב/);
  }
  assert.equal(lib.explainMediaCode('MEDIA_PLANNING_TIME_BUDGET').title, 'זמן ההפעלה הסתיים');
});

test('render: liveness lists only rows that are not progressing, names the rule in plain words, states the scan size and the detector caveat', () => {
  const p = payload({ override: { liveness: livenessRaw([livenessItem({ ...episodeOf(40, 35) }), livenessItem({ product_gid: 'gid://shopify/Product/502', sku: 'LIVE-502', ...episodeOf(4) })], 80) } });
  const html = render({ payload: p });
  assert.match(html, /חיות לפי מוצר/); assert.match(html, /לא התראה יזומה/); assert.match(html, /נבדקו 2 מתוך 80/); assert.match(html, /יש עוד שורות שלא נבדקו/);
  assert.match(html, /LIVE-501/); assert.match(html, /אין התקדמות מאומתת/); assert.match(html, /NO_VERIFIED_PROGRESS/);
  assert.doesNotMatch(html, /LIVE-502/); assert.doesNotMatch(html, /כל השורות הפתוחות שנבדקו מתקדמות/);
  const clean = render({ payload: payload({ override: { liveness: livenessRaw([livenessItem({ ...episodeOf(4) })]) } }) });
  assert.match(clean, /כל השורות הפתוחות שנבדקו מתקדמות/); assert.doesNotMatch(clean, /LIVE-501/);
});
test('render: no liveness key hides the section; an unavailable or stale liveness read is unknown, never zero problems', () => {
  assert.doesNotMatch(render({ payload: payload() }), /חיות לפי מוצר/);
  assert.match(render({ payload: payload({ override: { liveness: null } }) }), /נתוני החיות אינם זמינים/);
  const stale = render({ payload: payload({ override: { liveness: { ...livenessRaw([livenessItem({ ...episodeOf(40, 35) })]), observedAt: minutes(16) } } }) });
  assert.match(stale, /קריאת החיות ישנה מדי/); assert.doesNotMatch(stale, /LIVE-501/); assert.doesNotMatch(stale, /כל השורות הפתוחות שנבדקו מתקדמות/);
});

// ---------- route: real handler, stubbed auth/DB ----------
const stub = s => dataUrl(s);
async function route({ denied = null, rpc }) {
  const calls = [];
  globalThis.__monitor = { denied, rpc, calls };
  const src = stripTypeScriptTypes(read('src/app/api/admin/shopify/media/monitor/route.ts'))
    .replace(/from "next\/server";/, `from ${JSON.stringify(stub('export const NextResponse={json:(b,i={})=>new Response(JSON.stringify(b),{status:i.status??200,headers:i.headers})};'))};`)
    .replace(/from "@\/lib\/admin\/gallery-access";/, `from ${JSON.stringify(stub('export const requireGalleryAdmin=async()=>globalThis.__monitor.denied;'))};`)
    .replace(/from "@\/lib\/supabase\/service-role";/, `from ${JSON.stringify(stub('export const createSupabaseServiceRoleClient=()=>({rpc:(n,a)=>{globalThis.__monitor.calls.push([n,a]);return{abortSignal:()=>globalThis.__monitor.rpc(n,a)};}});'))};`)
    .replace(/from "@\/lib\/shopify\/admin-api";/, `from ${JSON.stringify(stub('export const isShopifySyncConfigured=()=>true;'))};`)
    .replace(/from "@\/lib\/shopify\/sync-rules";/, `from ${JSON.stringify(stub('export const configuredShopifySyncMode=()=>"verified_catalog";'))};`)
    .replace(/from "@\/lib\/shopify\/media-work-queue";/, `from ${JSON.stringify(stub('export const mediaSyncEnabled=()=>true;'))};`)
    .replace(/from "@\/lib\/shopify\/combined-sync-status";/, `from ${JSON.stringify(dataUrl(stripTypeScriptTypes(read('src/lib/shopify/combined-sync-status.ts'))))};`)
    .replace(/from "@\/lib\/shopify\/media-sync-monitor";/, `from ${JSON.stringify(libUrl)};`);
  const mod = await import(dataUrl(src + `\n//${Math.random()}`));
  process.env.VERCEL_ENV = 'production';
  const res = await mod.GET({ nextUrl: new URL('https://landing.toptik.co.il/api/admin/shopify/media/monitor'), method: 'GET', headers: new Headers() });
  return { res, body: res.status === 200 ? await res.json() : await res.text(), calls };
}
test('route: unauthenticated requests get the auth response and trigger no database read', async () => {
  const r = await route({ denied: new Response('{"error":"Unauthorized"}', { status: 401 }), rpc: async () => { throw Error('must not run'); } });
  assert.equal(r.res.status, 401); assert.deepEqual(r.calls, []);
});
const THREE = ['read_toptik_combined_sync_status', 'read_toptik_media_status', 'read_toptik_media_sync_monitor'];
const routeData = () => ({ read_toptik_combined_sync_status: combined(), read_toptik_media_status: status([{ status: 'pending', last_error: 'MEDIA_REVIEW_REQUIRED', products: 4, oldest_updated_at: AT, newest_updated_at: AT, maximum_attempts: 3 }]),
  read_toptik_media_sync_monitor: items([{ sku: 'ABC-1', status: 'pending', last_error: 'MEDIA_REVIEW_REQUIRED', updated_at: AT, attempts: 3 }]),
  read_toptik_media_liveness: livenessRaw([livenessItem({ ...episodeOf(40, 35) })]) });
test('route: exactly four bounded read-only RPCs, sanitized payload, no-store', async () => {
  const data = routeData();
  const r = await route({ rpc: async n => ({ data: data[n], error: null }) });
  assert.equal(r.res.status, 200); assert.equal(r.res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.calls.map(c => c[0]).sort(), [...THREE, 'read_toptik_media_liveness'].sort());
  assert.deepEqual(r.calls.find(c => c[0] === 'read_toptik_media_sync_monitor')[1], { p_limit: 50 });
  assert.deepEqual(r.calls.find(c => c[0] === 'read_toptik_media_liveness')[1], { p_limit: 50 });
  assert.ok(lib.parseMonitorPayload(r.body)); assert.equal(r.body.liveVerified, false);
  assert.equal(r.body.liveness.available, true); assert.equal(r.body.liveness.data.rows[0].episode.id, 'op-40');
});
test('route: MEDIA_MONITOR_LIVENESS=off skips the fourth read and omits the key, so the payload is the one older clients know', async () => {
  process.env.MEDIA_MONITOR_LIVENESS = 'off';
  try {
    const data = routeData();
    const r = await route({ rpc: async n => { assert.notEqual(n, 'read_toptik_media_liveness'); return { data: data[n], error: null }; } });
    assert.equal(r.res.status, 200); assert.deepEqual(r.calls.map(c => c[0]).sort(), THREE); assert.equal('liveness' in r.body, false); assert.ok(lib.parseMonitorPayload(r.body));
  } finally { delete process.env.MEDIA_MONITOR_LIVENESS; }
});
test('route: a failing liveness read blanks only the liveness section and leaks nothing', async () => {
  const data = routeData();
  const r = await route({ rpc: async n => n === 'read_toptik_media_liveness' ? Promise.reject(Error('statement timeout SECRET')) : { data: data[n], error: null } });
  assert.equal(r.res.status, 200); assert.ok(!JSON.stringify(r.body).includes('SECRET'));
  assert.deepEqual(r.body.liveness, { available: false }); assert.equal(r.body.items.available, true); assert.equal(r.body.reasons.available, true); assert.equal(r.body.queues.available, true);
});
test('route: a database error never leaks its message and only blanks that section', async () => {
  const r = await route({ rpc: async n => n === 'read_toptik_media_sync_monitor' ? { data: null, error: { message: 'permission denied for schema toptik_media_private; key=SECRET' } } :
    n === 'read_toptik_media_status' ? Promise.reject(Error('socket hang up SECRET')) : { data: combined(), error: null } });
  assert.equal(r.res.status, 200); assert.ok(!JSON.stringify(r.body).includes('SECRET'));
  assert.equal(r.body.items.available, false); assert.equal(r.body.reasons.available, false); assert.equal(r.body.queues.available, true);
});
