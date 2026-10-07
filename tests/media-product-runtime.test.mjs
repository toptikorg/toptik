import test from 'node:test';import assert from 'node:assert/strict';
import{mod,stripped,coreUrl,core,fixture,id,owner,opId,now}from'./helpers/media-planning-fixture.mjs';
Error.stackTraceLimit=0;
const api=await import(mod(`import{randomUUID}from'node:crypto';import{reconcileMedia,mediaSnapshotFingerprint}from'${coreUrl}';${stripped('media-product-runtime')}`));
function f(){const v=fixture(),calls=[],state={context:v.context,current:structuredClone(v.pair),chain:null,time:now,phase:{status:'verified',executed:true}};
 const record=(name,args,value)=>{calls.push({name,args});return value;};
 const planning={context:async(...a)=>record('context',a,state.context),register:async(...a)=>record('register',a,true),journal:async(...a)=>record('journal',a,{detached:[]}),
 reserve:async(...a)=>{record('reserve',a);const plan=a[3];state.context.operations=[{id:opId,status:'reserved',next_step:0,plan,observed_pair:state.current}];state.context.steps=[{operation_id:opId,step_index:0,status:'ready',body:plan.patches[0]??plan.orders[0]}];return{operationId:opId};},
 begin:async(...a)=>{record('begin',a);state.context.steps[0].status='started';return{status:'started'};},accept:async(...a)=>record('accept',a,{status:'verified'}),acceptFinal:async(...a)=>record('acceptFinal',a,{status:'verified'}),commit:async(...a)=>record('commit',a,{status:'verified'}),
 removal:async(...a)=>record('removal',a,{side:a[1],key:a[2],requestId:opId,kind:a[1]==='gallery'?'authenticated_editor':'signed_shopify_event',expectedBaselineFingerprint:a[3]})};
 const transport={acquire:async(...a)=>record('acquire',a,{owner,expiresAt:now+120000}),release:async(...a)=>record('release',a,true),recordPlannerConflict:async(...a)=>record('conflict',a,true),read:async(...a)=>record('read',a,{chain:state.chain}),prepare:async(...a)=>{record('prepare',a);state.chain={status:'ready',next_phase:0,phases:a[3]};return{};}};
 const deps={now:()=>state.time,environment:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},planning:()=>planning,transport:()=>transport,
 capture:async(...a)=>record('capture',a,{pair:state.current,proofs:[],refs:v.refs}),gallery:()=>({observe:async(...a)=>record('observe',a,{snapshot:state.current.gallery})}),
 discover:async(...a)=>record('discover',a,{identity:id,operation:state.context.operations[0],step:state.context.steps[0],provenance:state.context.provenance}),
 observer:()=>async(...a)=>record('guard',a,{sourceFingerprint:core.mediaSnapshotFingerprint(state.current.gallery),target:{...state.current.shopify,variantMediaIds:[]}}),phase:async(...a)=>record('phase',a,state.phase)};
 return{v,state,calls,deps,transport,planning,run:(e={})=>api.reconcilePersistedMediaProduct(id.productId,e,now+40000,deps)};}
