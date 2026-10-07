import test from 'node:test';
import assert from 'node:assert/strict';
import {mod,stripped,id,url,hash} from './helpers/media-planning-fixture.mjs';
Error.stackTraceLimit=0;
const guardUrl=mod('const manifest={items:[],deniedUrls:[],deniedSha256:[]};'+stripped('reviewed-media-guard'));
const factory=await import(mod(`import{assertReviewedCatalogMedia,assertReviewedManufacturerImport,assertReviewedMediaOperation,changedCatalogMedia,requireReviewedMedia,reviewedMediaRegistry}from'${guardUrl}';
 export function make(deps){const{loadReviewedMedia,loadReviewedMediaForItems,captureMediaSourceBytes}=deps;${stripped('reviewed-media-policy').replace(/^export /gm,'')}return{assertReviewedCatalogSave,assertReviewedPersistedMedia,assertReviewedImport};}`));
function fixture(){
 const entry={sku:id.exactGallerySku,shopifySku:id.exactShopifySku,productId:id.productId,variantId:id.variantId,galleryId:id.itemId,imageUrl:url,decodedSha256:hash};
 const state={entries:[entry],sha:hash},calls=[];
 const api=factory.make({loadReviewedMedia:async i=>{calls.push(['identity',i]);return state.entries;},loadReviewedMediaForItems:async ids=>{calls.push(['items',ids]);return state.entries;},captureMediaSourceBytes:async(i,u)=>{calls.push(['capture',i,u]);return{sha256:state.sha};}});
 const before={items:[{id:id.itemId,catalogNumber:id.exactGallerySku,shopifyLink:{variantId:id.variantId.split('/').at(-1),handle:id.productHandle},coverImagePath:url+'?old=1',angles:[]}],settings:{}};
 const next=structuredClone(before);next.items[0].angles.push({id:'new',imagePath:url});
 return{api,state,calls,before,next};
}
test('ordinary copy update stays independent of registry and source network',async()=>{
 const f=fixture();f.next=structuredClone(f.before);f.next.items[0].title='Updated copy';
 await f.api.assertReviewedCatalogSave(f.next,f.before,Date.now()+10000);assert.deepEqual(f.calls,[]);
});
test('new admin media needs exact dynamic identity and current approved bytes before CAS caller resumes',async()=>{
 const f=fixture();await f.api.assertReviewedCatalogSave(f.next,f.before,Date.now()+10000);
 assert.deepEqual(f.calls.map(c=>c[0]),['items','capture']);assert.deepEqual(f.calls[0][1],[id.itemId]);
 f.state.sha='b'.repeat(64);await assert.rejects(f.api.assertReviewedCatalogSave(f.next,f.before,Date.now()+10000),/MEDIA_REVIEW_REQUIRED/);
 f.state.entries[0].variantId='gid://shopify/ProductVariant/999';f.calls.length=0;
 await assert.rejects(f.api.assertReviewedCatalogSave(f.next,f.before,Date.now()+10000),/MEDIA_REVIEW_REQUIRED/);assert.equal(f.calls.some(c=>c[0]==='capture'),false);
});
test('dynamic approval resumes persisted attach while metadata phase has no registry dependency',async()=>{
 const f=fixture(),p={product_gid:id.productId,evidence_id:'e',asset_key:'k',content_id:hash,proof:{url,decodedSha256:hash}};
 const d={identity:id,step:{body:{kind:'attach',target:'gallery',key:'k'},expected_pair:{gallery:{assets:[{key:'k',evidenceId:'e',contentId:hash}]}}},provenance:[p]};
 await f.api.assertReviewedPersistedMedia(d,Date.now()+10000);assert.equal(f.calls.length,1);
 f.state.entries[0].sku='OTHER';await assert.rejects(f.api.assertReviewedPersistedMedia(d,Date.now()+10000),/MEDIA_REVIEW_REQUIRED/);
 f.calls.length=0;d.step.body.kind='alt';await f.api.assertReviewedPersistedMedia(d,Date.now()+10000);assert.deepEqual(f.calls,[]);
});
