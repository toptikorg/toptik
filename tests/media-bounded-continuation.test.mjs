import test from 'node:test';
import assert from 'node:assert/strict';
import {mod,stripped,id} from './helpers/media-planning-fixture.mjs';
const {make}=await import(mod(`import{randomUUID}from'node:crypto';export function make(deps){const{process,createSupabaseServiceRoleClient,reconcilePersistedMediaProduct,Date}=deps;const bootstrapProductionMedia=async()=>{throw Error('unexpected bootstrap');};${stripped('media-work-queue').replace(/^export /gm,'')}return{drainMediaWork};}`));
function fixture(){
 const calls=[],state={time:1000,product:id.productId};
 const db={rpc(name,args){calls.push({name,args});return{abortSignal:()=>Promise.resolve({data:name.startsWith('claim_toptik_media_work')?{productId:state.product,claimId:args.p_claim_id,generation:9,initialized:true,evidence:{}}:true,error:null})};}};
 const api=make({Date:{now:()=>state.time},process:{env:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'}},createSupabaseServiceRoleClient:()=>db});
 return{calls,state,db,api};
}
const verified=checkpoint=>({status:'pending',progressed:true,executed:true,verifiedCheckpoint:checkpoint});

test('five verified phases then acceptance and commit finish within one claim and absolute deadline',async()=>{
 const f=fixture(),runs=[],outcomes=[...Array.from({length:5},(_,n)=>verified('operation:0:phase:'+n)),{...verified('operation:0:accepted'),executed:false},{status:'done',progressed:true,executed:false}],deadline=241000;
 const result=await f.api.drainMediaWork(deadline,f.db,async(...args)=>{runs.push(args);f.state.time+=1000;return outcomes.shift();});
 assert.equal(runs.length,7);assert.equal(result.processed,1);
 assert.ok(runs.every(args=>args[0]===id.productId&&args[2]===deadline-5000));
 assert.deepEqual(f.calls.map(c=>c.name),['claim_toptik_media_work','finish_toptik_media_work','toptik_media_work_pending']);
 assert.equal(f.calls[1].args.p_status,'done');assert.equal(f.calls[1].args.p_generation,9);
});

test('new checkpoints remain bounded to ten entries and leave the next identity eligible',async()=>{
 const f=fixture();let runs=0;const deadline=241000;
 await f.api.drainMediaWork(deadline,f.db,async()=>{runs++;f.state.time+=1000;return verified('phase:'+runs);},undefined,[]);
 assert.equal(runs,10);assert.equal(f.calls.filter(c=>c.name.startsWith('claim_toptik_media_work')).length,1);
 const query=f.calls.find(c=>c.name==='toptik_media_work_pending_excluding');assert.deepEqual(query.args.p_exclude_product_gids,[id.productId]);
 f.state.product='gid://shopify/Product/987';let second=0;
 const result=await f.api.drainMediaWork(deadline,f.db,async()=>{second++;return{status:'done',progressed:false,executed:false};},undefined,[id.productId]);
 assert.equal(second,1);assert.equal(result.claimedProductId,f.state.product);
});

test('fake clock consumes the original deadline reserve without starting another call or sleeping',async()=>{
 const f=fixture(),deadlines=[];const deadline=241000;
 await f.api.drainMediaWork(deadline,f.db,async(_id,_e,d)=>{deadlines.push(d);f.state.time+=55000;return verified('phase:'+deadlines.length);});
 assert.equal(deadlines.length,4);assert.deepEqual(deadlines,[236000,236000,236000,236000]);
 assert.equal(f.calls.filter(c=>c.name==='keep_toptik_media_work_in_flight').length,1);
});

test('busy, prepared and uncertain pending remain single-entry waits, with no blind replay',async()=>{
 for(const outcome of [{status:'busy',progressed:false,executed:false},{status:'pending',progressed:true,executed:false},{status:'pending',progressed:false,executed:true}]){
  const f=fixture();let runs=0,mutatingCalls=0;
  await f.api.drainMediaWork(241000,f.db,async()=>{runs++;mutatingCalls+=outcome.executed?1:0;return outcome;});
  assert.equal(runs,1);assert.equal(mutatingCalls,outcome.executed?1:0);
 }
});

test('same durable checkpoint cannot authorize an unbounded replay or another mutation',async()=>{
 const f=fixture();let runs=0,mutatingCalls=0;
 await f.api.drainMediaWork(241000,f.db,async()=>{runs++;if(runs===1)mutatingCalls++;return{...verified('operation:0:phase:0'),executed:runs===1};});
 assert.equal(runs,2);assert.equal(mutatingCalls,1);
});

test('a plain pending or busy result after verified advancement ends this claim immediately',async()=>{
 for(const status of ['pending','busy']){
  const f=fixture();let runs=0;
  await f.api.drainMediaWork(241000,f.db,async()=>++runs===1?verified('operation:0:phase:0'):{status,progressed:false,executed:false});
  assert.equal(runs,2);
 }
});

const reloadCursor=(revision='b'.repeat(64),phase=0)=>`10000000-0000-4000-8000-000000000001:0:${phase}:${'a'.repeat(64)}:${revision}`;
const reload=cursor=>({status:'pending',progressed:false,executed:false,replanCheckpoint:cursor});

test('replacement with variant phase and two proven guard reloads reaches acceptance and commit',async()=>{
 const f=fixture(),outcomes=[verified('phase:0'),verified('phase:1'),verified('phase:2'),reload(reloadCursor('b'.repeat(64),3)),verified('phase:3'),reload(reloadCursor('c'.repeat(64),4)),verified('phase:4'),verified('phase:5'),verified('operation:0:accepted'),{status:'done',progressed:true,executed:false}];
 let runs=0;await f.api.drainMediaWork(241000,f.db,async()=>{runs++;f.state.time+=1000;return outcomes.shift();});
 assert.equal(runs,10);assert.equal(f.calls.find(c=>c.name==='finish_toptik_media_work').args.p_status,'done');
});

test('one exact guard reload proceeds within the same claim and deadline without verified accounting',async()=>{
 const f=fixture(),deadlines=[];let runs=0;
 const result=await f.api.drainMediaWork(241000,f.db,async(_p,_e,d)=>{deadlines.push(d);return ++runs===1?reload(reloadCursor()):{status:'pending',progressed:false,executed:false};});
 assert.equal(runs,2);assert.deepEqual(deadlines,[236000,236000]);assert.equal(result.processed,0);
 assert.equal(f.calls.some(c=>c.name==='keep_toptik_media_work_in_flight'),false);assert.equal(f.calls.find(c=>c.name==='finish_toptik_media_work').args.p_status,'pending');
});

test('repeated reload cursor stops at two calls and cannot masquerade as verified advancement',async()=>{
 const f=fixture();let runs=0;await f.api.drainMediaWork(241000,f.db,async()=>{runs++;return reload(reloadCursor());});
 assert.equal(runs,2);assert.equal(f.calls.some(c=>c.name==='keep_toptik_media_work_in_flight'),false);
});

test('reloads and verified advancement share the same ten-call ceiling',async()=>{
 const f=fixture();let runs=0;
 await f.api.drainMediaWork(241000,f.db,async()=>{runs++;return runs%2?reload(reloadCursor(runs.toString(16).repeat(64))):verified('phase:'+runs);});
 assert.equal(runs,10);assert.equal(f.calls.filter(c=>c.name.startsWith('claim_toptik_media_work')).length,1);
});

test('reload does not continue on executed pending, malformed cursor, busy or an exhausted deadline',async()=>{
 for(const outcome of [{...reload(reloadCursor()),executed:true},reload('wrong-operation:0:0'),{...reload(reloadCursor()),status:'busy'}]){
  const f=fixture();let runs=0;await f.api.drainMediaWork(241000,f.db,async()=>{runs++;return outcome;});assert.equal(runs,1);
 }
 const f=fixture();let runs=0;await f.api.drainMediaWork(241000,f.db,async()=>{runs++;f.state.time=220000;return reload(reloadCursor());});assert.equal(runs,1);
});
