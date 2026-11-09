import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { loadWrapped, description } from './helpers/owned-edit-harness.mjs';
const url=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const vendor=await import(url(readFileSync('src/lib/catalog-source/vendor-detect.ts','utf8')));
const rules=(await loadWrapped('src/lib/shopify/sync-rules.ts',['normalizeCatalogKey'],['normalizeSyncSku','isSafeShopifyProductHandle']))(vendor);
const make=await loadWrapped('src/lib/shopify/catalog-copy-adoption.ts',['createHash','assertSafeDescriptionHtml','descriptionTextFromHtml','isSafeShopifyProductHandle','normalizeSyncSku'],
 ['planExistingCopyAdoption','applyReviewedCopyAdoption','copyAdoptionFingerprint','reviewedExistingCopyClassification']);
const mod=make({createHash,...description,...rules});
const actor='11111111-1111-4111-8111-111111111111',approvalId='22222222-2222-4222-8222-222222222222';
export function observation(){return {
 shopDomain:'toptikcoil.myshopify.com',source:{id:'gid://shopify/Product/123',handle:'ori05500-024',title:'טרולי פורשה צהוב',descriptionHtml:'<p>תיאור מאומת</p>',
  seoTitle:'טרולי פורשה',seoDescription:'טרולי עם גלגלים',status:'ACTIVE',publishedOnPublication:true,vendor:'Porsche Design',productType:'טרולי',updatedAt:'2026-10-20T06:56:42Z',
  variants:[{id:'gid://shopify/ProductVariant/456',sku:'ORI05500.024',price:'2500.00',inventoryQuantity:0}],media:[]},
 gallery:{id:'33333333-3333-4333-8333-333333333333',catalog_number:'ORI05500.024',is_active:true,copy_updated_at:'2026-09-30T11:59:53.722209+00:00',editor_revision:4,
  title:'Porsche Carry-On',description:'Legacy text',description_html:null,seo_title:null,seo_description:null,display_order:23},
 binding:{catalog_key:'ORI05500024',carousel_item_id:'33333333-3333-4333-8333-333333333333',product_gid:'gid://shopify/Product/123',variant_gid:'gid://shopify/ProductVariant/456',product_handle:'ori05500-024',is_published:true,source_updated_at:'2026-10-31T23:43:29.091554+00:00'},
 publicLink:{catalog_key:'ORI05500024',product_handle:'ori05500-024',variant_id:'456',is_published:true},approval:null,state:null,unresolvedOutbox:[]};}
