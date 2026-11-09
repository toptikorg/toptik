import { pathToFileURL } from 'node:url';

const SOURCE = 'https://api.github.com/repos/toptikorg/toptik/git/ref/heads/master';
const LIVE = ['landing', 'admin', 'site'].map(host => `https://${host}.toptik.co.il/api/build-version`);
const SHA = /^[a-f0-9]{40}$/i;

async function readJson(fetchImpl, url, label) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { 'user-agent': 'TopTik-Version-Monitor/1.0', 'cache-control': 'no-cache' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error(`${label}_UNAVAILABLE`); }
  if (!response.ok) throw new Error(`${label}_HTTP_${response.status}`);
  try { return await response.json(); } catch { throw new Error(`${label}_INVALID_RESPONSE`); }
}

export async function checkProductionVersion(fetchImpl = fetch) {
  const source = await readJson(fetchImpl, SOURCE, 'MASTER');
  const expected = source?.object?.sha;
  if (typeof expected !== 'string' || !SHA.test(expected)) throw new Error('MASTER_INVALID_COMMIT');
  const versions = {};
  for (const url of LIVE) {
    const label = new URL(url).hostname.split('.')[0].toUpperCase();
    const site = await readJson(fetchImpl, url, `PRODUCTION_${label}`);
    const actual = site?.commit;
    if (typeof actual !== 'string' || !SHA.test(actual)) throw new Error(`PRODUCTION_${label}_INVALID_COMMIT`);
    versions[label.toLowerCase()] = actual.toLowerCase();
  }
  if (Object.values(versions).some(actual => expected.toLowerCase() !== actual)) {
    const reread = await readJson(fetchImpl, SOURCE, 'MASTER_RECHECK');
    const current = reread?.object?.sha;
    if (typeof current !== 'string' || !SHA.test(current)) throw new Error('MASTER_RECHECK_INVALID_COMMIT');
    if (current.toLowerCase() !== expected.toLowerCase()) throw new Error('MASTER_CHANGED_DURING_CHECK');
    throw new Error(`PRODUCTION_COMMIT_MISMATCH master=${expected.toLowerCase()} production=${JSON.stringify(versions)}`);
  }
  return { master: expected.toLowerCase(), production: versions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(`Production version matches: ${JSON.stringify(await checkProductionVersion())}`); }
  catch (error) { console.error(`Production version check failed: ${error instanceof Error ? error.message : 'UNKNOWN'}`); process.exitCode = 1; }
}
