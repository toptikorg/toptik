import test from 'node:test';
import assert from 'node:assert/strict';
import {core,adapter,workerFor} from './helpers/typed-spec-modules.mjs';
const gid='gid://shopify/Product/1', stamp='2026-09-30T18:00:00Z';
const identity={productGid:gid,variantGid:'gid://shopify/ProductVariant/2',exactSku:'SKU-1',gallerySku:'SKU-1',itemId:'11111111-1111-4111-8111-111111111111',productHandle:'verified'};
const clone=x=>structuredClone(x);
const merchant=(key,raw,rev='edit-1')=>core.observe(core.makeSpecValue(key,raw,{authority:'merchant',producer:'gallery_typed_editor',observedAt:stamp,evidenceId:rev,intentId:rev,raw}),rev);
function fixture(){
 const state={identity,fields:core.SPEC_KEYS.map(key=>({key,stateVersion:1,galleryVersion:1,galleryBaseline:core.absent(),shopifyBaseline:core.absent(),currentGallery:core.absent()}))};
 const raw=Object.fromEntries(core.SPEC_KEYS.map(key=>[key,null]));let lease=null,version=0;
 const f={state,raw,writes:[],commits:[],rpcNames:[],fetches:0,claim:null,finished:[],pending:0};
 f.setShop=(key,text)=>{raw[key]={id:`gid://shopify/Metafield/${core.SPEC_KEYS.indexOf(key)+1}`,namespace:'toptik_specs',key,type:core.FIELD_DEFINITIONS[key].type,value:text,compareDigest:`digest-${++version}`,updatedAt:stamp};};
 f.fetch=async(expected,provenance)=>{
  f.fetches++;assert.equal(expected.productGid,gid);
  if(f.beforeFetch)await f.beforeFetch(f.fetches);
  const product={id:gid,updatedAt:stamp,variants:{nodes:[{id:identity.variantGid,sku:identity.exactSku}],pageInfo:{hasNextPage:false}},control:f.control??null};
  for(const key of core.SPEC_KEYS)product[`f_${key}`]=raw[key];
  return adapter.parseSpecReadResponse({data:{product}},identity,provenance);
 };
 f.write=async(snapshot,operations)=>{
  const request=adapter.buildSpecWriteRequest(snapshot,operations,{clearConsumerContract:process.env.SHOPIFY_TYPED_SPEC_CLEAR_CONSUMER});f.writes.push(request);
  for(const field of request.variables.metafields)if(field.namespace==='toptik_specs')f.setShop(field.key,field.value);else f.control={...field,id:'gid://shopify/Metafield/999',compareDigest:'control-'+(++version),updatedAt:stamp};
  if(f.uncertain){f.uncertain=false;throw new Error('SHOPIFY_REQUEST_TIMEOUT');}
 };
 f.db={rpc:async(name,args={})=>{
  if(f.onRpc)f.onRpc(name,args);
  f.rpcNames.push(name);let data=null;
  if(name==='acquire_shopify_reconciliation_lease'){data=!f.busy&&!lease;if(data)lease=args.p_owner;}
  else if(name==='release_shopify_reconciliation_lease'){if(lease===args.p_owner)lease=null;data=true;}
  else if(name==='read_toptik_spec_state'){
   if(f.identityInvalid)return{error:{message:'SYNC_APPROVAL_MISSING_OR_CHANGED'}};
   assert.equal(args.p_lease_owner,lease);data=clone(state);
  } else if(name==='commit_toptik_spec_readback'){
   f.commits.push(clone(args));
   for(const change of args.p_changes){const row=state.fields.find(f=>f.key===change.key);assert.equal(change.expectedVersion,row.stateVersion);assert.equal(args.p_gallery_versions[change.key],row.galleryVersion);row.galleryBaseline=clone(change.gallery);row.shopifyBaseline=clone(change.shopify);row.currentGallery=clone(change.gallery);row.stateVersion++;}
  } else if(name==='claim_toptik_spec_work'){data=f.claim;f.claim=null;}
  else if(name==='finish_toptik_spec_work')f.finished.push(args);
  else if(name==='toptik_spec_queue_status')data={pending:f.pending,failed:0,review:0,processing:0};
  else if(name==='edit_toptik_spec_fields'){f.edits=args;data=[];}
  else throw Error(`Unexpected RPC ${name}`);
  return {data,error:null};
 }};
 return f;
}
async function enabled(fn){const old=[process.env.VERCEL_ENV,process.env.SHOPIFY_TYPED_SPEC_SYNC];process.env.VERCEL_ENV='production';process.env.SHOPIFY_TYPED_SPEC_SYNC='enabled_v1';try{return await fn();}finally{for(const[key,value]of[['VERCEL_ENV',old[0]],['SHOPIFY_TYPED_SPEC_SYNC',old[1]]])if(value===undefined)delete process.env[key];else process.env[key]=value;}}
test('default off and Preview never acquire a lease or mutate either system',async()=>{
 const f=fixture(),w=await workerFor(f);for(const env of ['preview',undefined]){delete process.env.SHOPIFY_TYPED_SPEC_SYNC;process.env.VERCEL_ENV=env;assert.equal(w.typedSpecSyncEnabled(),false);assert.equal(await w.enqueueTypedSpecProduct(f.db,gid),false);}
 process.env.VERCEL_ENV='preview';process.env.SHOPIFY_TYPED_SPEC_SYNC='enabled_v1';await assert.rejects(w.reconcileTypedSpecProduct(f.db,gid),/SPEC_DISABLED/);assert.equal(f.rpcNames.length,0);delete process.env.VERCEL_ENV;delete process.env.SHOPIFY_TYPED_SPEC_SYNC;
});
test('Gallery changed material only writes typed material with absent CAS; fresh readback advances independent baselines',()=>enabled(async()=>{
 const f=fixture();f.state.fields.find(f=>f.key==='material').currentGallery=merchant('material','100% PC');
 const w=await workerFor(f),result=await w.reconcileTypedSpecProduct(f.db,gid);
 assert.equal(result.fields,1);assert.equal(f.writes.length,1);
 const sets=f.writes[0].variables.metafields;assert.deepEqual(sets.map(x=>x.key),['material','clear_state_v1']);assert.equal(sets[0].compareDigest,null);assert.equal(sets[0].value,'100% PC');
 assert.equal(f.commits.length,1);assert.deepEqual(f.commits[0].p_changes.map(x=>x.key),['material']);
 await w.reconcileTypedSpecProduct(f.db,gid);assert.equal(f.writes.length,1);assert.equal(f.commits.length,1);
}));
test('Shopify typed net_weight updates Gallery exactly; no commerce/shipping fallback or Shopify write',()=>enabled(async()=>{
 const f=fixture();f.setShop('net_weight','{"value":2.4,"unit":"KILOGRAMS"}');const w=await workerFor(f);
 await w.reconcileTypedSpecProduct(f.db,gid);assert.equal(f.writes.length,0);
 const updated=f.state.fields.find(f=>f.key==='net_weight');assert.equal(updated.currentGallery.cell.value.decimal,'2.4');assert.equal(updated.currentGallery.cell.provenance.producer,'shopify_typed_metafield');assert.equal(f.commits[0].p_changes.length,1);
 assert.equal(updated.currentGallery.cell.value.unit,'kilograms');assert.equal(updated.currentGallery.cell.value.original.unit,'KILOGRAMS');
 await w.reconcileTypedSpecProduct(f.db,gid);assert.equal(f.writes.length,0);assert.equal(f.commits.length,1);
}));

