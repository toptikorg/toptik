import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = await readFile(new URL('../src/app/api/carousel/route.ts', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export async function GET')).replace(/^export /gm, '');
const code = stripTypeScriptTypes(`export function makeGet(deps) {
  const { getCarouselPayload, appendSamsoniteItems, isUnavailableCarouselPayload } = deps;
  const appendPreviewPackageItems = deps.appendPreviewPackageItems ?? (items => items);
  const NextResponse = { json: (body, options) => ({ body, options }) };
  ${body}
  return GET;
}`);
const { makeGet } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('public supplement respects inactive records and never masks a source outage', async () => {
  const inactive = { id: 'hidden', isActive: false };
  let calls = 0;
  const deps = {
    getCarouselPayload: async options => {
      assert.deepEqual(options, { includeInactive: true });
      return { items: [inactive], settings: {} };
    },
    appendSamsoniteItems: items => {
      calls++;
      assert.deepEqual(items, [inactive]);
      return [...items, { id: 'new', isActive: true }];
    },
    isUnavailableCarouselPayload: payload => payload.unavailable === true,
  };
  const result = await makeGet(deps)();
  assert.deepEqual(result.body.items, [{ id: 'new', isActive: true }]);
  assert.equal(result.options.headers['Cache-Control'], 'no-store, max-age=0, must-revalidate');
  const unavailable = { unavailable: true, items: [], settings: {} };
  assert.equal((await makeGet({ ...deps, getCarouselPayload: async () => unavailable })()).body, unavailable);
  assert.equal(calls, 1);
});