function active(f,kind='alt',target='shopify',status='started'){const body={kind,target,key:'existing',source:target==='shopify'?'gallery':'shopify',value:'new'};f.state.context.operations=[{id:opId,status:'running',next_step:0,plan:{patches:[body],orders:[]},observed_pair:f.state.current}];f.state.context.steps=[{operation_id:opId,step_index:0,status,body}];return body;}
test('disabled runtime performs no IO',async()=>{const x=f();delete x.deps.environment.SHOPIFY_MEDIA_SYNC;assert.equal((await x.run()).status,'disabled');assert.deepEqual(x.calls,[]);});
test('unchanged exact baselines perform no reservation or transport',async()=>{const x=f(),r=await x.run();assert.equal(r.status,'done');assert.equal(r.executed,false);assert.equal(x.calls.some(c=>c.name==='reserve'||c.name==='phase'),false);assert.equal(x.calls.at(-1).name,'release');});
test('Gallery alt edit uses real field merge then one clone/associate/detach/reorder phase',async()=>{const x=f();x.state.current.gallery.assets[0].alt='merchant new';x.state.current.gallery.revision='c'.repeat(64);const r=await x.run();assert.equal(r.status,'pending');assert.equal(r.executed,true);const plan=x.calls.find(c=>c.name==='reserve').args[3];assert.deepEqual(plan.patches,[{source:'gallery',target:'shopify',key:'existing',kind:'alt',value:'merchant new'}]);assert.deepEqual(x.calls.find(c=>c.name==='prepare').args[3],['stage_source','create_owned','associate','detach_old','reorder']);assert.equal(x.calls.filter(c=>c.name==='phase').length,1);assert.ok(x.calls.findIndex(c=>c.name==='release')<x.calls.findIndex(c=>c.name==='phase'));});
test('same-field concurrent changes hold and do not execute',async()=>{const x=f();x.state.current.gallery.assets[0].alt='gallery';x.state.current.shopify.assets[0].alt='shop';const r=await x.run();assert.equal(r.status,'review');assert.ok(x.calls.some(c=>c.name==='conflict'));assert.equal(x.calls.some(c=>c.name==='phase'),false);});
test('missing asset without authenticated side evidence cannot authorize deletion',async()=>{const x=f();x.state.current.gallery.assets=[];const r=await x.run();assert.equal(r.status,'review');assert.equal(x.calls.some(c=>c.name==='removal'||c.name==='phase'),false);});
test('explicit Gallery deletion records exact independent baseline fingerprint',async()=>{const x=f();x.state.current.gallery.assets=[];const e={gallery:{actorType:'admin_panel_token',actorId:'configured-admin-panel'}};await x.run(e);const c=x.calls.find(c=>c.name==='removal');assert.equal(c.args[1],'gallery');assert.equal(c.args[2],'existing');assert.equal(c.args[3],core.mediaSnapshotFingerprint(x.v.pair.gallery));assert.deepEqual(c.args[4],e.gallery);});
test('revision-only metadata changes can acknowledge baseline with zero external mutation',async()=>{const x=f();x.state.current.shopify.revision='updated';const r=await x.run();assert.equal(r.status,'done');assert.equal(r.executed,false);assert.ok(x.calls.some(c=>c.name==='commit'));assert.equal(x.calls.some(c=>c.name==='phase'),false);});
test('verified transport accepts logical step on a fresh complete observation followed by a fresh raw guard',async()=>{const x=f();active(x);x.state.chain={status:'verified',next_phase:5};const r=await x.run();assert.equal(r.progressed,true);assert.ok(x.calls.some(c=>c.name==='capture'));assert.ok(x.calls.some(c=>c.name==='acceptFinal'));assert.equal(x.calls.some(c=>c.name==='phase'||c.name==='accept'),false);assert.ok(x.calls.findIndex(c=>c.name==='capture')<x.calls.findIndex(c=>c.name==='guard'));assert.ok(x.calls.findIndex(c=>c.name==='guard')<x.calls.findIndex(c=>c.name==='acceptFinal'));});

test('a fresh final media conflict is durable review and never repeats the completed external detach',async()=>{const x=f();active(x,'detach_reference');x.state.chain={status:'verified',next_phase:1};x.planning.acceptFinal=async(...a)=>{x.calls.push({name:'acceptFinal',args:a});return{status:'conflict',detachAcknowledged:true};};const r=await x.run();assert.equal(r.status,'review');assert.equal(r.executed,false);assert.equal(x.calls.some(c=>c.name==='phase'||c.name==='prepare'||c.name==='begin'),false);assert.equal(x.calls.at(-1).name,'release');});

