import test from 'node:test';import assert from 'node:assert/strict';
import {policy,load,binding,raw,image,conn,snapshot} from './helpers/group-media-fixture.mjs';
test('group read keeps every native variant and ordered image without a single-variant facade',()=>{
 const s=snapshot();assert.equal(s.binding.variants.length,2);assert.equal(s.variants.length,3);assert.equal(s.variants[2].sku,'UNBOUND-PROTECTED');
 assert.deepEqual(s.media.map(m=>m.mediaId),[1,2,3,4].map(n=>image(n).id));assert.equal(s.variants[0].image.id,'gid://shopify/ProductImage/101');
 assert.match(policy.buildGroupMediaReadRequest(binding).query,/variants\(first: 10\)/);assert.doesNotMatch(policy.buildGroupMediaReadRequest(binding).query,/first: (?:[6-9]\d|[1-9]\d{2})/);
});
test('fingerprinting full snapshot and Omit are equal, metadata order independent, and copy timestamps do not masquerade as media edits',()=>{
 const s=snapshot(),{fingerprint,...without}=s;assert.equal(policy.groupMediaFingerprint(s),policy.groupMediaFingerprint(without));assert.equal(policy.groupMediaFingerprint(s),fingerprint);
 s.product.updatedAt='2026-11-09T11:00:00Z';assert.equal(policy.groupMediaFingerprint(s),fingerprint);
 s.variants[2].mediaIds=[];assert.notEqual(policy.groupMediaFingerprint(s),fingerprint);
});
test('pagination, count drift, unknown associations, duplicate identities and malformed envelopes never become complete snapshots',()=>{
 for(const mutate of [p=>p.media.pageInfo.hasNextPage=true,p=>p.variants.nodes[2].media.pageInfo.hasNextPage=true,p=>p.mediaCount.count=5,
 p=>p.variants.nodes[0].sku='wrong',p=>p.variants.nodes[2].media.nodes=[{id:image(99).id}],p=>p.media.nodes.push(image(1)),
 p=>p.variants.nodes[2].id=p.variants.nodes[0].id]){const r=raw();mutate(r.data.product);assert.throws(()=>policy.parseGroupMediaResponse(r,binding));}
 assert.throws(()=>policy.parseGroupMediaResponse({...raw(),errors:[{message:'private'}]},binding),/GROUP_MEDIA_GRAPHQL_ERROR/);
});
test('processing and unpublished reads are observations only and never mutation readiness',()=>{
 const r=raw();r.data.product.media.nodes[0].status='PROCESSING';const s=policy.parseGroupMediaResponse(r,binding);assert.equal(s.media.length,4);assert.throws(()=>policy.assertGroupMediaReady(s),/GROUP_MEDIA_NOT_READY/);
 const r2=raw();r2.data.product.publishedOnPublication=false;assert.throws(()=>policy.assertGroupMediaReady(policy.parseGroupMediaResponse(r2,binding)),/GROUP_MEDIA_SOURCE_UNPUBLISHED/);
 for(const status of ['UNLISTED','DRAFT','ARCHIVED']){const r3=raw();r3.data.product.status=status;
  const observed=policy.parseGroupMediaResponse(r3,binding);assert.equal(observed.product.status,status);
  assert.throws(()=>policy.assertGroupMediaReady(observed),/GROUP_MEDIA_SOURCE_UNPUBLISHED/);}
});
test('real group reader gathers capped pages, confirms a second complete pass, and never issues more than first50',async()=>{
 const make=await load('src/lib/shopify/group-media-read.ts',['configuredShopifyDomain','shopifyAdminGraphql','MEDIA_API_VERSION','buildGroupMediaReadRequest','buildGroupMediaPageRequest','GROUP_VARIANT_MEDIA_PAGE_QUERY','parseGroupMediaResponse','process'],['readGroupMediaSnapshot']);
 const calls=[];let firstPages=0;
 const read=make({...policy,MEDIA_API_VERSION:'2026-07',process:{env:{}},configuredShopifyDomain:()=> 'toptikcoil.myshopify.com',
 shopifyAdminGraphql:async(query,vars)=>{calls.push(query);const r=raw();
  if(query.includes('TopTikGroupMediaRead')){firstPages++;r.data.product.media=conn([image(1),image(2)]);r.data.product.media.pageInfo={hasNextPage:true,endCursor:'page-2'};return r.data;}
  assert.equal(vars.after,'page-2');return{product:{id:binding.productGid,handle:binding.handle,media:conn([image(3),image(4)])}};
 }}).readGroupMediaSnapshot;
 assert.deepEqual(await read(binding,Date.now()+20000),snapshot());assert.equal(firstPages,2);assert.equal(calls.length,4);
 assert.ok(calls.every(q=>!q.includes('first: 250')));
});
test('repeated cursors and changing paginated collections are held instead of accepted',async()=>{
 const make=await load('src/lib/shopify/group-media-read.ts',['configuredShopifyDomain','shopifyAdminGraphql','MEDIA_API_VERSION','buildGroupMediaReadRequest','buildGroupMediaPageRequest','GROUP_VARIANT_MEDIA_PAGE_QUERY','parseGroupMediaResponse','process'],['readGroupMediaSnapshot']);
 let reads=0;const read=make({...policy,MEDIA_API_VERSION:'2026-07',process:{env:{}},configuredShopifyDomain:()=> 'toptikcoil.myshopify.com',
 shopifyAdminGraphql:async(query)=>{const r=raw();if(query.includes('TopTikGroupMediaRead')){reads++;r.data.product.media=conn([image(1),image(2)]);r.data.product.media.pageInfo={hasNextPage:true,endCursor:'same'};return r.data;}
 const tail=[image(3),image(4)];if(reads>1)tail[0].alt='concurrent edit';return{product:{id:binding.productGid,handle:binding.handle,media:conn(tail)}};}}).readGroupMediaSnapshot;
 await assert.rejects(read(binding,Date.now()+20000),/GROUP_MEDIA_UNSTABLE_READ/);
});
