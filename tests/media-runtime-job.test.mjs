import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const src = name => readFileSync(`src/lib/shopify/${name}.ts`, 'utf8');
const mod = text => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(resolveImageLimits(text))).toString('base64');
const coreUrl = mod(src('media-sync-core')), core = await import(coreUrl);
const readUrl = mod(src('media-transport-read').replaceAll('from "./media-sync-core";', `from "${coreUrl}";`)), read = await import(readUrl);
const requestUrl = mod(src('media-transport-requests').replaceAll('from "./media-transport-read";', `from "${readUrl}";`)), requests = await import(requestUrl);
const intentUrl = mod(src('media-transport-journal-intent').replaceAll('from "./media-transport-read";', `from "${readUrl}";`)), intents = await import(intentUrl);
const body = stripTypeScriptTypes(resolveImageLimits(src('media-runtime-job'))).replace(/^import[\s\S]*?;\r?\n/gm, '');
const api = await import(mod(`import {mediaSnapshotFingerprint} from '${coreUrl}';
  import {assertMediaTransportRead,parseTransportMedia} from '${readUrl}';
  import {buildOwnedMediaCreate,buildOwnedMediaAssociate,buildMediaVariantReassign,buildMediaReferenceDetach,buildMediaReorder,ownedMediaFilename,stagedMediaUrl} from '${requestUrl}';
  import {buildMediaJournalIntent} from '${intentUrl}';
  const discoverMediaTransportOperation=()=>{throw Error('default discovery not invoked');};
  const readOwnedShopifyMediaNode=()=>{throw Error('default media read not invoked');};
  ${body}`));
const identity = { productId:'gid://shopify/Product/7550812619002', variantId:'gid://shopify/ProductVariant/42465754808570',
  itemId:'6f887176-e70a-44ba-b252-238f994b66ad', exactGallerySku:'P10SZV24-05J-TU', exactShopifySku:'P10SZV2405J', productHandle:'logoduck-i-טרולי' };
const time='2026-09-30T17:00:00Z', now=Date.parse(time), op='10000000-0000-4000-8000-000000000001';
const environment={VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'}, scopes={shopDomain:'toptikcoil.myshopify.com',apiVersion:'2026-07',
  publicationId:'gid://shopify/Publication/79538258170',scopes:['write_products','write_files'],observedAt:time};
const hash=n=>n.repeat(64), conn=nodes=>({nodes,pageInfo:{hasNextPage:false}}), aid=n=>`20000000-0000-4000-8000-${String(n+1).padStart(12,'0')}`;
const image=(n,url=`https://cdn.shopify.com/s/files/1/image-${n}.png`,alt='מזוודה')=>({id:`gid://shopify/MediaImage/${n}`,mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',updatedAt:time,alt,
  image:{id:`gid://shopify/ImageSource/${n}`,url,width:40,height:60}});
function raw(media, primary=1, updatedAt=time) { const m=media.find(m=>m.id===`gid://shopify/MediaImage/${primary}`);
  return read.parseMediaTransportResponse({data:{product:{id:identity.productId,handle:identity.productHandle,status:'ACTIVE',publishedOnPublication:true,updatedAt,
    mediaCount:{count:media.length,precision:'EXACT'},media:conn(media),variants:conn([{id:identity.variantId,sku:identity.exactShopifySku,
      image:m?{id:'gid://shopify/ProductImage/999',url:m.image.url}:null,media:conn(m?[{id:m.id}]:[])}])}}},identity); }
