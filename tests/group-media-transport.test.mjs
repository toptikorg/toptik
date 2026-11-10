import test from 'node:test';import assert from 'node:assert/strict';
import {binding,product,operationId,owner,staged,receipt,snapshot,restamp,image,transport,legacy} from './helpers/group-media-fixture.mjs';
const build=(phase,before=snapshot(),phaseIndex=1)=>transport.buildGroupMediaPhase({operationId,phaseIndex,before,phase});
test('group attach uses a verified created file and never updates global contents or alt',()=>{
 const r=build({kind:'product_attach',owned:receipt()});assert.deepEqual(r.variables.files,[{id:receipt().media.mediaId,referencesToAdd:[product]}]);assert.doesNotMatch(r.query,/fileDelete|originalSource| alt:/);
 for(const patch of [{productGid:'gid://shopify/Product/999'},{itemId:owner},{operationId:owner},{decodedSha256:'bad'},{filename:'foreign.jpg'}])assert.throws(()=>build({kind:'product_attach',owned:{...receipt(),...patch}}),/GROUP_MEDIA_OWNED_PROOF_REQUIRED/);
});
test('create owns immutable decoded bytes and deterministic filename, never a browser source URL',()=>{
 const r=build({kind:'create_owned',source:staged,alt:'צילום מדויק'},snapshot(),0);assert.equal(r.variables.files[0].duplicateResolutionMode,'RAISE_ERROR');assert.match(r.variables.files[0].filename,/^toptik-group-/);
 for(const patch of [{url:'https://example.com/a.jpg'},{itemId:owner},{sha256:'bad'},{mime:'image/avif'},{width:5001,height:5000}])assert.throws(()=>build({kind:'create_owned',source:{...staged,...patch},alt:'photo'}),/GROUP_MEDIA_STAGED_PROOF_REQUIRED/);
});
test('product detach requires private intent, protects all bound and unbound native references, and never fileDeletes',()=>{
 const before=snapshot();assert.throws(()=>build({kind:'product_detach',mediaId:image(4).id,protectedMediaIds:[],removalIntentId:owner},before),/GROUP_MEDIA_REFERENCE_PROTECTED/);
 before.variants[0].mediaIds=[image(2).id];before.variants[0].image={id:'gid://shopify/ProductImage/102',url:image(2).image.url};restamp(before);
 const r=build({kind:'product_detach',mediaId:image(1).id,protectedMediaIds:[image(3).id,image(4).id],removalIntentId:owner},before);
 assert.deepEqual(r.variables.files,[{id:image(1).id,referencesToRemove:[product]}]);assert.doesNotMatch(r.query,/fileDelete/);
 assert.throws(()=>build({kind:'product_detach',mediaId:image(1).id,protectedMediaIds:[image(1).id],removalIntentId:owner},before),/GROUP_MEDIA_REFERENCE_PROTECTED/);
});
test('variant append/detach/cover mutate only a bound native variant and cannot clear a live primary by detaching',()=>{
 const before=snapshot(),variantId=binding.variants[0].variantGid;
 before.variants[0].mediaIds=[image(1).id];restamp(before);
 assert.throws(()=>build({kind:'variant_append',variantId,mediaIds:[image(2).id,image(3).id]},before),/SINGLE_IMAGE_REQUIRED/);
 assert.throws(()=>build({kind:'variant_append',variantId,mediaIds:[image(3).id]},before),/SINGLE_IMAGE_REQUIRED/);
 const empty=structuredClone(before);empty.variants[0].mediaIds=[];empty.variants[0].image=null;restamp(empty);
 const add=build({kind:'variant_append',variantId,mediaIds:[image(3).id]},empty);assert.match(add.query,/productVariantAppendMedia/);assert.deepEqual(add.variables.variantMedia,[{variantId,mediaIds:[image(3).id]}]);
 assert.throws(()=>build({kind:'variant_append',variantId:before.variants[2].variantGid,mediaIds:[image(3).id]},before),/GROUP_MEDIA_VARIANT_NOT_BOUND/);
 assert.throws(()=>build({kind:'variant_detach',variantId,mediaIds:[image(1).id],removalIntentId:owner},before),/GROUP_MEDIA_VARIANT_IMAGE_PROTECTED/);
 assert.throws(()=>build({kind:'variant_cover',variantId,mediaId:image(99).id},before),/GROUP_MEDIA_COVER_NOT_ON_PRODUCT/);
 const cover=build({kind:'variant_cover',variantId,mediaId:image(2).id},before);assert.equal(cover.variables.variants[0].id,variantId);assert.equal(cover.variables.variants[0].mediaId,image(2).id);
});
test('reorder preserves complete membership and protected relative order, with readback-only noop',()=>{
 const before=snapshot(),mediaIds=[image(2).id,image(1).id,image(3).id,image(4).id],protectedMediaIds=[image(3).id,image(4).id];
 const r=build({kind:'reorder',mediaIds,protectedMediaIds},before);assert.match(r.query,/productReorderMedia/);assert.equal(r.variables.moves[0].newPosition,'0');
 assert.throws(()=>build({kind:'reorder',mediaIds:[image(2).id,image(1).id,image(4).id,image(3).id],protectedMediaIds},before),/GROUP_MEDIA_ORDER_CONFLICT/);
 assert.throws(()=>build({kind:'reorder',mediaIds:[image(1).id],protectedMediaIds},before),/GROUP_MEDIA_ORDER_CONFLICT/);
 const noop=build({kind:'reorder',mediaIds:before.media.map(m=>m.mediaId),protectedMediaIds},before);assert.equal(noop.readOnlyNoop,true);assert.equal(transport.verifyGroupMediaPhase(noop,before,before),'verified');
});
test('readback verifies exact complete deltas and catches another color or unbound variant being changed',()=>{
 const before=snapshot(),variantId=binding.variants[0].variantGid;before.variants[0].mediaIds=[];before.variants[0].image=null;restamp(before);
 const r=build({kind:'variant_append',variantId,mediaIds:[image(3).id]},before);
 const after=structuredClone(before);after.variants[0].mediaIds.push(image(3).id);restamp(after);assert.equal(transport.verifyGroupMediaPhase(r,before,after),'verified');
 after.variants[2].mediaIds=[];restamp(after);assert.equal(transport.verifyGroupMediaPhase(r,before,after),'review');
 assert.equal(transport.verifyGroupMediaPhase(r,before,before),'pending');
});

