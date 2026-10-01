import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
Error.stackTraceLimit=0;
const url=source=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const source=name=>readFileSync(new URL(`../src/lib/shopify/${name}.ts`,import.meta.url),'utf8');
const core=url(source('media-sync-core'));
const readUrl=url(source('media-transport-read').replaceAll('from "./media-sync-core";',`from "${core}";`));
const requestsUrl=url(source('media-transport-requests').replaceAll('from "./media-transport-read";',`from "${readUrl}";`));
const intentUrl=url(source('media-transport-journal-intent').replaceAll('from "./media-transport-read";',`from "${readUrl}";`));
const read=await import(readUrl), requests=await import(requestsUrl), intents=await import(intentUrl);
const {recoverShopifyMediaPhase}=await import(url(source('media-transport-recovery')
  .replaceAll('from "./media-transport-read";',`from "${readUrl}";`)
  .replaceAll('from "./media-transport-requests";',`from "${requestsUrl}";`)
  .replaceAll('from "./media-transport-journal-intent";',`from "${intentUrl}";`)));
const now=Date.parse('2026-09-30T17:00:00Z'),time=new Date(now).toISOString();
const identity={productId:'gid://shopify/Product/7550812619002',variantId:'gid://shopify/ProductVariant/42465754808570',
  itemId:'6f887176-e70a-44ba-b252-238f994b66ad',exactGallerySku:'P10SZV24-05J-TU',exactShopifySku:'P10SZV2405J',productHandle:'logoduck-i-טרולי'};
const owner='10000000-0000-4000-8000-000000000002';
const image=n=>({id:`gid://shopify/MediaImage/${n}`,mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',alt:'מזוודה',updatedAt:time,
  image:{id:`gid://shopify/ImageSource/${n}`,url:`https://cdn.shopify.com/s/files/1/0645/image-${n}.jpg?v=1`,width:40,height:60}});
