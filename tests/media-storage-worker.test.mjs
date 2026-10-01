import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
Error.stackTraceLimit=0;
const src=n=>readFileSync(`src/lib/shopify/${n}.ts`,'utf8'),mod=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const coreUrl=mod(src('media-sync-core')),core=await import(coreUrl);
const rawUrl=mod(src('media-transport-read').replaceAll('from "./media-sync-core";',`from "${coreUrl}";`)),raw=await import(rawUrl);
const reqUrl=mod(src('media-transport-requests').replaceAll('from "./media-transport-read";',`from "${rawUrl}";`)),req=await import(reqUrl);
const sourceBody=stripTypeScriptTypes(src('media-source-bytes')).replace(/^import[\s\S]*?;\r?\n/gm,'');
const proofUrl=mod(`import {mediaSnapshotFingerprint} from '${coreUrl}';${sourceBody}`);
const stubUrl=mod('export function nope(){throw Error("default transport must not run in fixture");}');
const body=src('media-storage-worker').replace('import "server-only";','').replaceAll('from "./media-sync-core";',`from "${coreUrl}";`)
  .replaceAll('from "./media-transport-read";',`from "${rawUrl}";`).replaceAll('from "./media-transport-requests";',`from "${reqUrl}";`)
  .replace('import { discoverMediaTransportOperation, createMediaTransportRpc, type MediaOperationDiscovery, type MediaRpcGuard } from "./media-transport-rpc";',`import {nope as discoverMediaTransportOperation,nope as createMediaTransportRpc} from '${stubUrl}';`)
  .replace('import { uploadImmutableMedia, readImmutableMedia } from "./media-storage-transport";',`import {nope as uploadImmutableMedia,nope as readImmutableMedia} from '${stubUrl}';`)
  .replaceAll('from "./media-source-bytes";',`from "${proofUrl}";`);
