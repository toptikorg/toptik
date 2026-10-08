import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{stripTypeScriptTypes}from'node:module';
Error.stackTraceLimit=0;const mod=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const source=readFileSync('src/lib/shopify/media-schedule.ts','utf8'),body=stripTypeScriptTypes(source).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const{make}=await import(mod(`export function make(deps){const{after,drainMediaWork,mediaSyncEnabled,fetch,process,console}=deps;${body}return{dispatchMediaSync,scheduleMediaSync,scheduleMediaSyncWakeup,validMediaHop};}`));
function fixture(){const calls=[],jobs=[],errors=[],state={enabled:true,status:202,redirected:false,continuation:true},deps={after:fn=>jobs.push(fn),drainMediaWork:async(d,_db,_run,_initialize,excluded)=>{calls.push(['drain',d,excluded]);return{continuationNeeded:state.continuation,claimedProductId:'gid://shopify/Product/'+calls.length};},mediaSyncEnabled:()=>state.enabled,fetch:async(...a)=>{calls.push(['fetch',...a]);return{status:state.status,redirected:state.redirected,body:{cancel:async()=>calls.push(['cancel'])}};},process:{env:{ADMIN_PANEL_TOKEN:'private-test-token'}},console:{error:(...a)=>errors.push(a)}};return{calls,jobs,errors,state,deps,api:make(deps)};}
test('disabled creates no background work or network',async()=>{const x=fixture();x.state.enabled=false;x.api.scheduleMediaSync();x.api.scheduleMediaSyncWakeup();await x.api.dispatchMediaSync();assert.deepEqual(x.calls,[]);assert.deepEqual(x.jobs,[]);});
test('authenticated fixed URL, no redirects, 202 acknowledgment required',async()=>{const x=fixture();await x.api.dispatchMediaSync(2);const c=x.calls[0];assert.equal(c[1],'https://landing.toptik.co.il/api/admin/shopify/media/worker?hop=2');assert.equal(c[2].redirect,'error');assert.equal(c[2].headers['x-admin-token'],'private-test-token');assert.equal(c[2].method,'POST');});
test('wake up dispatches only, never adds a long worker to shared request',async()=>{const x=fixture();x.api.scheduleMediaSyncWakeup();assert.equal(x.calls.length,0);await x.jobs[0]();assert.equal(x.calls.some(c=>c[0]==='drain'),false);assert.equal(x.calls[0][0],'fetch');});
test('worker uses one fixed 240sec budget and never chains without finished work',async()=>{const x=fixture(),start=Date.now();x.api.scheduleMediaSync(3);await x.jobs[0]();assert.ok(x.calls[0][1]>=start+240000&&x.calls[0][1]<=Date.now()+240000);assert.equal(x.calls.length,10);assert.equal(new Set(x.calls.map(c=>c[1])).size,1);assert.equal(x.calls.some(c=>c[0]==='fetch'),false);assert.equal(x.jobs.length,1);});
test('a deep backlog with finished work chains exactly one fresh bounded continuation',async()=>{
 const x=fixture();x.deps.drainMediaWork=async(d,_db,_r,_i,excluded)=>{x.calls.push(['drain',d,excluded]);return{continuationNeeded:true,processed:1,claimedProductId:'gid://shopify/Product/'+x.calls.filter(c=>c[0]==='drain').length};};
 make(x.deps).scheduleMediaSync(4);await x.jobs[0]();
 const fetches=x.calls.filter(c=>c[0]==='fetch');assert.equal(fetches.length,1);assert.equal(fetches[0][1],'https://landing.toptik.co.il/api/admin/shopify/media/worker?hop=5');
 assert.equal(x.calls.filter(c=>c[0]==='drain').length,10);assert.equal(x.errors.length,0);});
test('holds, failures and in-flight waits without finished work never chain; the hop cap is final',async()=>{
 const noWork=fixture();noWork.deps.drainMediaWork=async()=>{noWork.calls.push(['drain']);return{continuationNeeded:true,processed:0,failed:1,claimedProductId:'gid://shopify/Product/'+noWork.calls.length};};
 make(noWork.deps).scheduleMediaSync();await noWork.jobs[0]();assert.equal(noWork.calls.filter(c=>c[0]==='fetch').length,0);
 const capped=fixture();capped.deps.drainMediaWork=async()=>{capped.calls.push(['drain']);return{continuationNeeded:true,processed:1,claimedProductId:'gid://shopify/Product/'+capped.calls.length};};
 make(capped.deps).scheduleMediaSync(250);await capped.jobs[0]();assert.equal(capped.calls.filter(c=>c[0]==='fetch').length,0);
 const drained=fixture();drained.deps.drainMediaWork=async()=>{drained.calls.push(['drain']);return{continuationNeeded:false,processed:1,claimedProductId:'gid://shopify/Product/'+drained.calls.length};};
 make(drained.deps).scheduleMediaSync();await drained.jobs[0]();assert.equal(drained.calls.filter(c=>c[0]==='fetch').length,0);
 const broken=fixture();broken.state.status=500;broken.deps.drainMediaWork=async()=>{broken.calls.push(['drain']);return{continuationNeeded:true,processed:1,claimedProductId:'gid://shopify/Product/'+broken.calls.length};};
 make(broken.deps).scheduleMediaSync();await broken.jobs[0]();assert.equal(broken.errors.length,1);});
