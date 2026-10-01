import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = readFileSync(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8");
function extract(start, end) {
  return stripTypeScriptTypes(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), { mode: "transform" }).trim();
}
const imageSource = extract("function applyUploadedImage(", "export default function AdminPage");
const applyUploadedImage = new Function(`return (${imageSource});`)();
const upsertSource = extract("function upsertImportedItem(", "  function vendorForItem(");
const upsert = new Function("normalizeCatalogNumber", "normalizeCatalogKey", "plainDescriptionToHtml", `return (${upsertSource});`)(
  s => s.trim().toUpperCase(), s => s.replace(/[^A-Z0-9]/gi, "").toUpperCase(), s => `<p>${s}</p>`,
);
const row = (id, revision = 7) => ({ id, title: id, description: "original", descriptionHtml: "<p>original</p>",
  catalogNumber: id, editorRevision: revision, copyUpdatedAt: "2026-10-01T00:00:00Z", displayOrder: 1,
  isActive: true, coverImagePath: `/${id}.jpg`, angles: [], seoTitle: null, seoDescription: null });
const catalog = () => ({ settings: { editorRevision: 3, autoplayMs: 3000, transitionMode: "curtain-fade" }, items: [row("A"), row("B")] });

test("reimport preserves existing editor/copy revision and other rows", () => {
  const before = catalog();
  const imported = row("new-id", undefined); delete imported.editorRevision;
  const result = upsert(before, { item: imported, source: { catalogNumber: "A" } }, "A");
  assert.equal(result.next.items[0].editorRevision, 7);
  assert.equal(result.next.items[0].copyUpdatedAt, before.items[0].copyUpdatedAt);
  assert.deepEqual(result.next.items[1], before.items[1]);
  assert.deepEqual(result.next.settings, before.settings);
});
test("late upload resolves immutable item ID after array reordering", () => {
  const before = catalog(); before.items.reverse();
  const after = applyUploadedImage(before, "A", "/new-a.jpg", "cover", 2, 2);
  assert.equal(after.items[0].coverImagePath, "/B.jpg");
  assert.equal(after.items[1].coverImagePath, "/new-a.jpg");
  assert.equal(before.items[1].coverImagePath, "/A.jpg");
});
test("angle upload keeps exact parent identity and unrelated edits", () => {
  const before = catalog(); before.items[1].title = "unsaved B title";
  const after = applyUploadedImage(before, "A", "/angle-a.jpg", "angle", 4, 4);
  assert.equal(after.items[0].angles[0].itemId, "A");
  assert.equal(after.items[0].angles[0].angleOrder, 1);
  assert.equal(after.items[1].title, "unsaved B title");
  assert.equal(after.items[0].coverImagePath, "/A.jpg");
});
test("late upload after reload or removed ID never changes catalog", () => {
  const before = catalog();
  assert.equal(applyUploadedImage(before, "A", "/late.jpg", "cover", 2, 3), before);
  assert.equal(applyUploadedImage(before, "missing", "/late.jpg", "angle", 3, 3), before);
});
const uploadSource = extract("async function onImageUpload(", "  function removeAngle(");
function uploadHarness() {
  let payload = catalog(), calls = 0, finish;
  const pending = { current: 0 }, generation = { current: 1 }, status = [];
  const context = {
    pendingUploadsRef: pending, isCatalogBusy: false, authReady: true, payload,
    catalogGenerationRef: generation, setPendingUploads() {}, setStatus: value => status.push(value),
    uploadFile: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    setPayload: update => { payload = update(payload); }, applyUploadedImage,
    resolveErrorMessage: error => error.message,
  };
  const run = new Function(...Object.keys(context), `return (${uploadSource});`)(...Object.values(context));
  return { run, pending, generation, status, calls: () => calls, payload: () => payload, finish: url => finish(url) };
}
test("upload uses synchronous pending guard and clears it after completion", async () => {
  const h = uploadHarness();
  const first = h.run("A", {}, "cover");
  assert.equal(h.pending.current, 1);
  await h.run("B", {}, "angle");
  assert.equal(h.calls(), 1);
  h.finish("/uploaded-a.jpg"); await first;
  assert.equal(h.pending.current, 0);
  assert.equal(h.payload().items[0].coverImagePath, "/uploaded-a.jpg");
});
test("upload response after catalog generation change is discarded", async () => {
  const h = uploadHarness(); const first = h.run("A", {}, "cover");
  h.generation.current++; h.finish("/late.jpg"); await first;
  assert.equal(h.payload().items[0].coverImagePath, "/A.jpg");
  assert.equal(h.pending.current, 0);
  assert.ok(h.status.some(value => value.includes("לא הוחלה")));
});
test("save and all import entrypoints stop synchronously while an upload is pending", async () => {
  for (const [start, end, args] of [
    ["async function onSave()", "  // Load catalog numbers", []],
    ["async function onImportByUrl()", "  async function onImportIntoItem", []],
    ["async function onImportIntoItem(", "  async function onBatchImportAndSave", ["A"]],
    ["async function onBatchImportAndSave(", "  const sortedItems", ["mandarina"]],
  ]) {
    const fn = new Function("pendingUploadsRef", `return (${extract(start, end)});`)({ current: 1 });
    await fn(...args); // Any later state/network dependency is deliberately absent.
  }
});
test("reload and persist refuse pending uploads; full editor is inert for async catalog work", () => {
  assert.match(source, /loadData = useCallback\(async[^]*?if \(pendingUploadsRef.current\)[^]*?return;/);
  assert.match(source, /persistPayload\(nextPayload[^]*?if \(pendingUploadsRef.current\) throw/);
  assert.ok(source.includes('inert={isCatalogBusy} aria-busy={isCatalogBusy}'));
  assert.match(source, /const isCatalogBusy =[^]*?isUrlImporting \|\| isWarming[^]*?pendingUploads > 0[^]*?itemImportingMap/);
  assert.ok(source.includes('onImageUpload(item.id, file, "cover")'));
  assert.ok(source.includes('onImageUpload(item.id, file, "angle")'));
});
test("spreadsheet export never replaces unsaved editor data", () => {
  const code = source.slice(source.indexOf("async function onExportExcel()"), source.indexOf("async function onSave()"));
  assert.equal(code.includes("setPayload("), false);
  assert.ok(code.includes("buildShopifyExportRows(fresh.items"));
});
