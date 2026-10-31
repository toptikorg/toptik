import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/components/GalleryAnalytics.tsx', import.meta.url), 'utf8');
const helpers = stripTypeScriptTypes(source.slice(source.indexOf('const ID'), source.indexOf('export function GalleryAnalytics')));
function harness(host = 'landing.toptik.co.il') {
  const scripts = [];
  const context = vm.createContext({ window: { location: { hostname: host } }, document: { title: 'כותרת עמוד מדויקת', referrer: 'https://www.google.com/search?q=private', createElement: () => ({}), head: { appendChild: s => scripts.push(s) } }, URL, Date });
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
  h.run("startMeasurement('/', 'denied'); startMeasurement('/journal', 'granted');");
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].async, true);
  const events = h.run('window.dataLayer').map(a => Array.from(a));
  assert.equal(events.find(e => e[0] === 'config')[2].send_page_view, false);
  assert.equal(events.find(e => e[0] === 'config')[2].cookie_domain, 'toptik.co.il');
  assert.equal(events[0][2].analytics_storage, 'denied');
  assert.equal(events[0][2].ad_storage, 'denied');
  assert.equal(events.filter(e => e[0] === 'consent' && e[1] === 'update').at(-1)[2].analytics_storage, 'granted');
  assert.equal(events.filter(e => e[0] === 'event').length, 2);
  assert.equal(events.at(-1)[2].page_referrer, 'https://www.google.com');
  assert.equal(events.at(-1)[2].page_location, 'https://landing.toptik.co.il/journal');
  assert.equal(events.at(-1)[2].page_title, 'כותרת עמוד מדויקת');
});
test('store product clicks are recorded without query strings or variant identifiers', () => {
  assert.match(source, /"event", "select_item"/);
  assert.match(source, /url\.hostname !== "www\.toptik\.co\.il"/);
  assert.match(source, /link_url: `https:\/\/www\.toptik\.co\.il\$\{url\.pathname\}`/);
  assert.match(source, /item_list_name: path\.startsWith\("\/journal"\)/);
  assert.match(source, /document\.addEventListener\("click", onStoreClick, true\)/);
  assert.match(source, /document\.removeEventListener\("click", onStoreClick, true\)/);
});
test('consent mode defaults to cookieless measurement and keeps advertising denied', () => {
  assert.match(source, /startMeasurement\(path, choice === "granted" \? "granted" : "denied"\)/);
  assert.match(source, /analytics_storage: "denied"/);
  assert.doesNotMatch(source, /\["ga-disable-G-LHWB69CV2M"\] = true/);
  assert.match(source, /ללא עוגיות מדידה/);
  assert.match(source, /העדפות מדידה/);
});
