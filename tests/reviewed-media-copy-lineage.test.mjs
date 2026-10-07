import test from 'node:test';
import assert from 'node:assert/strict';
import {mod,stripped,galleryUrl,readyUrl,ready,coreUrl,core,fixture,id,owner,opId,now,url,stamp} from './helpers/media-planning-fixture.mjs';
Error.stackTraceLimit=0;
const guardUrl=mod('const manifest={items:[],deniedUrls:[],deniedSha256:[]};'+stripped('reviewed-media-guard'));
const guard=await import(guardUrl);
const captureFactory=await import(mod(`import * as guard from '${guardUrl}';import{createHash}from'node:crypto';import{galleryRawToSnapshot}from'${galleryUrl}';import{mediaReadToSnapshot}from'${readyUrl}';
export function make(entries){const{assertNotDeniedMedia,requireReviewedMedia,isReviewedMediaProof,reviewedMediaRegistry}=guard;const loadReviewedMedia=async()=>entries;${stripped('media-planning-observation').replace(/^export /gm,'')}return captureMediaPlanningPair;}`));
const runtime=await import(mod(`import{randomUUID}from'node:crypto';import{reconcileMedia,mediaSnapshotFingerprint}from'${coreUrl}';${stripped('media-product-runtime')}`));
const sha='c'.repeat(64),sourceUrl='https://cdn.shopify.com/s/files/1/extra.png?v=1';
const storagePath=`sync-media/${id.itemId}/${sha}.png`,storageUrl=`https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/${storagePath}`;
const angle='a0000000-0000-4000-8000-000000000009';
const review={sku:id.exactGallerySku,shopifySku:id.exactShopifySku,productId:id.productId,variantId:id.variantId,galleryId:id.itemId,imageUrl:sourceUrl,decodedSha256:sha};
const registry=()=>({items:[review],deniedUrls:[],deniedSha256:[]});
function proofs(){
 const source={product_gid:id.productId,side:'shopify',evidence_id:'s-new',asset_key:'s-media:2',content_id:sha,proof:{platformRef:'gid://shopify/MediaImage/2',url:sourceUrl,decodedSha256:sha,width:40,height:60,mime:'image/png',byteLength:200,verifiedAt:stamp,ownership:'reference_only'}};
 const copy={...source,side:'gallery',evidence_id:`gallery:${opId}:0`,proof:{...source.proof,platformRef:storagePath,url:storageUrl,ownership:'owned_storage'}};
 return{source,copy};
}
const check=(copy,source,reg=registry())=>guard.isReviewedMediaProof(id,copy,[copy,source],reg);

test('exact server-owned gallery copy follows genuine reviewed Shopify bytes without approving its URL directly',()=>{
 const {source,copy}=proofs();assert.equal(check(copy,source),true);
 assert.throws(()=>guard.requireReviewedMedia(id,storageUrl,sha,registry()),/MEDIA_REVIEW_REQUIRED/);
 assert.equal(check(copy,source,{...registry(),items:[]}),false);
 assert.equal(check(copy,source,{...registry(),items:[{...review,variantId:'gid://shopify/ProductVariant/999'}]}),false);
});

test('all supported same-byte MIME types require their exact storage extension',()=>{
 for(const [mime,extension]of [['image/png','png'],['image/jpeg','jpg'],['image/webp','webp'],['image/avif','avif']]){
  const {source,copy}=proofs(),path=`sync-media/${id.itemId}/${sha}.${extension}`;source.proof.mime=mime;copy.proof.mime=mime;copy.proof.platformRef=path;copy.proof.url=`https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/${path}`;
  assert.equal(check(copy,source),true);copy.proof.url+='x';assert.equal(check(copy,source),false);
 }
});

test('copy resolution requires explicit gallery to Shopify sides and matching product key content SHA',()=>{
 const {source,copy}=proofs();
 for(const field of ['side','product_gid','asset_key','content_id']){
  for(const value of [undefined,'wrong']){assert.equal(check({...copy,[field]:value},source),false);assert.equal(check(copy,{...source,[field]:value}),false);}
 }
 assert.equal(check({...copy,side:'shopify'},source),false);assert.equal(check(copy,{...source,side:'gallery'}),false);
 assert.equal(check({...copy,proof:{...copy.proof,decodedSha256:'d'.repeat(64)}},source),false);
 assert.equal(check(copy,{...source,proof:{...source.proof,decodedSha256:'d'.repeat(64)}}),false);
 assert.equal(guard.isReviewedMediaProof(id,copy,[copy,source,{...source,evidence_id:'another'}],registry()),false);
});

