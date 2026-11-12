// Time-budget errors raised by the shared Shopify transport under a MEDIA read or mutation must carry a
// media code. The shared `graphql()` reports an exhausted absolute deadline as the typed-specification
// lane's `SPEC_TIME_BUDGET`; the media work queue records anything outside /^MEDIA_/ as the undiagnosable
// MEDIA_WORK_FAILED, and the liveness monitor then shows FAILED_REQUIRES_HUMAN for a transient condition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
import { descriptionModuleUrl } from './helpers/description-module.mjs';
import { mod, stripped, id } from './helpers/media-planning-fixture.mjs';

const moduleUrl = s => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(resolveImageLimits(s))).toString('base64')}`;
const source = name => readFileSync(new URL(`../src/lib/shopify/${name}.ts`, import.meta.url), 'utf8');
const coreUrl = moduleUrl(source('media-sync-core'));
const readAdapterUrl = moduleUrl(source('media-read-adapter').replaceAll('from "./media-sync-core";', `from "${coreUrl}";`));
const readUrl = moduleUrl(source('media-transport-read').replaceAll('from "./media-sync-core";', `from "${coreUrl}";`));
const requestsUrl = moduleUrl(source('media-transport-requests').replaceAll('from "./media-transport-read";', `from "${readUrl}";`));

async function loadAdminApi(getToken) {
  const key = `mediaToken_${Math.random().toString(36).slice(2)}`; globalThis[key] = getToken;
  const provider = moduleUrl(`export const createShopifyClientCredentialsProvider=()=>()=>globalThis[${JSON.stringify(key)}]();`);
  const raw = source('admin-api').replace('import "server-only";', '')
    .replace('"./client-credentials"', JSON.stringify(provider))
    .replace('"./description-document"', JSON.stringify(descriptionModuleUrl))
    .replace('import("./media-read-adapter")', `import(${JSON.stringify(readAdapterUrl)})`);
  return import(moduleUrl(raw));
}
const ENV = { SHOPIFY_SHOP_DOMAIN: 'toptikcoil.myshopify.com', SHOPIFY_CLIENT_ID: 'test-id', SHOPIFY_CLIENT_SECRET: 'test-secret',
  SHOPIFY_ONLINE_STORE_PUBLICATION_ID: 'gid://shopify/Publication/79538258170', SHOPIFY_API_VERSION: '2026-07' };
function env(t) {
  const old = {}; for (const [k, v] of Object.entries(ENV)) { old[k] = process.env[k]; process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
}
const identity = { productId: 'gid://shopify/Product/7550812619002', variantId: 'gid://shopify/ProductVariant/42465754808570',
  itemId: '6f887176-e70a-44ba-b252-238f994b66ad', exactGallerySku: 'P10SZV24-05J-TU', exactShopifySku: 'P10SZV2405J', productHandle: 'logoduck-i-trolley' };

test('media read: an already-expired deadline fails with the media time-budget code before any token exchange or request', async t => {
  env(t); const now = 1000; let tokenCalls = 0, fetches = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('Must not fetch'); });
  const api = await loadAdminApi(async () => { tokenCalls++; return 'test-token'; });
  await assert.rejects(api.fetchShopifyMediaRead(identity, 8000, now - 1), { message: 'MEDIA_TIME_BUDGET' });
  assert.equal(tokenCalls, 0); assert.equal(fetches, 0);
});

test('media read: a token exchange that overruns the media deadline fails with the media time-budget code and sends nothing', async t => {
  env(t); const now = 1000; let fetches = 0, resolveToken;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('Must not fetch'); });
  const api = await loadAdminApi(() => new Promise(resolve => { resolveToken = resolve; }));
  await assert.rejects(api.fetchShopifyMediaRead(identity, 8000, now + 20), { message: 'MEDIA_TIME_BUDGET' });
  assert.equal(typeof resolveToken, 'function', 'the token exchange started before the deadline, so the wait itself timed out');
  resolveToken('test-token'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 0);
});

test('media read: every other transport error passes through unchanged', async t => {
  env(t); const now = 1000; t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const api = await loadAdminApi(async () => 'test-token');
  await assert.rejects(api.fetchShopifyMediaRead(identity, 8000, now + 8000), { message: 'SHOPIFY_API_HTTP_503' });
});

test('the typed-specification lane keeps its own SPEC_TIME_BUDGET code', async t => {
  env(t); const now = 1000; t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch'); });
  const api = await loadAdminApi(async () => 'test-token');
  await assert.rejects(api.shopifyAdminGraphql('mutation guarded', {}, 8000, now - 1), { message: 'SPEC_TIME_BUDGET' });
});

const transportBody = stripTypeScriptTypes(resolveImageLimits(source('media-shopify-transport'))).replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const { makeAdapter } = await import(moduleUrl(`
  import {buildMediaReadRequest,parseMediaReadResponse,MEDIA_API_VERSION,MEDIA_PUBLICATION_ID} from '${readAdapterUrl}';
  import {assertMediaTransportRead,parseMediaTransportResponse,parseTransportMedia,onlyForwardProductTimestampDrift,PRODUCT_TIMESTAMP_TOLERANT_PHASES} from '${readUrl}';
  import {buildOwnedMediaCreate,buildOwnedMediaAssociate,buildMediaVariantReassign,buildMediaReferenceDetach,
    buildMediaReorder,buildOwnedMediaRecoveryRead,buildOwnedMediaNodeRead,ownedMediaFilename,
    parseOwnedMediaRecovery,parseMediaTransportAcknowledgement} from '${requestsUrl}';
  export function makeAdapter(deps) {
    const {shopifyAdminGraphql,verifyOnboardingImage,process,Date}=deps;
    ${transportBody}
    return {readReadyShopifyMedia,readShopifyMediaTransport};
  }
