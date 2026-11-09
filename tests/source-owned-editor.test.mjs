import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const policy = await import(dataUrl(stripTypeScriptTypes(readFileSync('src/lib/shopify/variant-source-policy.ts', 'utf8'))));
const description = dataUrl(stripTypeScriptTypes(readFileSync('src/lib/shopify/description-document.ts', 'utf8'))
  .replace('from "parse5"', `from ${JSON.stringify(pathToFileURL(require.resolve('parse5')).href)}`));
let editor = ts.transpileModule(readFileSync('src/components/admin/ProductDescriptionEditor.tsx', 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
editor = editor.replace(/from "(react(?:\/jsx-runtime)?)"/g, (_, name) => `from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)}`)
  .replace('from "@/lib/shopify/description-document"', `from ${JSON.stringify(description)}`);
const { default: Editor } = await import(dataUrl(editor));

test('every source-owned color opens its own parent, and unrelated products have no source-only routing', () => {
  for (const row of policy.MD20_VARIANTS) assert.equal(policy.shopifyOwnedProductId(row.itemId), '7512404951290');
  for (const row of policy.FZT73_VARIANTS) assert.equal(policy.shopifyOwnedProductId(row.itemId), '7524873044218');
  assert.equal(policy.shopifyOwnedProductId('660aea87-5082-438d-86f0-bd982ac43a68'), null);
});

test('source-owned description remains selectable text without an editable iframe or edit action', () => {
  let changes = 0;
  const markup = renderToStaticMarkup(React.createElement(Editor, {
    text: 'תיאור המקור בצבע כחול', html: '<p>תיאור המקור בצבע כחול</p>', readOnly: true,
    onChange: () => { changes++; },
  }));
  assert.ok(markup.includes('תיאור המקור בצבע כחול'));
  assert.ok(markup.includes('לקריאה בלבד מהחנות'));
  assert.doesNotMatch(markup, /<(?:button|textarea|iframe)\b|contenteditable=/i);
  assert.equal(changes, 0);
});

test('ordinary product descriptions retain their edit action', () => {
  const markup = renderToStaticMarkup(React.createElement(Editor, {
    text: 'תיאור רגיל', html: '<p>תיאור רגיל</p>', onChange: () => assert.fail('render is read-only'),
  }));
  assert.match(markup, /<button\b/);
  assert.ok(markup.includes('עריכת תיאור'));
});
