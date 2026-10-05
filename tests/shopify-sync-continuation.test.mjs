import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

async function compile(source) {
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
}
const scheduleSource = readFileSync("src/lib/shopify/schedule-sync.ts", "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const { makeSchedule } = await compile(`export function makeSchedule(deps) {
  const {after,createSupabaseServiceRoleClient,hasSupabaseAdminEnv,isShopifySyncConfigured,drainShopifySyncQueues,fetch,process,console,dispatchTypedSpecSync,dispatchMediaSync} = deps;
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
    configuredShopifySyncMode,scheduleShopifySync,scheduleShopifySyncContinuation,drainShopifySyncQueues,createSupabaseServiceRoleClient,process,console,scheduleTypedSpecWakeup,scheduleMediaSyncWakeup} = deps;
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
    createSupabaseServiceRoleClient:()=>db,drainShopifySyncQueues:()=>drain(db),dispatchTypedSpecSync:async()=>{},dispatchMediaSync:async()=>{},scheduleMediaSyncWakeup:()=>{},scheduleTypedSpecWakeup:()=>{},console:{error:(...args)=>logs.push(args)}};
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

test("independent wakeups drain all78 durable rows without a recursive HTTP chain",async()=>{
  const f=fixture();
  for(let tick=0;tick<8;tick++){
    const before=f.rows.filter(row=>row.status==="synced").length;
    f.schedule.scheduleShopifySync();
    assert.equal(f.rows.filter(row=>row.status==="synced").length,before,"after defers work");
    assert.equal(await f.finish(),1,"each external tick has exactly one bounded drain");
    assert.equal(f.rows.filter(row=>row.status==="synced").length,Math.min(78,(tick+1)*10));
    assert.equal(f.requests.length,0,"no recursive copy request, including beyond former hop4 failure");
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

test("pending work survives a bounded drain and queue-read failures are sanitized",async()=>{
  for(const env of ["preview","production"]){
    const f=fixture({env});f.schedule.scheduleShopifySync();await f.finish();
    assert.equal(f.requests.length,0);assert.equal(f.rows.filter(r=>r.status==="pending").length,68);
  }
  const f=fixture({remainingError:true});f.schedule.scheduleShopifySync();await f.finish();
  assert.equal(f.requests.length,0);assert.equal(f.logs.length,1);
  assert.equal(f.logs[0][1].code,"SYNC_CONTINUATION_QUEUE_READ_FAILED");
  assert.ok(!JSON.stringify(f.logs).includes("fixture-token"));
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
  assert.equal(f.requests.length,0);assert.equal(f.logs.length,0,"legacy hop100 still runs one pass without chaining");
  assert.equal(f.rows.filter(r=>r.status==="pending").length,68);
});

test("synchronous admin drain schedules only dispatch after response, not a second in-budget drain",async()=>{
  const f=fixture();
  const result=await f.post({nextUrl:new URL("https://landing.toptik.co.il/api/admin/shopify/sync"),headers:new Headers({"x-admin-token":"server-only-fixture-token"})});
  assert.equal(result.status,200);assert.equal(result.body.continuationNeeded,true);assert.equal(f.rounds(),10);
  assert.equal(f.requests.length,0);await f.finish();assert.equal(f.rows.filter(r=>r.status==="synced").length,10);assert.equal(f.requests.length,0);
  assert.match(route,/if \(result\.continuationNeeded\) scheduleShopifySyncContinuation\(\);/);
  assert.equal((route.match(/if \(result\.continuationNeeded\) scheduleShopifySyncContinuation\(\);/g)??[]).length,2,"POST and cron GET both continue");
});

test("existing authenticated recovery cron runs every five minutes with no duplicate jobs",()=>{
 const config=JSON.parse(readFileSync("vercel.json","utf8"));
 const jobs=config.crons.filter(job=>job.path==="/api/admin/shopify/sync?run=1&pending=1");
 assert.equal(jobs.length,1);assert.equal(jobs[0].schedule,"*/5 * * * *");
 assert.equal(config.crons.find(job=>job.path==="/api/admin/shopify/sync?run=1").schedule,"0 4 * * *");
 assert.match(route,/allowCron: runWorker/);
});
