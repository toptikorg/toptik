import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

async function compile(source) {
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
}
const scheduleSource = readFileSync("src/lib/shopify/schedule-sync.ts", "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const { makeSchedule } = await compile(`export function makeSchedule(deps) {
  const {after,createSupabaseServiceRoleClient,hasSupabaseAdminEnv,isShopifySyncConfigured,drainShopifySyncQueues,fetch,process,console,dispatchTypedSpecSync} = deps;
  ${scheduleSource}
  return {scheduleShopifySync,scheduleShopifySyncContinuation,runScheduledShopifySync,validSyncContinuationHop};
}`);
const worker = readFileSync("src/lib/shopify/sync-worker.ts", "utf8");
const drainSource = worker.slice(worker.indexOf("export async function drainShopifySyncQueues"), worker.indexOf("export function gallerySyncHash")).replace(/^export /gm, "");
const { makeDrain } = await compile(`export function makeDrain(deps) {
  const {processShopifySyncQueues,configuredShopifySyncMode,process,Date} = deps;
  ${drainSource}
  return drainShopifySyncQueues;
}`);
const route = readFileSync("src/app/api/admin/shopify/sync/route.ts", "utf8");
const postSource = route.slice(route.indexOf("export async function POST"), route.indexOf("/** Return bounded private")).replace(/^export /gm, "");
const { makePost } = await compile(`export function makePost(deps) {
  const {requireAdminToken,hasSupabaseAdminEnv,isShopifySyncConfigured,validSyncContinuationHop,
    configuredShopifySyncMode,scheduleShopifySync,scheduleShopifySyncContinuation,drainShopifySyncQueues,createSupabaseServiceRoleClient,process,console,scheduleTypedSpecWakeup} = deps;
  const NextResponse = {json:(body,opts={})=>({body,status:opts.status??200})};
  ${postSource}
  return POST;
}`);

function fixture({count=78,env="production",failure=false,busy=false,hopResponse=202,networkError=false,remainingError=false,rowsWithErrors=false}={}) {
  const process = {env:{VERCEL_ENV:env,SHOPIFY_SYNC_MODE:"verified_catalog",ADMIN_PANEL_TOKEN:"server-only-fixture-token"}};
  const callbacks=[],requests=[],logs=[],filters=[];
  const rows=Array.from({length:count},(_,i)=>({id:String(i),status:"pending",attempts:0,last_error:rowsWithErrors?"SYNC_RECONCILIATION_BUSY":null}));
  let rounds=0,time=0;
  const db={from(table){const predicates=[]; const builder={
    select(){return builder;},eq(k,v){predicates.push(row=>row[k]===v); filters.push([table,k,v]);return builder;},
    lt(k,v){predicates.push(row=>row[k]<v);return builder;},is(k,v){predicates.push(row=>row[k]===v);return builder;},
    async limit(){return {data:table.includes("outbox")?rows.filter(row=>predicates.every(fn=>fn(row))).slice(0,1):[],error:remainingError?{}:null};}
  };return builder;}};
  const drain=makeDrain({process,configuredShopifySyncMode:()=>"verified_catalog",Date:{now:()=>time},
    processShopifySyncQueues:async()=>{
      rounds++;
      const totals={events:{processed:0,reviewed:0,failed:0},outbox:{processed:0,reviewed:0,failed:0}};
      const next=rows.find(row=>row.status==="pending");
      if(next){if(failure||busy){next.status=busy?"pending":"failed";next.last_error="SYNC_FAILURE";totals.outbox.failed=1;}
      else {next.status="synced";totals.outbox.processed=1;}}
      return totals;
    }});
  const deps={process,after:fn=>callbacks.push(fn),hasSupabaseAdminEnv:()=>true,isShopifySyncConfigured:()=>true,
    createSupabaseServiceRoleClient:()=>db,drainShopifySyncQueues:()=>drain(db),dispatchTypedSpecSync:async()=>{},scheduleTypedSpecWakeup:()=>{},console:{error:(...args)=>logs.push(args)}};
  let post;
  const schedule=makeSchedule({...deps,fetch:async(url,options)=>{
    requests.push({url,options});
    assert.equal(options.redirect,"error");
    if(networkError) throw new Error("raw provider message must not be logged");
    if(hopResponse!==202)return {status:hopResponse};
    const result=await post({nextUrl:new URL(url),headers:new Headers(options.headers)});
    assert.equal(result.status,202,"continuation must ACK before executing its worker");
    return {status:result.status,body:{cancel:async()=>{}}};
  }});
  post=makePost({...deps,...schedule,configuredShopifySyncMode:()=>process.env.SHOPIFY_SYNC_MODE,
    requireAdminToken:req=>req.headers.get("x-admin-token")===process.env.ADMIN_PANEL_TOKEN?null:{status:401}});
  return {schedule,post,rows,requests,logs,filters,callbacks,rounds:()=>rounds,setTime:value=>{time=value;},
    async finish(){let turns=0;while(callbacks.length){assert.ok(++turns<=105,"chain must terminate");await callbacks.shift()();}return turns;}};
}

test("one scheduled save drains all78 durable rows through authenticated bounded202 continuations",async()=>{
  const f=fixture();
  f.schedule.scheduleShopifySync();
  assert.equal(f.rounds(),0,"after() must defer work until response");
  assert.equal(await f.finish(),8);
  assert.equal(f.rows.filter(row=>row.status==="synced").length,78);
  assert.equal(f.requests.length,7);
  assert.deepEqual(f.requests.map(r=>new URL(r.url).searchParams.get("hop")),["1","2","3","4","5","6","7"]);
  for(const request of f.requests){
    assert.equal(new URL(request.url).origin,"https://landing.toptik.co.il");
    assert.equal(new URL(request.url).pathname,"/api/admin/shopify/sync");
    assert.equal(request.options.headers["x-admin-token"],"server-only-fixture-token");
    assert.ok(request.options.signal instanceof AbortSignal);
    assert.ok(!request.url.includes("fixture-token"));
  }
  assert.equal(f.logs.length,0);
});

test("drain never chains failures, busy rows, empty work, or errored pending rows",async()=>{
  for(const options of [{failure:true},{busy:true},{count:0},{rowsWithErrors:true}]){
    const f=fixture(options);f.schedule.scheduleShopifySync();await f.finish();assert.equal(f.requests.length,0);
  }
});

test("an empty inbox crossing the reserve still continues pending outbox after earlier progress only",async()=>{
  for (const priorProgress of [true,false]) {
    let now=0,round=0,pendingReads=0;
    const drain=makeDrain({process:{env:{SHOPIFY_SYNC_MODE:"verified_catalog"}},configuredShopifySyncMode:()=>"verified_catalog",Date:{now:()=>now},
      processShopifySyncQueues:async(_db,deadline)=>{
        round++;
        const result={events:{processed:0,reviewed:0,failed:0},outbox:{processed:0,reviewed:0,failed:0}};
        if(priorProgress&&round===1){result.outbox.processed=1;now=29_000;return result;}
        // The empty inbox SELECT finishes past the reserve; outbox correctly
        // does not claim even though it still has durable pending rows.
        now=30_001;assert.ok(now+15_000>=deadline);return result;
      }});
    const db={from(){const builder={select(){return builder;},eq(){return builder;},lt(){return builder;},is(){return builder;},
      async limit(){pendingReads++;return {data:[{id:"still-pending"}],error:null};}};return builder;}};
    const result=await drain(db);
    assert.equal(result.continuationNeeded,priorProgress);
    assert.equal(pendingReads,priorProgress?2:0,"no-progress drains must not initiate a continuation loop");
  }
});

test("Preview never dispatches credentials to Production; failed dispatch retains pending work without retry",async()=>{
  const preview=fixture({env:"preview"});preview.schedule.scheduleShopifySync();await preview.finish();
  assert.equal(preview.requests.length,0);assert.equal(preview.rows.filter(r=>r.status==="pending").length,68);
  for(const options of [{hopResponse:302},{hopResponse:503},{networkError:true},{remainingError:true}]){
    const f=fixture(options);f.schedule.scheduleShopifySync();await f.finish();
    assert.equal(f.requests.length,options.remainingError?0:1);assert.equal(f.rows.filter(r=>r.status==="pending").length,68);
    assert.equal(f.logs.length,1);assert.match(f.logs[0][1].code,/^SYNC_[A-Z_]+$/);
    assert.ok(!JSON.stringify(f.logs).includes("fixture-token"));assert.ok(!JSON.stringify(f.logs).includes("raw provider"));
  }
});

test("continuation auth, explicit mode and hop bounds gate scheduling before any work",async()=>{
  const f=fixture();
  for(const hop of ["0","-1","1.5","101","001","","999999","NaN"]){
    const req={nextUrl:new URL(`https://landing.toptik.co.il/api/admin/shopify/sync?continue=1&hop=${hop}`),headers:new Headers({"x-admin-token":"server-only-fixture-token"})};
    assert.equal((await f.post(req)).status,400);
  }
  assert.equal((await f.post({nextUrl:new URL("https://landing.toptik.co.il/api/admin/shopify/sync?continue=1&hop=1"),headers:new Headers()})).status,401);
  assert.equal(f.callbacks.length,0);assert.equal(f.rounds(),0);
  f.schedule.scheduleShopifySync(100);await f.finish();
  assert.equal(f.requests.length,0);assert.equal(f.logs[0][1].code,"SYNC_CONTINUATION_CHAIN_LIMIT");
  assert.equal(f.rows.filter(r=>r.status==="pending").length,68);
});

test("synchronous admin drain schedules only dispatch after response, not a second in-budget drain",async()=>{
  const f=fixture();
  const result=await f.post({nextUrl:new URL("https://landing.toptik.co.il/api/admin/shopify/sync"),headers:new Headers({"x-admin-token":"server-only-fixture-token"})});
  assert.equal(result.status,200);assert.equal(result.body.continuationNeeded,true);assert.equal(f.rounds(),10);
  assert.equal(f.requests.length,0);await f.finish();assert.equal(f.rows.filter(r=>r.status==="synced").length,78);
  assert.match(route,/if \(result\.continuationNeeded\) scheduleShopifySyncContinuation\(\);/);
  assert.equal((route.match(/if \(result\.continuationNeeded\) scheduleShopifySyncContinuation\(\);/g)??[]).length,2,"POST and cron GET both continue");
});
