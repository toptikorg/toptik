import test from 'node:test';import assert from 'node:assert/strict';
import {operation,transport,phases,binding,product,operationId,owner,staged,receipt,image,snapshot,restamp} from './helpers/group-media-fixture.mjs';
const stable=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
function memory(before=snapshot()){
 const f={graph:structuredClone(before),states:new Map(),calls:[],sent:[],clock:Date.now(),owned:new Map(),visible:true,reject:false};
 const key=r=>`${r.operationId}:${r.phaseIndex}`;
 f.state=(ref)=>{if(!f.states.has(key(ref)))f.states.set(key(ref),{status:'prepared',attemptId:null,request:null,before:structuredClone(f.graph),leaseExpiresAt:new Date(f.clock+180000).toISOString()});return f.states.get(key(ref));};
 f.ports={environment:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},now:()=>f.clock,
 readSnapshot:async()=>structuredClone(f.graph),readJob:async()=>true,
 observeOwnedFile:async(request,receiptId)=>{const owned=f.visible?structuredClone(f.owned.get(request.phaseIndex)??null):null;
  if(owned)owned.receiptId=receiptId;return owned;},
 journal:{read:async ref=>structuredClone(f.state(ref)),record:async(ref,record)=>{
  const s=f.state(ref);f.calls.push({ref:structuredClone(ref),record:structuredClone(record)});
  if(ref.productGid!==product||record.requestHash!==record.requestJson.requestHash)throw new Error('TEST_JOURNAL_IDENTITY');
  if(s.request&&!same(s.request,record.requestJson))throw new Error('TEST_JOURNAL_REUSED_REQUEST');
  if(record.action==='begin'){
   if(s.status!=='prepared')return{status:s.status,mayExecute:false};
   s.status='started';s.request=structuredClone(record.requestJson);s.attemptId=record.attemptId;
   await f.afterBegin?.(s);
   return{status:'started',mayExecute:true,leaseExpiresAt:s.leaseExpiresAt};
  }
  if(record.action==='ack'){s.ack=structuredClone(record.artifact);return{status:'started',mayExecute:false};}
  if(record.action==='uncertain'){s.status='uncertain';return{status:s.status,mayExecute:false};}
  if(record.action==='review'){s.status='review';s.request??=structuredClone(record.requestJson);s.attemptId??=record.attemptId;return{status:s.status,mayExecute:false};}
  assert.ok(['started','uncertain'].includes(s.status));
  assert.equal(s.attemptId,record.attemptId);
  const valid=record.requestJson.input.kind==='create_owned'
   ?record.artifact?.owned?.operationId===ref.operationId&&record.artifact.owned.receiptId===record.requestJson.input.source.receiptId&&record.observedGraph.fingerprint===s.before.fingerprint
   :transport.verifyGroupMediaPhase(record.requestJson,s.before,record.observedGraph)==='verified';
  s.status=valid&&!f.reject?'verified':'review';s.observedGraph=structuredClone(record.observedGraph);s.artifact=structuredClone(record.artifact);
  return{status:s.status,mayExecute:false};
 }},
 execute:async request=>{
  f.sent.push(structuredClone(request));const p=request.input;
  if(p.kind==='create_owned'){const owned=receipt(request.phaseIndex);owned.media.alt=p.alt;f.owned.set(request.phaseIndex,owned);}
  if(p.kind==='product_attach')f.graph.media.push(structuredClone(p.owned.media));
  if(p.kind==='variant_append')f.graph.variants.find(v=>v.variantGid===p.variantId).mediaIds.push(...p.mediaIds);
  if(p.kind==='variant_detach'){const v=f.graph.variants.find(v=>v.variantGid===p.variantId);v.mediaIds=v.mediaIds.filter(id=>!p.mediaIds.includes(id));}
  if(p.kind==='variant_cover'){const m=f.graph.media.find(m=>m.mediaId===p.mediaId);f.graph.variants.find(v=>v.variantGid===p.variantId).image={id:'gid://shopify/ProductImage/999',url:m.image.url};}
  if(p.kind==='product_detach')f.graph.media=f.graph.media.filter(m=>m.mediaId!==p.mediaId);
  if(p.kind==='reorder')f.graph.media=p.mediaIds.map(id=>f.graph.media.find(m=>m.mediaId===id));
  restamp(f.graph);if(f.loseResponse){f.loseResponse=false;throw new Error('GROUP_MEDIA_NETWORK_RESPONSE_LOST');}
  return p.kind==='reorder'?{jobId:'gid://shopify/Job/991'}:{};
 }};
 return f;
}
const phaseRef=index=>({productGid:product,operationId,phaseIndex:index,owner});
const propose=(before,phase,index=0)=>transport.buildGroupMediaPhase({operationId,phaseIndex:index,before,phase});
test('lost create response recovers an exact owned file and never sends a second create',async()=>{
 const before=snapshot(),f=memory(before),request=propose(before,{kind:'create_owned',source:staged,alt:'new photo'});f.loseResponse=true;f.visible=false;
 const first=await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports,{uploadKey:'upload:one'});
 assert.equal(first.status,'pending');assert.equal(f.sent.length,1);assert.equal(f.states.get(`${operationId}:0`).status,'uncertain');
 f.visible=true;
 const recovered=await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports,{uploadKey:'upload:one'});
 assert.equal(recovered.status,'verified');assert.equal(f.sent.length,1);assert.equal(recovered.artifact.uploadKey,'upload:one');assert.ok(recovered.artifact.owned.decodedSha256);
 assert.equal(recovered.artifact.owned.receiptId,staged.receiptId);
 assert.notEqual(f.states.get(`${operationId}:0`).attemptId,staged.receiptId,'dispatch attempt is distinct from immutable upload receipt');
});
test('a lost detach response uses its private source intent and full absent readback, with no second detach',async()=>{
 const before=snapshot();before.variants[0].mediaIds=[image(2).id];before.variants[0].image={id:'gid://shopify/ProductImage/102',url:image(2).image.url};restamp(before);
 const f=memory(before),request=propose(before,{kind:'product_detach',mediaId:image(1).id,protectedMediaIds:[image(3).id,image(4).id],removalIntentId:owner});f.loseResponse=true;
 assert.equal((await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports)).status,'verified');assert.equal(f.sent.length,1);
 assert.equal((await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports)).status,'verified');assert.equal(f.sent.length,1);
 assert.ok(f.graph.media.some(m=>m.mediaId===image(4).id));assert.deepEqual(f.graph.variants[2],before.variants[2]);
});

