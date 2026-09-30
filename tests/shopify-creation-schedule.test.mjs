import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const url=source=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const after=url('export const after=callback=>globalThis.__creationSchedule.callbacks.push(callback);');
const db=url('export const createSupabaseServiceRoleClient=()=>({fixture:true});');
const runtime=url('export const galleryDraftCreationMode=()=>globalThis.__creationSchedule.enabled;export const runPersistedGalleryDraft=async(db,id,deadline)=>{const s=globalThis.__creationSchedule;s.workerCalls.push({id,deadline});s.now=s.workerEnd;return s.result;};');
const moduleUrl=url(readFileSync('src/lib/shopify/schedule-creation.ts','utf8').replace('import "server-only";','')
 .replace('"next/server"',JSON.stringify(after)).replace('"@/lib/supabase/service-role"',JSON.stringify(db)).replace('"./creation-runtime"',JSON.stringify(runtime)));
const {scheduleGalleryDraftCreation,MAX_CREATION_HOPS}=await import(moduleUrl);
async function fixture(fn){
 const previous={now:Date.now,timer:globalThis.setTimeout,fetch:globalThis.fetch,error:console.error,token:process.env.ADMIN_PANEL_TOKEN};
 const state=globalThis.__creationSchedule={enabled:true,callbacks:[],workerCalls:[],requests:[],errors:[],now:9000,workerEnd:44000,result:{pending:true}};
 Date.now=()=>state.now;globalThis.setTimeout=(callback,ms)=>{state.now+=ms;callback();return 1;};
 globalThis.fetch=async(target,options)=>{state.requests.push({target,options});state.now+=8000;return new Response(null,{status:202});};
 console.error=(message,value)=>state.errors.push({message,value});process.env.ADMIN_PANEL_TOKEN='fixture-never-log';
 try{await fn(state);}finally{Date.now=previous.now;globalThis.setTimeout=previous.timer;globalThis.fetch=previous.fetch;console.error=previous.error;
  if(previous.token===undefined)delete process.env.ADMIN_PANEL_TOKEN;else process.env.ADMIN_PANEL_TOKEN=previous.token;delete globalThis.__creationSchedule;}
}
test('creation wakeup reserves worker cleanup and fixed-origin handoff inside original request budget',()=>fixture(async s=>{
 scheduleGalleryDraftCreation('fixture-id',0,55000);assert.equal(s.callbacks.length,1);await s.callbacks[0]();
 assert.deepEqual(s.workerCalls,[{id:'fixture-id',deadline:45000}]);assert.equal(s.requests.length,1);
 assert.equal(s.requests[0].target,'https://landing.toptik.co.il/api/admin/shopify/drafts');assert.equal(s.requests[0].options.redirect,'error');
 assert.deepEqual(JSON.parse(s.requests[0].options.body),{id:'fixture-id',hop:1});assert.ok(s.now<=55000);assert.deepEqual(s.errors,[]);
}));
test('insufficient tail budget leaves durable work visible and never starts another request',()=>fixture(async s=>{
 s.workerEnd=54000;scheduleGalleryDraftCreation('fixture-id',0,55000);await s.callbacks[0]();
 assert.equal(s.requests.length,0);assert.equal(s.errors[0].value.code,'SYNC_CREATION_CONTINUATION_BUDGET');
 assert.doesNotMatch(JSON.stringify(s.errors),/fixture-never-log/);
}));
test('default-off and bounded hop limit cannot start an unbounded continuation chain',()=>fixture(async s=>{
 s.enabled=false;scheduleGalleryDraftCreation('fixture-id');assert.equal(s.callbacks.length,0);
 s.enabled=true;scheduleGalleryDraftCreation('fixture-id',MAX_CREATION_HOPS,55000);await s.callbacks[0]();assert.equal(s.requests.length,0);
}));
