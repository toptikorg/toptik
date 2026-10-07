import test from 'node:test';import assert from 'node:assert/strict';
import{mod,stripped,id,owner}from'./helpers/media-planning-fixture.mjs';
Error.stackTraceLimit=0;
const {make}=await import(mod(`import{randomUUID}from'node:crypto';export function make(deps){const{process,createSupabaseServiceRoleClient,reconcilePersistedMediaProduct}=deps;const bootstrapProductionMedia=async(...a)=>deps.bootstrap(...a);${stripped('media-work-queue').replace(/^export /gm,'')}return{describeUncodedFailure,mediaSyncEnabled,enqueueGalleryMediaChanges,enqueueShopifyMediaChange,recoverMediaWork,drainMediaWork};}`));
function fixture(){const calls=[],env={VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},state={outcome:{status:'pending',progressed:true,executed:false},pending:true},db={rpc(name,args){calls.push({name,args});return{abortSignal(){return Promise.resolve({data:name.startsWith('claim_toptik_media_work')?{productId:id.productId,claimId:args.p_claim_id,generation:1,initialized:true,evidence:{}}:name.startsWith('toptik_media_work_pending')?state.pending:name==='enqueue_toptik_gallery_media_work'||name==='recover_toptik_media_work'?1:true,error:null});}};}},api=make({process:{env},createSupabaseServiceRoleClient:()=>{calls.push('factory');return db;},reconcilePersistedMediaProduct:async(...a)=>{calls.push(['run',...a]);if(state.error)throw state.error;return state.outcome;}});return{calls,env,state,db,api};}
const item={id:id.itemId,title:'bag',coverImagePath:'image',isActive:true,description:'text',angles:[{id:owner,angleKey:'front',imagePath:'image',angleOrder:1}]},actor={actorType:'admin_panel_token',actorId:'configured-admin-panel'};
test('default-off does not initialize service client or call any port',async()=>{const f=fixture();delete f.env.SHOPIFY_MEDIA_SYNC;await f.api.drainMediaWork(Date.now()+30000);assert.equal(await f.api.enqueueGalleryMediaChanges([],[],actor),0);assert.equal(await f.api.enqueueShopifyMediaChange(id.productId,owner),false);assert.equal(await f.api.recoverMediaWork(),0);assert.deepEqual(f.calls,[]);});
test('only changed existing media rows queue; copy-only and newly created items excluded',async()=>{const f=fixture();await f.api.enqueueGalleryMediaChanges([item],[{...item,description:'changed'}],actor);assert.deepEqual(f.calls,[]);await f.api.enqueueGalleryMediaChanges([item],[item,{...item,id:owner}],actor);assert.deepEqual(f.calls,[]);await f.api.enqueueGalleryMediaChanges([item],[{...item,coverImagePath:'new'}],actor);const c=f.calls.find(c=>c.name);assert.deepEqual(c.args,{p_item_ids:[id.itemId],p_actor:actor});});
test('title fallback alt, explicit alt and angle order edits enqueue',async()=>{for(const edit of [i=>i.title='new',i=>i.coverImageAlt='alt',i=>i.angles[0].angleOrder=2]){const f=fixture(),updated=structuredClone(item);edit(updated);assert.equal(await f.api.enqueueGalleryMediaChanges([item],[updated],actor),1);}});
test('Shopify queue requires exact fixed-type GID and existing inbox UUID',async()=>{const f=fixture();await assert.rejects(f.api.enqueueShopifyMediaChange('gid://shopify/Order/1',owner),/WEBHOOK_INVALID/);assert.deepEqual(f.calls,[]);assert.equal(await f.api.enqueueShopifyMediaChange(id.productId,owner),true);assert.equal(f.calls[1].name,'enqueue_toptik_shopify_media_work');});
test('one product claim -> bounded reconcile -> exact generation finish -> continuation',async()=>{const f=fixture(),deadline=Date.now()+35000,result=await f.api.drainMediaWork(deadline,f.db);assert.equal(result.processed,1);assert.equal(result.continuationNeeded,true);assert.deepEqual(f.calls.filter(c=>c.name).map(c=>c.name),['claim_toptik_media_work','finish_toptik_media_work','toptik_media_work_pending']);assert.equal(f.calls.find(c=>Array.isArray(c))[3],deadline-5000);assert.equal(f.calls.find(c=>c.name==='finish_toptik_media_work').args.p_generation,1);});
for(const outcome of [{status:'busy',progressed:false,executed:false},{status:'pending',progressed:false,executed:false}])test(`${outcome.status} without progress never chains`,async()=>{const f=fixture();f.state.outcome=outcome;const r=await f.api.drainMediaWork(Date.now()+30000,f.db);assert.equal(r.continuationNeeded,false);assert.equal(f.calls.some(c=>c.name==='toptik_media_work_pending'),false);});
test('uncertain already-executed call permits one read-only recovery wakeup',async()=>{const f=fixture();f.state.outcome={status:'pending',progressed:false,executed:true};assert.equal((await f.api.drainMediaWork(Date.now()+30000,f.db)).continuationNeeded,true);});
test('already-equal completed product advances pending queue without inventing a media mutation',async()=>{const f=fixture();f.state.outcome={status:'done',progressed:false,executed:false};const r=await f.api.drainMediaWork(Date.now()+30000,f.db);assert.equal(r.processed,0);assert.equal(r.continuationNeeded,true);assert.equal(f.calls.find(c=>c.name==='finish_toptik_media_work').args.p_status,'done');});
test('durable review/failure advances only independent pending work',async()=>{for(const [code,status]of[['MEDIA_TRANSPORT_FINAL_SNAPSHOT_MISMATCH','review'],['MEDIA_DETACH_RECEIPT_DUPLICATE','review'],['MEDIA_REVIEW_REQUIRED','review'],['MEDIA_REVIEW_REJECTED','review'],['MEDIA_PROVENANCE_REQUIRED','review'],['MEDIA_NETWORK_FAILED','failed'],['SECRET password','failed']]){const f=fixture();f.state.error=Error(code);const r=await f.api.drainMediaWork(Date.now()+30000,f.db),finish=f.calls.find(c=>c.name==='finish_toptik_media_work');assert.equal(finish.args.p_status,status);assert.equal(r.continuationNeeded,true);assert.notEqual(finish.args.p_error,'SECRET password');f.state.pending=false;assert.equal((await f.api.drainMediaWork(Date.now()+30000,f.db)).continuationNeeded,false);}});
test('less than admission reserve does not claim or initialize client',async()=>{const f=fixture();await f.api.drainMediaWork(Date.now()+100);assert.deepEqual(f.calls,[]);});
test('78 approved missing baselines initialize one product per bounded invocation with no cross-write run',async()=>{
 const products=Array.from({length:78},(_,i)=>'gid://shopify/Product/'+(1000+i)),initialized=[],finished=[];
 const db={rpc(name,args){return{abortSignal(){const p=products[0];return Promise.resolve({data:name==='claim_toptik_media_work'?(p?{productId:p,claimId:args.p_claim_id,generation:1,evidence:{},initialized:false}:null):name==='finish_toptik_media_work'?(finished.push(args),products.shift(),true):name==='toptik_media_work_pending'?products.length>0:null,error:null});}};}};
 const api=make({process:{env:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'}},createSupabaseServiceRoleClient:()=>db,reconcilePersistedMediaProduct:async()=>{throw Error('NO_CROSS_WRITE_DURING_ADMISSION');},bootstrap:async(p,enabled,d,o)=>{initialized.push(p);assert.equal(enabled,true);assert.equal(o.client,db);assert.ok(d>Date.now());return{initialized:true,enabled:true};}});
 for(let i=0;i<78;i++){const r=await api.drainMediaWork(Date.now()+35000,db);assert.equal(r.processed,1);assert.equal(r.continuationNeeded,i<77);}
 assert.equal(new Set(initialized).size,78);assert.equal(finished.length,78);assert.ok(finished.every(x=>x.p_status==='done'));
});


test('explicit review outcome continues independent pending but never claims review itself',async()=>{
 const f=fixture();f.state.outcome={status:'review',progressed:false,executed:false};
 assert.equal((await f.api.drainMediaWork(Date.now()+30000,f.db)).continuationNeeded,true);
 assert.equal(f.calls.find(c=>c.name==='finish_toptik_media_work').args.p_status,'review');
 f.state.pending=false;assert.equal((await f.api.drainMediaWork(Date.now()+30000,f.db)).continuationNeeded,false);
});

test('verified progress advances at most three phases in one claim with one deadline and finish',async()=>{
 const f=fixture(),runs=[],deadline=Date.now()+40000;
 const run=async(...a)=>{runs.push(a);return{status:'pending',progressed:true,executed:true,verifiedCheckpoint:'phase:'+runs.length};};
 const r=await f.api.drainMediaWork(deadline,f.db,run);
 assert.equal(runs.length,3);assert.equal(r.processed,1);
 assert.ok(runs.every(a=>a[0]===id.productId&&a[2]===deadline-5000));
 // A still-pending in-flight operation keeps its position (defer), never re-queues behind every product.
 assert.deepEqual(f.calls.filter(c=>c.name).map(c=>c.name),['claim_toptik_media_work','keep_toptik_media_work_in_flight','toptik_media_work_pending']);
});

test('repeated verified cursor stops instead of spinning, while finish retains original generation',async()=>{
 const f=fixture();let n=0;const run=async()=>{n++;return{status:'pending',progressed:true,executed:false,verifiedCheckpoint:'same:cursor'};};
 await f.api.drainMediaWork(Date.now()+40000,f.db,run);assert.equal(n,2);
 const keep=f.calls.find(c=>c.name==='keep_toptik_media_work_in_flight');assert.equal(keep.args.p_generation,1);assert.ok(!f.calls.some(c=>c.name==='finish_toptik_media_work'));
});

test('preparation or uncertain execution alone cannot immediately repeat a product',async()=>{
 for(const outcome of [{status:'pending',progressed:true,executed:false},{status:'pending',progressed:false,executed:true}]){
  const f=fixture();let n=0;await f.api.drainMediaWork(Date.now()+40000,f.db,async()=>{n++;return outcome;});assert.equal(n,1);
 }
});

test('remaining deadline reserve prevents another call even after verified progress',async()=>{
 const f=fixture();let n=0;await f.api.drainMediaWork(Date.now()+22000,f.db,async()=>{n++;return{status:'pending',progressed:true,executed:true,verifiedCheckpoint:'verified'};});
 assert.equal(n,1);assert.ok(f.calls.some(c=>c.name==='keep_toptik_media_work_in_flight'));assert.ok(!f.calls.some(c=>c.name==='finish_toptik_media_work'));
});

test('done, busy, review and uncertain outcomes after progress stop immediately',async()=>{
 for(const status of ['done','busy','review','pending']){
  const f=fixture();let n=0;const run=async()=>++n===1?{status:'pending',progressed:true,executed:true,verifiedCheckpoint:'verified'}:{status,progressed:false,executed:status==='pending'};
  await f.api.drainMediaWork(Date.now()+40000,f.db,run);assert.equal(n,2);
  // done/review finish normally; a still-pending outcome after a verified phase keeps its position.
  if(status==='done'||status==='review'){assert.equal(f.calls.filter(c=>c.name==='finish_toptik_media_work').length,1);
   assert.equal(f.calls.find(c=>c.name==='finish_toptik_media_work').args.p_status,status);}
  else{assert.equal(f.calls.filter(c=>c.name==='keep_toptik_media_work_in_flight').length,1);assert.ok(!f.calls.some(c=>c.name==='finish_toptik_media_work'));}
 }
});

test('failure after verified progress is durable and never repeated in the same claim',async()=>{
 const f=fixture();let n=0;const run=async()=>{if(++n===2)throw Error('MEDIA_SOURCE_CHANGED');return{status:'pending',progressed:true,executed:true,verifiedCheckpoint:'verified'};};
 const result=await f.api.drainMediaWork(Date.now()+40000,f.db,run);assert.equal(n,2);assert.equal(result.reviewed,1);
 assert.equal(f.calls.find(c=>c.name==='finish_toptik_media_work').args.p_error,'MEDIA_SOURCE_CHANGED');
});

for(const status of ['pending','busy'])test(`batch ${status} without progress advances only unvisited pending identities`,async()=>{
 const f=fixture(),excluded=['gid://shopify/Product/1234567'];f.state.outcome={status,progressed:false,executed:false};
 const result=await f.api.drainMediaWork(Date.now()+40000,f.db,undefined,undefined,excluded);
 assert.equal(result.continuationNeeded,true);assert.equal(result.claimedProductId,id.productId);assert.equal(result.processed,0);
 assert.deepEqual(f.calls.find(c=>c.name==='claim_toptik_media_work_excluding').args.p_exclude_product_gids,excluded);
 assert.deepEqual(f.calls.find(c=>c.name==='toptik_media_work_pending_excluding').args.p_exclude_product_gids,[...excluded,id.productId]);
 assert.deepEqual(excluded,['gid://shopify/Product/1234567']);
 assert.equal(f.calls.find(c=>c.name==='finish_toptik_media_work').args.p_status,'pending');
 f.state.pending=false;assert.equal((await f.api.drainMediaWork(Date.now()+40000,f.db,undefined,undefined,[])).continuationNeeded,false);
});

test('batch exclusions reject null malformed duplicates sparse and oversized lists before any RPC',async()=>{
 for(const excluded of [null,{},'x',[null],['gid://shopify/Order/1'],['gid://shopify/Product/0'],[id.productId,id.productId],new Array(1),Array.from({length:11},(_,i)=>'gid://shopify/Product/'+(100+i))]){
  const f=fixture();await assert.rejects(f.api.drainMediaWork(Date.now()+40000,f.db,undefined,undefined,excluded),/MEDIA_QUEUE_EXCLUSIONS_INVALID/);assert.deepEqual(f.calls,[]);
 }
});

test('batch with ten visited identities cannot claim an eleventh',async()=>{
 const f=fixture(),excluded=Array.from({length:10},(_,i)=>'gid://shopify/Product/'+(100+i));
 assert.equal((await f.api.drainMediaWork(Date.now()+40000,f.db,undefined,undefined,excluded)).claimedProductId,undefined);assert.deepEqual(f.calls,[]);
});

test('batch rejects a repeated identity from a bad claim response before reconciliation',async()=>{
 const f=fixture();await assert.rejects(f.api.drainMediaWork(Date.now()+40000,f.db,undefined,undefined,[id.productId]),/MEDIA_QUEUE_BATCH_REPEATED/);
 assert.equal(f.calls.some(Array.isArray),false);assert.equal(f.calls.some(c=>c.name==='finish_toptik_media_work'),false);
});

test('exclusion snapshot cannot be changed by caller while RPC is pending',async()=>{
 const f=fixture(),excluded=['gid://shopify/Product/1234567'];
 const pending=f.api.drainMediaWork(Date.now()+40000,f.db,undefined,undefined,excluded);excluded.push(id.productId);await pending;
 assert.deepEqual(f.calls.find(c=>c.name==='claim_toptik_media_work_excluding').args.p_exclude_product_gids,['gid://shopify/Product/1234567']);
});

test('batch empty claim stops and never finishes or asks for continuation',async()=>{
 const f=fixture();f.db.rpc=(name,args)=>{f.calls.push({name,args});return{abortSignal:()=>Promise.resolve({data:null,error:null})};};
 const r=await f.api.drainMediaWork(Date.now()+40000,f.db,undefined,undefined,[]);
 assert.equal(r.claimedProductId,undefined);assert.equal(r.continuationNeeded,false);assert.equal(f.calls.length,1);
});

test('failed exact finish stops batch before another pending predicate or claim',async()=>{
 const f=fixture(),original=f.db.rpc;f.db.rpc=(name,args)=>name==='finish_toptik_media_work'?{abortSignal:()=>Promise.resolve({error:{message:'MEDIA_QUEUE_CLAIM_CHANGED'}})}:original(name,args);
 await assert.rejects(f.api.drainMediaWork(Date.now()+40000,f.db,undefined,undefined,[]),/MEDIA_QUEUE_CLAIM_CHANGED/);
 assert.equal(f.calls.some(c=>c.name==='toptik_media_work_pending_excluding'),false);
});
test('pending transport diagnostic is recorded as last_error while the row stays pending and claimable',async()=>{
 const f=fixture();f.state.outcome={status:'pending',progressed:false,executed:false,diagnostic:'MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED'};
 const r=await f.api.drainMediaWork(Date.now()+30000,f.db),finish=f.calls.find(c=>c.name==='finish_toptik_media_work').args;
 assert.equal(finish.p_status,'pending');assert.equal(finish.p_error,'MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED');assert.equal(r.failed,0);assert.equal(r.reviewed,0);
 for(const outcome of [{status:'pending',progressed:false,executed:false,diagnostic:'not a code'},{status:'done',progressed:false,executed:false,diagnostic:'MEDIA_STORAGE_X'},{status:'pending',progressed:false,executed:false}]){
  const g=fixture();g.state.outcome=outcome;await g.api.drainMediaWork(Date.now()+30000,g.db);assert.equal(g.calls.find(c=>c.name==='finish_toptik_media_work').args.p_error,null);}
});

const capture=async(fn)=>{const logs=[];const orig=console.error;console.error=(...a)=>logs.push(a);try{await fn();}finally{console.error=orig;}return logs;};
test('an uncoded failure logs only its kind and an allowlisted message; finish is unchanged',async()=>{
 const f=fixture();const logs=await capture(()=>f.api.drainMediaWork(Date.now()+40000,f.db,async()=>{throw new TypeError("Cannot read properties of undefined (reading 'x')");}));
 const fin=f.calls.find(c=>c.name==='finish_toptik_media_work').args;assert.equal(fin.p_error,'MEDIA_WORK_FAILED');assert.equal(fin.p_status,'failed');
 const entry=logs.find(l=>l[0]==='toptik.media.work_failed');assert.equal(entry[1].kind,'TypeError');assert.equal(entry[1].message,'<omitted>','quotes are not allowlisted');
});
test('a coded MEDIA_ failure is not logged by the queue',async()=>{
 const f=fixture();const logs=await capture(()=>f.api.drainMediaWork(Date.now()+40000,f.db,async()=>{throw new Error('MEDIA_SOURCE_READ_FAILED');}));
 assert.ok(!logs.some(l=>l[0]==='toptik.media.work_failed'));
});
test('a hostile error object can never break the failure path',async()=>{
 for(const bad of [Object.assign(new Error('x'),{name:undefined}),Object.assign(new Error(),{message:{toString(){throw new Error('boom');}}}),{message:'not an Error'},null,42]){
  const f=fixture();await capture(()=>f.api.drainMediaWork(Date.now()+40000,f.db,async()=>{throw bad;}));
  const fin=f.calls.find(c=>c.name==='finish_toptik_media_work');assert.ok(fin,'finish still runs');assert.equal(fin.args.p_error,'MEDIA_WORK_FAILED');
 }
});
test('describeUncodedFailure allowlists only safe messages',()=>{
 const d=fixture().api.describeUncodedFailure;
 const cases=[[new TypeError("Cannot read properties of undefined (reading x)"),"Cannot read properties of undefined (reading x)"],[new Error("fetch failed"),"fetch failed"],[new Error("SHOPIFY_API_HTTP_500"),"SHOPIFY_API_HTTP_500"],
  [new Error("jane.doe@example.com rejected"),"<omitted>"],[new Error("key=sk_live_short123 token=abc123"),"<omitted>"],[new Error("Bearer shpat_short1234"),"<omitted>"],
  [new Error("connect postgres://postgres:hunter2pass@db.example"),"<omitted>"],[new Error("Unexpected token < in JSON at position 0 \"<!DOCTYPE\""),"<omitted>"],[new Error("abc%3Ddef%2Fghi"),"<omitted>"],
  [new Error("fetch failed\nhttps://x.example/?apikey=secret"),"fetch failed"]];
 for(const [e,want] of cases) assert.equal(d(e).message,want,String(e.message));
 assert.deepEqual(d({message:'x'}),{kind:'object',message:'<omitted>'});
 assert.equal(d(Object.assign(new Error('x'),{name:undefined})).kind,'Error');
});