test('an acknowledged create ID cannot be replaced by another deterministic filename match',async()=>{
 const before=snapshot(),f=memory(before),request=propose(before,{kind:'create_owned',source:staged,alt:'new photo'});
 const state=f.state(phaseRef(0));state.status='started';state.request=request;state.attemptId=owner;
 state.ack={mediaId:'gid://shopify/MediaImage/999'};f.owned.set(0,receipt());
 const result=await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports,{uploadKey:'upload:one'});
 assert.equal(result.status,'review');assert.equal(f.sent.length,0);assert.equal(f.calls.at(-1).record.artifact.reason,'GROUP_MEDIA_CREATED_FILE_ID_CHANGED');
});
test('a noop reorder is verified through journal readback without any mutation',async()=>{
 const before=snapshot(),f=memory(before),request=propose(before,{kind:'reorder',mediaIds:before.media.map(m=>m.mediaId),protectedMediaIds:[image(4).id]});
 assert.equal((await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports)).status,'verified');assert.equal(f.sent.length,0);
 assert.equal(f.calls.at(-1).record.artifact.verifiedNoop,true);
});
test('source drift after the begin lock and an expiring lease both prevent dispatch',async()=>{
 for(const scenario of ['source','lease']){
  const before=snapshot(),f=memory(before),request=propose(before,{kind:'reorder',mediaIds:[image(2).id,image(1).id,image(3).id,image(4).id],protectedMediaIds:[image(4).id]});
  f.afterBegin=async s=>{if(scenario==='lease')s.leaseExpiresAt=new Date(f.clock+1000).toISOString();else{f.graph.media[3].alt='external edit';restamp(f.graph);}};
  if(scenario==='lease')await assert.rejects(operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports),/GROUP_MEDIA_LEASE_TOO_SHORT/);
  else assert.equal((await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports)).status,'review');
  assert.equal(f.sent.length,0);
 }
});
test('the SQL acceptance gate can refuse an apparently correct readback and no success is claimed',async()=>{
 const before=snapshot(),f=memory(before),request=propose(before,{kind:'variant_append',variantId:binding.variants[0].variantGid,mediaIds:[image(3).id]});f.reject=true;
 assert.equal((await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports)).status,'review');
});

test('native withdrawal after the durable permit stops for review before any outbound mutation',async()=>{
 for(const status of ['UNLISTED','DRAFT','ARCHIVED','unpublished']){
  const before=snapshot(),f=memory(before),request=propose(before,{kind:'variant_append',variantId:binding.variants[0].variantGid,mediaIds:[image(3).id]});
  f.afterBegin=async()=>{if(status==='unpublished')f.graph.product.publishedOnPublication=false;else f.graph.product.status=status;restamp(f.graph);};
  const result=await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports);
  assert.equal(result.status,'review');assert.equal(f.sent.length,0);assert.equal(f.calls.at(-1).record.action,'review');
 }
});