test('one native cover replacement follows Shopify mediaId semantics and preserves every other variant',()=>{
 const before=snapshot(),variantId=binding.variants[0].variantGid;
 before.variants[0].mediaIds=[image(1).id];restamp(before);
 const request=build({kind:'variant_cover',variantId,mediaId:image(2).id},before),after=structuredClone(before);
 after.variants[0].image={id:'gid://shopify/ProductImage/102',url:image(2).image.url};after.variants[0].mediaIds=[image(2).id];restamp(after);
 assert.equal(transport.verifyGroupMediaPhase(request,before,after),'verified');
 const extra=structuredClone(after);extra.variants[0].mediaIds.push(image(3).id);restamp(extra);assert.equal(transport.verifyGroupMediaPhase(request,before,extra),'review');
 after.variants[1].mediaIds=[];restamp(after);assert.equal(transport.verifyGroupMediaPhase(request,before,after),'review');
 const ambiguous=structuredClone(before);ambiguous.variants[0].mediaIds.push(image(2).id);restamp(ambiguous);
 assert.throws(()=>build({kind:'variant_cover',variantId,mediaId:image(3).id},ambiguous),/MEMBERSHIP_REVIEW/);
});
test('a READY attachment with different content identity or alt is review, while processing is pending',()=>{
 const before=snapshot(),owned=receipt(),r=build({kind:'product_attach',owned},before),after=structuredClone(before);after.media.push(structuredClone(owned.media));restamp(after);
 assert.equal(transport.verifyGroupMediaPhase(r,before,after),'verified');after.media.at(-1).alt='unexpected';restamp(after);assert.equal(transport.verifyGroupMediaPhase(r,before,after),'review');
 after.media.at(-1).status='PROCESSING';restamp(after);assert.equal(transport.verifyGroupMediaPhase(r,before,after),'pending');after.media[0].alt='other changed';restamp(after);assert.equal(transport.verifyGroupMediaPhase(r,before,after),'review');
});

