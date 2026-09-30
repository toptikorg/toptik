import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {stripTypeScriptTypes,createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {p,cp,id,fixture} from './helpers/commerce-fixtures.mjs';
const require=createRequire(new URL('../package.json',import.meta.url));
const policySource=readFileSync(new URL('../src/lib/shopify/commerce-finalization.ts',import.meta.url),'utf8').replace("'zod'",JSON.stringify(pathToFileURL(require.resolve('zod')).href));
const data=s=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString('base64')}`;
const policyUrl=data(policySource);
const load=async name=>import(data(readFileSync(new URL('../src/lib/shopify/'+name,import.meta.url),'utf8').replace("'./commerce-finalization'",JSON.stringify(policyUrl))));
const {runCommercialFinalization}=await load('./commerce-worker.ts');
const {sendCommercialRequest}=await load('./commerce-transport.ts');
const {commercialDatabase}=await load('./commerce-database.ts');
const {commercialPublicationMode}=await load('./commerce-mode.ts');

function setup(t){
 const f=fixture(),x=p.prepareFinalization(f.intent,f.proof,f.snapshot,f.context);
 const dir=mkdtempSync(path.join(tmpdir(),'toptik-finalization-offline-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'journal.json');writeFileSync(file,JSON.stringify({id:id(2),plan:x.plan,state:x.state,boundReceipt:null}));
 const disk=()=>JSON.parse(readFileSync(file,'utf8'));const store=r=>writeFileSync(file,JSON.stringify(r));
 let actual=cp(f.snapshot),now=f.context.now;const calls={claim:0,read:0,save:0,dispatch:0,send:0,finalize:0,release:0};
 const faults={};
 const ports={mode:'publish_verified_v1',now:()=>now,
  claim:async()=>{calls.claim++;if(faults.busy)return null;return disk();},
  read:async()=>{calls.read++;now+=faults.readMs??0;const context={...cp(f.context),now,capturedAt:new Date(now).toISOString(),catalogCapturedAt:new Date(now).toISOString()};return {snapshot:cp(actual),context};},
  save:async(record,owner,next)=>{calls.save++;assert.equal(owner,id(7));const current=disk();assert.equal(current.state.version,record.state.version,'atomic CAS');if(faults.saveReject)throw new Error('FINALIZE_SOURCE_CAS_CHANGED');
   const saved={...current,state:cp(next)};store(saved);if(faults.saveAcceptedLost){faults.saveAcceptedLost=false;throw new Error('private transport text');}return saved;},
  assertDispatch:async()=>{calls.dispatch++;if(faults.dispatchReject)throw new Error('FINALIZE_OWNED_LEASE_REQUIRED');return true;},
  send:async request=>{calls.send++;assert.deepEqual(request,disk().state.pending.request);if(!faults.notAccepted)actual=cp(disk().state.pending.expected);
   if(faults.responseLost){faults.responseLost=false;throw new Error('private Shopify error and token');}},
  finalize:async()=>{calls.finalize++;const record=disk();const result={receiptId:id(99),productGid:record.plan.initial.identity.productGid,variantGid:record.plan.initial.identity.variantGid};store({...record,boundReceipt:result});
   if(faults.finalizeLost){faults.finalizeLost=false;throw new Error('lost SQL result');}return result;},
  release:async()=>{calls.release++;},
 };
 return {f,ports,faults,calls,disk,store,actual:()=>cp(actual),setActual:x=>actual=cp(x),advance:ms=>now+=ms,
  run:()=>runCommercialFinalization(id(2),id(7),ports)};
}
test('worker performs one request per call then NEW-only finalizer; persistent no-op bound replay',async t=>{
 const h=setup(t);for(let n=0;n<4;n++){const r=await h.run();assert.equal(r.status,'pending');assert.equal(h.calls.send,n+1);}
 assert.equal((await h.run()).status,'bound');assert.equal(h.calls.finalize,1);assert.equal(h.calls.send,4);
 assert.equal((await h.run()).status,'bound');assert.equal(h.calls.finalize,1);assert.equal(h.calls.release,6);
});
test('default-off and invalid ID make no port call',async t=>{
 const h=setup(t);h.ports.mode=undefined;assert.equal((await h.run()).status,'disabled');assert.equal(h.calls.claim,0);
 h.ports.mode='publish_verified_v1';assert.equal((await runCommercialFinalization('bad',id(7),h.ports)).status,'review');assert.equal(h.calls.claim,0);
});
test('busy lease sends nothing and is not released by a non-owner',async t=>{
 const h=setup(t);h.faults.busy=true;assert.equal((await h.run()).status,'busy');assert.equal(h.calls.send,0);assert.equal(h.calls.release,0);
});
test('persist CAS rejection stops before dispatch',async t=>{
 const h=setup(t);h.faults.saveReject=true;const result=await h.run();assert.equal(result.code,'FINALIZE_SOURCE_CAS_CHANGED');assert.equal(h.calls.send,0);assert.equal(h.calls.dispatch,0);assert.equal(h.disk().state.pending,null);
});
test('lost accepted intent-save response never dispatches; restart is read-only and goes to review',async t=>{
 const h=setup(t);h.faults.saveAcceptedLost=true;assert.equal((await h.run()).status,'pending');assert.equal(h.calls.send,0);assert.ok(h.disk().state.pending);
 assert.equal((await h.run()).status,'review');assert.equal(h.calls.send,0);assert.equal(h.disk().state.review,'FINALIZE_READBACK_CONCURRENT_OR_UNCERTAIN');
});
test('lost accepted Shopify response survives disk reload and never repeats write',async t=>{
 const h=setup(t);h.faults.responseLost=true;const r=await h.run();assert.equal(r.code,'FINALIZE_MUTATION_RESPONSE_UNCERTAIN');assert.equal(h.calls.send,1);
 assert.ok(h.disk().state.pending);assert.equal((await h.run()).mutationAttempted,false);assert.equal(h.calls.send,1);assert.equal(h.disk().state.index,1);
});
test('lost rejected Shopify response goes to review without retry',async t=>{
 const h=setup(t);h.faults.responseLost=true;h.faults.notAccepted=true;await h.run();assert.equal((await h.run()).status,'review');assert.equal(h.calls.send,1);
 await h.run();assert.equal(h.calls.send,1);
});
test('lease/source dispatch recheck rejects after durable intent, before external write',async t=>{
 const h=setup(t);h.faults.dispatchReject=true;assert.equal((await h.run()).code,'FINALIZE_OWNED_LEASE_REQUIRED');assert.equal(h.calls.send,0);assert.ok(h.disk().state.pending);
});
test('lost accepted finalizer response recovers immutable receipt without another finalizer',async t=>{
 const h=setup(t);for(let n=0;n<4;n++)await h.run();h.faults.finalizeLost=true;await h.run();assert.ok(h.disk().boundReceipt);
 assert.equal((await h.run()).status,'bound');assert.equal(h.calls.send,4);assert.equal(h.calls.finalize,1);
});
test('strict deadlines prevent starting a write with insufficient readback budget',async t=>{
 const h=setup(t);h.faults.readMs=14000;assert.equal((await h.run()).status,'budget');assert.equal(h.calls.send,0);assert.equal(h.calls.save,0);
 const result=await runCommercialFinalization(id(2),id(7),h.ports,h.ports.now()+5000);assert.equal(result.status,'budget');
});
test('port error output is filtered and credentials/freeform provider text never escape',async t=>{
 const h=setup(t);h.ports.read=async()=>{throw new Error('https://private token=secret');};const r=await h.run();assert.equal(r.code,'FINALIZE_OPERATION_UNCERTAIN');assert.doesNotMatch(JSON.stringify(r),/secret|private/);
});
test('transport fixes API/store, passes absolute deadline/no retry and requires valid envelope',async()=>{
 const f=fixture(),x=p.prepareFinalization(f.intent,f.proof,f.snapshot,f.context),request=p.beginNextStep(x.plan,x.state,x.state.observed,f.context).request;
 let calls=0;const transport={now:()=>1,graphql:async(q,v,options)=>{calls++;assert.deepEqual(options,{shopDomain:p.SHOP,apiVersion:'2026-07',deadline:100,mutation:true,retry:false});return {data:{productVariantsBulkUpdate:{userErrors:[]}}};}};
 await sendCommercialRequest(transport,request,100);assert.equal(calls,1);
 for(const response of [null,[],{data:[]},{data:{}},{data:{productVariantsBulkUpdate:{}}},{data:{productVariantsBulkUpdate:{userErrors:[{message:'private'}]}}},
  ...[null,{},'',false,0].map(errors=>({data:{productVariantsBulkUpdate:{userErrors:[]}},errors}))]){
  await assert.rejects(sendCommercialRequest({...transport,graphql:async()=>response},request,100),/FINALIZE_SHOPIFY_/);
 }
 await assert.rejects(sendCommercialRequest(transport,request,1),/TIME_BUDGET/);assert.equal(calls,1);
});
test('publication has a separate exact Production-only default-off flag',()=>{
 for(const env of [{},{VERCEL_ENV:'production',SHOPIFY_GALLERY_CREATE_MODE:'draft_only'},
  {VERCEL_ENV:'preview',SHOPIFY_GALLERY_PUBLISH_MODE:'publish_verified_v1'},{VERCEL_ENV:'production',SHOPIFY_GALLERY_PUBLISH_MODE:'true'}])assert.equal(commercialPublicationMode(env),undefined);
 assert.equal(commercialPublicationMode({VERCEL_ENV:'production',SHOPIFY_GALLERY_PUBLISH_MODE:'publish_verified_v1'}),'publish_verified_v1');
});
test('database bridge expires before dispatch and suppresses raw SQL diagnostics',async()=>{
 const f=fixture();let calls=0,now=1;const store=commercialDatabase({rpc:()=>({abortSignal:async()=>{calls++;return {data:f.intent,error:null};}})},()=>now);
 await assert.rejects(store.saveMerchant(f.intent,null,1),/TIME_BUDGET/);assert.equal(calls,0);
 await store.saveMerchant(f.intent,null,100);assert.equal(calls,1);
 const failed=commercialDatabase({rpc:()=>({abortSignal:async()=>({data:null,error:{message:'token=private provider text'}})})},()=>1);
 await assert.rejects(failed.saveMerchant(f.intent,null,100),e=>e.message==='FINALIZE_DATABASE_UNCONFIRMED');
 const late=commercialDatabase({rpc:()=>({abortSignal:async()=>{now=100;return {data:f.intent,error:null};}})},()=>now);now=1;
 await assert.rejects(late.saveMerchant(f.intent,null,100),/TIME_BUDGET/);
});
