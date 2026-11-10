import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import ts from 'typescript';

// Editor side of the staged Gallery review: which uploads still need the administrator's confirmation, the request
// that asks the server for it, how the confirmed copy replaces the upload, and how the page is wired to all of it.
// The server side (receipt, storage, route) is covered by staged-media-*.test.mjs; the end-to-end save through the
// real PUT route and revision check is in admin-editor-changed-only.test.mjs.

const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const helper = await import(dataUrl(stripTypeScriptTypes(readFileSync('src/lib/carousel/staged-upload-review.ts', 'utf8'))));

const ID = '660aea87-5082-438d-86f0-bd982ac43a68', OTHER = '11111111-2222-4333-8444-555555555555';
const OWNED = 'd0000000-0000-4000-8000-00000000f273';
const HOST = 'https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media';
const FILE = '5a6e2a30-733b-4df9-be1d-7bfa056e4613.jpg';
const up = (id = ID, folder = 'angles', name = FILE) => `${HOST}/items/${id}/${folder}/${name}`;
const sha = 'a'.repeat(64);
const stagedUrl = (id = ID, ext = 'jpg', hash = sha) => `${HOST}/sync-staged/${id}/${hash}.${ext}`;
const angle = (id, imagePath, extra = {}) => ({ id, itemId: ID, angleKey: `view-${id}`, angleOrder: 1, imagePath, imageAlt: `alt ${id}`, ...extra });
const card = (patch = {}) => ({ id: ID, title: 'תיק גב כחול', description: 'd', catalogNumber: 'KF901003', editorRevision: 7, copyUpdatedAt: '2026-10-01T00:00:00Z',
  displayOrder: 3, isActive: true, coverImagePath: 'https://cdn.shopify.com/s/files/1/0622/8082/7130/files/a.jpg', coverImageAlt: 'cover alt',
  angles: [angle('a1', '/old-1.jpg'), angle('a2', '/old-2.jpg')], ...patch });
const catalog = (...items) => ({ settings: { editorRevision: 3, autoplayMs: 3000, transitionMode: 'curtain-fade' }, items });

test('a fresh upload of this card is pending, once per file, with the places it is used', () => {
  const saved = card();
  assert.deepEqual(helper.pendingUploadReviews(saved, card({ coverImagePath: up(ID, 'cover') })), [{ url: up(ID, 'cover'), roles: ['cover'] }]);
  assert.deepEqual(helper.pendingUploadReviews(saved, card({ angles: [...saved.angles, angle('a3', up())] })), [{ url: up(), roles: ['angle'] }]);
  // The first angle also becomes the cover when the card had none: one file, two places, one confirmation.
  const shared = card({ coverImagePath: up(), angles: [angle('a3', up())] });
  assert.deepEqual(helper.pendingUploadReviews(saved, shared), [{ url: up(), roles: ['cover', 'angle'] }]);
  const two = card({ angles: [...saved.angles, angle('a3', up()), angle('a4', up(ID, 'angles', '9b6e2a30-733b-4df9-be1d-7bfa056e4614.png'))] });
  assert.equal(helper.pendingUploadReviews(saved, two).length, 2);
  assert.deepEqual(helper.pendingUploadReviews(undefined, card({ angles: [angle('a3', up())] })), [{ url: up(), roles: ['angle'] }], 'a card with no saved baseline has nothing known');
  assert.equal(helper.pendingUploadReviews(saved, card({ id: ID.toUpperCase(), angles: [angle('a3', up())] })).length, 1, 'the card id is compared without case');
});

test('saved images, confirmed copies and every other kind of address are never pending', () => {
  const saved = card({ coverImagePath: up(ID, 'cover'), angles: [angle('a1', up())] });
  assert.deepEqual(helper.pendingUploadReviews(saved, structuredClone(saved)), [], 'an upload that was already saved is not asked again');
  for (const url of [
    stagedUrl(), `${HOST}/sync-media/${ID}/${sha}.jpg`, `${HOST}/sync-owned/${ID}/${sha}.jpg`, `${HOST}/owned-drafts/${ID}/x.jpg`,
    up(OTHER), up(ID, 'other'), up(ID, 'angles', 'not-a-uuid.jpg'), up() + '?x=1', up() + '#frag', up().replace('https://', 'http://'),
    'https://cdn.shopify.com/s/files/1/0622/8082/7130/files/a.jpg', '/relative.jpg', '', 'items/' + ID + '/angles/' + FILE,
  ]) {
    assert.deepEqual(helper.pendingUploadReviews(card({ coverImagePath: 'https://x.test/c.jpg' }), card({ angles: [angle('a3', url)] })), [], url);
  }
  assert.deepEqual(helper.pendingUploadReviews(card(), card({ angles: [angle('a3', undefined)] })), [], 'a missing path is not a crash');
});

