import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const moduleFrom = (source) => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const fallbackSource = await read('src/lib/carousel/fallback-data.ts');
const { fallbackCarouselPayload, isUnavailableCarouselPayload, CAROUSEL_UNAVAILABLE_MESSAGE } = await moduleFrom(fallbackSource);
// Public read (repository.ts) and admin save (repository-admin.ts) are separate
// modules so public routes cannot reach the service-role client.
const repository = await read('src/lib/carousel/repository.ts');
const repositoryAdmin = await read('src/lib/carousel/repository-admin.ts');
const readStart = repository.indexOf('export async function getCarouselPayload');
const saveStart = repositoryAdmin.indexOf('export async function saveCarouselPayload');
assert.ok(readStart > 0 && saveStart > 0);
assert.ok(!repository.includes('saveCarouselPayload'), 'save path must not live in the public read module');
const { makeReader, makeSaver } = await moduleFrom(`
  export function makeReader(deps) {
    const { hasSupabasePublicEnv, createSupabaseServerClient, fallbackCarouselPayload, applyReviewedCopy } = deps;
    ${repository.slice(readStart).replace(/^export /gm, '')}
    return getCarouselPayload;
  }
  export function makeSaver(deps) {
    const { isUnavailableCarouselPayload, adminCarouselPayloadSchema, createSupabaseServiceRoleClient, applyReviewedCopy } = deps;
    ${repositoryAdmin.slice(saveStart).replace(/^export /gm, '')}
    return saveCarouselPayload;
  }
`);

test('unavailable fallback contains no invented products, images, angles or IDs', () => {
  assert.deepEqual(fallbackCarouselPayload.items, []);
  assert.equal(fallbackCarouselPayload.unavailable, true);
  assert.deepEqual(fallbackCarouselPayload.settings, { autoplayMs: 3500, transitionMode: 'shatter-particle' });
  assert.doesNotMatch(fallbackSource, /דגם \$|hero-web-airport|fallbackUuid|Array\.from/);
  assert.match(CAROUSEL_UNAVAILABLE_MESSAGE, /אינה זמינה כרגע/);
});

test('failure marker survives JSON but a valid empty result is not a failure', () => {
  assert.equal(isUnavailableCarouselPayload(JSON.parse(JSON.stringify(fallbackCarouselPayload))), true);
  for (const payload of [null, undefined, [], {}, { items: [] }, { unavailable: false }, { unavailable: 'true' }]) {
    assert.equal(isUnavailableCarouselPayload(payload), false);
  }
});

function readClient(itemsResult) {
  return { from(table) {
    const result = table === 'carousel_settings'
      ? { data: { autoplay_ms: 4500, transition_mode: 'curtain-fade' }, error: null }
      : itemsResult;
    const chain = {
      select() { return chain; }, order() { return chain; }, eq() { return chain; },
      maybeSingle() { return Promise.resolve(result); },
      then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
    };
    return chain;
  } };
}

test('missing DB and failed reads return flagged empty data; confirmed empty DB stays legitimate', async () => {
  const missing = makeReader({ hasSupabasePublicEnv: () => false, fallbackCarouselPayload,
    createSupabaseServerClient: () => { throw new Error('must not connect'); } });
  assert.equal(await missing(), fallbackCarouselPayload);
  for (const response of [{ data: null, error: new Error('offline') }, { data: null, error: null }]) {
    const get = makeReader({ hasSupabasePublicEnv: () => true, fallbackCarouselPayload,
      createSupabaseServerClient: () => readClient(response) });
    assert.equal(await get(), fallbackCarouselPayload);
  }
  const getEmpty = makeReader({ hasSupabasePublicEnv: () => true, fallbackCarouselPayload,
    createSupabaseServerClient: () => readClient({ data: [], error: null }) });
  assert.deepEqual(await getEmpty(), { items: [], settings: { autoplayMs: 4500, transitionMode: 'curtain-fade' } });
});

