import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(new URL('../src/lib/editorial/'+name,import.meta.url),'utf8'));
const products=read('knirps-products.json'),stories=read('knirps-stories.json');
test('Knirps only links the eleven approved distinct products, never the unresolved navy A400',()=>{
  assert.equal(products.length,11);assert.equal(new Set(products.map(p=>p.sku)).size,11);
  assert(!products.some(p=>p.sku==='74001200'));
  for(const p of products){assert.match(p.sku,/^\d{8}$/);assert.equal(p.purchaseUrl,'https://www.toptik.co.il/products/knirps-'+p.sku);assert.equal(p.images.length,2);for(const image of p.images){assert(image.src.startsWith('/knirps/'+p.sku+'-'));assert(existsSync(new URL('../public'+image.src,import.meta.url)));assert(image.alt.length>10);}}
});
test('all editorial recommendations and reciprocal article links have destinations in the release',()=>{
  const urls=new Set(products.map(p=>p.purchaseUrl));const slugs=new Set(stories.map(s=>'/journal/'+s.slug));
  assert.equal(slugs.size,3);
  for(const story of stories){assert(story.description.length<160);assert(story.sections.length>=3);assert(story.sourceUrls.every(x=>x.startsWith('https://')));for(const p of story.products)assert(urls.has(p.url));for(const related of story.related)assert(slugs.has(related.url));}
});
test('editorial hub does not mint unverified commerce offers or video schema',()=>{
  const source=readFileSync(new URL('../src/app/knirps/page.tsx',import.meta.url),'utf8');
  assert(!source.includes('aggregateRating'));assert(!source.includes('VideoObject'));assert(!source.includes('priceCurrency'));
});
