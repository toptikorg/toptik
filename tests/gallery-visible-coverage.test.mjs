import test from 'node:test';
import assert from 'node:assert/strict';
import {compareStoreGalleryProductHandles,compareVisibleStoreGalleryProductHandles} from '../scripts/production-visual-smoke.mjs';

test('monitor fails coverage for a product present in API but absent after public display filtering',()=>{
  const urls=['https://www.toptik.co.il/products/published-bag'];
  const payload={items:[{shopifyLink:{handle:'published-bag',isPublished:true}}],visibleProductHandles:[]};
  assert.deepEqual(compareStoreGalleryProductHandles(urls,payload.items).missing,[],'reproduces the old monitoring blind spot');
  assert.deepEqual(compareVisibleStoreGalleryProductHandles(urls,payload).missing,['published-bag']);
  assert.deepEqual(compareVisibleStoreGalleryProductHandles(urls,{...payload,visibleProductHandles:['published-bag']}).missing,[]);
  for(const invalid of [undefined,{}, {visibleProductHandles:null},{visibleProductHandles:[null]}]) {
    assert.throws(()=>compareVisibleStoreGalleryProductHandles(urls,invalid),/visibility projection/);
  }
});
