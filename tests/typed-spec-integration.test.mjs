import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {moduleUrl} from './helpers/typed-spec-modules.mjs';

const read=path=>readFileSync(path,'utf8');
const body=source=>source.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
async function factory(source,names,returned){
 return (await import(moduleUrl(`export function create(deps){const {${names}}=deps;${body(source)};return {${returned}};}`))).create;
}
class JsonResponse extends Response {static json(value,options){return Response.json(value,options);}}
test('typed admin editor checks role on each request and stays outside indexing',()=>{
 const source=read('src/app/(panel)/dashboard/specs/page.tsx');
 assert.match(source,/export const dynamic = "force-dynamic"/);assert.match(source,/await requireAdminPage\(\)/);
 assert.match(source,/robots: \{ index: false, follow: false \}/);
});
const rules=read('src/lib/shopify/sync-rules.ts');
const {shopifyProductGid}=await import(moduleUrl(rules.slice(rules.indexOf('export function shopifyProductGid'),rules.indexOf('export function numericVariantId'))));
const makeWebhook=await factory(read('src/app/api/webhooks/shopify/products/route.ts'),
 'NextResponse,verifyProductWebhook,hasSupabaseAdminEnv,createSupabaseServiceRoleClient,scheduleShopifySync,enqueueTypedSpecProduct,shopifyProductGid,process,console','POST');
function webhookFixture({payload={id:123},duplicate=false,inboxFailure=false,typedFailure=false,topic='products/update',invalidSignature=false}={}){
 const calls=[],logs=[];
 const {POST}=makeWebhook({NextResponse:JsonResponse,process:{env:{}},console:{error:(...args)=>logs.push(args)},shopifyProductGid,
  hasSupabaseAdminEnv:()=>true,verifyProductWebhook:()=>invalidSignature?{ok:false,reason:'bad_signature'}:{ok:true,event:{payload,topic,deliveryId:'d1',shopDomain:'toptikcoil.myshopify.com'}},
  createSupabaseServiceRoleClient:()=>({from:table=>({insert:async data=>{calls.push(['inbox',table,data]);return {error:inboxFailure?{code:'XX'}:duplicate?{code:'23505'}:null};}})}),
  scheduleShopifySync:()=>calls.push(['copy']),enqueueTypedSpecProduct:async(_db,gid)=>{calls.push(['typed',gid]);if(typedFailure)throw Error('private payload must not leak');},
 });
 return {calls,logs,run:()=>POST(new Request('https://landing.toptik.co.il/api/webhooks/shopify/products',{method:'POST',body:JSON.stringify(payload)}))};
}

test('accepted and duplicate signed events preserve copy scheduling when optional typed enqueue fails',async()=>{
 for(const duplicate of [false,true]){
  const f=webhookFixture({duplicate,typedFailure:true}),response=await f.run();assert.equal(response.status,200);
  assert.deepEqual(f.calls.map(c=>c[0]),['inbox','copy','typed']);assert.equal(f.calls[2][1],'gid://shopify/Product/123');
  assert.equal(f.logs[0][1].code,'SPEC_ENQUEUE_FAILED');assert.ok(!JSON.stringify(f.logs).includes('private payload'));
 }
 for(const options of [{invalidSignature:true},{inboxFailure:true}]){
  const f=webhookFixture(options);assert.equal((await f.run()).status,options.invalidSignature?401:503);assert.ok(!f.calls.some(c=>c[0]==='copy'||c[0]==='typed'));
 }
});

test('typed webhook identity rejects unsafe coercion/mismatched GID and deletion while copy still receives the event',async()=>{
 for(const id of [123,'123','gid://shopify/Product/123','9007199254740993']){
  const f=webhookFixture({payload:{id}});assert.equal((await f.run()).status,200);assert.equal(f.calls.find(c=>c[0]==='typed')[1],shopifyProductGid(id));
 }
 for(const payload of [{id:0},{id:-1},{id:1.2},{id:Number.MAX_SAFE_INTEGER+1},{id:{}},{id:['123']},{id:null},{},{id:' 123'},{id:'01'},
  {id:'gid://shopify/ProductVariant/123'},{id:123,admin_graphql_api_id:'gid://shopify/Product/456'}]){
  const f=webhookFixture({payload});assert.equal((await f.run()).status,200);assert.ok(f.calls.some(c=>c[0]==='copy'));assert.ok(!f.calls.some(c=>c[0]==='typed'));
 }
 const deleted=webhookFixture({topic:'products/delete'});assert.equal((await deleted.run()).status,200);assert.ok(!deleted.calls.some(c=>c[0]==='typed'));
});

