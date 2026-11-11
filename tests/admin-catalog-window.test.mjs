import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import ts from 'typescript';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadWrapped, dataUrl } from './helpers/owned-edit-harness.mjs';

const vendor = await import(dataUrl(stripTypeScriptTypes(readFileSync('src/lib/catalog-source/vendor-detect.ts', 'utf8'))));
const { editorCatalogWindow, EDITOR_PAGE_SIZE } = (await loadWrapped('src/lib/carousel/editor-catalog-window.ts',
  ['normalizeCatalogKey'], ['editorCatalogWindow', 'EDITOR_PAGE_SIZE']))(vendor);
const { planChangedOnlySave } = await import(dataUrl(stripTypeScriptTypes(readFileSync('src/lib/carousel/editor-changes.ts', 'utf8'))));
const catalog = () => ({ settings: { autoplayMs: 5000, transitionMode: 'fade', editorRevision: 1 },
  items: Array.from({ length: 470 }, (_, i) => ({ id: `row-${i}`, title: `מוצר ${i}`, catalogNumber: `SKU-${i}`,
    displayOrder: i + 1, description: 'תיאור מוצר', coverImagePath: '/image.jpg', isActive: true, editorRevision: 1,
    angles: Array.from({ length: 5 }, (_, j) => ({ id: `angle-${i}-${j}`, angleKey: `view-${j}`, imagePath: `/image-${j}.jpg`, angleOrder: j + 1 })) })) });

test('470 products are reachable exactly once with at most ten mounted rows per page', () => {
  const items = catalog().items, seen = [];
  for (let page = 0; page < 47; page++) {
    const result = editorCatalogWindow(items, '', page);
    assert.equal(result.page, page); assert.equal(result.pages, 47); assert.equal(result.total, 470);
    assert.ok(result.items.length <= EDITOR_PAGE_SIZE); seen.push(...result.items);
  }
  assert.deepEqual(seen, items); assert.equal(new Set(seen.map(row => row.id)).size, 470);
  assert.strictEqual(editorCatalogWindow(items, '', 0).items[0], items[0]);
});

test('search covers the last page, Hebrew names and separator-normalized SKU, with empty/clamped states', () => {
  const items = catalog().items;
  assert.deepEqual(editorCatalogWindow(items, 'sku 469', 46).items, [items[469]]);
  assert.deepEqual(editorCatalogWindow(items, 'מוצר 469', 0).items, [items[469]]);
  assert.equal(editorCatalogWindow(items, 'missing', 10).first, 0);
  assert.equal(editorCatalogWindow(items, 'missing', 10).page, 0);
  for (const page of [-1, NaN, Infinity, 0.5]) assert.equal(editorCatalogWindow(items, '', page).page, 0);
  assert.equal(editorCatalogWindow(items, '', 999).page, 46);
});

test('editing products across pages/search preserves full catalog and changed-only CAS save selection', () => {
  const before = catalog(), next = structuredClone(before);
  next.items[0].title = 'עריכה בעמוד הראשון';
  next.items[469].angles.pop();
  for (const [search, page] of [['', 46], ['SKU-469', 0], ['missing', 0], ['', 0]]) editorCatalogWindow(next.items, search, page);
  assert.equal(next.items.length, 470); assert.equal(next.items[469].angles.length, 4);
  assert.equal(before.items[469].angles.length, 5);
  const plan = planChangedOnlySave(before, next);
  assert.deepEqual(plan.items.map(row => row.id), ['row-0', 'row-469']);
  assert.equal(plan.settingsChanged, false);
});

