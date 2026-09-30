import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8");
const handlerSource = source.slice(source.indexOf("  async function onTranslateDescription("),
  source.indexOf("  // Dimensions/weight are stored"));
const makeHandler = new Function("payload", "setPayload", "setStatus", "setTranslatingItemId", "fetch",
  "token", "resolveErrorMessage", "translatingItemId",
  `${stripTypeScriptTypes(handlerSource)}\nreturn onTranslateDescription;`);

function harness(items, { respond, translatingItemId = null } = {}) {
  let payload = { items, settings: { autoplayMs: 4500 } };
  const calls = [], statuses = [], translating = [];
  const run = makeHandler(payload, update => { payload = update(payload); }, value => statuses.push(value),
    value => translating.push(value), async (...args) => {
      calls.push(args);
      return respond ? respond() : { ok: true, json: async () => ({ text: "תיאור מתורגם" }) };
    }, "local-test-token", (_error, fallback) => fallback, translatingItemId);
  return { run, calls, statuses, translating, get payload() { return payload; },
    setItems(next) { payload = { ...payload, items: next }; } };
}
const item = (extra = {}) => ({ id: "item-a", title: "Product", description: "English description", ...extra });
function deferredResponse() {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  return { pending, complete: () => complete({ ok: true, json: async () => ({ text: "תיאור מתורגם" }) }) };
}

test("saved rich documents never reach the plain-text translation API or change either representation", async () => {
  for (const html of ['<p>English <a href="https://example.com">link</a></p><table><tr><td>A</td></tr></table>',
    "<p>English description</p>", ""]) {
    const fixture = item({ descriptionHtml: html });
    const state = harness([fixture]);
    const before = state.payload;
    await state.run(0);
    assert.equal(state.calls.length, 0);
    assert.equal(state.payload, before);
    assert.equal(state.payload.items[0], fixture);
    assert.match(state.statuses[0], /תיאור מעוצב/);
  }
});

test("plain-text descriptions with null or absent HTML still translate without changing other fields", async () => {
  for (const extra of [{}, { descriptionHtml: null }]) {
    const original = item({ ...extra, seoTitle: "Preserved SEO", techSpecs: { specs: ["keep"] } });
    const state = harness([original]);
    await state.run(0);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0][0], "/api/admin/translate");
    assert.deepEqual(JSON.parse(state.calls[0][1].body), { text: "English description" });
    assert.deepEqual(state.payload.items[0], { ...original, description: "תיאור מתורגם" });
    assert.deepEqual(state.translating, ["item-a", null]);
  }
});

test("a rich document added while a translation is in flight is preserved exactly", async () => {
  const response = deferredResponse();
  const state = harness([item({ descriptionHtml: null })], { respond: () => response.pending });
  const running = state.run(0);
  const changed = item({ description: "New link", descriptionHtml: '<p><a href="https://example.com">New link</a></p>' });
  state.setItems([changed]);
  const before = state.payload;
  response.complete();
  await running;
  assert.equal(state.payload, before);
  assert.equal(state.payload.items[0], changed);
});

test("new plain-text edits made while translating are not overwritten", async () => {
  const response = deferredResponse();
  const state = harness([item()], { respond: () => response.pending });
  const running = state.run(0);
  state.setItems([item({ description: "New English description" })]);
  const before = state.payload;
  response.complete();
  await running;
  assert.equal(state.payload, before);
});

test("translation follows product identity after reordering, preserving edits to unrelated fields", async () => {
  const response = deferredResponse();
  const other = item({ id: "item-b", description: "Other product" });
  const state = harness([item(), other], { respond: () => response.pending });
  const running = state.run(0);
  state.setItems([other, item({ title: "Edited title" })]);
  response.complete();
  await running;
  assert.deepEqual(state.payload.items[0], other);
  assert.equal(state.payload.items[1].description, "תיאור מתורגם");
  assert.equal(state.payload.items[1].title, "Edited title");
});

test("a removed product cannot cause a translation to overwrite another product", async () => {
  const response = deferredResponse();
  const state = harness([item()], { respond: () => response.pending });
  const running = state.run(0);
  const other = item({ id: "item-b" });
  state.setItems([other]);
  const before = state.payload;
  response.complete();
  await running;
  assert.equal(state.payload, before);
});

test("missing, empty, and already-translating inputs make no API request", async () => {
  const fixtures = [harness([]), harness([item({ description: "  " })]),
    harness([item()], { translatingItemId: "item-b" })];
  for (const state of fixtures) {
    const before = state.payload;
    await state.run(0);
    assert.equal(state.calls.length, 0);
    assert.equal(state.payload, before);
  }
});

test("translation errors preserve the original document and clear the busy state", async () => {
  const state = harness([item()], { respond: async () => ({ ok: false, json: async () => ({ error: "Unavailable" }) }) });
  const before = state.payload;
  await state.run(0);
  assert.equal(state.payload, before);
  assert.deepEqual(state.translating, ["item-a", null]);
  assert.equal(state.statuses.at(-1), "שגיאת תרגום");
});

test("translation button exposes the rich-document guard and a linked concise explanation", () => {
  assert.match(source, /const hasRichDescription = typeof item\.descriptionHtml === "string"/);
  assert.match(source, /disabled=\{translatingItemId !== null \|\| hasRichDescription \|\| !\(item\.description \?\? ""\)\.trim\(\)\}/);
  assert.match(source, /aria-describedby=\{`translate-note-\$\{item\.id\}`\}/);
  assert.match(source, /id=\{`translate-note-\$\{item\.id\}`\}/);
  assert.match(source, /כדי לשמור על העיצוב, ערכו את התרגום ישירות בתיאור/);
});