test('swapping an upload for its confirmed copy changes only that path, everywhere it is used', () => {
  const before = card({ coverImagePath: up(), angles: [angle('a1', up()), angle('a2', '/keep.jpg', { angleOrder: 2 })], editorRevision: 7, copyUpdatedAt: '2026-10-01T00:00:00Z' });
  const frozen = structuredClone(before);
  const after = helper.applyStagedUpload(before, up(), stagedUrl());
  assert.deepEqual(before, frozen, 'the input is not mutated');
  assert.equal(after.coverImagePath, stagedUrl());
  assert.equal(after.angles[0].imagePath, stagedUrl());
  assert.equal(after.angles[1], before.angles[1], 'an unrelated angle is the same object');
  // Version, SKU, order, alt text and every other field stay exactly as they were.
  assert.deepEqual({ ...after, coverImagePath: before.coverImagePath, angles: before.angles }, before);
  assert.deepEqual({ ...after.angles[0], imagePath: 0 }, { ...before.angles[0], imagePath: 0 });
  assert.equal(after.editorRevision, 7);
  assert.equal(after.copyUpdatedAt, '2026-10-01T00:00:00Z');
  const untouched = helper.applyStagedUpload(before, up(ID, 'angles', '9b6e2a30-733b-4df9-be1d-7bfa056e4614.png'), stagedUrl());
  assert.deepEqual(untouched, before, 'a URL the card does not use changes nothing');
});

test('the editor update resolves the card by id and ignores a catalog that was reloaded or no longer has the card', () => {
  const a = card({ id: ID, coverImagePath: up() }), b = card({ id: OTHER, catalogNumber: 'KF901004', coverImagePath: up(OTHER, 'cover') });
  const current = catalog(b, a); // reordered since the request started
  const next = helper.applyStagedUploadToCatalog(current, ID, up(), stagedUrl(), 4, 4);
  assert.equal(next.items[1].coverImagePath, stagedUrl());
  assert.equal(next.items[0], b, 'the other card is the very same object');
  assert.equal(next.settings, current.settings);
  assert.equal(current.items[1].coverImagePath, up(), 'the previous state is not mutated');
  assert.equal(helper.applyStagedUploadToCatalog(current, ID, up(), stagedUrl(), 4, 5), current, 'reloaded during the request');
  assert.equal(helper.applyStagedUploadToCatalog(current, 'missing', up(), stagedUrl(), 4, 4), current, 'card removed');
});

test('a save is refused while an ordinary product still has an upload nobody confirmed, and shared products are left to their own editor', () => {
  const saved = catalog(card(), card({ id: OTHER, catalogNumber: 'KF901004' }));
  const unconfirmed = catalog(card(), card({ id: OTHER, catalogNumber: 'KF901004', angles: [angle('a9', up(OTHER))] }));
  assert.throws(() => helper.assertNoPendingUploadReviews(saved, unconfirmed), { message: helper.PENDING_REVIEW_SAVE_MESSAGE });
  assert.throws(() => helper.assertNoPendingUploadReviews(saved, unconfirmed, id => id === ID), { message: helper.PENDING_REVIEW_SAVE_MESSAGE });
  helper.assertNoPendingUploadReviews(saved, unconfirmed, id => id === OTHER);
  const confirmed = catalog(card(), card({ id: OTHER, catalogNumber: 'KF901004', angles: [angle('a9', stagedUrl(OTHER))] }));
  helper.assertNoPendingUploadReviews(saved, confirmed);
  helper.assertNoPendingUploadReviews(saved, structuredClone(saved));
  const added = catalog(card(), card({ id: OTHER, angles: [angle('a9', up(OTHER))] }), card({ id: '22222222-3333-4444-8555-666666666666', angles: [angle('b1', up('22222222-3333-4444-8555-666666666666'))] }));
  assert.throws(() => helper.assertNoPendingUploadReviews(saved, added), { message: helper.PENDING_REVIEW_SAVE_MESSAGE }, 'a card with no saved baseline is checked too');
});