test('copy target is exact canonical item content path and MIME, never an arbitrary Supabase URL',()=>{
 const {source,copy}=proofs();
 for(const changedUrl of [storageUrl+'?x=1',storageUrl+'#x',storageUrl.replace('https:','http:'),storageUrl.replace('ekgpaoavsavrtbhlbwdg','otherproject'),storageUrl.replace(id.itemId,owner),storageUrl.replace(sha,'d'.repeat(64)),storageUrl.replace('sync-media/','other/'),storageUrl.replace('.png','.jpg'),storageUrl.replace('.supabase.co/','.supabase.co:443/'),storageUrl.replace('/sync-media/','/sync-media/%2e%2e/'),storageUrl.replace('/sync-media/','/sync-media/../sync-media/')]){
  assert.equal(check({...copy,proof:{...copy.proof,url:changedUrl}},source),false);
 }
 for(const [field,value]of [['platformRef','wrong'],['platformRef',undefined],['ownership','reference_only'],['ownership',undefined],['mime','image/jpeg'],['mime',undefined],['byteLength',201],['width',41],['height',61]])
  assert.equal(check({...copy,proof:{...copy.proof,[field]:value}},source),false);
});

test('source must be genuine Shopify reference with equal byte metadata',()=>{
 const {source,copy}=proofs();
 for(const [field,value]of [['platformRef','angle:other'],['platformRef',undefined],['ownership','owned_storage'],['ownership',undefined],['mime','image/jpeg'],['byteLength',201],['width',41],['height',61],['url','https://example.com/s/files/extra.png'],['url',sourceUrl.replace('cdn.shopify.com','cdn.shopify.com:443')],['url',sourceUrl+'#x']]){
  const changed={...source,proof:{...source.proof,[field]:value}},reg=registry();if(field==='url')reg.items=[{...review,imageUrl:value}];assert.equal(check(copy,changed,reg),false);
 }
 for(const field of ['width','height','byteLength'])for(const value of [0,-1,1.5,NaN,undefined,'200'])
  assert.equal(check({...copy,proof:{...copy.proof,[field]:value}},{...source,proof:{...source.proof,[field]:value}}),false);
});

test('malformed partial lineage never falls back to equal-byte resolution',()=>{
 const {source,copy}=proofs();
 for(const keys of [{operationId:opId},{sourceEvidenceId:'s-new'},{operationId:undefined},{sourceEvidenceId:undefined},{operationId:null,sourceEvidenceId:'s-new'},{operationId:opId,sourceEvidenceId:null}])
  assert.equal(check({...copy,proof:{...copy.proof,...keys}},source),false);
});

test('deny rules apply to both copy and genuine source before approval',()=>{
 const {source,copy}=proofs();
 for(const deniedUrl of [storageUrl,sourceUrl])assert.throws(()=>check(copy,source,{...registry(),deniedUrls:[deniedUrl]}),/MEDIA_REVIEW_REJECTED/);
 assert.throws(()=>check(copy,source,{...registry(),deniedSha256:[sha]}),/MEDIA_REVIEW_REJECTED/);
});

test('known transformed lineage retains the original parent walk, bounded cycles do not approve',()=>{
 const {source,copy}=proofs();
 const transformed={...copy,content_id:'d'.repeat(64),proof:{...copy.proof,url:'https://ekgpaoavsavrtbhlbwdg.supabase.co/transformed.png',sourceEvidenceId:'s-new',operationId:opId}};
 assert.equal(check(transformed,{...source,content_id:transformed.content_id}),true);
 assert.equal(check({...transformed,proof:{...transformed.proof,operationId:undefined}},{...source,content_id:transformed.content_id}),false);
 const cyclic={...source,proof:{...source.proof,url:'https://cdn.shopify.com/s/files/unreviewed.png',sourceEvidenceId:copy.evidence_id,operationId:opId}};
 assert.equal(check(copy,cyclic),false);
});

