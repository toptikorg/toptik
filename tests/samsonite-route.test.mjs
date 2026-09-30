import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = await readFile(new URL('../src/app/api/carousel/route.ts', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export async function GET')).replace(/^export /gm, '');
const code = stripTypeScriptTypes(`export function makeGet(deps) {
  const { getPublicCarouselPayload } = deps;
  const NextResponse = { json: (body, options) => ({ body, options }) };
  ${body}
  return GET;
}`);
const { makeGet } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('public carousel route returns the shared active catalog and never masks a source outage', async () => {
  const publicItem = { id: 'active', isActive: true };
  let calls = 0;
  const deps = {
    getPublicCarouselPayload: async () => {
      calls++;
      return { items: [publicItem], settings: {} };
    },
  };
  const result = await makeGet(deps)();
  assert.deepEqual(result.body.items, [publicItem]);
  assert.equal(result.options.headers['Cache-Control'], 'no-store, max-age=0, must-revalidate');
  const unavailable = { unavailable: true, items: [], settings: {} };
  assert.equal((await makeGet({ getPublicCarouselPayload: async () => unavailable })()).body, unavailable);
  assert.equal(calls, 1);
});