function fakeFetch(reply, seen = []) {
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (reply instanceof Error) throw reply;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => { if (reply.json === undefined) throw new SyntaxError('not json'); return structuredClone(reply.json); } };
  };
  return fetchImpl;
}
const request = (patch = {}) => ({ itemId: ID, uploadUrl: up(), catalogNumber: 'KF901003', revision: 7, note: '  בדקתי מול האתר  ', token: 'tok', ...patch });

test('the request names the card, the SKU on screen and the version loaded, and carries nothing identity-like beyond that', async () => {
  const seen = [];
  const result = await helper.requestStagedReview(request(), fakeFetch({ status: 200, json: { ok: true, stagedUrl: stagedUrl() } }, seen));
  assert.deepEqual(result, { stagedUrl: stagedUrl() });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/admin/shopify/media/staged-review');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['x-admin-token'], 'tok');
  assert.equal(seen[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[0].init.body), { itemId: ID, uploadUrl: up(), reviewedExactSkuColor: true, reviewedCatalogNumber: 'KF901003', expectedRevision: 7, note: 'בדקתי מול האתר' });
  const blank = [];
  await helper.requestStagedReview(request({ note: '   ' }), fakeFetch({ status: 200, json: { ok: true, stagedUrl: stagedUrl() } }, blank));
  assert.equal('note' in JSON.parse(blank[0].init.body), false, 'a blank note is not sent');
});

test('only this card\'s own content-addressed copy, on the same storage host, is accepted back', async () => {
  const bad = [
    stagedUrl(OTHER), stagedUrl(ID, 'avif'), stagedUrl(ID, 'gif'), stagedUrl(ID, 'jpg', 'A'.repeat(64)), stagedUrl(ID, 'jpg', 'a'.repeat(63)), stagedUrl() + '?x=1', stagedUrl() + '#f',
    up(), `${HOST}/sync-media/${ID}/${sha}.jpg`, stagedUrl().replace('ekgpaoavsavrtbhlbwdg', 'evil'), stagedUrl().replace('https://', 'https://user:pw@'),
    stagedUrl().replace('https://', 'http://'), 'https://cdn.shopify.com/s/files/1/0622/8082/7130/files/a.jpg', '', 7, null, undefined, {},
  ];
  for (const value of bad) {
    await assert.rejects(helper.requestStagedReview(request(), fakeFetch({ status: 200, json: { ok: true, stagedUrl: value } })), /כתובת תמונה לא צפויה/, String(value));
  }
  for (const ext of ['jpg', 'png', 'webp']) {
    assert.deepEqual(await helper.requestStagedReview(request(), fakeFetch({ status: 200, json: { ok: true, stagedUrl: stagedUrl(ID, ext) } })), { stagedUrl: stagedUrl(ID, ext) });
  }
  await assert.rejects(helper.requestStagedReview(request({ itemId: ID.toUpperCase() }), fakeFetch({ status: 200, json: { ok: true, stagedUrl: stagedUrl(OTHER) } })), /לא צפויה/);
  const mixed = await helper.requestStagedReview(request({ itemId: ID.toUpperCase() }), fakeFetch({ status: 200, json: { ok: true, stagedUrl: stagedUrl() } }));
  assert.equal(mixed.stagedUrl, stagedUrl(), 'the card id is compared without case');
});