const connection=nodes=>({nodes,pageInfo:{hasNextPage:false}});
function raw(media=[image(1),image(2)],variant=image(1)){
  return {data:{product:{id:identity.productId,handle:identity.productHandle,status:'ACTIVE',publishedOnPublication:true,updatedAt:time,
    mediaCount:{count:media.length,precision:'EXACT'},media:connection(media),variants:connection([{id:identity.variantId,sku:identity.exactShopifySku,
      image:variant?{id:'gid://shopify/ProductImage/999',url:variant.image.url}:null,media:connection(variant?[{id:variant.id}]:[])}])}}};
}
const parse=value=>read.parseMediaTransportResponse(value,identity);
function fixture(phase='create_owned'){
  const operationId='10000000-0000-4000-8000-000000000001',ref={operationId,step:0,phaseIndex:1};
  let before=parse(raw()); const context={identity,operationId,step:0,sourceFingerprint:'a'.repeat(64),targetRevision:before.revision};
  const staged={identity,contentSha256:'b'.repeat(64),mime:'image/jpeg',byteLength:1000,width:40,height:60,
    url:requests.stagedMediaUrl(identity,'b'.repeat(64),'image/jpeg'),receiptId:'stage-proof'};
  const filename=requests.ownedMediaFilename(context,staged.contentSha256,staged.mime),newImage=image(3);
  newImage.image.url=`https://cdn.shopify.com/s/files/1/0645/${filename}?v=1`;
  const media=read.parseTransportMedia(newImage),decoded={mediaGid:media.mediaId,url:media.image.url,width:40,height:60,byteLength:999,mime:'image/jpeg',sha256:'c'.repeat(64)};
  const owned={identity,operationId,step:0,sourceFingerprint:context.sourceFingerprint,filename,sourceSha256:staged.contentSha256,
    mime:staged.mime,alt:'מזוודה',media,decodedSha256:decoded.sha256,decodedByteLength:decoded.byteLength,receiptId:'owned-proof'};
  let request,evidence,after;
  if(phase==='create_owned'){request=requests.buildOwnedMediaCreate(context,staged,'מזוודה');evidence={phase,before,source:staged,alt:'מזוודה'};after=before;}
  if(phase==='associate'){request=requests.buildOwnedMediaAssociate(context,before,owned);evidence={phase,before,owned};after=parse(raw([image(1),image(2),newImage]));}
  if(phase==='variant_reassign'){
    before=parse(raw([image(1),image(2),newImage]));context.targetRevision=before.revision;
    request=requests.buildMediaVariantReassign(context,before,image(1).id,owned);evidence={phase,before,owned,oldMediaId:image(1).id};after=parse(raw([image(1),image(2),newImage],newImage));
  }
  if(phase==='detach_old'){request=requests.buildMediaReferenceDetach(context,before,image(2).id,phase);evidence={phase,before,oldMediaId:image(2).id};after=parse(raw([image(1)]));}
  if(phase==='reorder'){request=requests.buildMediaReorder(context,before,[image(2).id,image(1).id]);evidence={phase,before,desiredIds:[image(2).id,image(1).id]};after=parse(raw([image(2),image(1)]));}
  const job={request,before,sourceEvidenceId:'source-proof',enabled:true,scopes:['write_products','write_themes']};
  const guard=target=>({sourceFingerprint:context.sourceFingerprint,target,observedAt:time});
  const journal={chain:{operation_id:operationId,step_index:0,next_phase:1,phases:['stage_source',phase],status:'uncertain'},
    attempts:[{operation_id:operationId,step_index:0,phase_index:1,phase,status:'uncertain',request_hash:'d'.repeat(64),
      before_guard:structuredClone(guard(before)),request:intents.buildMediaJournalIntent(request,before,'source-proof')}],artifacts:[]};
  const calls=[];let clock=now;
  const deps={now:()=>clock,readJournal:async()=>{calls.push('journal');return structuredClone(journal);},
    observe:async()=>{calls.push('observe');return guard(after);},
    readDecodedOwned:async(...args)=>{calls.push(['decode',...args]);return {filename,media,decoded};},
    accept:async(...args)=>{calls.push(['accept',...args]);return {status:'verified',mayExecute:false};}};
  const f={ref,job,evidence,journal,deps,calls,decoded,media,newImage,before,guard,
    setAfter:value=>{after=value;},tick:ms=>{clock+=ms;}};
  f.run=(content='e'.repeat(64),deadline=now+1000)=>recoverShopifyMediaPhase(ref,owner,job,evidence,content,deadline,deps);
  return f;
}
test('lost create response is found and decoded without a second mutation; target reread follows decode',async()=>{
  const f=fixture();assert.deepEqual(await f.run(),{status:'verified'});
  assert.deepEqual(f.calls.map(x=>Array.isArray(x)?x[0]:x),['journal','decode','observe','accept']);
  const c=f.calls.at(-1);assert.equal(c[4],'d'.repeat(64));assert.equal(c[6].decodedSha256,'c'.repeat(64));
  assert.equal(c[6].contentId,'e'.repeat(64));assert.notEqual(c[6].decodedSha256,f.evidence.source.contentSha256);
});
for(const phase of ['associate','variant_reassign','detach_old','reorder'])test(`${phase}: complete changed state is passed to SQL for exact delta acceptance`,async()=>{
  const f=fixture(phase);assert.deepEqual(await f.run(null),{status:'verified'});assert.equal(f.calls.at(-1)[6],null);
});
for(const phase of ['associate','variant_reassign','detach_old','reorder'])test(`${phase}: unchanged state stays pending and cannot dispatch`,async()=>{
  const f=fixture(phase);f.setAfter(f.before);assert.deepEqual(await f.run(null),{status:'pending'});assert.equal(f.calls.length,2);
});
test('missing owned file stays pending, not duplicate create or success',async()=>{
  const f=fixture();f.deps.readDecodedOwned=async()=>null;assert.deepEqual(await f.run(),{status:'pending'});assert.deepEqual(f.calls,['journal']);
});
test('known processing read stays pending',async()=>{
  const f=fixture();f.deps.readDecodedOwned=async()=>{throw Error('MEDIA_TRANSPORT_NOT_READY');};assert.deepEqual(await f.run(),{status:'pending'});
});
test('processing filename lookup without image stays pending, not failed or retried',async()=>{
  const f=fixture();f.deps.readDecodedOwned=async()=>{throw Error('MEDIA_TRANSPORT_RECOVERY_PENDING');};
  assert.deepEqual(await f.run(),{status:'pending'});assert.deepEqual(f.calls,['journal']);
});
for(const [name,edit] of [
  ['alt',f=>f.evidence.alt='other alt'],
  ['source bytes',f=>{f.evidence.source.contentSha256='f'.repeat(64);f.evidence.source.url=requests.stagedMediaUrl(identity,'f'.repeat(64),f.evidence.source.mime);}],
  ['source MIME',f=>{f.evidence.source.mime='image/png';f.evidence.source.url=requests.stagedMediaUrl(identity,f.evidence.source.contentSha256,'image/png');}],
])test(`changed create ${name} cannot be read back as the frozen request`,async()=>{
  const f=fixture();edit(f);await assert.rejects(f.run(),/MEDIA_RECOVERY_EXECUTION_EVIDENCE_CHANGED/);assert.deepEqual(f.calls,[]);
});
test('changed desired reorder does not bypass immutable request via unchanged journal',async()=>{
  const f=fixture('reorder');f.evidence.desiredIds=[image(1).id,image(2).id];
  await assert.rejects(f.run(),/MEDIA_RECOVERY_EXECUTION_EVIDENCE_CHANGED/);assert.deepEqual(f.calls,[]);
});
test('decode failure is not recast as absence or retried',async()=>{
  const f=fixture();f.deps.readDecodedOwned=async()=>{throw Error('MEDIA_DECODE_INVALID');};await assert.rejects(f.run(),/MEDIA_DECODE_INVALID/);assert.deepEqual(f.calls,['journal']);
});
test('new association can finish processing later without overwriting or accepting prematurely',async()=>{
  const f=fixture('associate');const pending={...f.newImage,status:'PROCESSING',fileStatus:'PROCESSING',image:null};
  f.setAfter(parse(raw([image(1),image(2),pending])));assert.deepEqual(await f.run(null),{status:'pending'});assert.equal(f.calls.length,2);
});
test('source drift is submitted to SQL conflict policy even if target unchanged',async()=>{
  const f=fixture('associate');f.deps.observe=async()=>({...f.guard(f.before),sourceFingerprint:'f'.repeat(64)});
  f.deps.accept=async(...args)=>{f.calls.push(['accept',...args]);return {status:'conflict',mayExecute:false};};
  assert.deepEqual(await f.run(null),{status:'conflict'});assert.equal(f.calls.at(-1)[5].sourceFingerprint,'f'.repeat(64));
});
test('changed unrelated image is not ignored: exact SQL acceptance can hold it',async()=>{
  const f=fixture('associate');const other=image(2);other.alt='external edit';f.setAfter(parse(raw([image(1),other,f.newImage])));
  f.deps.accept=async()=>({status:'conflict',mayExecute:false});assert.deepEqual(await f.run(),{status:'conflict'});
});
test('already verified attempt needs no network reread or mutation',async()=>{
  const f=fixture();f.journal.attempts[0].status='verified';assert.deepEqual(await f.run(),{status:'verified'});assert.deepEqual(f.calls,['journal']);
});
for(const [name,edit] of [
  ['original request',f=>f.journal.attempts[0].request.filename='forged'],
  ['original source',f=>f.journal.attempts[0].before_guard.sourceFingerprint='f'.repeat(64)],
  ['original target',f=>f.journal.attempts[0].before_guard.target.revision='f'.repeat(64)],
  ['wrong phase',f=>f.journal.attempts[0].phase='reorder'],
  ['missing attempt',f=>f.journal.attempts=[]],
  ['duplicate attempts',f=>f.journal.attempts.push(structuredClone(f.journal.attempts[0]))],
])test(`rejects ${name} before recovery evidence`,async()=>{const f=fixture();edit(f);await assert.rejects(f.run(),/MEDIA_RECOVERY_/);assert.deepEqual(f.calls,['journal']);});
for(const [name,edit] of [
  ['wrong media identity',f=>f.decoded.mediaGid='gid://shopify/MediaImage/888'],
  ['wrong image URL',f=>f.decoded.url='https://cdn.shopify.com/s/files/other.jpg'],
  ['bad digest',f=>f.decoded.sha256='not-hash'],
  ['pixel mismatch',f=>f.decoded.width++],
  ['oversize bytes',f=>f.decoded.byteLength=9*1024*1024],
  ['wrong alt',f=>f.media.alt='changed'],
])test(`rejects ${name} without SQL acceptance`,async()=>{const f=fixture();edit(f);await assert.rejects(f.run(),/MEDIA_RECOVERY_DECODE_INVALID/);assert.equal(f.calls.length,2);});
test('expired or stale observations cannot accept',async()=>{
  const f=fixture('reorder');f.deps.observe=async()=>({...f.guard(f.before),observedAt:'2020-01-01T00:00:00Z'});
  await assert.rejects(f.run(null),/GUARD_INVALID/);
  const g=fixture();await assert.rejects(g.run(null,now),/TIME_BUDGET/);assert.equal(g.calls.length,0);
});
test('late read expires before decode or SQL acceptance',async()=>{
  const f=fixture();f.deps.readJournal=async()=>{f.tick(1001);return f.journal;};await assert.rejects(f.run(),/TIME_BUDGET/);assert.equal(f.calls.length,0);
});
test('lost SQL acceptance reply propagates; later invocation reads verified receipt without another Shopify call',async()=>{
  const f=fixture('reorder');f.deps.accept=async()=>{f.journal.attempts[0].status='verified';throw Error('network');};
  await assert.rejects(f.run(),/network/);f.calls.length=0;assert.deepEqual(await f.run(),{status:'verified'});assert.deepEqual(f.calls,['journal']);
});
test('invalid SQL acceptance response cannot be reported verified',async()=>{
  const f=fixture('reorder');f.deps.accept=async()=>({status:'verified',mayExecute:true});await assert.rejects(f.run(),/ACCEPT_INVALID/);
});
