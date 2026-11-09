import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {loadWrapped,description} from './helpers/owned-edit-harness.mjs';
const url=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const vendor=await import(url(readFileSync('src/lib/catalog-source/vendor-detect.ts','utf8')));
const rules=(await loadWrapped('src/lib/shopify/sync-rules.ts',['normalizeCatalogKey'],['normalizeSyncSku','isSafeShopifyProductHandle']))(vendor);
const makePlan=await loadWrapped('src/lib/shopify/catalog-copy-adoption.ts',['createHash','assertSafeDescriptionHtml','descriptionTextFromHtml','isSafeShopifyProductHandle','normalizeSyncSku'],['planExistingCopyAdoption','applyReviewedCopyAdoption']);
const logic=makePlan({createHash,...description,...rules});
const makeRuntime=await loadWrapped('src/lib/shopify/catalog-copy-adoption-runtime.ts',['randomUUID','configuredShopifyDomain','shopifyAdminGraphql','applyReviewedCopyAdoption','planExistingCopyAdoption','process','AbortSignal','console'],['prepareExistingCopyAdoption','commitExistingCopyAdoption','readExistingCopyAdoptionObservation']);
const product='gid://shopify/Product/123',item='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222';
function fixture(){const calls=[],state={receipt:null,publication:'gid://shopify/Publication/79538258170',source:{id:product,handle:'ori',title:'טרולי פורשה',descriptionHtml:'<p>תיאור</p>',status:'ACTIVE',updatedAt:'2026-10-20T00:00:00Z',vendor:'Porsche Design',productType:'טרולי',seo:{title:'SEO',description:'Description'},publishedOnPublication:true,
 variants:{nodes:[{id:'gid://shopify/ProductVariant/456',sku:'ORI.24',inventoryQuantity:0,price:'2500',selectedOptions:[]}],pageInfo:{hasNextPage:false}},media:{nodes:[],pageInfo:{hasNextPage:false}}}};
 const tables={carousel_items:{id:item,catalog_number:'ORI.24',title:'Old title',description:'Old',description_html:null,seo_title:null,seo_description:null,is_active:true,copy_updated_at:'2026-09-30T00:00:00Z',editor_revision:1},
  shopify_gallery_bindings:[{catalog_key:'ORI24',carousel_item_id:item,product_gid:product,variant_gid:'gid://shopify/ProductVariant/456',product_handle:'ori',is_published:true,source_updated_at:'2026-10-31T00:00:00Z'}],
  shopify_gallery_public_links:{catalog_key:'ORI24',product_handle:'ori',variant_id:'456',is_published:true},shopify_gallery_copy_eligibility:null,shopify_gallery_sync_state:null,shopify_gallery_content_outbox:[]};
 const db={from(table){calls.push('table:'+table);const b={select(){return b;},eq(){return b;},limit(){return b;},in(){return b;},maybeSingle(){return b;},abortSignal(signal){assert.ok(signal instanceof AbortSignal);return b;},then(resolve,reject){return Promise.resolve({data:structuredClone(tables[table]),error:null}).then(resolve,reject);}};return b;},rpc(name,args){calls.push('rpc:'+name);return {async abortSignal(){
  if(name==='read_reviewed_copy_adoption_receipt')return {data:state.receipt,error:null};
  if(name==='acquire_shopify_reconciliation_lease')return {data:true,error:null};
  if(name==='release_shopify_reconciliation_lease')return {data:null,error:null};
  if(name==='commit_reviewed_copy_adoption'){
   assert.equal(args.p_owner,owner);const p=args.p_plan,a=args.p_approval,c=p.proposedGalleryCopy;
   Object.assign(tables.carousel_items,{title:c.title,description:c.description,description_html:c.descriptionHtml,seo_title:c.seoTitle,seo_description:c.seoDescription});
   tables.shopify_gallery_copy_eligibility={enabled:true,product_gid:product,catalog_key:'ORI24'};tables.shopify_gallery_sync_state={gallery_baseline_payload:c,shopify_baseline_payload:p.shopifyCopy};
   state.receipt={approvalId:a.approvalId,actorId:a.actorId,planHash:p.planHash,resolution:p.resolution,committedAt:new Date().toISOString()};return {data:state.receipt,error:null};
  }throw Error('unexpected rpc');}};}};
 const mod=makeRuntime({randomUUID:()=>owner,configuredShopifyDomain:()=> 'toptikcoil.myshopify.com',shopifyAdminGraphql:async(query,vars,timeout,deadline)=>{calls.push('shopify');assert.ok(query.includes('variants(first:2)'));assert.ok(query.includes('media(first:50)'));assert.equal(vars.id,product);assert.equal(vars.publicationId,state.publication);assert.ok(timeout<=6000&&deadline>Date.now());return {product:structuredClone(state.source)};},
  ...logic,process:{env:{get SHOPIFY_ONLINE_STORE_PUBLICATION_ID(){return state.publication;}}},AbortSignal,console});return {mod,db,state,tables,calls};}
test('private prepare adapter reads exact bounded source/local observations and never commits or leases',async()=>{
 const f=fixture(),p=await f.mod.prepareExistingCopyAdoption(f.db,product);
 assert.equal(p.approved,false);assert.equal(p.resolution,'preserve_both');assert.equal(p.brand,'Porsche Design');assert.equal(p.poisonedWatermark,true);
 assert.ok(!f.calls.some(c=>c.startsWith('rpc:')));assert.equal(p.observation.source.variants[0].inventoryQuantity,0);
});
test('truncated source and another publication fail before local reads or any privileged RPC',async()=>{
 for(const kind of ['variants','media','publication']){const f=fixture();if(kind==='publication')f.state.publication='gid://shopify/Publication/999';else f.state.source[kind].pageInfo.hasNextPage=true;
  await assert.rejects(f.mod.prepareExistingCopyAdoption(f.db,product),/SOURCE_INCOMPLETE|PUBLICATION_UNCONFIGURED/);assert.ok(!f.calls.some(c=>c.startsWith('table:')||c.startsWith('rpc:')));}
});
test('private commit adapter uses reviewed RPC under one lease, verifies both readbacks and releases it',async()=>{
 const f=fixture(),p=await f.mod.prepareExistingCopyAdoption(f.db,product,'adopt_shopify'),a={approvalId:'33333333-3333-4333-8333-333333333333',actorId:owner,planHash:p.planHash,sourceHash:p.sourceHash,galleryHash:p.galleryHash,observedSourceWatermark:p.observedSourceWatermark,approvedAt:new Date().toISOString(),reviewReference:'owner reviewed exact plan'};
 const result=await f.mod.commitExistingCopyAdoption(f.db,p,a);assert.equal(result.sourceVerifiedAfterCommit,true);assert.equal(result.galleryVerifiedAfterCommit,true);
 const rpcs=f.calls.filter(c=>c.startsWith('rpc:'));assert.deepEqual(rpcs,['rpc:read_reviewed_copy_adoption_receipt','rpc:acquire_shopify_reconciliation_lease','rpc:commit_reviewed_copy_adoption','rpc:release_shopify_reconciliation_lease']);
 assert.equal(f.tables.shopify_gallery_bindings[0].source_updated_at,p.observedSourceWatermark);assert.equal(f.tables.carousel_items.title,p.shopifyCopy.title);
});
