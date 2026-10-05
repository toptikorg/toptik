import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('live gallery stays uncached without overriding explicit classification caching', async () => {
  const route = await readFile(new URL('../src/app/api/carousel/route.ts', import.meta.url), 'utf8');
  const classification = await readFile(new URL('../src/lib/carousel/store-classification.ts', import.meta.url), 'utf8');
  assert.match(route, /export const revalidate = 0;/);
  assert.doesNotMatch(route, /export const dynamic\s*=/);
  assert.match(route, /"Cache-Control": "no-store, max-age=0, must-revalidate"/);
  assert.match(classification, /next: \{ revalidate: 300 \}/);
});