test('every server refusal becomes a clear Hebrew message and no URL is returned', async () => {
  const codes = ['STAGED_MEDIA_NOT_ELIGIBLE', 'STAGED_MEDIA_IDENTITY_CHANGED', 'STAGED_MEDIA_STALE_ITEM', 'STAGED_MEDIA_BINDING_READ_FAILED', 'STAGED_MEDIA_OWNED_GROUP',
    'STAGED_MEDIA_UPLOAD_INVALID', 'STAGED_MEDIA_FORMAT_INVALID', 'STAGED_MEDIA_READBACK_MISMATCH', 'STAGED_MEDIA_STORAGE_FAILED', 'STAGED_MEDIA_TIME_BUDGET', 'STAGED_MEDIA_INPUT_INVALID',
    'STAGED_MEDIA_RECORD_INVALID', 'STAGED_MEDIA_FAILED', 'MEDIA_REVIEW_REJECTED', 'MEDIA_REVIEW_STORAGE_READ_FAILED', 'MEDIA_REVIEW_STORAGE_NOT_PRIVATE', 'MEDIA_SOURCE_BYTE_LIMIT',
    'MEDIA_SOURCE_DECODE_FAILED', 'MEDIA_SOURCE_DECODE_CHANGED', 'MEDIA_SOURCE_READ_FAILED'];
  for (const code of codes) {
    const message = helper.stagedReviewErrorMessage(code);
    assert.match(message, /[֐-׿]/, code);
    assert.ok(!message.includes(code), `${code} is not shown to the merchant`);
    for (const status of [400, 409]) {
      await assert.rejects(helper.requestStagedReview(request(), fakeFetch({ status, json: { error: code } })), { message });
    }
  }
  assert.equal(new Set(codes.map(helper.stagedReviewErrorMessage)).size >= 17, true, 'the messages are specific');
  // An unknown but well-formed code is named so it can be reported; anything else is not echoed.
  assert.match(helper.stagedReviewErrorMessage('SOMETHING_NEW'), /\(SOMETHING_NEW\)/);
  for (const hostile of ['<script>alert(1)</script>', 'select * from t', 'a'.repeat(200), '__proto__', 'constructor', 'toString', undefined, '']) {
    const message = helper.stagedReviewErrorMessage(hostile);
    assert.ok(message.includes('לא נשלח דבר'), String(hostile));
    assert.ok(!message.includes('<') && !message.includes('select') && !message.includes('()'), String(hostile));
  }
  await assert.rejects(helper.requestStagedReview(request(), fakeFetch({ status: 502 })), /אישור התמונה נכשל\. לא נשלח דבר/, 'a non-JSON answer');
  await assert.rejects(helper.requestStagedReview(request(), fakeFetch({ status: 200, json: { ok: false } })), /לא נשלח דבר/, 'ok must be exactly true');
  await assert.rejects(helper.requestStagedReview(request(), fakeFetch({ status: 200, json: { stagedUrl: stagedUrl() } })), /לא נשלח דבר/);
  await assert.rejects(helper.requestStagedReview(request(), fakeFetch({ status: 401, json: { ok: true, stagedUrl: stagedUrl() } })), /לא נשלח דבר/, 'a failing status never succeeds');
  await assert.rejects(helper.requestStagedReview(request(), fakeFetch(new TypeError('Failed to fetch'))), /אין תקשורת עם השרת\. לא נשלח דבר/);
});

// ---- page.tsx: the real handler and the real wiring -------------------------------------------------------------
const page = readFileSync('src/app/admin/page.tsx', 'utf8');
const slice = (start, end) => page.slice(page.indexOf(start), page.indexOf(end, page.indexOf(start)));
const confirmSource = stripTypeScriptTypes(slice('async function onConfirmStagedUpload(', '  async function onImageUpload('), { mode: 'transform' }).trim();

function confirmHarness({ request: requestImpl, ctx = {}, payload: start } = {}) {
  const calls = [], status = [];
  let payload = start ?? catalog(card({ coverImagePath: up(ID, 'cover') }));
  const pending = { current: 0 }, generation = { current: 4 };
  const snapshot = { current: catalog(card()) };
  const context = {
    pendingUploadsRef: pending, isCatalogBusy: false, authReady: true, savedSnapshotRef: snapshot, isShopifyOwnedVariant: id => id === OWNED,
    catalogGenerationRef: generation, setPendingUploads: count => calls.push(['pending', count]), setStatus: value => status.push(value), token: 'tok',
    requestStagedReview: async req => { calls.push(['request', req]); return requestImpl ? requestImpl(req) : { stagedUrl: stagedUrl() }; },
    setPayload: update => { payload = update(payload); }, applyStagedUploadToCatalog: helper.applyStagedUploadToCatalog,
    resolveErrorMessage: (error, fallback) => error instanceof Error ? error.message : fallback, ...ctx,
  };
  const run = new Function(...Object.keys(context), `return (${confirmSource});`)(...Object.values(context));
  return { run, calls, status, pending, generation, snapshot, payload: () => payload };
}
const requests = h => h.calls.filter(c => c[0] === 'request').map(c => c[1]);

