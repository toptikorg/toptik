import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/components/admin/ProductDescriptionEditor.tsx", import.meta.url), "utf8");

// These are component wiring guards, not a substitute for real browser/touch QA.
test("all visual HTML insertion uses validation and unsafe originals stay in source mode", () => {
  const setter = source.slice(source.indexOf("function setEditorHtml"), source.indexOf("export default function"));
  assert.match(setter, /assertSafeDescriptionHtml\(nextHtml\)/);
  assert.match(setter, /catch \{ return false; \}/);
  assert.ok(setter.indexOf("assertSafeDescriptionHtml") < setter.indexOf("editor.innerHTML ="));
  assert.equal((source.match(/\.innerHTML\s*=/g) ?? []).length, 1);
  assert.match(source, /if \(editor\.innerHTML !== next\) setEditorHtml\(editor, next\)/);
  assert.match(source, /if \(!setEditorHtml\(editor, currentRef\.current\.html \?\? plainDescriptionToHtml\(currentRef\.current\.text\)\)\) return/);
  assert.match(source, /const visualMode = mode === "visual" && safeForVisualEditing/);
  assert.match(source, /disabled=\{!safeForVisualEditing\}/);
  assert.match(source, /value=\{html \?\? plainDescriptionToHtml\(text\)\}/);
});

test("unsupported rich paste is rejected before editing, without a plain-text downgrade", () => {
  const paste = source.slice(source.indexOf("const paste ="), source.indexOf('editor.addEventListener("input"'));
  const rejection = paste.slice(paste.indexOf("catch {"), paste.indexOf("// Native editing"));
  assert.match(rejection, /setNotice\(/);
  assert.match(rejection, /return;/);
  assert.doesNotMatch(rejection, /plainDescriptionToHtml|execCommand|input\(\)|emitEdit/);
  assert.ok(paste.indexOf("assertSafeDescriptionHtml(next)") < paste.indexOf('doc.execCommand("insertHTML"'));
});

test("native selection changes including touch selections are tracked and cleaned up", () => {
  assert.match(source, /doc\.addEventListener\("selectionchange", rememberSelection\)/);
  assert.match(source, /doc\.removeEventListener\("selectionchange", rememberSelection\)/);
  assert.match(source, /editor\.contains\(selection\.anchorNode\) && editor\.contains\(selection\.focusNode\)/);
});

test("same-mode clicks keep listeners and mode changes do not emit edits", () => {
  const modes = source.slice(source.indexOf("function changeMode"), source.indexOf("function toggleEditor"));
  assert.ok(modes.indexOf("if (next === mode) return;") < modes.indexOf("cleanupRef.current?.()"));
  assert.doesNotMatch(modes, /emitEdit\(|onChangeRef\.current\(|innerHTML/);
});

test("editor shell is fixed and prohibits product scripts independently of validation", () => {
  const shell = source.slice(source.indexOf("const EDITOR_DOCUMENT ="), source.indexOf("function setEditorHtml"));
  assert.doesNotMatch(shell, /\$\{/);
  assert.match(shell, /script-src 'none'/);
  assert.match(shell, /form-action 'none'; base-uri 'none'/);
  assert.match(source, /sandbox="allow-same-origin"/);
  assert.doesNotMatch(source, /allow-scripts|dangerouslySetInnerHTML/);
  assert.match(source, /srcDoc=\{EDITOR_DOCUMENT\}/);
});
