import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
Error.stackTraceLimit=0;
const src=name=>readFileSync(`src/lib/shopify/${name}.ts`,'utf8');
const mod=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const coreUrl=mod(src('media-sync-core')),core=await import(coreUrl);
const readUrl=mod(src('media-transport-read').replaceAll('from "./media-sync-core";',`from "${coreUrl}";`)),read=await import(readUrl);
const reqUrl=mod(src('media-transport-requests').replaceAll('from "./media-transport-read";',`from "${readUrl}";`)),requests=await import(reqUrl);
const intentUrl=mod(src('media-transport-journal-intent').replaceAll('from "./media-transport-read";',`from "${readUrl}";`));
const imports=s=>s.replaceAll('from "./media-transport-read";',`from "${readUrl}";`).replaceAll('from "./media-transport-requests";',`from "${reqUrl}";`).replaceAll('from "./media-transport-journal-intent";',`from "${intentUrl}";`);
const {runMediaTransportPhase}=await import(mod(imports(src('media-transport-worker'))));
const {recoverShopifyMediaPhase}=await import(mod(imports(src('media-transport-recovery'))));
const runtime=stripTypeScriptTypes(src('media-runtime')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const {make}=await import(mod(`export function make(deps){const {mediaSnapshotFingerprint,loadMediaRuntimeJob,readMediaRuntimeScopes,createMediaTransportRpc,
  readShopifyMediaTransport,executeShopifyMediaTransport,readDecodedOwnedShopifyMedia,readGalleryMediaSnapshot,runMediaTransportPhase,recoverShopifyMediaPhase,process,Date}=deps;
  ${runtime};return runPersistedShopifyMediaPhase;}`));
const identity={productId:'gid://shopify/Product/7550812619002',variantId:'gid://shopify/ProductVariant/42465754808570',itemId:'6f887176-e70a-44ba-b252-238f994b66ad',
  exactGallerySku:'P10SZV24-05J-TU',exactShopifySku:'P10SZV2405J',productHandle:'logoduck-i-טרולי'};
const stamp='2026-09-30T17:00:00Z',now=Date.parse(stamp),hash='a'.repeat(64),owner='20000000-0000-4000-8000-000000000001';
const ref={operationId:'10000000-0000-4000-8000-000000000001',step:7,phaseIndex:0};
const conn=nodes=>({nodes,pageInfo:{hasNextPage:false}});
const image=(n,url=`https://cdn.shopify.com/s/files/1/${n}.png`)=>({id:`gid://shopify/MediaImage/${n}`,mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',updatedAt:stamp,alt:'מזוודה',
  image:{id:`gid://shopify/ImageSource/${n}`,url,width:40,height:60}});
function parseRaw(media=[image(1)]){return read.parseMediaTransportResponse({data:{product:{id:identity.productId,handle:identity.productHandle,status:'ACTIVE',publishedOnPublication:true,updatedAt:stamp,
  mediaCount:{count:media.length,precision:'EXACT'},media:conn(media),variants:conn([{id:identity.variantId,sku:identity.exactShopifySku,image:null,media:conn([])}])}}},identity);}
function fixture(){
  let clock=now,attempt=null,guard=null,intent=null;
  const calls=[],before=parseRaw(),gallery={identity,side:'gallery',revision:'gallery-1',complete:true,assets:[{key:'a',contentId:hash,alt:'מזוודה',evidenceId:'g-a'}]};
  const context={identity,operationId:ref.operationId,step:7,sourceFingerprint:core.mediaSnapshotFingerprint(gallery),targetRevision:before.revision};
  const source={identity,contentSha256:hash,mime:'image/png',byteLength:100,width:40,height:60,url:requests.stagedMediaUrl(identity,hash,'image/png'),receiptId:'g-a'};
  const request=requests.buildOwnedMediaCreate(context,source,'מזוודה'),evidence={phase:'create_owned',before,source,alt:'מזוודה'};
  const job={request,before,sourceEvidenceId:'g-a',enabled:true,scopes:['write_files']},loaded={status:'ready',identity,job,evidence,expectedContentId:hash};
  const filename=requests.ownedMediaFilename(context,hash,'image/png'),created=image(2,`https://cdn.shopify.com/s/files/1/${filename}`),media=read.parseTransportMedia(created);
  const rpc={
    acquire:async until=>{calls.push(['acquire',until]);return {owner,expiresAt:now+120000};},
    release:async(...args)=>{calls.push(['release',...args]);},
    begin:async(r,o,a,i,g,d)=>{calls.push(['begin',r,o,a,i,g,d]);attempt=a;intent=i;guard=g;return {mayExecute:true,replayed:false,phase:'create_owned',attemptId:a,requestHash:hash,request:i};},
    uncertain:async(...args)=>{calls.push(['uncertain',...args]);},
    conflict:async(...args)=>{calls.push(['conflict',...args]);},
    read:async(...args)=>{calls.push(['read',...args]);return {chain:{operation_id:ref.operationId,step_index:7,next_phase:0,phases:['create_owned'],status:'uncertain'},
      attempts:[{operation_id:ref.operationId,step_index:7,phase_index:0,phase:'create_owned',attempt_id:attempt,status:'uncertain',request_hash:hash,request:intent,before_guard:guard}],artifacts:[]};},
    accept:async(...args)=>{calls.push(['accept',...args]);return {status:'verified',mayExecute:false};},
  };
  const deps={mediaSnapshotFingerprint:core.mediaSnapshotFingerprint,runMediaTransportPhase,recoverShopifyMediaPhase,
    process:{env:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'}},
    Date:class extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}},
    readMediaRuntimeScopes:async()=>{throw Error('scope reader should be passed to actual loader');},
    loadMediaRuntimeJob:async(...args)=>{calls.push(['load',...args]);return loaded;},
    createMediaTransportRpc:id=>{calls.push(['factory',id]);return rpc;},
    readShopifyMediaTransport:async(...args)=>{calls.push(['shopify-read',...args]);return before;},
    executeShopifyMediaTransport:async(...args)=>{calls.push(['execute',...args]);return {data:{fileCreate:{files:[created],userErrors:[]}}};},
    readDecodedOwnedShopifyMedia:async(...args)=>{calls.push(['decode',...args]);return {filename,media,decoded:{mediaGid:media.mediaId,url:media.image.url,width:40,height:60,byteLength:100,mime:'image/png',sha256:hash}};},
  };
  const f={calls,loaded,job,evidence,source,before,gallery,deps,rpc,clock:()=>clock,tick:ms=>clock+=ms,
    readGallery:async(...args)=>{calls.push(['gallery-read',...args]);return structuredClone(gallery);}};
  f.run=(deadline=now+60000)=>make(deps)(ref,deadline,(...args)=>f.readGallery(...args));return f;
}

