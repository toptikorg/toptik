import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const url = text => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(resolveImageLimits(text))).toString('base64')}`;
const core = url(readFileSync(new URL('../src/lib/shopify/media-sync-core.ts', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/lib/shopify/media-read-adapter.ts', import.meta.url), 'utf8');
const api = await import(url(source.replace('from "./media-sync-core";', `from "${core}";`).replace('from "./media-sync-core";', `from "${core}";`)));
const identity = { productId:'gid://shopify/Product/7550812619002',variantId:'gid://shopify/ProductVariant/42465754808570',
  itemId:'6f887176-e70a-44ba-b252-238f994b66ad',exactGallerySku:'P10SZV24-05J-TU',exactShopifySku:'P10SZV2405J',productHandle:'logoduck-i-טרולי' };
const connection = nodes => ({nodes,pageInfo:{hasNextPage:false}});
const image = n => ({id:`gid://shopify/MediaImage/${n}`, mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',
  alt:'מזוודה צהובה',updatedAt:'2026-09-30T17:00:00Z',image:{id:`gid://shopify/ImageSource/${n}`,url:`https://cdn.shopify.com/s/files/1/0645/image-${n}.jpg?v=123`,width:1000,height:1000}});
const response = () => ({data:{product:{id:identity.productId,handle:identity.productHandle,status:'ACTIVE',updatedAt:'2026-09-30T17:00:00Z',publishedOnPublication:true,
  mediaCount:{count:2,precision:'EXACT'},media:connection([image(1),image(2)]),
  variants:connection([{id:identity.variantId,sku:identity.exactShopifySku,image:{id:'gid://shopify/ProductImage/999',url:image(1).image.url},media:connection([{id:'gid://shopify/MediaImage/1'}])}])}}});
const parse = r => api.parseMediaReadResponse(r,identity);
const receipt = (i,id) => ({identity:id,side:'shopify',mediaId:i.mediaId,imageId:i.imageId,url:i.url,width:i.width,height:i.height,platformUpdatedAt:i.updatedAt,
  decodedSha256:'a'.repeat(64),contentId:'a'.repeat(64),byteLength:1000,mime:'image/jpeg',key:`media-${i.mediaId.split('/').at(-1)}`,evidenceId:`evidence-${i.mediaId.split('/').at(-1)}`});

