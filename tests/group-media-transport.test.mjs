import test from 'node:test';import assert from 'node:assert/strict';
import {binding,product,operationId,owner,staged,receipt,snapshot,restamp,image,transport} from './helpers/group-media-fixture.mjs';
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
 const add=build({kind:'variant_append',variantId,mediaIds:[image(3).id]},before);assert.match(add.query,/productVariantAppendMedia/);assert.deepEqual(add.variables.variantMedia,[{variantId,mediaIds:[image(3).id]}]);
 assert.throws(()=>build({kind:'variant_append',variantId:before.variants[2].variantGid,mediaIds:[image(3).id]},before),/GROUP_MEDIA_VARIANT_NOT_BOUND/);
 assert.throws(()=>build({kind:'variant_detach',variantId,mediaIds:[image(1).id],removalIntentId:owner},before),/GROUP_MEDIA_VARIANT_IMAGE_PROTECTED/);
 assert.throws(()=>build({kind:'variant_cover',variantId,mediaId:image(3).id},before),/GROUP_MEDIA_COVER_NOT_ASSIGNED/);
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
 const before=snapshot(),variantId=binding.variants[0].variantGid,r=build({kind:'variant_append',variantId,mediaIds:[image(3).id]},before);
 const after=structuredClone(before);after.variants[0].mediaIds.push(image(3).id);restamp(after);assert.equal(transport.verifyGroupMediaPhase(r,before,after),'verified');
 after.variants[2].mediaIds=[];restamp(after);assert.equal(transport.verifyGroupMediaPhase(r,before,after),'review');
 assert.equal(transport.verifyGroupMediaPhase(r,before,before),'pending');
});
test('a READY attachment with different content identity or alt is review, while processing is pending',()=>{
 const before=snapshot(),owned=receipt(),r=build({kind:'product_attach',owned},before),after=structuredClone(before);after.media.push(structuredClone(owned.media));restamp(after);
 assert.equal(transport.verifyGroupMediaPhase(r,before,after),'verified');after.media.at(-1).alt='unexpected';restamp(after);assert.equal(transport.verifyGroupMediaPhase(r,before,after),'review');
 after.media.at(-1).status='PROCESSING';restamp(after);assert.equal(transport.verifyGroupMediaPhase(r,before,after),'pending');after.media[0].alt='other changed';restamp(after);assert.equal(transport.verifyGroupMediaPhase(r,before,after),'review');
});