test('default source is the concrete Gallery snapshot service adapter',async()=>{
  const f=fixture();f.deps.readGalleryMediaSnapshot=(...args)=>f.readGallery(...args);
  assert.deepEqual(await make(f.deps)(ref,now+60000),{status:'verified',executed:true});
  assert.ok(f.calls.filter(c=>c[0]==='gallery-read').length>=2);
});
test('real phase worker and real recovery complete one permitted call with correct service ports',async()=>{
  const f=fixture();assert.deepEqual(await f.run(),{status:'verified',executed:true});
  assert.equal(f.calls.filter(c=>c[0]==='execute').length,1);
  const load=f.calls.find(c=>c[0]==='load');assert.deepEqual(load[1],ref);assert.equal(load[2],now+29000);assert.equal(load[3].readScopes,f.deps.readMediaRuntimeScopes);
  assert.deepEqual(f.calls.find(c=>c[0]==='factory'),['factory',identity.productId]);
  const begin=f.calls.find(c=>c[0]==='begin');assert.deepEqual(begin[1],ref);assert.equal(begin[2],owner);assert.equal(begin[6],now+29000);
  const execute=f.calls.find(c=>c[0]==='execute');assert.deepEqual(execute.slice(1),[f.job.request,f.evidence,now+25000]);
  const uncertain=f.calls.find(c=>c[0]==='uncertain');assert.deepEqual(uncertain.slice(1),[ref,owner,{outcome:'accepted',mediaGid:'gid://shopify/MediaImage/2'},now+29000]);
  const decoded=f.calls.find(c=>c[0]==='decode');assert.deepEqual(decoded.slice(1),[f.job.request.context,hash,'image/png',null,now+29000]);
  const accepted=f.calls.find(c=>c[0]==='accept');assert.deepEqual(accepted[1],ref);assert.equal(accepted[2],owner);assert.equal(accepted[4],hash);assert.equal(accepted[6].contentId,hash);assert.equal(accepted[7],now+29000);
  assert.deepEqual(f.calls.at(-1),['release',owner,now+30000]);
  for(const c of f.calls.filter(c=>['gallery-read','shopify-read'].includes(c[0])))assert.deepEqual(c.slice(1),[identity,now+29000]);
});
test('disabled flag or preview returns without any IO, even malformed unused deadline',async()=>{
  for(const env of [{},{VERCEL_ENV:'preview',SHOPIFY_MEDIA_SYNC:'enabled_v1'},{VERCEL_ENV:'production'}]){const f=fixture();f.deps.process.env=env;
    assert.deepEqual(await f.run(NaN),{status:'disabled',executed:false});assert.deepEqual(f.calls,[]);}
});
test('invalid or elapsed enabled deadline rejects before loading',async()=>{for(const deadline of [NaN,Infinity,now]){const f=fixture();await assert.rejects(f.run(deadline),/TIME_BUDGET/);assert.deepEqual(f.calls,[]);}});
test('initial loading consumes shared budget; no new 30 second worker window or late lease',async()=>{
  const f=fixture();f.deps.loadMediaRuntimeJob=async(...args)=>{f.calls.push(['load',...args]);f.tick(29500);return f.loaded;};
  await assert.rejects(f.run(),/TIME_BUDGET/);assert.ok(!f.calls.some(c=>c[0]==='acquire'));assert.ok(!f.calls.some(c=>c[0]==='execute'));
});
for(const status of ['disabled','scope_missing','verified','conflict'])test(`loader ${status} exits before RPC factory or lease`,async()=>{
  const f=fixture();f.loaded.status=status;assert.deepEqual(await f.run(),{status,executed:false});assert.deepEqual(f.calls.map(c=>c[0]),['load']);
});
test('busy lease returns without reading products or executing',async()=>{const f=fixture();f.rpc.acquire=async()=>null;
  assert.deepEqual(await f.run(),{status:'lease_busy',executed:false});assert.deepEqual(f.calls.map(c=>c[0]),['load','factory']);});