test('a source change during final readback releases the lease without success or external execution',async()=>{const x=f();active(x,'detach_reference');x.state.chain={status:'verified',next_phase:1};x.deps.observer=()=>async()=>{throw Error('MEDIA_RUNTIME_SOURCE_CHANGED_DURING_READ');};await assert.rejects(x.run(),/SOURCE_CHANGED_DURING_READ/);assert.equal(x.calls.some(c=>c.name==='acceptFinal'||c.name==='phase'),false);assert.equal(x.calls.at(-1).name,'release');});
test('all logical steps verified commits baselines only after fresh read',async()=>{const x=f();active(x);x.state.context.operations[0].next_step=1;const r=await x.run();assert.equal(r.status,'done');assert.ok(x.calls.some(c=>c.name==='commit'));assert.equal(x.calls.some(c=>c.name==='phase'),false);});
test('uncertain persisted chain resumes exact phase without preparing again',async()=>{const x=f();active(x);x.state.chain={status:'uncertain',next_phase:2};await x.run();assert.equal(x.calls.find(c=>c.name==='phase').args[0].phaseIndex,2);assert.equal(x.calls.some(c=>c.name==='prepare'),false);});
test('variant-linked replacement explicitly owns reassignment before detach',async()=>{const x=f();active(x,'replace_reference');x.deps.observer=()=>async()=>({target:{...x.state.current.shopify,variantMediaIds:['gid://shopify/MediaImage/1']}});await x.run();assert.deepEqual(x.calls.find(c=>c.name==='prepare').args[3],['stage_source','create_owned','associate','variant_reassign','detach_old','reorder']);});
test('direct removal of variant-linked image holds instead of guessing replacement',async()=>{const x=f();active(x,'detach_reference');x.deps.observer=()=>async()=>({target:{...x.state.current.shopify,variantMediaIds:['gid://shopify/MediaImage/1']}});await assert.rejects(x.run(),/VARIANT_LINKED_REMOVAL_REQUIRES_REPLACEMENT/);assert.equal(x.calls.some(c=>c.name==='phase'),false);assert.equal(x.calls.at(-1).name,'release');});
test('Shopify-to-Gallery image attach requires upload then narrow CAS',async()=>{const x=f();active(x,'attach','gallery');await x.run();assert.deepEqual(x.calls.find(c=>c.name==='prepare').args[3],['gallery_upload','gallery_cas']);});
test('Gallery alt-only change uses only CAS, not new upload',async()=>{const x=f();active(x,'alt','gallery');await x.run();assert.deepEqual(x.calls.find(c=>c.name==='prepare').args[3],['gallery_cas']);});
test('long planning persists its continuation but never starts another full-duration phase',async()=>{const x=f();active(x);x.transport.prepare=async()=>{x.state.chain={status:'ready',next_phase:0};x.state.time=now+30000;};const r=await x.run();assert.equal(r.status,'pending');assert.equal(r.progressed,true);assert.equal(x.calls.some(c=>c.name==='phase'),false);});
test('product busy does not reserve, decode or execute',async()=>{const x=f();x.transport.acquire=async()=>null;assert.equal((await x.run()).status,'busy');assert.deepEqual(x.calls,[]);});
test('source failure releases lease and cannot write or falsely succeed',async()=>{const x=f();x.deps.capture=async()=>{throw Error('MEDIA_SOURCE_CHANGED');};await assert.rejects(x.run(),/SOURCE_CHANGED/);assert.equal(x.calls.at(-1).name,'release');assert.equal(x.calls.some(c=>c.name==='phase'),false);});

