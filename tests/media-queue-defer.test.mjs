import test from 'node:test';import assert from 'node:assert/strict';
import{mod,stripped,coreUrl,fixture as planningFixture,id,owner,opId,now}from'./helpers/media-planning-fixture.mjs';
Error.stackTraceLimit=0;
// REAL drainMediaWork (queue) and REAL reconcilePersistedMediaProduct (runtime); only RPC ports are fakes.
const {make}=await import(mod(`import{randomUUID}from'node:crypto';export function make(deps){const{process,createSupabaseServiceRoleClient,reconcilePersistedMediaProduct}=deps;const bootstrapProductionMedia=async(...a)=>deps.bootstrap(...a);${stripped('media-work-queue').replace(/^export /gm,'')}return{drainMediaWork};}`));
const runtime=await import(mod(`import{randomUUID}from'node:crypto';import{reconcileMedia,mediaSnapshotFingerprint}from'${coreUrl}';${stripped('media-product-runtime')}`));
const other='gid://shopify/Product/1234567';
function queue(outcome,{deferFails=false,deferHangs=false,keepResult=true,keepFails=false}={}){
 const calls=[],env={VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'};
 const db={rpc(name,args){calls.push({name,args});return{abortSignal(){
  if(name==='defer_toptik_media_work'&&deferHangs)return new Promise(()=>{});
  if(name==='keep_toptik_media_work_in_flight')return Promise.resolve(keepFails?{data:null,error:{message:'function public.keep_toptik_media_work_in_flight does not exist'}}:{data:keepResult,error:null});
  if(name==='defer_toptik_media_work'&&deferFails)return Promise.resolve({data:null,error:{message:'function public.defer_toptik_media_work does not exist'}});
  return Promise.resolve({data:name.startsWith('claim_toptik_media_work')?{productId:id.productId,claimId:args.p_claim_id,generation:3,initialized:true,evidence:{}}:
   name.startsWith('toptik_media_work_pending')?true:true,error:null});}};}};
 const api=make({process:{env},createSupabaseServiceRoleClient:()=>db,reconcilePersistedMediaProduct:async()=>outcome});
 return{calls,run:excluded=>api.drainMediaWork(Date.now()+35000,db,undefined,undefined,excluded)};
}
const names=q=>q.calls.map(c=>c.name);
const deferred={status:'pending',progressed:false,executed:false,deferred:true};

test('a budget-deferred product claimed late in a batch keeps its queue position (no finish)',async()=>{
 const q=queue(deferred);await q.run([other]);
 assert.ok(names(q).includes('defer_toptik_media_work'));assert.ok(!names(q).includes('finish_toptik_media_work'));
 const args=q.calls.find(c=>c.name==='defer_toptik_media_work').args;
 assert.deepEqual(Object.keys(args).sort(),['p_claim_id','p_generation','p_product_gid']);assert.equal(args.p_generation,3);assert.equal(args.p_product_gid,id.productId);
});
test('the FIRST claim of a batch always finishes normally, so no row can hold the head',async()=>{
 for(const excluded of [[],undefined]){const q=queue(deferred);await q.run(excluded);
  assert.ok(!names(q).includes('defer_toptik_media_work'));assert.equal(q.calls.find(c=>c.name==='finish_toptik_media_work').args.p_status,'pending');}
});
test('ordinary outcomes are unchanged: done, review, progress and diagnostics still finish',async()=>{
 for(const outcome of [{status:'done',progressed:false,executed:false},{status:'review',progressed:false,executed:false},
   {status:'pending',progressed:true,executed:true},{status:'pending',progressed:false,executed:true,diagnostic:'MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED'}]){
  const q=queue(outcome);await q.run([other]);assert.ok(!names(q).includes('defer_toptik_media_work'));assert.ok(names(q).includes('finish_toptik_media_work'));}
});
test('missing migration or a changed claim falls back to the ordinary finish (never left processing)',async()=>{
 const q=queue(deferred,{deferFails:true});await q.run([other]);
 assert.deepEqual(names(q).filter(n=>n==='defer_toptik_media_work'||n==='finish_toptik_media_work'),['defer_toptik_media_work','finish_toptik_media_work']);
});
test('a hung defer RPC is bounded to 2 s and finish still runs in its own window',async()=>{
 const q=queue(deferred,{deferHangs:true}),t=Date.now();const r=await q.run([other]);
 assert.ok(Date.now()-t<4000,'defer must not consume the finish window');
 assert.equal(q.calls.find(c=>c.name==='finish_toptik_media_work').args.p_status,'pending');assert.equal(r.failed,0);
});
test('runtime marks deferred only when planning left less than 12 s for the phase',async()=>{
 const v=planningFixture(),calls=[];let time=now;
 const body={kind:'alt',target:'shopify',key:'existing',source:'gallery',value:'new'};
 v.context.operations=[{id:opId,status:'running',next_step:0,plan:{patches:[body],orders:[]},observed_pair:v.pair}];v.context.steps=[{operation_id:opId,step_index:0,status:'started',body}];
 const planning={context:async()=>v.context,register:async()=>true,journal:async()=>({detached:[]})};
 const transport={acquire:async()=>({owner,expiresAt:now+120000}),release:async()=>true,read:async()=>({chain:{status:'running',next_phase:1,phases:['stage_source','create_owned']}})};
 const deps=budget=>({now:()=>time,environment:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},planning:()=>planning,transport:()=>transport,
  capture:async()=>({pair:v.pair,proofs:[],refs:v.refs}),gallery:()=>({observe:async()=>({snapshot:v.pair.gallery})}),
  phase:async()=>{calls.push('phase');return{status:'pending',executed:false};},budget});
 // Plenty of budget: the phase runs, nothing is deferred.
 const full=await runtime.reconcilePersistedMediaProduct(id.productId,{},now+40000,deps());
 assert.equal(full.deferred,undefined);assert.deepEqual(calls,['phase']);
 // 11 s left: no phase, deferred.
 calls.length=0;const late=await runtime.reconcilePersistedMediaProduct(id.productId,{},now+11500,deps());
 assert.equal(late.status,'pending');assert.equal(late.deferred,true);assert.deepEqual(calls,[]);
});