test('explicit native userError records actual readback for review without retry or false pending',async()=>{
 const before=snapshot(),f=memory(before),request=propose(before,{kind:'variant_append',variantId:binding.variants[0].variantGid,mediaIds:[image(3).id]});
 f.ports.execute=async()=>{f.sent.push(request);throw Error('GROUP_MEDIA_WRITE_REJECTED');};
 assert.equal((await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports)).status,'review');
 assert.equal(f.calls.at(-1).record.artifact.reason,'GROUP_MEDIA_WRITE_REJECTED');
 assert.equal((await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports)).status,'review');
 assert.equal(f.sent.length,1);
});
test('private JSONB key ordering is not request drift, while changed phase content is rejected',async()=>{
 const before=snapshot(),f=memory(before),request=propose(before,{kind:'reorder',mediaIds:before.media.map(m=>m.mediaId),protectedMediaIds:[]});
 const s=f.state(phaseRef(0));s.status='started';s.request=Object.fromEntries(Object.entries(request).reverse());s.before=Object.fromEntries(Object.entries(before).reverse());s.attemptId=owner;
 assert.equal((await operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports)).status,'verified');
 s.status='uncertain';s.request.variables={unexpected:true};await assert.rejects(operation.runGroupMediaPhase(phaseRef(0),request,before,f.clock+60000,f.ports),/GROUP_MEDIA_REQUEST_CHANGED/);
});
test('all planned native phases resume to phase verification, preserving the other color and unbound native references',async()=>{
 const before=snapshot(),f=memory(before),uploadKey=`upload:${operationId}:0`;
 const beforeManifest={variants:[{...binding.variants[0],orderedMediaIds:[image(1).id,image(2).id],coverMediaId:image(1).id},{...binding.variants[1],orderedMediaIds:[image(3).id],coverMediaId:image(3).id}]};
 const desiredManifest={globalOrder:[image(2).id,image(3).id,image(4).id,uploadKey],variants:[{...beforeManifest.variants[0],orderedMediaIds:[image(2).id,uploadKey],coverMediaId:image(2).id},beforeManifest.variants[1]]};
 const plan={requestId:operationId,itemId:binding.variants[0].itemId,uploads:[{key:uploadKey,uploadUrl:staged.url,alt:'new photo'}],beforeManifest,desiredManifest,
  removedReferences:[{itemId:binding.variants[0].itemId,variantGid:binding.variants[0].variantGid,mediaId:image(1).id}],productDetachMediaIds:[image(1).id],protectedMediaIds:[image(3).id,image(4).id],impactedItemIds:[binding.variants[0].itemId],noop:false};
 const specs=phases.buildOwnedMediaPhaseSpecs(plan,before,{[uploadKey]:staged});
 assert.deepEqual(specs.map(p=>p.kind),['create_owned','product_attach','variant_append','variant_cover','variant_detach','product_detach','reorder']);
 const op={id:operationId,productGid:product,nextPhase:0,phases:specs,cursor:before,artifacts:[]};
 const done=await operation.runOwnedMediaOperationPhases(op,owner,f.clock+180000,f.ports);
 assert.equal(done.status,'phases_verified');assert.equal(done.nextPhase,specs.length);assert.equal(done.createdMediaIdsByUploadKey[uploadKey],receipt().media.mediaId);
 assert.equal(f.sent.filter(r=>r.input.kind==='create_owned').length,1);assert.equal(f.sent.filter(r=>r.input.kind==='reorder').length,0,'already correct native order uses readback-only noop');
 assert.deepEqual(done.cursor.variants[1],before.variants[1]);assert.deepEqual(done.cursor.variants[2],before.variants[2]);
 assert.deepEqual(done.cursor.media.map(m=>m.mediaId),[image(2).id,image(3).id,image(4).id,receipt().media.mediaId]);
});
test('disabled operation does not observe, acquire or mutate anything and is not reported as complete',async()=>{
 const f=memory(),before=snapshot();f.ports.environment={VERCEL_ENV:'preview',SHOPIFY_MEDIA_SYNC:'enabled_v1'};
 const result=await operation.runOwnedMediaOperationPhases({id:operationId,productGid:product,nextPhase:0,phases:[],cursor:before,artifacts:[]},owner,f.clock+60000,f.ports);
 assert.equal(result.status,'disabled');assert.equal(f.calls.length+f.sent.length,0);
});
