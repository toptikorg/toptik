import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync('src/components/carousel/ArticleProductCard.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function render({ failed, destination }) {
  const exports = {};
  const imports = name => {
    if (name === 'react') return { useState: () => [failed, () => {}] };
    if (name.includes('purchase-links')) return { purchaseUrlFor: () => destination };
    if (name === './CarouselGrid') return { CatalogCard: () => null };
    return require(name);
  };
  vm.runInNewContext(source, { exports, require: imports });
  return exports.ArticleProductCard({ item: { title: 'Verified exact product', catalogNumber: 'SKU42' } });
}
test('failed editorial image retains verified exact product/variant/tracking link without a blank card', () => {
  const destination = 'https://www.toptik.co.il/products/exact?variant=42&utm_source=journal';
  const element = render({ failed: true, destination });
  assert.equal(element.type, 'a'); assert.equal(element.props.href, destination);
  assert.ok(element.props.children.includes('Verified exact product'));
  assert.equal(element.props.className, 'journal-product-text-link');
});
test('missing verified purchase URL never creates a default or fallback product link', () => {
  assert.equal(render({ failed: true, destination: null }), null);
  assert.equal(render({ failed: false, destination: null }), null);
});