test('Gallery change around Shopify read rejects before reserving a mutation',async()=>{
  const f=fixture();let reads=0;f.readGallery=async(...args)=>{f.calls.push(['gallery-read',...args]);const g=structuredClone(f.gallery);if(++reads===2)g.assets[0].alt='edited';return g;};
  await assert.rejects(f.run(),/SOURCE_CHANGED_DURING_READ/);assert.ok(!f.calls.some(c=>['begin','execute','accept'].includes(c[0])));assert.equal(f.calls.at(-1)[0],'release');
});
for(const side of ['gallery','shopify'])test(`${side} identity drift cannot reach begin`,async()=>{
  const f=fixture();if(side==='gallery')f.readGallery=async()=>({...f.gallery,identity:{...identity,exactGallerySku:'OTHER'}});
  else f.deps.readShopifyMediaTransport=async()=>({...f.before,identity:{...identity,exactShopifySku:'OTHER'}});
  await assert.rejects(f.run(),/IDENTITY|VARIANT|READ_CHANGED|OBSERVATION/);assert.ok(!f.calls.some(c=>['begin','execute'].includes(c[0])));assert.equal(f.calls.at(-1)[0],'release');
});
test('source change after permit triggers only exact pre-send conflict',async()=>{
  const f=fixture();let reads=0;f.readGallery=async()=>{const g=structuredClone(f.gallery);if(++reads>=3)g.assets[0].alt='later';return g;};
  assert.deepEqual(await f.run(),{status:'conflict',executed:false});assert.ok(!f.calls.some(c=>c[0]==='execute'));
  const c=f.calls.find(c=>c[0]==='conflict');assert.deepEqual(c.slice(1,4),[ref,owner,'MEDIA_TRANSPORT_CHANGED_BEFORE_CALL']);assert.equal(c.at(-1),now+29000);
});
test('lost send response records uncertainty once and never reruns execution',async()=>{
  const f=fixture();f.deps.executeShopifyMediaTransport=async(...args)=>{f.calls.push(['execute',...args]);throw Error('lost');};
  assert.deepEqual(await f.run(),{status:'pending',executed:true});assert.equal(f.calls.filter(c=>c[0]==='execute').length,1);
  assert.deepEqual(f.calls.find(c=>c[0]==='uncertain').slice(1),[ref,owner,{outcome:'unknown'},now+29000]);assert.ok(!f.calls.some(c=>c[0]==='accept'));
});
test('runtime port binding rejects swapped references and product IDs before calling RPC',async()=>{
  const f=fixture();f.deps.runMediaTransportPhase=async(r,d,p)=>{
    for(const action of [()=>p.load({...r,step:8},d),()=>p.acquire(identity.productId+'1',d),()=>p.release(identity.productId+'1',owner,d),
      ()=>p.begin({...r,phaseIndex:1},owner,owner,{},null,d),()=>p.uncertain({...r,operationId:owner},owner,{},d),()=>p.conflict({...r,step:8},owner,'x',null,d),
      ()=>p.recover({...r,step:8},owner,f.job,d)])await assert.rejects(action(),/MEDIA_RUNTIME_(IDENTITY|REFERENCE)_CHANGED/);
    return {status:'pending',executed:false};};
  assert.deepEqual(await f.run(),{status:'pending',executed:false});assert.deepEqual(f.calls.map(c=>c[0]),['load','factory']);
});
test('fresh observation overrunning deadline fails before mutation and releases lease',async()=>{
  const f=fixture();f.deps.readShopifyMediaTransport=async()=>{f.tick(29001);return f.before;};await assert.rejects(f.run(),/TIME_BUDGET/);
  assert.ok(!f.calls.some(c=>['begin','execute'].includes(c[0])));assert.equal(f.calls.at(-1)[0],'release');
});