test('read query pins complete product, variant associations, exact publication and ordered media',()=>{
  const r=api.buildMediaReadRequest(identity);assert.equal(r.variables.id,identity.productId);assert.equal(r.apiVersion,'2026-07');
  assert.match(r.query,/media\(first: 250, sortKey: POSITION\)/);assert.match(r.query,/mediaCount \{ count precision \}/);assert.doesNotMatch(r.query,/mutation/);
});
test('complete read preserves variant linkage and order without pretending decode',()=>{
  const r=parse(response());assert.equal(r.images.length,2);assert.equal(r.images[0].variantAssigned,true);assert.equal(r.images[1].variantAssigned,false);
  assert.equal(r.variantImageId,'gid://shopify/ProductImage/999');assert.equal(r.images[0].imageId,'gid://shopify/ImageSource/1');assert.equal(r.fingerprint.length,64);assert.equal(r.images[0].contentId,undefined);
});
test('existing Shopify 25MP image is retained exactly, while larger or over-edge images are held',()=>{
  const r=response(),image=r.data.product.media.nodes[0].image;image.width=5000;image.height=5000;
  assert.equal(parse(r).images[0].width,5000);assert.equal(parse(r).images[0].url,image.url);
  image.width=5001;assert.throws(()=>parse(r),/MEDIA_IMAGE_INVALID/);
  image.width=16001;image.height=1;assert.throws(()=>parse(r),/MEDIA_IMAGE_INVALID/);
});
for(const [name,edit,code] of [
  ['wrong SKU',p=>p.variants.nodes[0].sku+='-TU','MEDIA_VARIANT_CHANGED'],
  ['wrong handle',p=>p.handle='other','MEDIA_IDENTITY_OR_PUBLICATION_CHANGED'],
  ['unpublished',p=>p.publishedOnPublication=false,'MEDIA_IDENTITY_OR_PUBLICATION_CHANGED'],
  ['archived',p=>p.status='ARCHIVED','MEDIA_IDENTITY_OR_PUBLICATION_CHANGED'],
  ['second variant',p=>p.variants.nodes.push({...p.variants.nodes[0],id:'gid://shopify/ProductVariant/2'}),'MEDIA_VARIANT_CHANGED'],
  ['product pagination',p=>p.media.pageInfo.hasNextPage=true,'MEDIA_RESPONSE_INCOMPLETE'],
  ['variant pagination',p=>p.variants.nodes[0].media.pageInfo.hasNextPage=true,'MEDIA_RESPONSE_INCOMPLETE'],
  ['missing pageInfo',p=>delete p.media.pageInfo,'MEDIA_RESPONSE_INVALID'],
  ['count drift',p=>p.mediaCount.count=3,'MEDIA_RESPONSE_INCOMPLETE'],
  ['count estimate',p=>p.mediaCount.precision='AT_LEAST','MEDIA_RESPONSE_INCOMPLETE'],
  ['video not silently filtered',p=>p.media.nodes[0].mediaContentType='VIDEO','MEDIA_UNSUPPORTED_ASSET_TYPE'],
  ['processing image',p=>p.media.nodes[0].fileStatus='PROCESSING','MEDIA_ASSET_NOT_READY'],
  ['image not ready',p=>p.media.nodes[0].image=null,'MEDIA_ASSET_NOT_READY'],
  ['foreign host',p=>p.media.nodes[0].image.url='https://cdn.shopify.com.example.org/s/files/a.jpg','MEDIA_IMAGE_INVALID'],
  ['encoded path',p=>p.media.nodes[0].image.url='https://cdn.shopify.com/s/files/%2e%2e/a.jpg','MEDIA_IMAGE_INVALID'],
  ['pixel bomb',p=>{p.media.nodes[0].image.width=16000;p.media.nodes[0].image.height=2000;},'MEDIA_IMAGE_INVALID'],
  ['duplicate media',p=>p.media.nodes[1]=structuredClone(p.media.nodes[0]),'MEDIA_VARIANT_ASSOCIATION_INVALID'],
  ['orphan assignment',p=>p.variants.nodes[0].media.nodes[0].id='gid://shopify/MediaImage/999','MEDIA_VARIANT_ASSOCIATION_INVALID'],
  ['unlinked variant primary image',p=>p.variants.nodes[0].image.url=image(2).image.url,'MEDIA_VARIANT_ASSOCIATION_INVALID'],
  ['missing variant image',p=>delete p.variants.nodes[0].image,'MEDIA_RESPONSE_INVALID'],
  ['missing alt',p=>delete p.media.nodes[0].alt,'MEDIA_IMAGE_INVALID'],
]) test(`reject ${name}`,()=>{const r=response();edit(r.data.product);assert.throws(()=>parse(r),new RegExp(code));});
test('GraphQL errors reject even when data was returned',()=>{const r=response();r.errors=[{message:'partial'}];assert.throws(()=>parse(r),/MEDIA_GRAPHQL_ERROR/);});
test('complete empty media is observed without fabricating a deletion instruction',()=>{
  const r=response(),p=r.data.product;p.mediaCount.count=0;p.media.nodes=[];p.variants.nodes[0].media.nodes=[];p.variants.nodes[0].image=null;
  assert.deepEqual(parse(r).images,[]);
});
test('media change changes revision despite unchanged product updatedAt',()=>{
  const r=response(),old=parse(r).fingerprint;r.data.product.media.nodes[0].alt='חדש';assert.notEqual(parse(r).fingerprint,old);
});
test('variant-only assignment changes also invalidate whole-media revision',()=>{
  const r=response(),old=parse(r).fingerprint;r.data.product.variants.nodes[0].image=null;assert.notEqual(parse(r).fingerprint,old);
});
test('exact decode receipts produce core snapshot and null alt becomes empty text',()=>{
  const r=response();r.data.product.media.nodes[0].alt=null;const snapshot=api.mediaReadToSnapshot(parse(r),receipt);
  assert.equal(snapshot.assets[0].alt,'');assert.equal(snapshot.assets.length,2);assert.equal(snapshot.complete,true);
});
test('receipt is mandatory for every image; URL or API status is insufficient',()=>{
  assert.throws(()=>api.mediaReadToSnapshot(parse(response()),()=>null),/MEDIA_DECODE_PROVENANCE_REQUIRED/);
});
for(const [name,edit] of [
  ['different product',r=>r.identity={...r.identity,productId:'gid://shopify/Product/2'}],
  ['different color URL',r=>r.url+='other'],['stale version',r=>r.platformUpdatedAt='2026-09-29T17:00:00Z'],
  ['invalid bytes',r=>r.byteLength=0],['wrong dimensions',r=>r.width=123],
  ['unproved lineage',r=>r.contentId='b'.repeat(64)],['unsupported content',r=>r.mime='text/html'],
]) test(`reject receipt ${name}`,()=>assert.throws(()=>api.mediaReadToSnapshot(parse(response()),(i,id)=>{const r=receipt(i,id);edit(r);return r;}),/MEDIA_DECODE_PROVENANCE_REQUIRED/));
test('private import lineage supports actual Shopify recompression',()=>{
  const out=api.mediaReadToSnapshot(parse(response()),(i,id)=>({...receipt(i,id),contentId:'b'.repeat(64),importReceiptId:'import-verified'}));
  assert.equal(out.assets[0].contentId,'b'.repeat(64));
});
test('duplicate logical key cannot collapse two platform references',()=>assert.throws(()=>api.mediaReadToSnapshot(parse(response()),(i,id)=>({...receipt(i,id),key:'same'})),/MEDIA_ASSET_INVALID/));
test('modified parsed read is rejected before resolver runs',()=>{
  const r=parse(response());r.images[0].url+='a';assert.throws(()=>api.mediaReadToSnapshot(r,()=>{throw Error('should not call');}),/MEDIA_READ_TAMPERED/);
});