test('confirming asks for exactly the SAVED card\'s SKU and version, applies the copy, and holds saving back while it runs', async () => {
  const h = confirmHarness();
  // Local edits to the card must not change what is sent: the server checks the saved card.
  const edited = catalog(card({ coverImagePath: up(ID, 'cover'), catalogNumber: 'EDITED-LOCALLY', editorRevision: 99 }));
  const h2 = confirmHarness({ payload: edited });
  assert.equal(await h2.run(ID, up(ID, 'cover'), 'נבדק'), null);
  assert.deepEqual(requests(h2), [{ itemId: ID, uploadUrl: up(ID, 'cover'), catalogNumber: 'KF901003', revision: 7, note: 'נבדק', token: 'tok' }]);
  assert.equal(h2.payload().items[0].coverImagePath, stagedUrl());
  assert.equal(h2.payload().items[0].catalogNumber, 'EDITED-LOCALLY', 'local edits survive');
  assert.deepEqual(h2.calls.filter(c => c[0] === 'pending').map(c => c[1]), [1, 0], 'counted as a pending upload while it runs, released after');
  assert.equal(h2.pending.current, 0);
  assert.ok(h2.status.at(-1).includes('אושרה'));
  assert.equal(await h.run(ID, up(ID, 'cover'), ''), null);
  assert.equal(h.payload().items[0].coverImagePath, stagedUrl());
});

test('confirming is refused, with nothing sent, while the editor is busy, signed out, or has no usable saved version', async () => {
  const idle = confirmHarness();
  idle.pending.current = 1;
  assert.match(await idle.run(ID, up(), ''), /להמתין/);
  assert.equal(idle.pending.current, 1, 'the other operation\'s count is not disturbed');
  assert.deepEqual(requests(idle), []);
  for (const ctx of [{ isCatalogBusy: true }, { authReady: false }]) {
    const h = confirmHarness({ ctx });
    assert.match(await h.run(ID, up(), ''), /להמתין/);
    assert.deepEqual(h.calls, []);
  }
  const broken = [
    snapshot => { snapshot.current = catalog(); }, snapshot => { snapshot.current = catalog(card({ id: OTHER })); },
    snapshot => { snapshot.current = catalog(card({ catalogNumber: '' })); }, snapshot => { snapshot.current = catalog(card({ catalogNumber: null })); },
    snapshot => { snapshot.current = catalog(card({ editorRevision: undefined })); }, snapshot => { snapshot.current = catalog(card({ editorRevision: '7' })); },
    snapshot => { snapshot.current = null; },
  ];
  for (const breakIt of broken) {
    const h = confirmHarness();
    breakIt(h.snapshot);
    assert.match(await h.run(ID, up(), ''), /גרסת הכרטיס חסרה/);
    assert.deepEqual(h.calls, []);
    assert.equal(h.pending.current, 0);
  }
  const owned = confirmHarness();
  owned.snapshot.current = catalog(card({ id: OWNED }));
  assert.match(await owned.run(OWNED, up(OWNED), ''), /גרסת הכרטיס חסרה/);
  assert.deepEqual(owned.calls, [], 'shared multi-color products are never confirmed here');
});

test('a refusal, a failure or a reload during the request leaves the catalog untouched and releases the counter', async () => {
  const refused = confirmHarness({ request: async () => { throw new Error('הכרטיס עודכן במקום אחר'); } });
  const before = refused.payload();
  assert.equal(await refused.run(ID, up(ID, 'cover'), ''), 'הכרטיס עודכן במקום אחר');
  assert.equal(refused.payload(), before);
  assert.equal(refused.pending.current, 0);
  assert.equal(refused.status.at(-1), 'הכרטיס עודכן במקום אחר');
  const opaque = confirmHarness({ request: async () => { throw 'boom'; } });
  assert.equal(await opaque.run(ID, up(ID, 'cover'), ''), 'אישור התמונה נכשל');
  let release;
  const reloaded = confirmHarness({ request: () => new Promise(resolve => { release = () => resolve({ stagedUrl: stagedUrl() }); }) });
  const startedWith = reloaded.payload();
  const running = reloaded.run(ID, up(ID, 'cover'), '');
  assert.equal(reloaded.pending.current, 1);
  reloaded.generation.current += 1; // the catalog was reloaded while the server worked
  release();
  assert.match(await running, /נטען מחדש/);
  assert.equal(reloaded.payload(), startedWith);
  assert.equal(reloaded.pending.current, 0);
});