// In-flight operations: a claim that verified a NEW transport phase and now waits for its next
// step keeps its position (even as the batch's first claim) instead of re-queuing per step.
const inFlight = { status: 'pending', progressed: true, executed: true, verifiedCheckpoint: 'op:0:phase:1' };
const release = q => names(q).filter(n => /^(defer|keep|finish)_toptik_media_work/.test(n));
test('a newly verified phase keeps the queue position, including for the first claim of a batch', async () => {
  for (const excluded of [[], [other], undefined]) {
    const q = queue(inFlight); await q.run(excluded);
    assert.deepEqual(release(q), ['keep_toptik_media_work_in_flight']);
    assert.deepEqual(Object.keys(q.calls.find(c => c.name === 'keep_toptik_media_work_in_flight').args).sort(), ['p_claim_id', 'p_generation', 'p_product_gid']);
  }
});
test('no newly verified phase, a diagnostic, review, done or failure still finishes normally (moves to the back)', async () => {
  for (const outcome of [{ status: 'pending', progressed: true, executed: true },
    { ...inFlight, diagnostic: 'MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED' },
    { ...inFlight, status: 'review' }, { ...inFlight, status: 'done' }]) {
    const q = queue(outcome); await q.run([]);
    assert.deepEqual(release(q), ['finish_toptik_media_work'], JSON.stringify(outcome));
  }
});
test('the SQL cap (keep returns false) or an unavailable keep falls back to the ordinary finish', async () => {
  for (const opts of [{ keepResult: false }, { keepFails: true }]) {
    const q = queue(inFlight, opts); await q.run([]);
    assert.deepEqual(release(q), ['keep_toptik_media_work_in_flight', 'finish_toptik_media_work']);
    assert.equal(q.calls.find(c => c.name === 'finish_toptik_media_work').args.p_status, 'pending');
  }
});
test('a budget deferral still uses defer, never keep', async () => {
  const q = queue(deferred); await q.run([other]); assert.deepEqual(release(q), ['defer_toptik_media_work']);
});
