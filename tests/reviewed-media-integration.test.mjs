import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {mod,stripped,galleryUrl,readyUrl,fixture,id,owner,now,url} from './helpers/media-planning-fixture.mjs';
Error.stackTraceLimit=0;
const source=readFileSync(new URL('../src/lib/shopify/reviewed-media-guard.ts',import.meta.url),'utf8').replace(/^import[^\n]*;\r?\n/gm,'');
const guardUrl=mod('const manifest={items:[],deniedUrls:[],deniedSha256:[]};'+source);
const factory=await import(mod(`import * as guard from '${guardUrl}';import{createHash}from'node:crypto';import{galleryRawToSnapshot}from'${galleryUrl}';import{mediaReadToSnapshot}from'${readyUrl}';
 export function make(reviews){const assertNotDeniedMedia=(u,h)=>guard.assertNotDeniedMedia(u,h,reviews),requireReviewedMedia=(i,u,h,r)=>guard.requireReviewedMedia(i,u,h,r??reviews),isReviewedMediaProof=(i,p,ps,r)=>guard.isReviewedMediaProof(i,p,ps,r??reviews),reviewedMediaRegistry=entries=>({...reviews,items:[...reviews.items,...entries]}),loadReviewedMedia=async()=>[];${stripped('media-planning-observation').replace(/^export /gm,'')}return captureMediaPlanningPair;}`));
function f(){const x=fixture();const deps={now:()=>now,capture:async()=>x.bytes,shopify:async()=>x.read,gallery:()=>({read:async()=>x.raw})};return {x,deps};}
const review=(u)=>({sku:id.exactGallerySku,shopifySku:id.exactShopifySku,productId:id.productId,variantId:id.variantId,galleryId:id.itemId,imageUrl:u});
test('actual planning keeps unchanged legacy but rejects a new unreviewed source before proof registration',async()=>{
 const {x,deps}=f(),reviews={items:[],deniedUrls:[],deniedSha256:[]},capture=factory.make(reviews);
 assert.deepEqual((await capture(x.context,owner,now+30000,deps)).pair,x.pair);
 x.raw.angles.push({...x.raw.angles[0],id:'a0000000-0000-4000-8000-000000000009',angle_order:2,image_path:url+'?new=1'});
 await assert.rejects(capture(x.context,owner,now+30000,deps),/MEDIA_REVIEW_REQUIRED/);
 reviews.items.push(review(url+'?new=1'));
 const result=await capture(x.context,owner,now+30000,deps);assert.equal(result.pair.gallery.assets.length,2);
});
test('actual planning cannot recycle known wrong-color historical proof',async()=>{
 const {x,deps}=f(),capture=factory.make({items:[],deniedUrls:[url],deniedSha256:[]});
 await assert.rejects(capture(x.context,owner,now+30000,deps),/MEDIA_REVIEW_REJECTED/);
});
test('actual planning treats changed decoded bytes as replacement, with exact rendition checksum when recorded',async()=>{
 const {x,deps}=f(),reviews={items:[],deniedUrls:[],deniedSha256:[]},capture=factory.make(reviews);
 x.bytes.sha256='c'.repeat(64);await assert.rejects(capture(x.context,owner,now+30000,deps),/MEDIA_REVIEW_REQUIRED/);
 reviews.items.push({...review(url),decodedSha256:'d'.repeat(64)});await assert.rejects(capture(x.context,owner,now+30000,deps),/MEDIA_REVIEW_REQUIRED/);
 reviews.items[0].decodedSha256=x.bytes.sha256;assert.equal((await capture(x.context,owner,now+30000,deps)).pair.gallery.assets[0].contentId,x.bytes.sha256);
});
test('actual catalog route applies review guard before atomic save or scheduling',async()=>{
 const routeSource=readFileSync(new URL('../src/app/api/admin/carousel/route.ts',import.meta.url),'utf8').replace(/^import[^\n]*;\r?\n/gm,'').replace(/^export /gm,'');
 const routeFactory=await import(mod(`import{assertReviewedCatalogMedia,mediaReviewMessage}from'${guardUrl}';export function make(deps){const{NextResponse,authorizeGalleryAdmin,getCarouselPayload,prepareExistingCatalogSave,saveCarouselPayload,scheduleShopifySync,scheduleMediaSyncWakeup}=deps;const isUnavailableCarouselPayload=()=>false;const assertReviewedCatalogSave=async(a,b)=>assertReviewedCatalogMedia(a,b);${routeSource}return PUT;}`));
 const before={items:[{id:id.itemId,catalogNumber:id.exactGallerySku,shopifyLink:{variantId:id.variantId.split('/').at(-1)},coverImagePath:url,angles:[]}],settings:{}};
 const next=structuredClone(before);next.items[0].angles.push({id:'new',imagePath:url+'?wrong=1'});const calls=[];
 const route=routeFactory.make({NextResponse:{json:(body,{status=200}={})=>({body,status})},authorizeGalleryAdmin:async()=>({ok:true,actorId:owner,authMethod:'session'}),getCarouselPayload:async()=>before,prepareExistingCatalogSave:async b=>b,saveCarouselPayload:async()=>calls.push('write'),scheduleShopifySync:()=>calls.push('copy'),scheduleMediaSyncWakeup:()=>calls.push('media')});
 const response=await route({json:async()=>next});assert.equal(response.status,400);assert.match(response.body.error,/MEDIA_REVIEW_REQUIRED/);assert.deepEqual(calls,[]);assert.equal(before.items[0].angles.length,0);
});


test('private bootstrap observes existing independent catalogs without approving future media transfer',async()=>{
 const {x,deps}=f(),reviews={items:[],deniedUrls:[],deniedSha256:[]},capture=factory.make(reviews);
 x.context.provenance=[];x.context.baselines.gallery.assets=[];x.context.baselines.shopify.assets=[];
 const result=await capture(x.context,owner,now+30000,{...deps,observationOnlyBootstrap:true});
 assert.equal(result.pair.gallery.assets.length,1);assert.equal(result.pair.shopify.assets.length,1);
 await assert.rejects(capture(x.context,owner,now+30000,deps),/MEDIA_REVIEW_REQUIRED/);
 const bad=factory.make({...reviews,deniedUrls:[url]});
 await assert.rejects(bad(x.context,owner,now+30000,{...deps,observationOnlyBootstrap:true}),/MEDIA_REVIEW_REJECTED/);
});

test('dynamic exact approval propagates without deployment and is fetched once only for changed media',async()=>{
 const {x,deps}=f(),capture=factory.make({items:[],deniedUrls:[],deniedSha256:[]});let reads=0;
 const loader=async()=>{reads++;return [{...review(url+'?new=1'),decodedSha256:x.bytes.sha256}];};
 await capture(x.context,owner,now+30000,{...deps,reviewLoader:loader});assert.equal(reads,0);
 x.raw.angles.push({...x.raw.angles[0],id:'a0000000-0000-4000-8000-000000000009',angle_order:2,image_path:url+'?new=1'});
 assert.equal((await capture(x.context,owner,now+30000,{...deps,reviewLoader:loader})).pair.gallery.assets.length,2);
 assert.equal(reads,1);
 const wrong=async()=>[{...review(url+'?new=1'),variantId:'gid://shopify/ProductVariant/999'}];
 await assert.rejects(capture(x.context,owner,now+30000,{...deps,reviewLoader:wrong}),/MEDIA_REVIEW_REQUIRED/);
});