test('uncertain accepted weight write normalized to uppercase recovers without a repeated mutation',()=>enabled(async()=>{
 const f=fixture();f.state.fields.find(f=>f.key==='net_weight').currentGallery=merchant('net_weight',{value:'2.4',unit:'kilograms'});f.uncertain=true;const w=await workerFor(f);
 await assert.rejects(w.reconcileTypedSpecProduct(f.db,gid),/SHOPIFY_REQUEST_TIMEOUT/);assert.equal(f.commits.length,0);assert.equal(f.writes.length,1);
 f.setShop('net_weight','{"value":2.4,"unit":"KILOGRAMS"}');
 await w.reconcileTypedSpecProduct(f.db,gid);assert.equal(f.writes.length,1);assert.equal(f.commits.length,1);
 const row=f.state.fields.find(f=>f.key==='net_weight');assert.equal(row.shopifyBaseline.cell.value.decimal,'2.4');assert.equal(row.shopifyBaseline.cell.value.original.unit,'KILOGRAMS');
 await w.reconcileTypedSpecProduct(f.db,gid);assert.equal(f.writes.length,1);assert.equal(f.commits.length,1);
}));
test('simultaneous same-field conflict advances no baseline; independent fields still reconcile',()=>enabled(async()=>{
 const f=fixture();f.state.fields.find(f=>f.key==='material').currentGallery=merchant('material','PC');f.setShop('material','PP');f.setShop('wheel_count','4');
 const w=await workerFor(f),result=await w.reconcileTypedSpecProduct(f.db,gid);assert.deepEqual(result.conflicts,['SPEC_CONCURRENT_FIELD_CONFLICT']);assert.equal(f.writes.length,0);assert.deepEqual(f.commits[0].p_changes.map(x=>x.key),['wheel_count']);
}));
test('uncertain accepted Shopify mutation recovers as acknowledgement, never repeats write',()=>enabled(async()=>{
 const f=fixture();f.state.fields.find(f=>f.key==='material').currentGallery=merchant('material','PC');f.uncertain=true;const w=await workerFor(f);
 await assert.rejects(w.reconcileTypedSpecProduct(f.db,gid),/SHOPIFY_REQUEST_TIMEOUT/);assert.equal(f.commits.length,0);assert.equal(f.writes.length,1);
 await w.reconcileTypedSpecProduct(f.db,gid);assert.equal(f.writes.length,1);assert.equal(f.commits.length,1);
}));
test('changed digest or exact identity blocks stale writes and keeps baselines',()=>enabled(async()=>{
 for(const mode of ['digest','identity']){const f=fixture();f.state.fields.find(f=>f.key==='material').currentGallery=merchant('material','PC');f.beforeFetch=n=>{if(n===1&&mode==='identity')f.identityInvalid=true;if(n===2&&mode==='digest')f.setShop('material','PP');};const w=await workerFor(f);await assert.rejects(w.reconcileTypedSpecProduct(f.db,gid),/CONFLICT|APPROVAL/);assert.equal(f.writes.length,0);assert.equal(f.commits.length,0);}
}));
test('editor generates merchant provenance and queues only changed fields; null clears are refused',()=>enabled(async()=>{
 const f=fixture(),w=await workerFor(f),id='33333333-3333-4333-8333-333333333333';await w.editTypedSpecs(f.db,gid,id,{material:'100% PC'},{material:1});
 assert.equal(f.edits.p_edits.length,1);const source=f.edits.p_edits[0].observation.cell.provenance;assert.equal(source.authority,'merchant');assert.equal(source.producer,'gallery_typed_editor');assert.equal(source.evidenceId,id);
 await assert.rejects(w.editTypedSpecs(f.db,gid,id,{material:null},{material:1}),/CLEAR_CONSUMER_NOT_READY/);
}));
test('token operator supplied identity must exactly match approval under lease before any field write',()=>enabled(async()=>{
 const expected={itemId:identity.itemId,variantGid:identity.variantGid,gallerySku:identity.gallerySku,exactSku:identity.exactSku,productHandle:identity.productHandle};
 for(const key of Object.keys(expected)){const f=fixture(),w=await workerFor(f);await assert.rejects(w.editTypedSpecs(f.db,gid,'33333333-3333-4333-8333-333333333333',{material:'PC'},{material:1},{...expected,[key]:'wrong'}),/SPEC_IDENTITY_CHANGED/);assert.equal(f.edits,undefined);assert.equal(f.rpcNames.at(-1),'release_shopify_reconciliation_lease');}
 const f=fixture(),w=await workerFor(f);await w.editTypedSpecs(f.db,gid,'33333333-3333-4333-8333-333333333333',{material:'PC'},{material:1},expected);assert.equal(f.edits.p_edits.length,1);
}));
test('drain continues only after actual progress, busy work returns pending without spin',()=>enabled(async()=>{
 for(const busy of [false,true]){const f=fixture();f.claim={productGid:gid,generation:1};f.pending=3;f.busy=busy;const w=await workerFor(f),result=await w.drainTypedSpecQueue(f.db);assert.equal(result.continuationNeeded,!busy);assert.equal(f.finished[0].p_status,busy?'pending':'complete');assert.equal(f.rpcNames.filter(n=>n==='claim_toptik_spec_work').length,busy?1:2);}
}));
test('remaining25s does not claim another outbound item; prior progress continues and zero progress does not',t=>enabled(async()=>{
 let now=100000;t.mock.method(Date,'now',()=>now);
 const f=fixture();f.claim={productGid:gid,generation:1};f.pending=2;f.beforeFetch=()=>{now+=15000;};
 const w=await workerFor(f),result=await w.drainTypedSpecQueue(f.db,140000);
 assert.equal(result.processed,1);assert.equal(result.failed,0);assert.equal(result.continuationNeeded,true);assert.equal(f.rpcNames.filter(n=>n==='claim_toptik_spec_work').length,1);
 const next=fixture();next.claim={productGid:gid,generation:2};next.pending=2;const w2=await workerFor(next),idle=await w2.drainTypedSpecQueue(next.db,140000);
 assert.equal(idle.processed,0);assert.equal(idle.continuationNeeded,false);assert.equal(next.rpcNames.length,0);
}));
test('near-deadline accepted write reserves lease cleanup, queue finish and continuation lookup inside40s',t=>enabled(async()=>{
 let now=100000;t.mock.method(Date,'now',()=>now);const deadline=140000;
 const f=fixture();f.state.fields.find(f=>f.key==='material').currentGallery=merchant('material','100% PC');f.claim={productGid:gid,generation:1};f.pending=1;
 f.onRpc=name=>{if(name==='commit_toptik_spec_readback')now=deadline-9000;else if(['release_shopify_reconciliation_lease','finish_toptik_spec_work','toptik_spec_queue_status'].includes(name))now+=3000;};
 const w=await workerFor(f),result=await w.drainTypedSpecQueue(f.db,deadline);assert.equal(result.processed,1);assert.equal(result.continuationNeeded,true);assert.equal(f.finished[0].p_status,'complete');assert.equal(now,deadline);assert.ok(now+8000<160000);
}));
async function clearEnabled(fn){const before=process.env.SHOPIFY_TYPED_SPEC_CLEAR_CONSUMER;process.env.SHOPIFY_TYPED_SPEC_CLEAR_CONSUMER=adapter.CLEAR_CONSUMER_CONTRACT;try{return await enabled(fn)}finally{if(before===undefined)delete process.env.SHOPIFY_TYPED_SPEC_CLEAR_CONSUMER;else process.env.SHOPIFY_TYPED_SPEC_CLEAR_CONSUMER=before;}}
test('explicit clear stores null intent with prior public value, never infers absence',()=>clearEnabled(async()=>{const f=fixture(),row=f.state.fields.find(r=>r.key==='material');row.currentGallery=merchant('material','PC');const w=await workerFor(f);await w.editTypedSpecs(f.db,gid,'33333333-3333-4333-8333-333333333333',{material:null},{material:1});const cell=f.edits.p_edits[0].observation.cell;assert.equal(cell.state,'clear');assert.deepEqual(cell.provenance.raw,{intent:'clear',previousValue:'PC'});assert.equal(cell.provenance.intentId,'33333333-3333-4333-8333-333333333333:material');}));
test('clear CAS leaves native value and recovers accepted marker without second mutation',()=>clearEnabled(async()=>{const f=fixture();f.setShop('material','PC');const w=await workerFor(f);await w.reconcileTypedSpecProduct(f.db,gid);const row=f.state.fields.find(r=>r.key==='material');row.currentGallery=core.observe(core.makeSpecClear('material',{authority:'merchant',producer:'gallery_typed_editor',observedAt:stamp,evidenceId:'clear-1',intentId:'clear-1',raw:{intent:'clear',previousValue:'PC'}}),'g-clear');f.uncertain=true;await assert.rejects(w.reconcileTypedSpecProduct(f.db,gid),/TIMEOUT/);assert.equal(f.raw.material.value,'PC');assert.equal(f.writes.length,1);await w.reconcileTypedSpecProduct(f.db,gid);assert.equal(f.writes.length,1);assert.equal(row.currentGallery.cell.state,'clear');f.setShop('material','PP');await w.reconcileTypedSpecProduct(f.db,gid);assert.equal(row.currentGallery.cell.state,'value');assert.equal(row.currentGallery.cell.value,'PP');}));
test('explicit clear on absent typed target writes only bound control; later new value survives',()=>clearEnabled(async()=>{const f=fixture(),row=f.state.fields.find(r=>r.key==='material');row.currentGallery=core.observe(core.makeSpecClear('material',{authority:'merchant',producer:'gallery_typed_editor',observedAt:stamp,evidenceId:'clear-empty',intentId:'clear-empty',raw:{intent:'clear',previousValue:null}}),'g-clear');const w=await workerFor(f);await w.reconcileTypedSpecProduct(f.db,gid);assert.deepEqual(f.writes[0].variables.metafields.map(x=>x.key),['clear_state_v1']);assert.equal(f.raw.material,null);assert.equal(row.shopifyBaseline.cell.state,'clear');f.setShop('material','PC');await w.reconcileTypedSpecProduct(f.db,gid);assert.equal(row.currentGallery.cell.value,'PC');}));
test('automatic missing baseline establishes independent sides without native or Gallery first-fill',()=>enabled(async()=>{const f=fixture();f.state.fields=[];f.setShop('material','PC');let missing=true;const original=f.db.rpc;f.db.rpc=async(name,args)=>{if(name==='read_toptik_spec_state'&&missing)return{error:{message:'SPEC_APPROVAL_MISSING_OR_CHANGED'}};if(name==='read_toptik_spec_admission')return{data:{identity,copyApprovalId:'verified-copy'},error:null};if(name==='activate_toptik_spec_product'){missing=false;assert.equal(args.p_approval_id,'copy-approved-auto-v1');return{data:true,error:null}}if(name==='commit_toptik_spec_readback'){f.commits.push(args);return{data:[],error:null}}return original(name,args)};const w=await workerFor(f),r=await w.reconcileTypedSpecProduct(f.db,gid);assert.equal(r.fields,19);assert.equal(f.writes.length,0);assert.equal(f.commits.length,1);for(const c of f.commits[0].p_changes){assert.equal(c.gallery.cell.state,'absent');assert.equal(c.expectedVersion,null)}assert.equal(f.commits[0].p_changes.find(c=>c.key==='material').shopify.cell.value,'PC');}));
