import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertVariantColorSelector} from '../scripts/production-visual-smoke.mjs';
const product={handle:'tag',variants:[{id:12,sku:null},{id:13,sku:null}]};
const html='<nav class="tt-variant-colors"><a href="/products/tag?variant=12"></a><a href="/products/tag?variant=13"></a></nav>';
test('color variants without merchant SKUs retain exact Shopify identities',()=>assertVariantColorSelector(html,product));
test('missing, wrong-product, hidden and external variant links fail',()=>{
 for(const bad of [html.replace('variant=13','variant=14'),html.replaceAll('/products/tag','/products/other'),html.replace('<nav ','<nav hidden '),html.replaceAll('/products/tag','https://other.example/products/tag'),html.replace('tt-variant-colors','unrelated')]) assert.throws(()=>assertVariantColorSelector(bad,product),/Visible color selection missing/);
});
test('SKU remains checked whenever the merchant supplied one',()=>{
 const withSku={handle:'tag',variants:[{id:12,sku:'CODE'}]};
 assert.throws(()=>assertVariantColorSelector(html,withSku),/Visible color selection missing/);
 assertVariantColorSelector(html.replace('variant=12"','variant=12" data-color-sku="CODE"'),withSku);
});