function scenario(afterCas=true,entries=[review]){
 const v=fixture(),{source,copy}=proofs();
 const image={id:'gid://shopify/MediaImage/2',mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',alt:'bag 2',updatedAt:stamp,image:{id:'gid://shopify/ImageSource/2',url:sourceUrl,width:40,height:60}};
 v.product.media.nodes.push(image);v.product.mediaCount.count=2;v.context.provenance.push(source);
 if(afterCas){v.context.galleryRaw.angles.push({id:angle,item_id:id.itemId,angle_key:'sync-x',image_path:storageUrl,angle_order:2,image_alt:'bag 2'});v.context.galleryRefs.push({role:'angle',angleId:angle,key:copy.asset_key,evidenceId:copy.evidence_id});v.context.provenance.push(copy);}
 const read=ready.parseMediaReadResponse({data:{product:v.product}},id),capture=captureFactory.make(entries);
 const deps={now:()=>now,capture:async(_i,u)=>u===url?v.bytes:{bytes:new Uint8Array(200),sha256:sha,width:40,height:60,mime:'image/png',byteLength:200},shopify:async()=>read,gallery:()=>({read:async()=>v.context.galleryRaw})};
 return{v,capture,run:()=>capture(v.context,owner,now+30000,deps),deps};
}

test('actual planning capture before and after Gallery CAS keeps the same reviewed product image',async()=>{
 const before=scenario(false);assert.equal((await before.run()).pair.shopify.assets.length,2);
 const after=scenario();const result=await after.run();assert.equal(result.pair.gallery.assets.length,2);assert.equal(result.pair.gallery.assets[1].key,'s-media:2');assert.equal(result.pair.gallery.assets[1].contentId,sha);
 assert.equal(after.v.context.baselines.gallery.assets.length,1); // No baseline adoption workaround.
 await assert.rejects(scenario(true,[]).run(),/MEDIA_REVIEW_REQUIRED/);
 const wrong=scenario();wrong.v.context.provenance.at(-1).proof.mime='image/jpeg';await assert.rejects(wrong.run(),/MEDIA_REVIEW_REQUIRED/);
});

test('actual product runtime final readback passes real review/capture and reaches next step without duplicating transport',async()=>{
 const s=scenario(),context=s.v.context,calls=[];let captured;
 const body={kind:'attach',target:'gallery',source:'shopify',key:'s-media:2'};
 context.operations=[{id:opId,status:'running',next_step:0,plan:{patches:[body],orders:[{target:'gallery',keys:['existing','s-media:2']}]}}];
 context.steps=[{operation_id:opId,step_index:0,status:'started',body},{operation_id:opId,step_index:1,status:'ready',body:{kind:'reorder',target:'gallery'}}];
 const planning={context:async()=>context,register:async()=>calls.push('register'),acceptFinal:async()=>{calls.push('acceptFinal');context.operations[0].next_step=1;return{status:'verified'};},begin:async()=>{calls.push('begin');context.steps[1].status='started';return{status:'started'};},commit:async()=>{calls.push('commit');return{status:'verified'};}};
 let nextPhase=false;
 const transport={acquire:async()=>({owner,expiresAt:now+120000}),release:async()=>calls.push('release'),read:async()=>({chain:nextPhase?{status:'ready',next_phase:0}:{status:'verified',next_phase:2}}),prepare:async()=>{throw Error('no reprepare');}};
 const deps={now:()=>now,environment:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},planning:()=>planning,transport:()=>transport,
 capture:async()=>{calls.push('capture');captured=await s.run();return captured;},gallery:()=>({observe:async()=>({snapshot:captured.pair.gallery})}),
 discover:async()=>({identity:id,operation:context.operations[0],step:context.steps[context.operations[0].next_step],provenance:context.provenance}),
 observer:()=>async()=>({sourceFingerprint:core.mediaSnapshotFingerprint(captured.pair.shopify),target:captured.pair.gallery,observedAt:new Date(now).toISOString()}),
 phase:async()=>{calls.push('phase');return{status:'verified',executed:true};}};
 const accepted=await runtime.reconcilePersistedMediaProduct(id.productId,{},now+40000,deps);assert.equal(accepted.verifiedCheckpoint,`${opId}:0:accepted`);assert.equal(context.operations[0].next_step,1);assert.equal(calls.includes('phase'),false);
 nextPhase=true;const next=await runtime.reconcilePersistedMediaProduct(id.productId,{},now+40000,deps);assert.equal(next.verifiedCheckpoint,`${opId}:1:phase:0`);assert.equal(calls.filter(x=>x==='begin').length,1);
 context.operations[0].next_step=2;const done=await runtime.reconcilePersistedMediaProduct(id.productId,{},now+40000,deps);assert.equal(done.status,'done');assert.equal(calls.filter(x=>x==='commit').length,1);assert.equal(calls.filter(x=>x==='phase').length,1);
});