const api=await import(mod(body));
const id={productId:'gid://shopify/Product/123',variantId:'gid://shopify/ProductVariant/456',itemId:'a0000000-0000-4000-8000-000000000001',exactGallerySku:'ABC',exactShopifySku:'ABC',productHandle:'abc'};
const stamp='2026-09-30T17:00:00Z',now=Date.parse(stamp),hash='a'.repeat(64),content='b'.repeat(64),owner='20000000-0000-4000-8000-000000000001';
const ref={operationId:'10000000-0000-4000-8000-000000000001',step:7,phaseIndex:0},conn=nodes=>({nodes,pageInfo:{hasNextPage:false}});
const image={id:'gid://shopify/MediaImage/1',mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',updatedAt:stamp,alt:'מזוודה',image:{id:'gid://shopify/ImageSource/1',url:'https://cdn.shopify.com/s/files/1/a.png',width:40,height:60}};
const shopRaw=raw.parseMediaTransportResponse({data:{product:{id:id.productId,handle:id.productHandle,status:'ACTIVE',publishedOnPublication:true,updatedAt:stamp,
  mediaCount:{count:1,precision:'EXACT'},media:conn([image]),variants:conn([{id:id.variantId,sku:id.exactShopifySku,image:null,media:conn([])}])}}},id);
function fixture(phase='stage_source'){
  let clock=now;const calls=[],gallery={identity:id,side:'gallery',complete:true,revision:'g1',assets:[{key:'a',contentId:content,alt:'מזוודה',evidenceId:'proof-a'}]},
    shopify={...structuredClone(gallery),side:'shopify',revision:'s1'},pair={gallery,shopify},target=phase==='stage_source'?'shopify':'gallery';
  const guard={sourceFingerprint:core.mediaSnapshotFingerprint(pair[target==='gallery'?'shopify':'gallery']),target:target==='gallery'?gallery:shopRaw,observedAt:stamp};
  const discovery={identity:id,enabled:true,operation:{id:ref.operationId,product_gid:id.productId,status:'running',observed_pair:pair},
    step:{operation_id:ref.operationId,step_index:7,status:'started',body:{kind:'replace_reference',target,key:'a'},expected_pair:pair},
    transport:{chain:{operation_id:ref.operationId,step_index:7,status:'running',next_phase:0,phases:phase==='stage_source'?['stage_source','create_owned','associate','detach_old','reorder']:['gallery_upload','gallery_cas'],current_guard:guard},attempts:[],artifacts:[]},
    provenance:[{evidence_id:'proof-a',product_gid:id.productId,asset_key:'a',side:target==='gallery'?'shopify':'gallery',content_id:content,
      proof:{url:image.image.url,decodedSha256:hash,mime:'image/png',width:40,height:60,byteLength:100,ownership:'verified_source'}}]};
  const staged={identity:id,receiptId:'proof-a',contentSha256:hash,mime:'image/png',width:40,height:60,byteLength:100,url:req.stagedMediaUrl(id,hash,'image/png')};
  const rpc={acquire:async d=>{calls.push(['acquire',d]);return {owner,expiresAt:now+120000};},release:async(...a)=>{calls.push(['release',...a]);},
    begin:async(r,o,a,intent,fresh,d)=>{calls.push(['begin',r,o,a,intent,fresh,d]);let previous=discovery.transport.attempts[0];
      if(previous)return {mayExecute:false,replayed:true,status:previous.status,requestHash:previous.request_hash};
      previous={operation_id:r.operationId,step_index:r.step,phase_index:0,phase,status:'started',attempt_id:a,request_hash:'c'.repeat(64),request:intent,before_guard:fresh};discovery.transport.attempts.push(previous);
      return {mayExecute:true,replayed:false,phase,attemptId:a,requestHash:previous.request_hash,request:intent};},
    uncertain:async(...a)=>{calls.push(['uncertain',...a]);discovery.transport.attempts[0].status='uncertain';discovery.transport.chain.status='uncertain';},
    conflict:async(...a)=>{calls.push(['conflict',...a]);},read:async(...a)=>{calls.push(['read',...a]);return structuredClone(discovery.transport);},
    accept:async(...a)=>{calls.push(['accept',...a]);discovery.transport.attempts[0].status='verified';return {status:'verified',mayExecute:false};}};
  const deps={now:()=>clock,environment:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},discover:async(...a)=>{calls.push(['discover',...a]);return structuredClone(discovery);},
    createRpc:p=>{calls.push(['factory',p]);return rpc;},readSource:async(...a)=>{calls.push(['source',...a]);return new Uint8Array(100);},upload:async(...a)=>{calls.push(['upload',...a]);return {outcome:'accepted'};},
    readUploaded:async(...a)=>{calls.push(['uploaded-read',...a]);return {sha256:hash,mime:'image/png',width:40,height:60,byteLength:100,url:staged.url,storagePath:`sync-media/${id.itemId}/${hash}.png`};}};
  const f={calls,discovery,staged,guard,rpc,deps,tick:n=>clock+=n,observe:async(...a)=>{calls.push(['observe',...a]);return structuredClone(guard);}};
  f.run=(deadline=now+60000)=>api.runPersistedStorageMediaPhase(ref,deadline,(...a)=>f.observe(...a),deps);return f;
}
for(const phase of ['stage_source','gallery_upload'])test(`${phase} one upload and exact independently read artifact accepted`,async()=>{
  const f=fixture(phase),out=await f.run();assert.deepEqual(out,{status:'verified',executed:true});assert.equal(f.calls.filter(c=>c[0]==='upload').length,1);
  const begin=f.calls.find(c=>c[0]==='begin');assert.deepEqual(begin[1],ref);assert.equal(begin[2],owner);assert.equal(begin[4].upsert,false);
  assert.deepEqual(f.calls.find(c=>c[0]==='upload')[1],f.staged);assert.equal(f.calls.find(c=>c[0]==='upload').at(-1),now+24000);
  const a=f.calls.find(c=>c[0]==='accept');assert.equal(a[4],'c'.repeat(64));assert.deepEqual(a[6],{contentId:content,decodedSha256:hash,ready:true,url:f.staged.url,
    storagePath:`sync-media/${id.itemId}/${hash}.png`,width:40,height:60,byteLength:100,mime:'image/png'});assert.equal(f.calls.at(-1)[0],'release');
});
test('feature disabled performs no reads, RPCs or uploads',async()=>{for(const env of [{},{VERCEL_ENV:'preview',SHOPIFY_MEDIA_SYNC:'enabled_v1'}]){const f=fixture();f.deps.environment=env;assert.deepEqual(await f.run(NaN),{status:'disabled',executed:false});assert.deepEqual(f.calls,[]);}});
test('expired deadline performs no discovery',async()=>{const f=fixture();await assert.rejects(f.run(now),/TIME_BUDGET/);assert.deepEqual(f.calls,[]);});
test('source decoding failure occurs before any durable mutation permit',async()=>{const f=fixture();f.deps.readSource=async()=>{throw Error('MEDIA_SOURCE_DECODE_FAILED');};await assert.rejects(f.run(),/DECODE_FAILED/);
  assert.ok(!f.calls.some(c=>['begin','upload','accept'].includes(c[0])));assert.equal(f.calls.at(-1)[0],'release');});