const approval=plan=>({approvalId,actorId:actor,planHash:plan.planHash,sourceHash:plan.sourceHash,galleryHash:plan.galleryHash,observedSourceWatermark:plan.observedSourceWatermark,approvedAt:'2026-11-09T20:20:00Z',reviewReference:'owner reviewed exact difference package'});
test('review defaults to preserving both sides and displays every existing difference without approving it',()=>{
 const input=observation(),saved=structuredClone(input),p=mod.planExistingCopyAdoption(input);
 assert.equal(p.approved,false);assert.equal(p.resolution,'preserve_both');assert.equal(p.poisonedWatermark,true);
 assert.deepEqual(p.proposedGalleryCopy,p.galleryCopy);assert.deepEqual(p.differences.map(d=>d.field),['title','description','descriptionHtml','seoTitle','seoDescription']);
 assert.deepEqual(input,saved);assert.equal(p.observedSourceWatermark,input.binding.source_updated_at);
 assert.equal(mod.reviewedExistingCopyClassification(input.source).brand,'Porsche Design');
 assert.equal(input.source.variants[0].inventoryQuantity,0,'inventory zero must not make this explicitly public product unavailable');
});
test('adopt_shopify is a separate explicit manifest/hash with exact source copy, never an automatic default',()=>{
 const o=observation(),preserve=mod.planExistingCopyAdoption(o),adopt=mod.planExistingCopyAdoption(o,'adopt_shopify');
 assert.notEqual(adopt.planHash,preserve.planHash);assert.deepEqual(adopt.proposedGalleryCopy,adopt.shopifyCopy);
 assert.equal(adopt.proposedGalleryCopy.descriptionHtml,o.source.descriptionHtml);assert.equal(adopt.proposedGalleryCopy.description,'תיאור מאומת');
 assert.equal(adopt.approved,false);assert.equal(adopt.observation.binding.source_updated_at,preserve.observation.binding.source_updated_at);
});
test('classification is based on exact approved vendor and product type, never title or SKU guesses',()=>{
 for(const vendor of ['Porsche','Unknown','Porsche Design impostor'])assert.throws(()=>mod.planExistingCopyAdoption({...observation(),source:{...observation().source,vendor}}),/CLASSIFICATION_REQUIRED/);
 assert.throws(()=>mod.planExistingCopyAdoption({...observation(),source:{...observation().source,productType:'guess from title'}}),/CLASSIFICATION_REQUIRED/);
 for(const vendor of ['Mandarina Duck',"Bric's",'Samsonite','American Tourister','Porsche Design'])assert.ok(mod.reviewedExistingCopyClassification({vendor,productType:'טרולי'}));
});
test('draft, unlisted, archived, withdrawn and unconfirmed publication remain protected',()=>{
 for(const status of ['DRAFT','ARCHIVED','UNLISTED']){const o=observation();o.source.status=status;assert.throws(()=>mod.planExistingCopyAdoption(o),/NOT_PUBLIC/);}
 for(const change of [o=>o.source.publishedOnPublication=false,o=>o.gallery.is_active=false,o=>o.binding.is_published=false,o=>o.publicLink.is_published=false]){
  const o=observation();change(o);assert.throws(()=>mod.planExistingCopyAdoption(o),/NOT_PUBLIC|PUBLICATION_CONFLICT/);
 }
});
test('ambiguous/rebound identities, existing baselines and unresolved edits stop before any adoption',()=>{
 for(const change of [o=>o.source.variants.push({...o.source.variants[0],id:'gid://shopify/ProductVariant/789'}),o=>o.binding.variant_gid='gid://shopify/ProductVariant/789',
  o=>o.gallery.catalog_number='ORI05500.909',o=>o.binding.product_handle='different',o=>o.approval={enabled:false},o=>o.state={},o=>o.unresolvedOutbox.push({id:'pending'})]){
  const o=observation();change(o);assert.throws(()=>mod.planExistingCopyAdoption(o),/SINGLE_VARIANT_REQUIRED|IDENTITY_CONFLICT|ALREADY_BOOTSTRAPPED|OPEN_EDIT/);
 }
});
function ports(plan){let current=structuredClone(plan.observation),receipt=null;const calls=[];
 const api={readReceipt:async()=>{calls.push('receipt');return receipt;},withProductLease:async(id,run)=>{calls.push('lease:'+id);return run('lease-owner');},
  readObservation:async()=>{calls.push('read');return structuredClone(current);},commitReviewed:async(p,a,owner)=>{calls.push('commit');assert.equal(owner,'lease-owner');
   const c=p.proposedGalleryCopy;current.gallery={...current.gallery,title:c.title,description:c.description,description_html:c.descriptionHtml,seo_title:c.seoTitle,seo_description:c.seoDescription};
   current.approval={enabled:true,product_gid:p.observation.source.id,catalog_key:p.observation.binding.catalog_key};
   current.state={gallery_baseline_payload:c,shopify_baseline_payload:p.shopifyCopy};
   receipt={approvalId:a.approvalId,planHash:p.planHash,actorId:a.actorId,resolution:p.resolution,committedAt:'2026-11-09T20:21:00Z'};return receipt;}};
 return {api,calls,get current(){return current;},set current(v){current=v;},set receipt(v){receipt=v;}};
}
test('apply needs explicit exact hash/source/gallery/watermark review before opening the lease',async()=>{
 const p=mod.planExistingCopyAdoption(observation());for(const mutate of [a=>a.planHash='bad',a=>a.sourceHash='bad',a=>a.galleryHash='bad',a=>a.observedSourceWatermark=null,a=>a.actorId='------------------------------------',a=>a.reviewReference='']){
  const f=ports(p),a=approval(p);mutate(a);await assert.rejects(mod.applyReviewedCopyAdoption(p,a,f.api),/REVIEW_REQUIRED/);assert.deepEqual(f.calls,[]);
 }
});
test('a fresh source, gallery, baseline or watermark change refuses the reviewed commit',async()=>{
 const p=mod.planExistingCopyAdoption(observation());for(const mutate of [o=>o.source.variants[0].price='2600',o=>o.source.title='New independent title',o=>o.gallery.editor_revision++,o=>o.binding.source_updated_at='2026-11-01T00:00:00Z',o=>o.state={}]){
  const f=ports(p);mutate(f.current);await assert.rejects(mod.applyReviewedCopyAdoption(p,approval(p),f.api),/OBSERVATION_CHANGED|ALREADY_BOOTSTRAPPED/);assert.ok(!f.calls.includes('commit'));
 }
});
test('a reviewed commit preserves its poisoned publication watermark and proves both readbacks',async()=>{
 for(const mode of ['preserve_both','adopt_shopify']){const p=mod.planExistingCopyAdoption(observation(),mode),f=ports(p),r=await mod.applyReviewedCopyAdoption(p,approval(p),f.api);
  assert.equal(r.sourceVerifiedAfterCommit,true);assert.equal(r.galleryVerifiedAfterCommit,true);assert.equal(f.current.binding.source_updated_at,p.observedSourceWatermark);
  assert.equal(f.calls.filter(c=>c==='commit').length,1);assert.equal(r.receipt.resolution,mode);
 }
});
test('lost commit response is recovered from a receipt and never resubmitted',async()=>{
 const p=mod.planExistingCopyAdoption(observation()),f=ports(p),commit=f.api.commitReviewed;
 f.api.commitReviewed=async(...args)=>{await commit(...args);throw new Error('reply lost');};
 await assert.rejects(mod.applyReviewedCopyAdoption(p,approval(p),f.api),/reply lost/);
 const r=await mod.applyReviewedCopyAdoption(p,approval(p),f.api);assert.equal(r.replayed,true);assert.equal(f.calls.filter(c=>c==='commit').length,1);
 assert.equal(r.sourceVerifiedAfterCommit,false,'a receipt alone is not a fresh catalog proof');
});
test('a post-commit source move preserves its receipt but never claims current verification',async()=>{
 const p=mod.planExistingCopyAdoption(observation()),f=ports(p),commit=f.api.commitReviewed;
 f.api.commitReviewed=async(...args)=>{const r=await commit(...args);f.current.source.title='A newer legitimate change';return r;};
 const r=await mod.applyReviewedCopyAdoption(p,approval(p),f.api);assert.equal(r.sourceVerifiedAfterCommit,false);assert.equal(r.galleryVerifiedAfterCommit,true);
 assert.ok(r.receipt);assert.equal(f.calls.filter(c=>c==='commit').length,1);
});
test('receipt reuse with another reviewed plan or actor fails closed',async()=>{
 const p=mod.planExistingCopyAdoption(observation()),f=ports(p);f.receipt={...approval(p),resolution:'adopt_shopify'};
 await assert.rejects(mod.applyReviewedCopyAdoption(p,approval(p),f.api),/RECEIPT_CONFLICT/);assert.ok(!f.calls.includes('commit'));
});
