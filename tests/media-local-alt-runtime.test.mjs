import test from 'node:test';import assert from 'node:assert/strict';
import{mod,stripped,coreUrl,core,fixture,id,owner,opId,now,visualsFor}from'./helpers/media-planning-fixture.mjs';
Error.stackTraceLimit=0;
// Consumer review: the REAL reconcilePersistedMediaProduct + REAL reconcileMedia (core) with the planning/transport
// ports faked exactly as tests/media-product-runtime.test.mjs does. No change to runtime, transport or SQL.
const api=await import(mod(`import{randomUUID}from'node:crypto';import{reconcileMedia,mediaSnapshotFingerprint}from'${coreUrl}';${stripped('media-product-runtime')}`));
const hash='b'.repeat(64);
function harness({mutate}={}){
 const v=fixture(),calls=[],record=(name,args,value)=>{calls.push({name,args});return value;};
 // Baseline: shared 'existing' image + an INDEPENDENT gallery-only image 'legacy'.
 const legacy={key:'legacy',contentId:hash,alt:'תמונה ישנה',evidenceId:'g-legacy'};
 v.context.baselines.gallery.assets.push(structuredClone(legacy));
 const state={context:v.context,current:structuredClone(v.context.baselines),committed:null};
 state.current.gallery.assets[1].alt='תיאור נגיש מעודכן של הזווית הישנה';
 mutate?.(state);
 const planning={context:async(...a)=>record('context',a,state.context),register:async(...a)=>record('register',a,true),journal:async(...a)=>record('journal',a,{detached:[]}),
  reserve:async(...a)=>{record('reserve',a);state.context.operations=[{id:opId,status:'reserved',next_step:0,plan:a[3],observed_pair:state.current}];state.context.steps=[];return{operationId:opId};},
  commit:async(...a)=>{record('commit',a);state.committed=structuredClone(a[2]);return{status:'verified'};},
  removal:async()=>{throw Error('no removal may be created');},begin:async()=>{throw Error('no step');},acceptFinal:async()=>{throw Error('no transport');}};
 const transport={acquire:async(...a)=>record('acquire',a,{owner,expiresAt:now+120000}),release:async(...a)=>record('release',a,true),
  recordPlannerConflict:async(...a)=>record('conflict',a,true),read:async()=>{throw Error('no transport read');},prepare:async()=>{throw Error('no transport prepare');}};
 const deps={now:()=>now,environment:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},planning:()=>planning,transport:()=>transport,
  capture:async(...a)=>record('capture',a,{pair:state.current,proofs:[],refs:v.refs,visuals:visualsFor(state.current)}),gallery:()=>({observe:async(...a)=>record('observe',a,{snapshot:state.current.gallery})}),
  phase:async()=>{throw Error('no transport phase may run');}};
 return{state,calls,run:()=>api.reconcilePersistedMediaProduct(id.productId,{},now+40000,deps)};
}
test('local independent ALT: reserve with no patch/order/conflict, ordinary fresh commit, no transport, then idempotent',async()=>{
 const h=harness(),r=await h.run();
 assert.equal(r.status,'done');assert.equal(r.progressed,true);assert.equal(r.executed,false);
 const reserve=h.calls.find(c=>c.name==='reserve').args,plan=reserve[3];
 assert.deepEqual(plan.patches,[]);assert.deepEqual(plan.orders,[]);assert.deepEqual(plan.conflicts,[]);
 assert.deepEqual(Object.keys(plan).sort(),['conflicts','identity','orders','patches','preconditions','projected'],'reserve requires exactly six plan keys');
 assert.deepEqual(plan.projected.gallery,h.state.current.gallery.assets);assert.ok(!plan.projected.shopify.some(a=>a.key==='legacy'));
 assert.deepEqual(h.state.committed,h.state.current,'the fresh observation is committed, never a synthesized baseline');
 assert.equal(h.calls.at(-1).name,'release');assert.ok(!h.calls.some(c=>c.name==='conflict'));
 assert.deepEqual(core.independentLocalAltChanges(h.state.context.baselines,h.state.current).map(x=>[x.side,x.key]),[['gallery','legacy']]);
 // After the verified commit the baseline is the committed pair: the same reconciliation does nothing.
 const again=harness();again.state.context.baselines=structuredClone(h.state.committed);again.state.current=structuredClone(h.state.committed);
 const r2=await again.run();assert.equal(r2.status,'done');assert.ok(!again.calls.some(c=>c.name==='reserve'||c.name==='commit'));
});
test('local ALT with a changed source keeps the durable mapping conflict (review), no reserve',async()=>{
 const h=harness({mutate:s=>{s.current.gallery.assets[1].evidenceId='g-other-source';}}),r=await h.run();
 assert.equal(r.status,'review');assert.ok(!h.calls.some(c=>c.name==='reserve'));
 const conflicts=h.calls.find(c=>c.name==='conflict').args[4];assert.deepEqual(conflicts.map(c=>[c.key,c.code]),[['legacy','MEDIA_TARGET_MAPPING_REQUIRED']]);
});
test('local ALT plus a possible counterpart (same bytes appear on Shopify under another key) stays a conflict',async()=>{
 const h=harness({mutate:s=>{s.current.shopify.assets.push({key:'s-media:99',contentId:hash,alt:'x',evidenceId:'s-99'});}}),r=await h.run();
 assert.equal(r.status,'review');assert.ok(h.calls.find(c=>c.name==='conflict').args[4].some(c=>c.key==='legacy'));
});
