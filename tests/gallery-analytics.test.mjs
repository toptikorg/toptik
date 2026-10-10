import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/components/GalleryAnalytics.tsx', import.meta.url), 'utf8');
const helpers = stripTypeScriptTypes(source.slice(source.indexOf('const ID'), source.indexOf('export function GalleryAnalytics')));
function harness(host = 'landing.toptik.co.il') {
  const scripts = [];
  const context = vm.createContext({ window: { location: { hostname: host } }, document: { referrer: 'https://www.google.com/search?q=private', createElement: () => ({}), head: { appendChild: s => scripts.push(s) } }, URL, Date });
  vm.runInContext(helpers, context);
  return { context, scripts, run: code => vm.runInContext(code, context) };
}
test('only public gallery routes are eligible', () => {
  const h = harness();
  for (const p of ['/', '/carousel', '/journal/example']) assert.equal(h.run(`permitted('${p}')`), true);
  for (const p of ['/admin', '/admin/products', '/login', '/auth/callback', '/api/products', '/settings']) assert.equal(h.run(`permitted('${p}')`), false);
  assert.equal(harness('admin.toptik.co.il').run("permitted('/')"), false);
  assert.equal(harness('preview.vercel.app').run("permitted('/')"), false);
});
test('tag initializes once, pageviews are explicit and advertising stays denied', () => {
  const h = harness();
  h.run("startMeasurement('/'); startMeasurement('/journal');");
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].async, true);
  const events = h.run('window.dataLayer').map(a => Array.from(a));
  assert.equal(events.find(e => e[0] === 'config')[2].send_page_view, false);
  assert.equal(events[0][2].ad_storage, 'denied');
  assert.equal(events.filter(e => e[0] === 'event').length, 2);
  assert.equal(events.at(-1)[2].page_referrer, 'https://www.google.com');
  assert.equal(events.at(-1)[2].page_location, 'https://landing.toptik.co.il/journal');
});
test('consent gates startup and withdrawal disables Google collection', () => {
  assert.match(source, /if \(choice === "granted"\) startMeasurement\(path\)/);
  assert.match(source, /\["ga-disable-G-LHWB69CV2M"\] = true/);
  assert.match(source, /ללא מדידה/);
  assert.match(source, /העדפות מדידה/);
});