test('no progress, hop limit, failure and missing secret never retry or spin',async()=>{const x=fixture();x.state.continuation=false;x.api.scheduleMediaSync();await x.jobs[0]();assert.equal(x.calls.length,1);const cap=fixture();cap.api.scheduleMediaSync(250);await cap.jobs[0]();assert.equal(cap.calls.length,10);assert.equal(cap.errors.length,0);for(const status of[301,401,500]){const y=fixture();y.state.status=status;await assert.rejects(y.api.dispatchMediaSync(),/NOT_ACCEPTED/);assert.equal(y.calls.filter(c=>c[0]==='fetch').length,1);}const z=fixture();delete z.deps.process.env.ADMIN_PANEL_TOKEN;await assert.rejects(z.api.dispatchMediaSync(),/AUTH_UNAVAILABLE/);assert.equal(z.calls.length,0);});
test('hop values strict; no overflow, signs, fractions or padded numbers',()=>{const x=fixture();for(const v of[null,'','01','-1','+1','1.5','251','9999'])assert.equal(x.api.validMediaHop(v),null);for(const v of['0','1','250'])assert.equal(x.api.validMediaHop(v),Number(v));});
test('private route validates authorization and hop before scheduling any work',async()=>{const b=stripTypeScriptTypes(readFileSync('src/app/api/admin/shopify/media/worker/route.ts','utf8')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');const{create}=await import(mod(`export function create(deps){const{requireAdminToken,mediaSyncEnabled,scheduleMediaSync,validMediaHop}=deps;const NextResponse={json:(body,options)=>({body,...options})};${b};return POST;}`));const x=fixture(),scheduled=[],deps={requireAdminToken:()=>({status:401}),mediaSyncEnabled:()=>true,scheduleMediaSync:h=>scheduled.push(h),validMediaHop:x.api.validMediaHop},req=h=>({nextUrl:new URL('https://landing.toptik.co.il/api/admin/shopify/media/worker?hop='+h)});const post=create(deps);assert.equal((await post(req('0'))).status,401);deps.requireAdminToken=()=>null;const authorized=create(deps);assert.equal((await authorized(req('251'))).status,400);assert.equal(scheduled.length,0);assert.equal((await authorized(req('0'))).status,202);assert.deepEqual(scheduled,[0]);});

test('durable failed/review row does not block independent pending products; no pending stops',async()=>{
 for(const outcome of [{failed:1},{reviewed:1}]){
  const x=fixture();x.deps.drainMediaWork=async()=>{x.calls.push(['drain']);return {continuationNeeded:x.calls.length<3,claimedProductId:'gid://shopify/Product/'+x.calls.length,...outcome};};
  const api=make(x.deps);api.scheduleMediaSync();await x.jobs[0]();assert.equal(x.calls.length,3);assert.equal(x.jobs.length,1);
 }
 const x=fixture();x.deps.drainMediaWork=async()=>{x.calls.push(['drain']);return {continuationNeeded:false,failed:1};};
 const api=make(x.deps);api.scheduleMediaSync();await x.jobs[0]();assert.equal(x.calls.length,1);
});

test('bounded batch passes growing independent exclusion snapshots without resetting its deadline',async()=>{
 const x=fixture();x.api.scheduleMediaSync();await x.jobs[0]();assert.equal(x.calls.length,10);
 for(let i=0;i<10;i++)assert.deepEqual(x.calls[i][2],Array.from({length:i},(_,j)=>'gid://shopify/Product/'+(j+1)));
 assert.equal(new Set(x.calls.map(c=>c[1])).size,1);assert.equal(x.calls.some(c=>c[0]==='fetch'),false);assert.equal(x.jobs.length,1);
});

test('a repeated product from drain ends the invocation and does not recurse',async()=>{
 const x=fixture();x.deps.drainMediaWork=async()=>{x.calls.push(['drain']);return{continuationNeeded:true,claimedProductId:'gid://shopify/Product/1'};};
 make(x.deps).scheduleMediaSync();await x.jobs[0]();assert.equal(x.calls.length,2);assert.equal(x.errors.length,1);assert.equal(x.errors[0][1].code,'MEDIA_QUEUE_BATCH_REPEATED');assert.equal(x.jobs.length,1);
});

test('empty claim stops even if a malformed drain result asks to continue',async()=>{
 const x=fixture();x.deps.drainMediaWork=async()=>{x.calls.push(['drain']);return{continuationNeeded:true};};
 make(x.deps).scheduleMediaSync();await x.jobs[0]();assert.equal(x.calls.length,1);
});
