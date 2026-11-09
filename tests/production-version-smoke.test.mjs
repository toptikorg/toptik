import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { checkProductionVersion } from '../scripts/production-version-smoke.mjs';

const current = 'a'.repeat(40);
const old = 'b'.repeat(40);
const master = (sha) => Response.json({ object: { sha } });
const production = (sha) => Response.json({ commit: sha });
const siteRedirect = (location = 'https://landing.toptik.co.il/api/build-version', status = 308) => new Response(null, {status, headers: {location}});
const sequence = (values, urls = []) => async (url, options) => {
  urls.push(url);
  assert.equal(options.redirect, url.startsWith('https://site.toptik.co.il/') ? 'manual' : 'error');
  assert.equal(options.cache, 'no-store');
  assert.equal(new Headers(options.headers).has('authorization'), false);
  const next = values.shift();
  if (next instanceof Error) throw next;
  return next;
};

test('equal versions and an exact 308 redirect pass without Shopify requests', async () => {
  const urls = [];
  assert.deepEqual(await checkProductionVersion(sequence([master(current), production(current), production(current), siteRedirect(), master(current)], urls)), { master: current, production: { landing: current, admin: current }, site: 'redirect-to-landing' });
  assert.equal(urls.length, 5);
  assert.ok(urls.every(url => !url.includes('www.toptik.co.il')));
});
test('stale production fails after confirming unchanged master', async () => {
  await assert.rejects(checkProductionVersion(sequence([master(current), production(current), production(old), siteRedirect(), master(current)])), /PRODUCTION_COMMIT_MISMATCH/);
});
test('master changing during inspection is inconclusive, not a stale deployment claim', async () => {
  await assert.rejects(checkProductionVersion(sequence([master(current), production(old), production(old), siteRedirect(), master(old)])), /MASTER_CHANGED_DURING_CHECK/);
});
test('matching versions cannot pass when master moves before final check', async () => {
  await assert.rejects(checkProductionVersion(sequence([master(current), production(current), production(current), siteRedirect(), master(old)])), /MASTER_CHANGED_DURING_CHECK/);
});
test('wrong redirect destination, status, and missing site path fail closed', async () => {
  for (const response of [siteRedirect('https://other.example/api/build-version'), siteRedirect('https://landing.toptik.co.il/other'), siteRedirect('https://landing.toptik.co.il/api/build-version', 301), new Response(null, {status:404})]) {
    await assert.rejects(checkProductionVersion(sequence([master(current), production(current), production(current), response])), /PRODUCTION_SITE_REDIRECT_INVALID/);
  }
});
test('missing version endpoint or GitHub failure cannot pass', async () => {
  await assert.rejects(checkProductionVersion(sequence([master(current), new Response(null,{status:404})])), /PRODUCTION_LANDING_HTTP_404/);
  await assert.rejects(checkProductionVersion(sequence([new Error('network')])), /MASTER_UNAVAILABLE/);
});

test('an existing incident is updated with the current run instead of opening a duplicate', async () => {
  const workflow = readFileSync('.github/workflows/production-visual-monitor.yml', 'utf8').replace(/\r\n/g, '\n');
  const section = workflow.split('      - name: Open or update version incident')[1]?.split('      - name: Close version incident')[0];
  assert.ok(section);
  const script = section.split('          script: |\n')[1].split('\n').map(line => line.startsWith('            ') ? line.slice(12) : '').join('\n');
  const calls = [];
  const api = { issues: {
    listForRepo: async () => ({data:[{title:'[Production monitor] Gallery version mismatch or unavailable', number:41}]}),
    update: async (arg) => calls.push({type:'update',arg}),
    create: async (arg) => calls.push({type:'create',arg}),
  }};
  await new (Object.getPrototypeOf(async function(){}).constructor)('github','context',script)({rest:api}, {serverUrl:'https://github.com', repo:{owner:'toptikorg',repo:'toptik'},runId:123});
  assert.equal(calls.length,1);
  assert.equal(calls[0].type,'update');
  assert.equal(calls[0].arg.issue_number,41);
  assert.match(calls[0].arg.body, /actions\/runs\/123/);
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