test('the page refuses to save, before any request, when a new upload has not been confirmed', () => {
  const persist = slice('async function persistPayload(', 'const loadData = useCallback');
  const at = text => persist.indexOf(text);
  assert.ok(at('assertNoPendingUploadReviews(snapshot, nextPayload, isShopifyOwnedVariant)') > at('ownedCardChanges(saved, item)'), 'after the shared-product check');
  assert.ok(at('assertNoPendingUploadReviews(') < at('planChangedOnlySave('), 'before the changes are planned');
  assert.ok(at('assertNoPendingUploadReviews(') < at('fetch('), 'before anything is sent');
  assert.ok(at('assertNoPendingUploadReviews(') > at('if (!snapshot) throw'), 'against the loaded snapshot');
});

test('every new upload of an ordinary product gets its own confirmation panel, fed by the saved card', () => {
  const grid = slice('{!sourceOwned && (() => {', '<div className="admin-item-angles"');
  assert.ok(grid.includes('const saved = savedSnapshotRef.current?.items.find(row => row.id === item.id);'));
  assert.ok(grid.includes('pendingUploadReviews(saved, item).map(pending => ('));
  assert.ok(grid.includes('<StagedImageReview key={pending.url}'));
  assert.ok(grid.includes('sku={saved?.catalogNumber ?? ""} revision={saved?.editorRevision}'), 'the SKU and version shown and sent are the saved card\'s');
  assert.ok(grid.includes('imageUrl={pending.url}'));
  assert.ok(grid.includes('disabled={isCatalogBusy || !authReady}'));
  assert.ok(grid.includes('onConfirm={note => onConfirmStagedUpload(item.id, pending.url, note)}'));
  assert.ok(page.indexOf('<OwnedMediaEditor') < page.indexOf('{!sourceOwned && (() => {'), 'the panel sits with the card\'s media section');
  assert.ok(page.includes('import StagedImageReview from "@/components/admin/StagedImageReview";'));
  assert.equal(page.match(/<StagedImageReview\b/g).length, 1);
  // Uploading itself is unchanged: it never confirms anything.
  const upload = slice('async function onImageUpload(', '  function removeAngle(');
  assert.ok(!upload.includes('StagedReview') && !upload.includes('staged-review') && !upload.includes('onConfirmStagedUpload'));
  assert.ok(upload.includes('יש לאשר אותה בכרטיס המוצר'), 'the status tells the merchant what to do next');
});

// ---- the panel itself, with a minimal hooks and JSX shim (no browser needed) -------------------------------------
const compiled = ts.transpileModule(readFileSync('src/components/admin/StagedImageReview.tsx', 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const shimJsx = dataUrl('export const jsx = (type, props, key) => ({ type, props, key }); export const jsxs = jsx;');
const shimReact = dataUrl('export const useState = initial => globalThis.__panelHooks.useState(initial); export const useRef = initial => globalThis.__panelHooks.useRef(initial);');
const shimImage = dataUrl('export default function Image() { return null; }');
const { default: Panel } = await import(dataUrl(compiled
  .replace('from "react/jsx-runtime"', `from ${JSON.stringify(shimJsx)}`).replace('from "react"', `from ${JSON.stringify(shimReact)}`).replace('from "next/image"', `from ${JSON.stringify(shimImage)}`)));

function mount(props) {
  const slots = []; let cursor = 0, tree;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: initial }; const slot = slots[i]; return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: { current: initial } }; return slots[i].value; },
  };
  const render = () => { cursor = 0; globalThis.__panelHooks = hooks; tree = Panel(props); return tree; };
  render();
  return { render, tree: () => tree };
}
function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== 'object') return;
  yield node; yield* walk(node.props?.children);
}
const all = tree => [...walk(tree)];
const textOf = node => (Array.isArray(node) ? node : [node]).map(part => typeof part === 'string' ? part : part && typeof part === 'object' ? textOf(part.props?.children ?? []) : '').join('');
const checkbox = tree => all(tree).find(n => n.type === 'input' && n.props.type === 'checkbox');
const noteInput = tree => all(tree).find(n => n.type === 'input' && n.props.type === undefined);
const button = tree => all(tree).find(n => n.type === 'button');
const alerts = tree => all(tree).filter(n => n.props?.role === 'alert').map(n => textOf(n.props.children));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const props = (patch = {}) => ({ sku: 'KF901003', revision: 7, title: 'תיק גב כחול', imageUrl: up(), disabled: false, onConfirm: async () => null, ...patch });

