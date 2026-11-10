import test from'node:test';import assert from'node:assert/strict';
import{mod,stripped,fixture,id,now,url}from'./helpers/media-planning-fixture.mjs';
const guardUrl=mod('const manifest={items:[],deniedUrls:[],deniedSha256:[]};'+stripped('reviewed-media-guard'));
const api=await import(mod(`import{requireReviewedMedia,reviewedMediaRegistry}from'${guardUrl}';const loadReviewedMedia=()=>{throw Error('REAL_STORAGE_NOT_ALLOWED');};${stripped('media-reviewed-observation')}`));
function f(){const x=fixture(),hash='c'.repeat(64),refs=x.refs.map(r=>({...r,evidenceId:'g-new'})),proofs=[{evidenceId:'g-new',key:'existing',side:'gallery',contentId:hash,proof:{...x.context.provenance[0].proof,decodedSha256:hash}}],entry={sku:id.exactGallerySku,shopifySku:id.exactShopifySku,productId:id.productId,variantId:id.variantId,galleryId:id.itemId,imageUrl:url,decodedSha256:hash};
return{...x,refs,proofs,entry,run:entries=>api.reviewedObservationEvidenceIds(x.context,refs,proofs,now+10000,async()=>entries)};}
test('refresh authorizes unique changed evidence only after exact current review, including a shared cover',async()=>{const x=f();assert.deepEqual(await x.run([x.entry]),['g-new']);});
for(const [name,change]of[
 ['no review',()=>[]],['wrong SKU',x=>[{...x.entry,sku:'WRONG'}]],['wrong product',x=>[{...x.entry,productId:'gid://shopify/Product/999'}]],
 ['wrong variant',x=>[{...x.entry,variantId:'gid://shopify/ProductVariant/999'}]],['old bytes',x=>[{...x.entry,decodedSha256:'a'.repeat(64)}]],
 ['different URL',x=>[{...x.entry,imageUrl:url+'?other=1'}]],
])test('real review guard rejects '+name,async()=>{const x=f();await assert.rejects(x.run(change(x)),/MEDIA_REVIEW_REQUIRED/);});
for(const [name,edit]of[
 ['new identity',x=>x.refs[1].angleId='new-angle'],['new logical key',x=>x.refs[1].key='other'],['missing ref',x=>x.refs.pop()],
 ['missing proof',x=>x.proofs.pop()],['ambiguous proof',x=>x.proofs.push(structuredClone(x.proofs[0]))],
 ['foreign source',x=>x.proofs[0].proof.url=url+'?other=1'],['synthetic content',x=>x.proofs[0].contentId='f'.repeat(64)],
 ['transformed receipt',x=>x.proofs[0].proof.operationId='pretend'],['parent receipt',x=>x.proofs[0].proof.sourceEvidenceId='pretend'],
 ['active operation',x=>x.context.operations.push({status:'running'})],['unchanged evidence',x=>x.refs.forEach((r,n)=>r.evidenceId=x.context.galleryRefs[n].evidenceId)],
])test('refresh refuses '+name+' before loading reviews',async()=>{const x=f();edit(x);let loaded=false;await assert.rejects(api.reviewedObservationEvidenceIds(x.context,x.refs,x.proofs,now+10000,async()=>{loaded=true;return[x.entry];}),/MEDIA_OBSERVATION_REFRESH_REVIEW_REQUIRED/);assert.equal(loaded,false);});
