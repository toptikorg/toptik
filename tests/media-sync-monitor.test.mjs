import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { stripTypeScriptTypes } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const dataUrl = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64');
const libUrl = dataUrl(stripTypeScriptTypes(read('src/lib/shopify/media-sync-monitor.ts')));
const lib = await import(libUrl);
// Real presentational component, compiled with the project's TypeScript; CSS module class names are identity-mapped.
const cssUrl = dataUrl('export default new Proxy({}, { get: (_, k) => String(k) });');
const viewCode = ts.transpileModule(read('src/components/admin/MediaSyncMonitorView.tsx'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime'))).replace('"./MediaSyncMonitor.module.css"', JSON.stringify(cssUrl))
  .replace('"@/lib/shopify/media-sync-monitor"', JSON.stringify(libUrl));
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
  for (const override of [{ combined: null, combinedValid: false }, { status: null }, { items: null }, { items: { observedAt: AT, limit: 1, openTotal: 2, items: [{}, {}] } }, { combined: { observedAt: AT, queues: [{ lane: 'media', status: 'weird', count: 1 }], coverage: combined().coverage }, combinedValid: true }]) {
    const p = payload({ override }); const off = Object.entries({ queues: p.queues, reasons: p.reasons, items: p.items }).filter(([, s]) => !s.available).map(([k]) => k);
    assert.equal(off.length, 1, JSON.stringify(override)); assert.ok(lib.parseMonitorPayload(JSON.parse(JSON.stringify(p))));
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
  assert.equal(lib.explainMediaCode('MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED').title, 'התאוששות נדרשת');
  assert.equal(lib.explainMediaCode('MEDIA_STORAGE_OBJECT_PRESENT_UNREADABLE').title, 'הקובץ קיים אך עדיין לא ניתן לקריאה');
  assert.equal(lib.explainMediaCode('MEDIA_PLANNING_TIME_BUDGET').title, 'זמן ההפעלה הסתיים');
  assert.equal(lib.explainMediaCode('MEDIA_SOMETHING_NEW').code, 'MEDIA_SOMETHING_NEW');
  assert.equal(lib.explainMediaCode(null).code, null);
});

const counts = html => [...html.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]+)<\/dd>/g)].map(m => [m[1], m[2]]);
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
test('route: exactly three bounded read-only RPCs, sanitized payload, no-store', async () => {
  const data = { read_toptik_combined_sync_status: combined(), read_toptik_media_status: status([{ status: 'pending', last_error: 'MEDIA_REVIEW_REQUIRED', products: 4, oldest_updated_at: AT, newest_updated_at: AT, maximum_attempts: 3 }]),
    read_toptik_media_sync_monitor: items([{ sku: 'ABC-1', status: 'pending', last_error: 'MEDIA_REVIEW_REQUIRED', updated_at: AT, attempts: 3 }]) };
  const r = await route({ rpc: async n => ({ data: data[n], error: null }) });
  assert.equal(r.res.status, 200); assert.equal(r.res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.calls.map(c => c[0]).sort(), ['read_toptik_combined_sync_status', 'read_toptik_media_status', 'read_toptik_media_sync_monitor']);
  assert.deepEqual(r.calls.find(c => c[0] === 'read_toptik_media_sync_monitor')[1], { p_limit: 50 });
  assert.ok(lib.parseMonitorPayload(r.body)); assert.equal(r.body.liveVerified, false);
});
test('route: a database error never leaks its message and only blanks that section', async () => {
  const r = await route({ rpc: async n => n === 'read_toptik_media_sync_monitor' ? { data: null, error: { message: 'permission denied for schema toptik_media_private; key=SECRET' } } :
    n === 'read_toptik_media_status' ? Promise.reject(Error('socket hang up SECRET')) : { data: combined(), error: null } });
  assert.equal(r.res.status, 200); assert.ok(!JSON.stringify(r.body).includes('SECRET'));
  assert.equal(r.body.items.available, false); assert.equal(r.body.reasons.available, false); assert.equal(r.body.queues.available, true);
});
