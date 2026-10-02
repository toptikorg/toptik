import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(p,'utf8');
test('gallery return links target the shop in header, footer and loading state',()=>{
 for(const file of ['page.tsx','CarouselPageClient.tsx','loading.tsx']){
  const s=read(`src/app/carousel/${file}`);
  assert.ok(s.includes('href="https://www.toptik.co.il/"'));
  assert.ok(s.includes('חזרה לחנות'));
  assert.ok(!s.includes('חזרה לדף הבית'));
 }
});
test('decoded and displayed product image use one exact URL without Next deployment rewriting',()=>{
 const s=read('src/components/carousel/ReliableProductImage.tsx');
 assert.ok(!s.includes('from "next/image"'));
 assert.match(s,/<img\s+src=\{src\}/);
 assert.match(s,/firstDecodedProductImage/);
 assert.match(s,/visibility: visibleFrame \? undefined : "hidden"/);
});
test('gallery starts catalog request from HTML and retains no-store catalog freshness',()=>{
 assert.match(read('src/app/carousel/page.tsx'),/rel="preload" href="\/api\/carousel" as="fetch" crossOrigin="anonymous"/);
 assert.match(read('src/app/api/carousel/route.ts'),/no-store, max-age=0, must-revalidate/);
});