`));
const transportEnv = { SHOPIFY_SHOP_DOMAIN: 'toptikcoil.myshopify.com', SHOPIFY_ONLINE_STORE_PUBLICATION_ID: 'gid://shopify/Publication/79538258170', SHOPIFY_API_VERSION: '2026-07' };

test('media transport reads: a shared-transport time budget surfaces as MEDIA_TIME_BUDGET, other errors unchanged', async () => {
  const failing = code => makeAdapter({ shopifyAdminGraphql: async () => { throw new Error(code); }, verifyOnboardingImage: async () => { throw new Error('unused'); }, process: { env: transportEnv }, Date });
  const budget = failing('SPEC_TIME_BUDGET');
  await assert.rejects(budget.readShopifyMediaTransport(identity, Date.now() + 8000), { message: 'MEDIA_TIME_BUDGET' });
  await assert.rejects(budget.readReadyShopifyMedia(identity, Date.now() + 8000), { message: 'MEDIA_TIME_BUDGET' });
  await assert.rejects(failing('SHOPIFY_GRAPHQL_THROTTLED').readShopifyMediaTransport(identity, Date.now() + 8000), { message: 'SHOPIFY_GRAPHQL_THROTTLED' });
});

// Why the boundary matters: the queue and the liveness monitor only understand MEDIA_ codes.
const { make } = await import(mod(`import{randomUUID}from'node:crypto';export function make(deps){const{process,createSupabaseServiceRoleClient,reconcilePersistedMediaProduct}=deps;const bootstrapProductionMedia=async(...a)=>deps.bootstrap(...a);${stripped('media-work-queue').replace(/^export /gm, '')}return{drainMediaWork};}`));
function queueFixture(error) {
  const calls = [], env = { VERCEL_ENV: 'production', SHOPIFY_MEDIA_SYNC: 'enabled_v1' };
  const db = { rpc(name, args) { calls.push({ name, args }); return { abortSignal() { return Promise.resolve({ data: name.startsWith('claim_toptik_media_work')
    ? { productId: id.productId, claimId: args.p_claim_id, generation: 1, initialized: true, evidence: {} } : name.startsWith('toptik_media_work_pending') ? false : true, error: null }); } }; } };
  const api = make({ process: { env }, createSupabaseServiceRoleClient: () => db, reconcilePersistedMediaProduct: async () => { throw error; } });
  return { calls, db, api };
}
test('queue: a media time budget is recorded as itself; a leaked SPEC_TIME_BUDGET collapses to MEDIA_WORK_FAILED', async t => {
  t.mock.method(console, 'error', () => {});
  for (const [thrown, recorded] of [['MEDIA_TIME_BUDGET', 'MEDIA_TIME_BUDGET'], ['SPEC_TIME_BUDGET', 'MEDIA_WORK_FAILED']]) {
    const f = queueFixture(new Error(thrown));
    await f.api.drainMediaWork(Date.now() + 30000, f.db);
    const finish = f.calls.find(c => c.name === 'finish_toptik_media_work').args;
    assert.equal(finish.p_status, 'failed'); assert.equal(finish.p_error, recorded);
  }
});

const liveness = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source('media-liveness'))).toString('base64')}`);
test('liveness: a media time budget on a failed row is a scheduler cooldown; MEDIA_WORK_FAILED asks for a person', () => {
  const NOW = Date.parse('2026-11-11T09:00:00Z'), iso = ms => new Date(ms).toISOString();
  const row = code => ({ productGid: 'gid://shopify/Product/1', sku: 'SKU-1', status: 'failed', code, updatedAt: iso(NOW - 60000), attempts: 3, generation: 7,
    claimId: null, claimedAt: null, claimStaleAfter: null, inflightKeeps: 0, routine: false, retryDueAt: iso(NOW + 9 * 60000),
    episode: null, episodeProgress: null, lastCompleted: null, lastObservedAt: iso(NOW - 60000) });
  const pick = v => [v.state, v.rule];
  assert.deepEqual(pick(liveness.assessLiveness(row('MEDIA_TIME_BUDGET'), NOW)), ['waiting', 'FAILED_COOLDOWN']);
  assert.deepEqual(pick(liveness.assessLiveness(row('MEDIA_WORK_FAILED'), NOW)), ['blocked', 'FAILED_REQUIRES_HUMAN']);
});