test('server refuses unavailable saves before parsing, client creation, or any DB calls', async () => {
  let parses = 0;
  let connections = 0;
  const save = makeSaver({ isUnavailableCarouselPayload,
    adminCarouselPayloadSchema: { parse() { parses += 1; throw new Error('must not parse'); } },
    createSupabaseServiceRoleClient() { connections += 1; throw new Error('must not write'); },
  });
  await assert.rejects(save(JSON.parse(JSON.stringify(fallbackCarouselPayload))), /Cannot save an unavailable catalog/);
  // Editing the empty placeholder in the admin must not erase the failure marker.
  await assert.rejects(save({ ...fallbackCarouselPayload, items: [{ title: 'Manual draft' }] }), /Cannot save an unavailable catalog/);
  assert.equal(parses, 0);
  assert.equal(connections, 0);
  await assert.rejects(save({ items: [], settings: fallbackCarouselPayload.settings }), /must not parse/);
  assert.equal(parses, 1, 'a legitimate manual zero-item catalog still reaches normal validation');
});

test('authorized admin GET returns 503 for unavailable data, not a saveable HTTP 200 catalog', async () => {
  const route = await read('src/app/api/admin/carousel/route.ts');
  const body = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function PUT')).replace(/^export /gm, '');
  const { makeGet } = await moduleFrom(`export function makeGet(deps) {
    const { getCarouselPayload, isUnavailableCarouselPayload, CAROUSEL_UNAVAILABLE_MESSAGE } = deps;
    const visibleAdminCatalog = async value => value; // private-draft filtering is tested separately
    const requireGalleryAdmin = () => null; // authorized request (central token gate)
    const NextResponse = { json: (body, options) => ({ body, status: options?.status ?? 200 }) };
    ${body}
    return GET;
  }`);
  const failed = makeGet({ getCarouselPayload: async () => fallbackCarouselPayload, isUnavailableCarouselPayload, CAROUSEL_UNAVAILABLE_MESSAGE });
  assert.deepEqual(await failed({}), { body: { error: CAROUSEL_UNAVAILABLE_MESSAGE }, status: 503 });
  const empty = { items: [], settings: fallbackCarouselPayload.settings };
  const good = makeGet({ getCarouselPayload: async () => empty, isUnavailableCarouselPayload, CAROUSEL_UNAVAILABLE_MESSAGE });
  assert.deepEqual(await good({}), { body: empty, status: 200 });
});

test('admin initial/failed read cannot unlock the editor or send a replacement catalog', async () => {
  const admin = await read('src/app/admin/page.tsx');
  assert.match(admin, /\[authReady, setAuthReady\] = useState\(false\)/);
  assert.doesNotMatch(admin, /setAuthReady\(Boolean\(savedToken\)\)/);
  const load = admin.slice(admin.indexOf('const loadData = useCallback'), admin.indexOf('function updateItemField'));
  assert.ok(load.indexOf('setAuthReady(false)') < load.indexOf('fetch('));
  assert.ok(load.indexOf('if (isUnavailableCarouselPayload(data))') < load.indexOf('setAuthReady(true)'));
  const persist = admin.slice(admin.indexOf('async function persistPayload'), admin.indexOf('const loadData = useCallback'));
  const { makePersist } = await moduleFrom(`export function makePersist(deps) {
    const { authReady, isUnavailableCarouselPayload, CAROUSEL_UNAVAILABLE_MESSAGE, fetch } = deps;
    const token = 'not-a-real-token';
    const pendingUploadsRef = { current: 0 };
    const catalogGenerationRef = { current: 0 };
    ${persist}
    return persistPayload;
  }`);
  let requests = 0;
  const dependencies = { isUnavailableCarouselPayload, CAROUSEL_UNAVAILABLE_MESSAGE,
    fetch: async () => { requests += 1; return { ok: true }; } };
  await assert.rejects(makePersist({ ...dependencies, authReady: false })({ items: [], settings: fallbackCarouselPayload.settings }), /אינה זמינה/);
  await assert.rejects(makePersist({ ...dependencies, authReady: true })(fallbackCarouselPayload), /אינה זמינה/);
  assert.equal(requests, 0);
});

test('public client distinguishes loading, temporary unavailable, and confirmed empty results', async () => {
  const client = await read('src/app/carousel/CarouselPageClient.tsx');
  assert.match(client, /const galleryUnavailable = isUnavailableCarouselPayload\(payload\)/);
  assert.match(client, /isLoading \?[\s\S]*?: galleryUnavailable \?[\s\S]*?CAROUSEL_UNAVAILABLE_MESSAGE/);
  assert.match(client, /disabled=\{isLoading \|\| galleryUnavailable\}/);
  assert.match(client, /setPayload\(fallbackCarouselPayload\)/);
  assert.match(client, /אין כרגע מוצרים להצגה בגלריה/);
});