function reorderedWithPositionTimestamps(){
 const before=snapshot();before.media=Array.from({length:16},(_,i)=>legacy.parseTransportMedia(image(i+1)));restamp(before);
 const order=[...before.media.slice(0,4),before.media[15],...before.media.slice(4,15)].map(m=>m.mediaId);
 const request=build({kind:'reorder',mediaIds:order,protectedMediaIds:[]},before),after=structuredClone(before);
 after.media=order.map(id=>structuredClone(before.media.find(m=>m.mediaId===id)));
 after.media.forEach((m,i)=>{if(before.media[i].mediaId!==m.mediaId)m.updatedAt='2026-11-10T05:56:50Z';});
 after.product.updatedAt='2026-11-10T05:56:50Z';restamp(after);
 return{before,request,after};
}
test('reorder accepts advanced timestamps only for the moved photo and its shifted neighbors',()=>{
 const{before,request,after}=reorderedWithPositionTimestamps(),original=structuredClone(before);
 assert.equal(after.media.filter((m,i)=>m.updatedAt!==before.media.find(b=>b.mediaId===m.mediaId).updatedAt&&i>=4).length,12);
 assert.notEqual(after.fingerprint,before.fingerprint,'global source fingerprint is deliberately still strict');
 assert.equal(transport.verifyGroupMediaPhase(request,before,after),'verified');assert.deepEqual(before,original);
 const equalTimes=structuredClone(after);equalTimes.media.forEach(m=>m.updatedAt=before.media.find(b=>b.mediaId===m.mediaId).updatedAt);restamp(equalTimes);
 assert.equal(transport.verifyGroupMediaPhase(request,before,equalTimes),'verified');
});
test('reorder rejects timestamp drift on unchanged-position media and decreasing or invalid moved timestamps',()=>{
 for(const mutate of[
  graph=>graph.media[0].updatedAt='2026-11-10T05:56:50Z',
  graph=>graph.media[4].updatedAt='2020-01-01T00:00:00Z',
  graph=>graph.media[4].updatedAt='not-a-timestamp',
 ]){const{before,request,after}=reorderedWithPositionTimestamps();mutate(after);restamp(after);assert.equal(transport.verifyGroupMediaPhase(request,before,after),'review');}
});
test('reorder rejects a backward microsecond step that Date.parse would truncate',()=>{
 const before=snapshot();before.media[0].updatedAt='2026-11-10T05:56:50.123999Z';restamp(before);
 const order=[before.media[1].mediaId,before.media[0].mediaId,...before.media.slice(2).map(m=>m.mediaId)];
 const request=build({kind:'reorder',mediaIds:order,protectedMediaIds:[]},before);
 const after=structuredClone(before);after.media=order.map(id=>structuredClone(before.media.find(m=>m.mediaId===id)));
 after.media[1].updatedAt='2026-11-10T05:56:50.123001Z';restamp(after);
 assert.equal(Date.parse(after.media[1].updatedAt),Date.parse(before.media[0].updatedAt));
 assert.equal(transport.verifyGroupMediaPhase(request,before,after),'review');
 after.media[1].updatedAt='2026-11-10T05:56:50.124000Z';restamp(after);
 assert.equal(transport.verifyGroupMediaPhase(request,before,after),'verified');
});
test('reorder timestamp tolerance does not permit any other media or native-variant change',()=>{
 for(const mutate of[
  graph=>graph.media[4].alt='concurrent ALT',graph=>graph.media[4].image.url+='&other=1',graph=>graph.media[4].image.id='gid://shopify/ImageSource/999',
  graph=>graph.media[4].image.width++,graph=>graph.media[4].image.height++,graph=>graph.media[4].status='PROCESSING',graph=>graph.media[4].fileStatus='FAILED',
  graph=>graph.media[4].mediaContentType='VIDEO',graph=>graph.media.splice(4,1),graph=>graph.media.push(structuredClone(graph.media[4])),
  graph=>graph.variants[0].mediaIds.pop(),graph=>graph.variants[1].image.url+='?other=1',
  graph=>{[graph.media[4],graph.media[5]]=[graph.media[5],graph.media[4]];},
 ]){const{before,request,after}=reorderedWithPositionTimestamps();mutate(after);restamp(after);assert.equal(transport.verifyGroupMediaPhase(request,before,after),'review');}
});
test('no-op reorder and other phases retain their original strict media timestamp comparison',()=>{
 const before=snapshot(),noop=build({kind:'reorder',mediaIds:before.media.map(m=>m.mediaId),protectedMediaIds:[]},before),changed=structuredClone(before);
 changed.media[0].updatedAt='2026-11-10T05:56:50Z';restamp(changed);
 assert.equal(transport.verifyGroupMediaPhase(noop,before,changed),'review');
 const owned=receipt(),attach=build({kind:'product_attach',owned},before),after=structuredClone(before);after.media.push(structuredClone(owned.media));
 after.media[0].updatedAt='2026-11-10T05:56:50Z';restamp(after);
 assert.equal(transport.verifyGroupMediaPhase(attach,before,after),'review');
});
