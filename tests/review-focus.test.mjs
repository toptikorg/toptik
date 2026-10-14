import test from 'node:test';
import assert from 'node:assert/strict';
import { mountReviewWidget } from '../src/components/reviews/review-widget.mjs';

// Minimal DOM models the browser rule: hidden elements cannot receive focus.
function environment({ delayedScrollLayout = false } = {}) {
  const nodes = [], frames = new Map();
  let sequence = 0, settled = true;
  const doc = { activeElement: null };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.hidden = false; this.isConnected = true; this.listeners = {}; this.style = { getPropertyValue: () => '', getPropertyPriority: () => '', removeProperty() {}, setProperty() {} }; nodes.push(this); }
    append(...els) { this.children.push(...els); }
    prepend(el) { this.children.unshift(el); }
    setAttribute() {}
    removeAttribute() {}
    contains(el) { return this === el || this.children.some(c => c.contains(el)); }
    getClientRects() { return this.hidden || !this.isConnected ? [] : [{}]; }
    getBoundingClientRect() { return { left: 0, right: 1, top: 0, bottom: 1 }; }
    focus() { if (this.getClientRects().length) doc.activeElement = this; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    showModal() { this.open = true; }
    close() { this.open = false; doc.activeElement = doc.body; this.listeners.close?.(); }
    click() { this.onclick?.({ currentTarget: this }); }
    remove() { this.isConnected = false; }
  }
  const win = {
    HTMLDialogElement: Element, scrollX: 0, scrollY: 250,
    getComputedStyle: () => ({ visibility: 'visible' }),
    requestAnimationFrame: cb => { frames.set(++sequence, cb); return sequence; },
    cancelAnimationFrame: id => frames.delete(id), scrollTo() { settled = !delayedScrollLayout; },
    addEventListener() {}, removeEventListener() {}, location: { pathname: '/' },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  Object.assign(doc, { defaultView: win, body: new Element('body'), createElement: tag => new Element(tag), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
  const purchase = new Element('button');
  doc.querySelectorAll = selector => selector === 'a,button,input,select,textarea' && !settled ? [purchase] : [];
  const host = new Element('div'); host.ownerDocument = doc;
  const branches = ['gan', 'ramat', 'weiz'].map(id => ({ id, name: id, address: id, verified: true, reviewUrl: `https://g.page/r/${id}/review`, qrPath: `/reviews/${id}.svg` }));
  const cleanup = mountReviewWidget(host, branches);
  return { doc, cleanup, find: cls => nodes.find(n => n.className === cls), flush: () => { settled = true; const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb()); } };
}

for (const opener of ['tt-review-fab', 'tt-review-header']) {
  for (const route of ['close button', 'native close', 'backdrop']) {
    test(`${opener} restores focus after ${route}, including repeated opening`, () => {
      const env = environment();
      for (let i = 0; i < 2; i++) {
        const trigger = env.find(opener), dialog = env.find('tt-review-dialog');
        trigger.click(); env.flush();
        assert.equal(env.find('tt-review-fab').hidden, true);
        if (route === 'close button') env.find('tt-review-close').click();
        else if (route === 'backdrop') dialog.listeners.click({ target: dialog });
        else dialog.close();
        env.flush();
        assert.equal(trigger.hidden, false);
        assert.equal(env.doc.activeElement, trigger);
        env.flush(); assert.equal(env.doc.activeElement, trigger);
      }
      env.cleanup();
    });
  }
}

test('removed opener falls back to header, unmount does not focus removed controls', () => {
  const env = environment();
  env.find('tt-review-fab').click(); env.flush(); env.find('tt-review-fab').remove();
  env.find('tt-review-dialog').close(); env.flush();
  assert.equal(env.doc.activeElement, env.find('tt-review-header'));
  env.find('tt-review-header').click(); env.flush(); env.cleanup();
  assert.equal(env.doc.activeElement, env.doc.body);
});

test('scroll restoration settles before collision checks choose the focus target', () => {
  const env = environment({ delayedScrollLayout: true });
  env.find('tt-review-fab').click(); env.flush();
  env.find('tt-review-dialog').close(); env.flush();
  assert.equal(env.doc.activeElement, env.find('tt-review-fab'));
  env.cleanup();
});

test('pending focus restoration cannot steal focus from a reopened dialog', () => {
  const env = environment();
  env.find('tt-review-fab').click(); env.flush();
  env.find('tt-review-dialog').close();
  env.find('tt-review-header').click(); env.flush();
  assert.equal(env.doc.activeElement, env.find('tt-review-close'));
  env.cleanup();
});