function fixture(phaseIndex=0) {
  const ref={operationId:op,step:7,phaseIndex};
  const desired={key:'a',contentId:hash('b'),alt:'מזוודה חדשה',evidenceId:'g-a'}, other={key:'b',contentId:hash('d'),alt:'מזוודה',evidenceId:'s-b'};
  const gallery={identity,side:'gallery',complete:true,revision:'g1',assets:[desired,other]};
  const shopify={identity,side:'shopify',complete:true,revision:'s1',assets:[{...desired,contentId:hash('a'),alt:'מזוודה',evidenceId:'s-a'},other]};
  const observed={gallery,shopify}, expected={gallery,shopify:{...shopify,assets:[desired,other]}};
  const sf=core.mediaSnapshotFingerprint(gallery), initial=raw([image(1),image(2)]);
  const context={identity,operationId:op,step:7,sourceFingerprint:sf,targetRevision:initial.revision};
  const filename=requests.ownedMediaFilename(context,hash('c'),'image/png'), url=`https://cdn.shopify.com/s/files/1/${filename}`;
  const created=image(3,url,desired.alt), source={identity,contentSha256:hash('c'),mime:'image/png',byteLength:400,width:40,height:60,
    url:requests.stagedMediaUrl(identity,hash('c'),'image/png'),receiptId:'g-a'};
  const create=requests.buildOwnedMediaCreate(context,source,desired.alt), createIntent=intents.buildMediaJournalIntent(create,initial,'g-a');
  const before=phaseIndex<2?initial:phaseIndex===2?raw([image(1),image(2),created]):phaseIndex===3?raw([image(1),image(2),created],3):raw([image(2),created],3);
  const guard={sourceFingerprint:sf,target:before,observedAt:time}, phases=['create_owned','associate','variant_reassign','detach_old','reorder'];
  const attempts=phases.slice(0,phaseIndex).map((phase,n)=>({operation_id:op,step_index:7,phase_index:n,phase,status:'verified',attempt_id:aid(n),request_hash:hash('e'),
    request:n===0?createIntent:{},before_guard:{sourceFingerprint:sf,target:initial,observedAt:time},after_guard:guard}));
  const artifacts=phaseIndex?[{operation_id:op,step_index:7,phase_index:0,artifact:{contentId:hash('b'),decodedSha256:hash('f'),ready:true,url,width:40,height:60,
    byteLength:399,mime:'image/png',mediaGid:created.id,filename}}]:[];
  const provenance=[{evidence_id:'g-a',product_gid:identity.productId,asset_key:'a',side:'gallery',content_id:hash('b'),proof:{platformRef:'angle-a',url:source.url,
    decodedSha256:hash('c'),mime:'image/png',width:40,height:60,byteLength:400,ownership:'owned_storage',verifiedAt:time}},
  {evidence_id:'s-a',product_gid:identity.productId,asset_key:'a',side:'shopify',content_id:hash('a'),proof:{platformRef:image(1).id}},
  {evidence_id:'s-b',product_gid:identity.productId,asset_key:'b',side:'shopify',content_id:hash('d'),proof:{platformRef:image(2).id}}];
  const discovery={identity,enabled:true,operation:{id:op,product_gid:identity.productId,status:'running',observed_pair:observed},
    step:{operation_id:op,step_index:7,status:'started',body:{kind:'replace_reference',target:'shopify',key:'a',source:'gallery'},expected_pair:expected},
    transport:{chain:{operation_id:op,step_index:7,status:'running',phases,next_phase:phaseIndex,initial_guard:{...guard,target:initial},current_guard:guard},attempts,artifacts},
    provenance,desiredSemanticSha256:hash('e')};
  return {ref,discovery,options:{environment,now,scopes,ownedMedia:{media:read.parseTransportMedia(created),observedAt:time}},before,created,create,source};
}
const assemble=f=>api.assembleMediaRuntimeJob(f.ref,f.discovery,f.options);
test('module is server-only, no writes or arbitrary GraphQL executor',()=>{ const s=src('media-runtime-job'); assert.match(s,/^import "server-only"/); assert.doesNotMatch(s,/fetch\(|\.rpc\(|\.from\(|shopifyAdminGraphql/); });
for(const [index,phase] of ['create_owned','associate','variant_reassign','detach_old','reorder'].entries()) test(`first ${phase} builds exact logical step and same execution evidence`,()=>{
  const f=fixture(index), snapshot=structuredClone(f), result=assemble(f); assert.equal(result.status,'ready'); assert.equal(result.job.request.phase,phase);
  assert.equal(result.job.request.context.step,7); assert.equal(result.job.request.context.targetRevision,f.before.revision); assert.deepEqual(result.job.before,result.evidence.before);
  assert.equal(result.recovery,false); assert.equal(result.previousAttemptId,null); assert.equal(result.requestHash,null);
  assert.equal(result.expectedContentId,index===0?hash('b'):null); assert.deepEqual(result.intent,intents.buildMediaJournalIntent(result.job.request,result.job.before,result.job.sourceEvidenceId));
  assert.deepEqual(f,snapshot); result.job.request.context.identity.exactShopifySku='changed'; assert.equal(f.discovery.identity.exactShopifySku,identity.exactShopifySku);
});
test('recovery keeps original before guard and exact request despite changed current chain snapshot',()=>{
  const f=fixture(), old=assemble(f); f.discovery.transport.attempts.push({operation_id:op,step_index:7,phase_index:0,phase:'create_owned',status:'uncertain',attempt_id:aid(0),
    request_hash:hash('e'),request:old.intent,before_guard:structuredClone(f.discovery.transport.chain.current_guard),after_guard:null});
  f.discovery.transport.chain.current_guard.target=raw([image(1),image(2)],1,'2026-09-30T17:00:01Z');
  const result=assemble(f); assert.equal(result.recovery,true); assert.equal(result.previousAttemptId,aid(0)); assert.equal(result.requestHash,hash('e'));
  assert.deepEqual(result.job.request,old.job.request); assert.deepEqual(result.evidence,old.evidence);
});
for(const phaseIndex of [1,2,3,4]) test(`phase ${phaseIndex} recovery reconstructs identical original mutation from immutable attempt`,()=>{
  const f=fixture(phaseIndex), old=assemble(f), beforeGuard=structuredClone(f.discovery.transport.chain.current_guard);
  f.discovery.transport.attempts.push({operation_id:op,step_index:7,phase_index:phaseIndex,phase:f.discovery.transport.chain.phases[phaseIndex],status:'uncertain',
    attempt_id:aid(phaseIndex),request_hash:hash('e'),request:old.intent,before_guard:beforeGuard,after_guard:null});
  f.discovery.transport.chain.status='uncertain'; f.discovery.operation.status='uncertain';
  f.discovery.transport.chain.current_guard.target=raw([image(1),image(2)],1,'2026-09-30T17:00:05Z');
  const result=assemble(f); assert.equal(result.recovery,true); assert.deepEqual(result.job.request,old.job.request); assert.deepEqual(result.evidence,old.evidence);
});
test('verified staging artifact enables create without claiming external source is owned storage',()=>{
  const f=fixture(); f.ref.phaseIndex=1; f.discovery.transport.chain.next_phase=1; f.discovery.transport.chain.phases.unshift('stage_source');
  const p=f.discovery.provenance[0].proof; p.ownership='verified_source'; p.url='https://cdn.shopify.com/s/files/1/source.png';
  f.discovery.transport.attempts=[{operation_id:op,step_index:7,phase_index:0,phase:'stage_source',status:'verified',attempt_id:aid(0),request_hash:hash('e'),request:{},before_guard:f.discovery.transport.chain.current_guard}];
  f.discovery.transport.artifacts=[{operation_id:op,step_index:7,phase_index:0,artifact:{contentId:hash('b'),decodedSha256:hash('c'),ready:true,
    url:f.source.url,storagePath:`sync-media/${identity.itemId}/${hash('c')}.png`,mime:'image/png',width:40,height:60,byteLength:400}}];
  const result=assemble(f); assert.equal(result.job.request.phase,'create_owned'); assert.equal(result.job.request.context.step,7);
  assert.equal(result.evidence.source.url,f.source.url); assert.equal(result.evidence.source.contentSha256,hash('c'));
});
test('immutable normalized request or mutation hash drift is a hold, never a new request',()=>{
  for(const change of [i=>i.mutationSha256=hash('0'),i=>i.sourceEvidenceId='s-a',i=>i.filename+='x']) {
    const f=fixture(), old=assemble(f); change(old.intent); f.discovery.transport.attempts.push({operation_id:op,step_index:7,phase_index:0,phase:'create_owned',status:'started',attempt_id:aid(0),request_hash:hash('e'),
      request:old.intent,before_guard:f.discovery.transport.chain.current_guard,after_guard:null}); assert.throws(()=>assemble(f),/MEDIA_JOB_(IMMUTABLE_REQUEST_CHANGED|PROVENANCE_MISMATCH)/);
  }
});
test('associate requires exact fresh private MediaImage node not filename or inferred ID',()=>{
  const f=fixture(1); delete f.options.ownedMedia; assert.throws(()=>assemble(f),/OWNED_NODE_REQUIRED/);
  f.options.ownedMedia={media:read.parseTransportMedia(f.created),observedAt:'2026-09-30T16:59:00Z'}; assert.throws(()=>assemble(f),/FRESH_EVIDENCE_REQUIRED/);
  f.options.ownedMedia.observedAt=time; f.options.ownedMedia.media.image.url+='?changed'; assert.throws(()=>assemble(f),/OWNED_NODE_CHANGED/);
});
test('variant assignment takes frozen before media even if supplied node changed later',()=>{
  const f=fixture(2); f.options.ownedMedia.media.updatedAt='2026-10-01T00:00:00Z'; const r=assemble(f); assert.equal(r.evidence.owned.media.updatedAt,time);
});
test('verified or conflicted phase returns terminal without file lookup or another request',()=>{
  for(const status of ['verified','conflict']) { const f=fixture(1); f.discovery.step.status=status; delete f.options.ownedMedia; delete f.options.scopes; assert.deepEqual(assemble(f),{status,identity}); }
});
test('disabled deployment never requires proofs/scopes or invents placeholder request',()=>{
  for(const env of [{}, {VERCEL_ENV:'preview',SHOPIFY_MEDIA_SYNC:'enabled_v1'}, {VERCEL_ENV:'production'}]) {
    const f=fixture(); f.options.environment=env; f.discovery.step.expected_pair=null; delete f.options.scopes; const r=assemble(f); assert.deepEqual(r,{status:'disabled',identity});
  }
  const f=fixture(); f.discovery.enabled=false; assert.equal(assemble(f).status,'disabled');
});
test('scopes are fresh fixed-shop evidence and phase-specific',()=>{
  const f=fixture(); f.options.scopes={...scopes,scopes:['write_products']}; assert.equal(assemble(f).status,'scope_missing');
  f.options.scopes={...scopes,shopDomain:'other.myshopify.com'}; assert.throws(()=>assemble(f),/SCOPE_EVIDENCE_REQUIRED/);
  f.options.scopes={...scopes,observedAt:'2026-09-30T16:59:00Z'}; assert.throws(()=>assemble(f),/FRESH_EVIDENCE_REQUIRED/);
});
test('phase indices, missing prior receipts and identity changes fail closed',()=>{
  for(const mutate of [f=>f.ref.phaseIndex=9,f=>f.discovery.transport.chain.next_phase=4,f=>f.discovery.transport.attempts=[],
    f=>f.discovery.identity={...identity,exactShopifySku:'FAKE'},f=>f.discovery.transport.artifacts[0].step_index=9,
    f=>f.discovery.provenance[0].content_id=hash('0'),f=>f.discovery.transport.attempts[0].status='uncertain']) {
    const f=fixture(1); mutate(f); assert.throws(()=>assemble(f),/MEDIA_JOB_/);
  }
});
test('source fingerprint must describe original Gallery side, not arbitrary caller hash',()=>{
  const f=fixture(); f.discovery.transport.chain.current_guard.sourceFingerprint=hash('0'); assert.throws(()=>assemble(f),/GUARD_CHANGED/);
});
test('missing or unverified staging receipt cannot authorize create',()=>{
  const f=fixture(); f.discovery.provenance[0].proof.ownership='verified_source'; assert.throws(()=>assemble(f),/STAGED_SOURCE_REQUIRED/);
});
test('direct detach preserves variant and last-image protection',()=>{
  const f=fixture(); f.discovery.step.body={kind:'detach_reference',source:'gallery',target:'shopify',key:'a'}; f.discovery.transport.chain.phases=['detach_old'];
  assert.throws(()=>assemble(f),/VARIANT_IMAGE_PROTECTED/);
});
test('already-correct reorder builds empty proposal exclusively for SQL verified no-op',()=>{
  const f=fixture(4); f.discovery.transport.chain.current_guard.target=raw([f.created,image(2)],3); const r=assemble(f);
  assert.deepEqual(r.job.request.variables.moves,[]); assert.deepEqual(r.intent.mediaGids,[f.created.id,image(2).id]);
});
test('storage phase and Gallery target are explicitly delegated, not fabricated',()=>{
  const f=fixture(); f.discovery.transport.chain.phases.unshift('stage_source'); assert.throws(()=>assemble(f),/STORAGE_PHASE_REQUIRED/);
  f.discovery.step.body.target='gallery'; assert.throws(()=>assemble(f),/NON_SHOPIFY_PHASE/);
});
test('bounded loader calls only discovery, real scopes and exact owned node when required',async()=>{
  const f=fixture(1), calls=[]; const result=await api.loadMediaRuntimeJob(f.ref,now+8000,{now:()=>now,environment,
    discover:async(ref,deadline)=>{calls.push(['discover',ref,deadline]);return f.discovery;},readScopes:async deadline=>{calls.push(['scopes',deadline]);return scopes;},
    readOwnedMedia:async(id,deadline)=>{calls.push(['media',id,deadline]);return read.parseTransportMedia(f.created);}});
  assert.equal(result.status,'ready'); assert.deepEqual(calls.map(c=>c[0]),['discover','scopes','media']); assert.equal(calls[2][1],f.created.id);
  assert.ok(calls.every(c=>c.at(-1)===now+8000));
});
test('disabled loader makes no scope or file request',async()=>{
  const f=fixture(); const result=await api.loadMediaRuntimeJob(f.ref,now+8000,{now:()=>now,environment:{},discover:async()=>f.discovery,readScopes:async()=>{throw Error('scope must not run');}});
  assert.equal(result.status,'disabled');
});
test('deadline crossing cannot start next lookup, no retry',async()=>{
  const f=fixture(1); let clock=now,calls=0; await assert.rejects(api.loadMediaRuntimeJob(f.ref,now+100,{now:()=>clock,environment,discover:async()=>f.discovery,
    readScopes:async()=>{calls++;clock=now+101;return scopes;},readOwnedMedia:async()=>{throw Error('must not run');}}),/TIME_BUDGET/); assert.equal(calls,1);
});
