import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { checkProductionVersion } from '../scripts/production-version-smoke.mjs';

const current = 'a'.repeat(40);
const old = 'b'.repeat(40);
const master = (sha) => Response.json({ object: { sha } });
const production = (sha) => Response.json({ commit: sha });
const sequence = (values, urls = []) => async (url, options) => {
  urls.push(url);
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.equal(new Headers(options.headers).has('authorization'), false);
  const next = values.shift();
  if (next instanceof Error) throw next;
  return next;
};

test('equal versions pass for all three aliases without Shopify requests', async () => {
  const urls = [];
  assert.deepEqual(await checkProductionVersion(sequence([master(current), production(current), production(current), production(current)], urls)), { master: current, production: { landing: current, admin: current, site: current } });
  assert.equal(urls.length, 4);
  assert.ok(urls.every(url => !url.includes('www.toptik.co.il')));
});
test('stale production fails after confirming unchanged master', async () => {
  await assert.rejects(checkProductionVersion(sequence([master(current), production(current), production(old), production(current), master(current)])), /PRODUCTION_COMMIT_MISMATCH/);
});
test('master changing during inspection is inconclusive, not a stale deployment claim', async () => {
  await assert.rejects(checkProductionVersion(sequence([master(current), production(old), production(old), production(old), master(old)])), /MASTER_CHANGED_DURING_CHECK/);
});
test('missing version endpoint or GitHub failure cannot pass', async () => {
  await assert.rejects(checkProductionVersion(sequence([master(current), new Response(null,{status:404})])), /PRODUCTION_LANDING_HTTP_404/);
  await assert.rejects(checkProductionVersion(sequence([new Error('network')])), /MASTER_UNAVAILABLE/);
});
test('malformed version and malformed source fail closed', async () => {
  await assert.rejects(checkProductionVersion(sequence([master(current), production('unknown')])), /PRODUCTION_LANDING_INVALID_COMMIT/);
  await assert.rejects(checkProductionVersion(sequence([master('bad')])), /MASTER_INVALID_COMMIT/);
});

test('version route exposes only an exact public SHA and is never cached', async () => {
  const ts = createRequire(import.meta.url)('typescript');
  const code = ts.transpileModule(readFileSync('src/app/api/build-version/route.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const { GET } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const before = process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    process.env.VERCEL_GIT_COMMIT_SHA = current;
    const ok = GET();
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await ok.json(), { commit: current });
    process.env.VERCEL_GIT_COMMIT_SHA = 'missing';
    const unknown = GET();
    assert.equal(unknown.status, 503);
    assert.match(unknown.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await unknown.json(), { error: 'BUILD_COMMIT_UNAVAILABLE' });
  } finally {
    if (before === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = before;
  }
});
