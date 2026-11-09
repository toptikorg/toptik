import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {load,product,binding,operationId,owner} from './helpers/group-media-fixture.mjs';
const make=await load('src/lib/shopify/owned-media-work-queue.ts',
 ['randomUUID','createSupabaseServiceRoleClient','mediaSyncEnabled','ownedFamilyForItem'],['drainOwnedMediaWork']);
function fixture(){
 const clock=Date.now(),calls=[],state={enabled:true,pending:true,lease:true,status:'pending',phase:0,mapVersion:1};
 const claim={operationId,requestId:operationId,productGid:product,itemId:binding.variants[0].itemId,claimId:owner,
  actor:{actorType:'session_admin',actorId:owner},status:'running',nextPhase:0,mapVersion:1};
 const db={rpc(name,args){calls.push({name,args});const data=name==='claim_toptik_owned_media_work'?state.empty?{operation:null}:claim:
  name==='owned_media_work_pending'?{pending:state.pending}:name==='acquire_shopify_reconciliation_lease'?state.lease:true;
  return{abortSignal:()=>Promise.resolve({data,error:state.rpcError??null})};}};
 const resume=async(_db,input,execution)=>{calls.push({name:'resume',input,execution});if(state.failure)throw state.failure;
  return{status:state.status,requestId:operationId,checkpoint:`${operationId}:${state.mapVersion}:${state.phase}:${state.status}`};};
 const api=make({randomUUID,createSupabaseServiceRoleClient:()=>db,mediaSyncEnabled:()=>state.enabled,
  ownedFamilyForItem:id=>id===binding.variants[0].itemId?{productGid:product}:null});
 return{state,claim,calls,db,api,run:(excluded=[])=>api.drainOwnedMediaWork(clock+60000,excluded,{client:db,resume,now:()=>clock})};
}
test('disabled and short-budget work never acquire a claim or create a client',async()=>{
 const f=fixture();f.state.enabled=false;assert.equal((await f.run()).processed,0);assert.deepEqual(f.calls,[]);
 f.state.enabled=true;await f.api.drainOwnedMediaWork(Date.now()+100);assert.deepEqual(f.calls,[]);
});
test('empty or backoff-only claim only checks durable pending, without service or lease',async()=>{
 const f=fixture();f.state.empty=true;const r=await f.run([product]);assert.equal(r.continuationNeeded,true);
 assert.deepEqual(f.calls.map(c=>c.name),['claim_toptik_owned_media_work','owned_media_work_pending']);
 assert.deepEqual(f.calls[0].args.p_excluded_product_gids,[product]);assert.equal(r.claimedProductId,undefined);
});
test('resumes only the stored identity and authenticated actor under the common product lease',async()=>{
 const f=fixture();f.state.phase=2;const r=await f.run();assert.equal(r.processed,1);assert.equal(r.completed,0);
 assert.deepEqual(f.calls.map(c=>c.name),['claim_toptik_owned_media_work','acquire_shopify_reconciliation_lease','resume',
  'release_shopify_reconciliation_lease','finish_toptik_owned_media_work','owned_media_work_pending']);
 const run=f.calls.find(c=>c.name==='resume'),lease=f.calls.find(c=>c.name==='acquire_shopify_reconciliation_lease');
 assert.deepEqual(run.input,{itemId:f.claim.itemId,requestId:operationId});assert.deepEqual(run.execution.actor,f.claim.actor);
 assert.equal(run.execution.owner,lease.args.p_owner);assert.ok(run.execution.deadline<=Date.now()+55000);
 assert.equal(f.calls.find(c=>c.name==='finish_toptik_owned_media_work').args.p_progressed,true);
});
test('pending preparation or uncertain response is not completion or verified progress',async()=>{
 const f=fixture();const r=await f.run();assert.equal(r.processed,0);assert.equal(r.completed,0);
 const finish=f.calls.find(c=>c.name==='finish_toptik_owned_media_work');assert.equal(finish.args.p_status,'pending');assert.equal(finish.args.p_progressed,false);
});
test('busy product preserves pending operation with no service call, no mutation, and no progress',async()=>{
 const f=fixture();f.state.lease=false;const r=await f.run();assert.equal(r.processed,0);assert.equal(f.calls.some(c=>c.name==='resume'),false);
 assert.equal(f.calls.some(c=>c.name==='release_shopify_reconciliation_lease'),false);
 assert.equal(f.calls.find(c=>c.name==='finish_toptik_owned_media_work').args.p_error,'SYNC_RECONCILIATION_BUSY');
});
test('only final readback and projection commit receipt can mark the queue verified',async()=>{
 const f=fixture();f.state.status='done';f.state.pending=false;const r=await f.run();assert.equal(r.completed,1);assert.equal(r.processed,1);
 assert.equal(r.continuationNeeded,false);assert.equal(f.calls.find(c=>c.name==='finish_toptik_owned_media_work').args.p_status,'verified');
});
test('invalid or source-drift failure is review; uncoded errors never leak and do not block release',async()=>{
 for(const [failure,expected] of [[Error('OWNED_MEDIA_SOURCE_CHANGED'),'review'],[Error('customer secret'),'failed']]){
  const f=fixture();f.state.failure=failure;const r=await f.run();assert.equal(r.completed,0);
  const finish=f.calls.find(c=>c.name==='finish_toptik_owned_media_work');assert.equal(finish.args.p_status,expected);
  assert.notEqual(finish.args.p_error,'customer secret');assert.ok(f.calls.some(c=>c.name==='release_shopify_reconciliation_lease'));
 }
});
test('forged queue identity, exclusions or actor fail closed before lease or resume',async()=>{
 for(const mutate of [f=>f.claim.productGid='gid://shopify/Product/999',f=>f.claim.itemId=owner,
  f=>f.claim.actor={actorType:'supabase_user',actorId:owner},f=>f.claim.actor={actorType:'session_admin',actorId:'forged'},f=>delete f.claim.mapVersion]){
  const f=fixture();mutate(f);await assert.rejects(f.run(),/OWNED_MEDIA_QUEUE_INVALID/);
  assert.equal(f.calls.some(c=>c.name==='resume'||c.name==='acquire_shopify_reconciliation_lease'),false);
 }
 const f=fixture();await assert.rejects(f.run([product,product]),/EXCLUSIONS_INVALID/);assert.deepEqual(f.calls,[]);
});
test('stored token and system actors remain audit identities rather than new caller assertions',async()=>{
 for(const actor of [{actorType:'admin_token',actorId:'configured-admin-panel'},{actorType:'system',actorId:'shopify-media-observer'}]){
  const f=fixture();f.claim.actor=actor;await f.run();assert.deepEqual(f.calls.find(c=>c.name==='resume').execution.actor,actor);
 }
});
test('a malformed checkpoint cannot claim progress or completion and is marked review',async()=>{
 const f=fixture();f.state.phase=-1;const r=await f.run();assert.equal(r.reviewed,1);assert.equal(r.processed,0);assert.equal(r.completed,0);
 assert.equal(f.calls.find(c=>c.name==='finish_toptik_owned_media_work').args.p_error,'OWNED_MEDIA_QUEUE_RESULT_INVALID');
});
