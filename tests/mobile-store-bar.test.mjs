import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(fs.readFileSync('src/components/commerce/mobile-store-bar.ts', 'utf8')).replace('export function', 'function');
function fixture({ bottom = 500, mobile = true, intro = false, href = 'https://www.toptik.co.il/products/test?variant=42&utm_source=gallery' } = {}) {
  const listeners = new Map();
  const events = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const body = { children: [], appendChild(el) { this.children.push(el); el.parentElement = this; } };
  const create = () => ({ dataset: {}, attrs: {}, children: [], textContent: '', hidden: false, href: '',
    setAttribute(k, v) { this.attrs[k] = v; }, append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); node.parentElement = this; },
    getBoundingClientRect: () => ({ top: 252, bottom: 300, height: 48 }),
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(el => el !== this); } });
  const anchor = { href, dataset: { productName: 'Verified product' }, getBoundingClientRect: () => ({ top: bottom - 48, bottom, height: 48, left: 0, right: 375 }), closest: () => null };
  const introHost = intro ? create() : null;
  const root = { querySelectorAll: () => [anchor], querySelector: () => introHost };
  const media = { matches: mobile, ...events };
  let observer;
  let mutation;
  function Observer(fn, options) { observer = { fn, options, observe(target) { this.target = target; }, disconnect() { this.target = null; } }; return observer; }
  function Mutation(fn) { mutation = { fn, observe() {}, disconnect() { this.closed = true; } }; return mutation; }
  const context = vm.createContext({ document: { body, createElement: create, ...events }, window: { scrollY: 0, innerWidth: 375, matchMedia: () => media, ...events },
    IntersectionObserver: Observer, MutationObserver: Mutation, getComputedStyle: () => ({ visibility: 'visible' }), URL });
  vm.runInContext(source + '\nthis.mount = mountMobileStoreBar;', context);
  const cleanup = context.mount(root, 'bar');
  return { body, anchor, introHost, media, listeners, observer, mutation, cleanup, setBottom(value) { bottom = value; },
    intersect(value, position) { bottom = position; observer.fn([{ target: anchor, isIntersecting: value, boundingClientRect: { bottom }, rootBounds: { top: 0 } }]); } };
}
test('initial visible source hides bar and preserves exact product/variant/tracking link', () => {
  const f = fixture(); const bar = f.body.children[0];
  assert.equal(bar.hidden, true); assert.equal(bar.parentElement, f.body);
  assert.equal(bar.children[0].textContent, 'Verified product'); assert.equal(bar.children[1].href, f.anchor.href); f.cleanup();
});
test('fast jump past source shows bar and reentry hides it', () => {
  const f = fixture(); const bar = f.body.children[0];
  assert.match(f.observer.options.rootMargin, /100000px/);
  f.intersect(false, -200); assert.equal(bar.hidden, false);
  f.intersect(true, 400); assert.equal(bar.hidden, true); f.cleanup();
});
test('restored scroll initializes correctly and pageshow resynchronizes', () => {
  const f = fixture({ bottom: -50 }); const bar = f.body.children[0]; assert.equal(bar.hidden, false);
  f.setBottom(300); f.listeners.get('pageshow')(); assert.equal(bar.hidden, true);
  assert.ok(f.listeners.has('DOMContentLoaded')); assert.ok(f.listeners.has('load')); f.cleanup();
});
test('desktop remains hidden after source passes and breakpoint changes resync', () => {
  const f = fixture({ mobile: false, bottom: -200 }); const bar = f.body.children[0]; assert.equal(bar.hidden, true);
  f.media.matches = true; f.listeners.get('change')(); assert.equal(bar.hidden, false); f.cleanup();
});
test('deep article source gains first-screen mobile link with exact destination and original retained', () => {
  const f = fixture({ bottom: 2500, intro: true }); const promoted = f.introHost.children[0];
  assert.equal(promoted.href, f.anchor.href); assert.equal(f.observer.target, promoted);
  assert.equal(f.body.children[0].hidden, true);
  f.observer.fn([{ target: promoted, isIntersecting: false, boundingClientRect: { bottom: -10 }, rootBounds: { top: 0 } }]);
  assert.equal(f.body.children[0].hidden, false); assert.equal(f.anchor.href, promoted.href);
  f.cleanup(); assert.equal(f.introHost.children.length, 0);
});
test('external and non-product destinations never produce an actionable bar', () => {
  for (const href of ['https://evil.test/products/test', 'https://www.toptik.co.il/collections/all', 'javascript:alert(1)']) {
    const f = fixture({ href, bottom: -100 }); assert.equal(f.body.children[0].hidden, true); assert.ok(!f.observer.target); f.cleanup();
  }
});
test('catalog source changes update destination without duplicate bars; unmount cleans observers/listeners', () => {
  const f = fixture({ bottom: -100 }); f.anchor.href = 'https://www.toptik.co.il/products/next?variant=8';
  f.anchor.dataset.productName = 'Next verified product'; f.mutation.fn();
  assert.equal(f.body.children.length, 1); assert.equal(f.body.children[0].children[1].href, f.anchor.href);
  assert.equal(f.body.children[0].children[0].textContent, 'Next verified product');
  f.cleanup(); assert.equal(f.body.children.length, 0); assert.equal(f.observer.target, null); assert.equal(f.mutation.closed, true); assert.equal(f.listeners.size, 0);
});