function newAngle(x){const a=structuredClone(x.state.context.galleryRaw.angles[0]);a.id='a0000000-0000-4000-8000-000000000099';a.image_path='https://cdn.shopify.com/s/files/1/new-reviewed.jpg';a.angle_order=2;x.state.context.galleryRaw.angles.push(a);}
for(const chain of [null,{status:'ready',next_phase:0,phases:['stage_source']},{status:'uncertain',next_phase:1,phases:['stage_source','create_owned']}])test(`started transport refreshes newly added exact angle before resume (${chain?.status??'no chain'})`,async()=>{
 const x=f();active(x);newAngle(x);x.state.chain=chain;await x.run();
 assert.equal(x.calls.filter(c=>c.name==='capture').length,1);
 assert.ok(x.calls.findIndex(c=>c.name==='capture')<x.calls.findIndex(c=>c.name==='phase'));
 assert.ok(x.calls.findIndex(c=>c.name==='register')<x.calls.findIndex(c=>c.name==='observe'));
 assert.ok(x.calls.findIndex(c=>c.name==='observe')<x.calls.findIndex(c=>c.name==='phase'));
});
test('ready step refreshes once through its existing begin gate, not twice',async()=>{
 const x=f();active(x,'alt','shopify','ready');newAngle(x);await x.run();
 assert.equal(x.calls.filter(c=>c.name==='capture').length,1);assert.ok(x.calls.some(c=>c.name==='begin'));
});
test('complete unchanged references resume with no redundant capture',async()=>{
 const x=f();active(x);x.state.chain={status:'uncertain',next_phase:1};await x.run();
 assert.equal(x.calls.some(c=>c.name==='capture'),false);assert.ok(x.calls.some(c=>c.name==='phase'));
});
test('same UUID with replaced URL requires reviewed decoded observation before resume',async()=>{
 const x=f();active(x);x.state.chain={status:'uncertain',next_phase:1};x.state.context.galleryRaw.angles[0].image_path='https://cdn.shopify.com/s/files/1/reviewed-replacement.jpg';await x.run();
 assert.equal(x.calls.filter(c=>c.name==='capture').length,1);
});
test('new unreviewed angle holds before observation registration or transport execution',async()=>{
 const x=f();active(x);newAngle(x);x.state.chain={status:'uncertain',next_phase:1};x.deps.capture=async()=>{throw Error('MEDIA_REVIEW_REQUIRED');};
 await assert.rejects(x.run(),/MEDIA_REVIEW_REQUIRED/);assert.equal(x.calls.some(c=>['phase','register','observe','prepare'].includes(c.name)),false);assert.equal(x.calls.at(-1).name,'release');
});
test('refresh predicate requires exact product, side, row UUID, source URL and complete cover mapping',()=>{
 const c=fixture().context;assert.equal(api.galleryObservationNeedsRefresh(c),false);
 for(const mutate of [x=>x.galleryRefs.pop(),x=>x.galleryRefs.push(x.galleryRefs[0]),x=>x.galleryRefs[1].angleId='other',x=>x.provenance[0].product_gid='gid://shopify/Product/999',x=>x.provenance[0].side='shopify',x=>x.provenance[0].proof.url+='x',x=>x.galleryRaw.item.cover_image_path+='x']){
  const changed=structuredClone(c);mutate(changed);assert.equal(api.galleryObservationNeedsRefresh(changed),true);
 }
});
test('observation refresh never authorizes changed-source transport; its guard conflict is retained',async()=>{
 const x=f();active(x);newAngle(x);x.state.chain={status:'uncertain',next_phase:1};x.state.phase={status:'conflict',executed:false};
 const r=await x.run();assert.equal(r.status,'review');assert.equal(r.executed,false);assert.equal(x.calls.filter(c=>c.name==='phase').length,1);
});

test('only durable verified phase and accepted step expose a continuation checkpoint',async()=>{
 const x=f();active(x);x.state.chain={status:'ready',next_phase:2};
 assert.equal((await x.run()).verifiedCheckpoint,`${opId}:0:phase:2`);
 const y=f();active(y);y.state.chain={status:'verified',next_phase:3};
 assert.equal((await y.run()).verifiedCheckpoint,`${opId}:0:accepted`);
 for(const phase of [{status:'uncertain',executed:true},{status:'conflict',executed:true},{status:'lease_busy',executed:false}]){
  const z=f();active(z);z.state.phase=phase;assert.equal((await z.run()).verifiedCheckpoint,undefined);
 }
 const prepared=f();active(prepared);prepared.transport.prepare=async()=>{prepared.state.chain={status:'ready',next_phase:0};prepared.state.time=now+30000;};
 const r=await prepared.run();assert.equal(r.progressed,true);assert.equal(r.verifiedCheckpoint,undefined);
});
test('durable pending transport diagnostic is preserved; only allowlisted MEDIA codes on pending',async()=>{
 const z=f();active(z);z.state.phase={status:'pending',executed:true,diagnostic:'MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED'};
 const r=await z.run();assert.equal(r.status,'pending');assert.equal(r.diagnostic,'MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED');
 for(const phase of [{status:'pending',executed:true,diagnostic:'provider said: secret'},{status:'conflict',executed:false,diagnostic:'MEDIA_STORAGE_X'},{status:'pending',executed:false}]){
  const y=f();active(y);y.state.phase=phase;assert.equal((await y.run()).diagnostic,undefined);}
});