const route=read('src/app/api/admin/shopify/sync/route.ts');
const makeCron=await factory(route.slice(route.indexOf('export async function GET')),
 'NextResponse,requireAdminToken,hasSupabaseAdminEnv,isShopifySyncConfigured,createSupabaseServiceRoleClient,drainShopifySyncQueues,recoverTypedSpecQueue,recoverMediaWork,scheduleMediaSyncWakeup,scheduleShopifySyncContinuation,scheduleTypedSpecWakeup,console','GET');
test('daily optional typed recovery starts alongside copy and failure never blocks copy result or schedules two tails',async()=>{
 for(const continuationNeeded of [true,false]){
  const calls=[],logs=[];let releaseCopy;
  const copyWait=new Promise(resolve=>{releaseCopy=resolve;});
  const {GET}=makeCron({NextResponse:JsonResponse,requireAdminToken:()=>null,hasSupabaseAdminEnv:()=>true,isShopifySyncConfigured:()=>true,
   createSupabaseServiceRoleClient:()=>({}),console:{error:(...args)=>logs.push(args)},
   drainShopifySyncQueues:async()=>{calls.push('copy');await copyWait;return {continuationNeeded};},
   recoverTypedSpecQueue:async()=>{calls.push('typedRecovery');releaseCopy();throw Error('SPEC_DB_RETRY');},
   recoverMediaWork:async()=>{calls.push('mediaRecovery');},scheduleMediaSyncWakeup:()=>calls.push('mediaTail'),
   scheduleShopifySyncContinuation:()=>calls.push('jointTail'),scheduleTypedSpecWakeup:()=>calls.push('typedTail'),
  });
  const request=new Request('https://landing.toptik.co.il/api/admin/shopify/sync?run=1');request.nextUrl=new URL(request.url);
  const result=await GET(request);assert.equal(result.status,200);assert.deepEqual(await result.json(),{continuationNeeded});
  assert.deepEqual(calls,continuationNeeded?['copy','mediaRecovery','typedRecovery','jointTail']:['copy','mediaRecovery','typedRecovery','typedTail','mediaTail']);assert.equal(logs[0][1].code,'SPEC_DB_RETRY');
 }
});

const makeSchedule=await factory(read('src/lib/shopify/schedule-sync.ts'),
 'after,createSupabaseServiceRoleClient,hasSupabaseAdminEnv,isShopifySyncConfigured,drainShopifySyncQueues,dispatchTypedSpecSync,dispatchMediaSync,process,fetch,console',
 'runScheduledShopifySync,scheduleShopifySyncContinuation');
test('typed and media wakeups start together after lease release instead of serial eight-second tails',async()=>{
 for(const synchronous of [false,true]){
  const calls=[],afters=[],started=[];let release;
  const wait=new Promise(resolve=>{release=resolve;});
  async function dispatch(name){calls.push(name);started.push(name);if(started.length===2)release();await wait;}
  const schedule=makeSchedule({after:fn=>afters.push(fn),createSupabaseServiceRoleClient:()=>({}),hasSupabaseAdminEnv:()=>true,isShopifySyncConfigured:()=>true,
   process:{env:{VERCEL_ENV:'production',ADMIN_PANEL_TOKEN:'fixture'}},console:{error:()=>{}},
   drainShopifySyncQueues:async()=>{calls.push('drainReleased');return {continuationNeeded:true};},
   fetch:async()=>{await dispatch('copyWakeup');return {status:202};},dispatchTypedSpecSync:()=>dispatch('typedWakeup'),dispatchMediaSync:()=>dispatch('mediaWakeup'),
  });
  if(synchronous){schedule.scheduleShopifySyncContinuation();assert.equal(calls.length,0);await afters[0]();}
  else await schedule.runScheduledShopifySync();
  assert.deepEqual(calls,synchronous?['typedWakeup','mediaWakeup']:['drainReleased','typedWakeup','mediaWakeup']);
 }
});

const makeTypedScheduler=await factory(read('src/lib/shopify/schedule-typed-spec-sync.ts'),
 'after,createSupabaseServiceRoleClient,hasSupabaseAdminEnv,isShopifySyncConfigured,drainTypedSpecQueue,typedSpecSyncEnabled,process,fetch,console',
 'dispatchTypedSpecSync,scheduleTypedSpecSync,scheduleTypedSpecWakeup,validTypedSpecHop');
const makeTypedWorkerRoute=await factory(read('src/app/api/admin/shopify/specs/worker/route.ts'),
 'NextResponse,requireAdminToken,hasSupabaseAdminEnv,isShopifySyncConfigured,typedSpecSyncEnabled,scheduleTypedSpecSync,validTypedSpecHop','POST');
