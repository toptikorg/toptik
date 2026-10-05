import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../src/lib/carousel/public-payload.ts', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export async function getPublicCarouselPayload'))
  .replace('export async function', 'async function')
  .replace('import("@/lib/shopify/typed-spec-public")', 'Promise.resolve({ readPublicTypedSpecOverlay })');
const compiled = stripTypeScriptTypes(`export function reader(deps) {
  const { getCarouselPayload, readStoreClassification, readPublicTypedSpecOverlay } = deps;
  const process = { env: { VERCEL_ENV: 'production', SHOPIFY_TYPED_SPEC_SYNC: 'enabled_v1' } };
  const isUnavailableCarouselPayload = payload => payload.unavailable;
  const appendSamsoniteItems = items => items;
  const applyStoreClassification = items => items;
  ${body}
  return getPublicCarouselPayload;
}`);
const { reader } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('typed projection starts before catalog resolves and is applied only to active catalog items', async () => {
  let release;
  const catalog = new Promise(resolve => { release = resolve; });
  let started = false;
  const timings = [];
  const get = reader({ getCarouselPayload: () => catalog, readStoreClassification: async () => null,
    readPublicTypedSpecOverlay: async () => { started = true; return items => items.map(item => ({ ...item, projected: true })); } });
  const pending = get((name, ms) => timings.push({name, ms}));
  await Promise.resolve();
  assert.equal(started, true);
  release({items:[{id:'active',isActive:true},{id:'hidden',isActive:false}],settings:{}});
  const result = await pending;
  assert.deepEqual(result.items, [{id:'active',isActive:true,projected:true}]);
  assert.deepEqual(timings.map(t => t.name).sort(), ['catalog','classification','specs']);
  assert.ok(timings.every(t => t.ms >= 0));
});