test('the panel shows the SKU and title next to an unticked box, and cannot confirm until the box is ticked', async () => {
  const seen = [];
  const m = mount(props({ onConfirm: async note => { seen.push(note); return null; } }));
  const first = m.tree();
  assert.equal(first.props.role, 'group');
  const text = textOf(first.props.children);
  assert.ok(text.includes('KF901003') && text.includes('תיק גב כחול') && text.includes('הדגם והצבע'));
  assert.equal(checkbox(first).props.checked, false);
  assert.equal(button(first).props.disabled, true);
  await button(first).props.onClick();
  await settle();
  assert.deepEqual(seen, [], 'a click on a disabled button does nothing');
  checkbox(first).props.onChange({ target: { checked: true } });
  const ticked = m.render();
  assert.equal(button(ticked).props.disabled, false);
  noteInput(ticked).props.onChange({ target: { value: '  נבדק מול הצבע  ' } });
  const withNote = m.render();
  button(withNote).props.onClick();
  await settle();
  assert.deepEqual(seen, ['נבדק מול הצבע'], 'the note is trimmed');
});

test('while the server works the panel is locked and a second click through the same handler sends nothing', async () => {
  let release, calls = 0;
  const m = mount(props({ onConfirm: () => { calls++; return new Promise(resolve => { release = resolve; }); } }));
  checkbox(m.tree()).props.onChange({ target: { checked: true } });
  const ready = m.render();
  const click = button(ready).props.onClick;
  click(); click(); click();
  await settle();
  assert.equal(calls, 1);
  const busy = m.render();
  assert.equal(button(busy).props.disabled, true);
  assert.ok(textOf(button(busy).props.children).includes('מכין'));
  assert.equal(checkbox(busy).props.disabled, true);
  release('הכרטיס עודכן במקום אחר מאז שנטען.');
  await settle();
  const done = m.render();
  assert.deepEqual(alerts(done), ['הכרטיס עודכן במקום אחר מאז שנטען.'], 'the refusal is shown next to the image');
  assert.equal(button(done).props.disabled, false, 'the merchant can try again');
  button(done).props.onClick();
  await settle();
  assert.equal(calls, 2, 'a refused attempt can be retried');
  release(null);
  await settle();
  assert.deepEqual(alerts(m.render()), []);
});

test('success clears the message; a thrown error gives a generic one; neither leaves the panel stuck', async () => {
  const ok = mount(props());
  checkbox(ok.tree()).props.onChange({ target: { checked: true } });
  button(ok.render()).props.onClick();
  await settle();
  assert.deepEqual(alerts(ok.render()), []);
  assert.equal(button(ok.render()).props.disabled, false);
  const thrown = mount(props({ onConfirm: async () => { throw new Error('secret internal detail'); } }));
  checkbox(thrown.tree()).props.onChange({ target: { checked: true } });
  button(thrown.render()).props.onClick();
  await settle();
  assert.deepEqual(alerts(thrown.render()), ['אישור התמונה נכשל. לא נשלח דבר.'], 'the thrown text is not shown');
  assert.equal(button(thrown.render()).props.disabled, false);
});

test('without a card version, or while the editor is busy, the panel cannot be confirmed at all', async () => {
  for (const patch of [{ revision: undefined }, { revision: -1 }, { revision: 1.5 }, { revision: Number.NaN }, { sku: '' }]) {
    let calls = 0;
    const m = mount(props({ ...patch, onConfirm: async () => { calls++; return null; } }));
    const first = m.tree();
    assert.equal(checkbox(first).props.disabled, true, JSON.stringify(patch));
    assert.equal(button(first).props.disabled, true);
    assert.ok(alerts(first).some(text => text.includes('גרסת הכרטיס חסרה')));
    checkbox(first).props.onChange({ target: { checked: true } }); // forced through anyway
    button(m.render()).props.onClick();
    await settle();
    assert.equal(calls, 0, JSON.stringify(patch));
  }
  let calls = 0;
  const busy = mount(props({ disabled: true, onConfirm: async () => { calls++; return null; } }));
  checkbox(busy.tree()).props.onChange({ target: { checked: true } });
  const rendered = busy.render();
  assert.equal(button(rendered).props.disabled, true);
  button(rendered).props.onClick();
  await settle();
  assert.equal(calls, 0);
});