function typedScheduleFixture({env='production',enabled=true,token='fixture',httpStatus=202,continuationNeeded=false}={}){
 const afters=[],calls=[],logs=[];
 const scheduler=makeTypedScheduler({after:fn=>afters.push(fn),createSupabaseServiceRoleClient:()=>({}),hasSupabaseAdminEnv:()=>true,isShopifySyncConfigured:()=>true,
  typedSpecSyncEnabled:()=>enabled,process:{env:{VERCEL_ENV:env,ADMIN_PANEL_TOKEN:token}},console:{error:(...args)=>logs.push(args)},
  drainTypedSpecQueue:async(_db,deadline)=>{calls.push(['drain',deadline]);return {continuationNeeded};},
  fetch:async(url,options)=>{calls.push(['fetch',url,options]);return {status:httpStatus};},
 });
 return {scheduler,afters,calls,logs};
}
test('typed dispatcher uses fixed authenticated202 destination, rejects redirect/hop/auth errors and never dispatches from Preview',async()=>{
 const f=typedScheduleFixture();await f.scheduler.dispatchTypedSpecSync(0);const [,url,options]=f.calls[0];
 assert.equal(url,'https://landing.toptik.co.il/api/admin/shopify/specs/worker?hop=0');assert.equal(options.redirect,'error');assert.equal(options.headers['x-admin-token'],'fixture');assert.ok(options.signal instanceof AbortSignal);
 for(const value of [101,-1,1.5,NaN])await assert.rejects(()=>f.scheduler.dispatchTypedSpecSync(value),/SPEC_CONTINUATION_INVALID/);
 for(const options of [{env:'preview'},{enabled:false}]){const p=typedScheduleFixture(options);await p.scheduler.dispatchTypedSpecSync();assert.equal(p.calls.length,0);}
 await assert.rejects(()=>typedScheduleFixture({token:''}).scheduler.dispatchTypedSpecSync(),/AUTH_UNAVAILABLE/);
 await assert.rejects(()=>typedScheduleFixture({httpStatus:302}).scheduler.dispatchTypedSpecSync(),/NOT_ACCEPTED/);
});
test('typed worker endpoint ACK precedes drain and rejects unauthenticated/invalid hops; chain stops at100',async()=>{
 const f=typedScheduleFixture({continuationNeeded:true});
 for(const authorized of [false,true]){
  const {POST}=makeTypedWorkerRoute({NextResponse:JsonResponse,requireAdminToken:()=>authorized?null:Response.json({}, {status:401}),
   hasSupabaseAdminEnv:()=>true,isShopifySyncConfigured:()=>true,typedSpecSyncEnabled:()=>true,...f.scheduler});
  for(const hop of ['','101','-1','1.1','01','0']){
   const request={nextUrl:new URL(`https://landing.toptik.co.il/api/admin/shopify/specs/worker?hop=${hop}`)};
   assert.equal((await POST(request)).status,authorized?(hop==='0'?202:400):401);
  }
 }
 assert.equal(f.calls.length,0);assert.equal(f.afters.length,1);await f.afters.shift()();assert.equal(f.calls[0][0],'drain');assert.equal(f.calls.length,1,'pending work waits for independent cron');
 f.calls.length=0;f.scheduler.scheduleTypedSpecSync(100);await f.afters.shift()();assert.equal(f.calls.length,1,'hop100 drains but cannot dispatch hop101');
 assert.equal(f.logs.length,0);
});

test('frequent authenticated tick drains durable work without re-enqueuing completed catalog',async()=>{
 const calls=[];
 const {GET}=makeCron({NextResponse:JsonResponse,requireAdminToken:(_req,options)=>{assert.equal(options.allowCron,true);return null;},hasSupabaseAdminEnv:()=>true,isShopifySyncConfigured:()=>true,
 createSupabaseServiceRoleClient:()=>({}),console:{error:()=>{}},drainShopifySyncQueues:async()=>{calls.push('copy');return {continuationNeeded:true};},
 recoverTypedSpecQueue:async()=>{throw Error('must not sweep');},recoverMediaWork:async()=>{throw Error('must not sweep');},
 scheduleShopifySyncContinuation:()=>calls.push('dependentWakeups'),scheduleMediaSyncWakeup:()=>{},scheduleTypedSpecWakeup:()=>{}});
 const request=new Request('https://landing.toptik.co.il/api/admin/shopify/sync?run=1&pending=1');request.nextUrl=new URL(request.url);
 assert.equal((await GET(request)).status,200);assert.deepEqual(calls,['copy','dependentWakeups']);
});