const source = readFileSync('src/app/admin/page.tsx', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const imports = ts.createSourceFile('admin.js', compiled, ts.ScriptTarget.Latest, true).statements
  .filter(ts.isImportDeclaration).flatMap(node => {
    const clause = node.importClause;
    return [...(clause?.name ? [clause.name.text] : []), ...(clause?.namedBindings?.elements?.map(el => el.name.text) ?? [])];
  });
const body = compiled.replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export default function AdminPage', 'function AdminPage');
const makePage = new Function('deps', `const {${imports.join(',')}}=deps; ${body}; return AdminPage;`);

function renderCatalog(search = '', page = 0) {
  const payload = catalog(); let hook = 0, mountedDescriptions = 0;
  const stub = () => null;
  const deps = Object.fromEntries(imports.map(name => [name, stub]));
  Object.assign(deps, React, jsxRuntime, { _jsx: jsxRuntime.jsx, _jsxs: jsxRuntime.jsxs, _Fragment: React.Fragment,
    useState: initial => { hook++; return React.useState(hook === 3 ? true : hook === 4 ? payload : hook === 5 ? search : hook === 6 ? page : initial); },
    fallbackCarouselPayload: payload, ADMIN_HOST: 'admin.example.test', LANDING_URL: 'https://example.test',
    editorCatalogWindow, normalizeCatalogKey: vendor.normalizeCatalogKey,
    PRODUCT_CATEGORIES: [], SHOPIFY_OWNED_VARIANTS: [], isShopifyOwnedVariant: () => false, pendingUploadReviews: () => [],
    ProductDescriptionEditor: () => { mountedDescriptions++; return null; },
    Image: ({ src, alt }) => React.createElement('img', { src, alt }), Link: ({ href, children }) => React.createElement('a', { href }, children),
  });
  const Page = makePage(deps);
  return { markup: renderToStaticMarkup(React.createElement(Page)), descriptions: () => mountedDescriptions };
}

test('actual admin page mounts only ten heavy product editors, with accessible navigation at both ends', () => {
  const view = renderCatalog();
  assert.equal((view.markup.match(/class="admin-item-card"/g) ?? []).length, 10);
  assert.equal(view.descriptions(), 10);
  assert.ok(view.markup.includes('מתוך 470')); assert.ok(view.markup.includes('מתוך 47'));
  assert.equal((view.markup.match(/דפדוף במוצרי הניהול/g) ?? []).length, 2);
  assert.ok(!view.markup.includes('value="SKU-469"'));
});

test('actual page can render final product via next pages and direct search without mounting earlier cards', () => {
  for (const [search, page, count] of [['', 46, 10], ['sku 469', 0, 1], ['missing', 0, 0]]) {
    const view = renderCatalog(search, page);
    assert.equal(view.descriptions(), count);
    if (count) assert.ok(view.markup.includes('value="SKU-469"'));
    else assert.ok(view.markup.includes('לא נמצאו מוצרים'));
  }
});

test('real page handlers retain edits through next/previous/search and remove only the selected final-row angle', () => {
  const original = catalog(), state = [], refs = []; let cursor = 0, refCursor = 0;
  const noop = () => null, Description = () => null;
  const deps = Object.fromEntries(imports.map(name => [name, noop]));
  Object.assign(deps, { _jsx: jsxRuntime.jsx, _jsxs: jsxRuntime.jsxs, _Fragment: React.Fragment,
    useState: initial => {
      const index = cursor++;
      if (!(index in state)) state[index] = index === 2 ? true : index === 3 ? original : initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    }, useRef: initial => { const index = refCursor++; return refs[index] ??= { current: initial }; },
    useEffect: () => {}, useMemo: fn => fn(), useCallback: fn => fn,
    fallbackCarouselPayload: original, ADMIN_HOST: 'admin.example.test', LANDING_URL: 'https://example.test',
    editorCatalogWindow, normalizeCatalogKey: vendor.normalizeCatalogKey,
    PRODUCT_CATEGORIES: [], SHOPIFY_OWNED_VARIANTS: [], isShopifyOwnedVariant: () => false, pendingUploadReviews: () => [],
    ProductDescriptionEditor: Description,
    removeEditorAngle: (item, id) => ({ ...item, angles: item.angles.filter(angle => angle.id !== id) }),
  });
  const Page = makePage(deps);
  function nodes(value) {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    return [value, ...nodes(value.props?.children)];
  }
  const render = () => { cursor = 0; refCursor = 0; return nodes(Page()); };
  const button = (list, name) => list.find(node => node.type === 'button' && node.props.children === name);
  let view = render();
  view.find(node => node.type === 'input' && node.props.value === 'מוצר 0').props.onChange({ target: { value: 'עריכה ראשונה' } });
  for (let page = 0; page < 46; page++) { view = render(); const next = button(view, 'העמוד הבא'); assert.ok(next, `page ${page}`); assert.equal(next.props.disabled, false); next.props.onClick(); }
  view = render(); assert.equal(button(view, 'העמוד הבא').props.disabled, true);
  button(view, 'העמוד הקודם').props.onClick(); view = render();
  view.find(node => node.type === 'input' && node.props.placeholder === 'חיפוש מוצר').props.onChange({ target: { value: 'sku 469' } });
  view = render(); assert.equal(view.filter(node => node.props?.className === 'admin-item-card').length, 1);
  view.find(node => node.type === Description).props.onChange({ text: 'תיאור חדש', html: '<p>תיאור חדש</p>' });
  view = render(); view.filter(node => node.type === 'button' && node.props['aria-label'] === 'הסר תמונה').at(-1).props.onClick();
  assert.equal(state[3].items[469].angles.length, 4);
  assert.equal(state[3].items[469].descriptionHtml, '<p>תיאור חדש</p>');
  assert.equal(original.items[469].angles.length, 5); assert.equal(original.items[0].title, 'מוצר 0');
  assert.strictEqual(state[3].items[1], original.items[1]);
  assert.deepEqual(planChangedOnlySave(original, state[3]).items.map(row => row.id), ['row-0', 'row-469']);
});