test('lost upload response consumes permit; 404 remains pending and resume never uploads',async()=>{
  const f=fixture();f.deps.upload=async(...a)=>{f.calls.push(['upload',...a]);throw Error('lost');};f.deps.readUploaded=async(...a)=>{f.calls.push(['uploaded-read',...a]);throw Error('MEDIA_STORAGE_READ_FAILED');};
  assert.deepEqual(await f.run(),{status:'pending',executed:true});f.calls.length=0;
  assert.deepEqual(await f.run(),{status:'pending',executed:false});assert.ok(!f.calls.some(c=>['upload','source','uncertain'].includes(c[0])));assert.equal(f.calls.filter(c=>c[0]==='uploaded-read').length,1);
});
test('lost begin reply never uploads; persisted attempt subsequently recovers read-only',async()=>{
  const f=fixture(),begin=f.rpc.begin;f.rpc.begin=async(...a)=>{await begin(...a);throw Error('lost SQL response');};await assert.rejects(f.run(),/lost SQL/);assert.ok(!f.calls.some(c=>c[0]==='upload'));
  f.rpc.begin=begin;f.calls.length=0;assert.deepEqual(await f.run(),{status:'verified',executed:false});assert.ok(!f.calls.some(c=>['upload','source'].includes(c[0])));
});
test('accepted-but-lost receipt resolves from verified record with no new upload/read',async()=>{
  const f=fixture(),accept=f.rpc.accept;f.rpc.accept=async(...a)=>{await accept(...a);throw Error('lost acceptance');};await assert.rejects(f.run(),/lost acceptance/);
  f.calls.length=0;assert.deepEqual(await f.run(),{status:'verified',executed:false});assert.deepEqual(f.calls.map(c=>c[0]),['discover']);
});
test('before-send source drift records exact conflict and never uploads',async()=>{
  const f=fixture();let reads=0;f.observe=async()=>{const g=structuredClone(f.guard);if(++reads===2)g.sourceFingerprint='d'.repeat(64);return g;};
  assert.deepEqual(await f.run(),{status:'conflict',executed:false});const c=f.calls.find(c=>c[0]==='conflict');assert.equal(c[3],'MEDIA_TRANSPORT_CHANGED_BEFORE_CALL');assert.ok(!f.calls.some(c=>c[0]==='upload'));
});
test('source drift during upload is submitted as exact SQL readback conflict',async()=>{
  const f=fixture();let reads=0;f.observe=async()=>{const g=structuredClone(f.guard);if(++reads===3)g.sourceFingerprint='d'.repeat(64);return g;};
  f.rpc.accept=async(...a)=>{f.calls.push(['accept',...a]);return {status:'conflict',mayExecute:false};};assert.deepEqual(await f.run(),{status:'conflict',executed:true});
  assert.equal(f.calls.find(c=>c[0]==='accept')[5].sourceFingerprint,'d'.repeat(64));
});
test('immutable retry intent mismatch cannot create a replacement attempt',async()=>{
  const f=fixture();f.deps.readUploaded=async()=>{throw Error('MEDIA_STORAGE_READ_FAILED');};await f.run();f.discovery.transport.attempts[0].request.mutationSha256='d'.repeat(64);f.calls.length=0;
  await assert.rejects(f.run(),/IMMUTABLE_REQUEST_CHANGED/);assert.deepEqual(f.calls.map(c=>c[0]),['discover']);
});
test('SQL cannot reauthorize an existing uncertain attempt even with a fresh UUID',async()=>{
  const f=fixture();f.deps.readUploaded=async()=>{throw Error('MEDIA_STORAGE_READ_FAILED');};await f.run();f.calls.length=0;
  f.rpc.begin=async(r,o,a,intent)=>({mayExecute:true,replayed:false,phase:'stage_source',attemptId:a,requestHash:hash,request:intent});
  await assert.rejects(f.run(),/PERMIT_INVALID/);assert.ok(!f.calls.some(c=>['upload','source'].includes(c[0])));
});
test('changed readback dimensions or SHA cannot be accepted',async()=>{for(const change of [v=>v.sha256='e'.repeat(64),v=>v.width++,v=>v.storagePath='other']){
  const f=fixture(),read=f.deps.readUploaded;f.deps.readUploaded=async(...a)=>{const v=await read(...a);change(v);return v;};await assert.rejects(f.run(),/READBACK_CHANGED/);assert.ok(!f.calls.some(c=>c[0]==='accept'));}
});
test('AVIF holds before source read or lease because bucket capability is unverified',async()=>{const f=fixture();f.discovery.provenance[0].proof.mime='image/avif';await assert.rejects(f.run(),/MIME_NOT_ENABLED/);assert.deepEqual(f.calls.map(c=>c[0]),['discover']);});
test('short lease and identity mismatch fail before source read',async()=>{
  const f=fixture();f.rpc.acquire=async()=>({owner,expiresAt:now+1000});await assert.rejects(f.run(),/LEASE_TOO_SHORT/);assert.ok(!f.calls.some(c=>c[0]==='source'));
  const g=fixture();g.discovery.operation.product_gid+='1';await assert.rejects(g.run(),/JOB_INVALID/);assert.deepEqual(g.calls.map(c=>c[0]),['discover']);
});
test('insufficient post-observation budget records not-sent instead of starting upload',async()=>{
  const f=fixture();let reads=0;f.observe=async()=>{if(++reads===2)f.tick(23500);return structuredClone(f.guard);};
  assert.deepEqual(await f.run(),{status:'conflict',executed:false});assert.equal(f.calls.find(c=>c[0]==='conflict')[3],'MEDIA_TRANSPORT_NOT_SENT_TIME_BUDGET');assert.ok(!f.calls.some(c=>c[0]==='upload'));
});
test('source intent is deterministic and never depends on generated attempt UUID',()=>{
  const f=fixture();assert.deepEqual(api.buildMediaStorageIntent(ref,'stage_source','proof-a',f.staged),api.buildMediaStorageIntent({...ref},'stage_source','proof-a',structuredClone(f.staged)));
  assert.notEqual(api.buildMediaStorageIntent({...ref,step:8},'stage_source','proof-a',f.staged).mutationSha256,api.buildMediaStorageIntent(ref,'stage_source','proof-a',f.staged).mutationSha256);
  assert.match(createHash('sha256').update('fixture').digest('hex'),/^[a-f0-9]{64}$/);
});
