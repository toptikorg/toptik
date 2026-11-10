import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadWrapped,policy} from './helpers/owned-edit-harness.mjs';
import {fixture as baseFixture,core,visualsFor,id,owner,now} from './helpers/media-planning-fixture.mjs';
const api=(await loadWrapped('src/lib/shopify/media-obsolete-membership.ts',
 ['createHash','VERIFIED_COPY_COLUMNS','assertVerifiedCopyApproval','reviewIdentity','isShopifyOwnedVariant','mediaSnapshotFingerprint','reconcileMedia','createMediaPlanningRpc','createMediaTransportRpc','captureMediaPlanningPair','process'],
 ['parseObsoleteMembershipCommand','obsoleteMembershipRequestId','obsoleteMembershipProposal','handleObsoleteMembership']))({
 createHash,VERIFIED_COPY_COLUMNS:'columns',assertVerifiedCopyApproval:a=>{if(!a.enabled)throw Error('SYNC_COPY_APPROVAL');},
 reviewIdentity:a=>a,isShopifyOwnedVariant:policy.isShopifyOwnedVariant,...core,process:{env:{}},
 createMediaPlanningRpc:()=>{throw Error('unexpected planning');},createMediaTransportRpc:()=>{throw Error('unexpected transport');},captureMediaPlanningPair:()=>{throw Error('unexpected capture');}});
const oldKey='g-angle:a0000000-0000-4000-8000-000000000009';
const actor={actorType:'admin_panel_token',actorId:'configured-admin-panel'};
function fixture(){
 const b=baseFixture();b.pair.gallery.assets[0].alt=b.pair.shopify.assets[0].alt;
 const observed={pair:structuredClone(b.pair),refs:b.refs,proofs:b.context.provenance.map(p=>({side:p.side,key:p.asset_key,evidenceId:p.evidence_id,contentId:p.content_id,proof:p.proof})),visuals:visualsFor(b.pair)};
 const context=structuredClone(b.context);context.baselines.gallery.assets.push({key:oldKey,contentId:'c'.repeat(64),evidenceId:'g-old',alt:'old'});
 const calls=[],state={context,capture:observed,queueError:null,queueValue:true,onContext:null,reads:0,removalFail:0};
 const approval={product_gid:id.productId,variant_gid:id.variantId,carousel_item_id:id.itemId,exact_gallery_sku:id.exactGallerySku,exact_shopify_sku:id.exactShopifySku,approved_product_handle:id.productHandle,enabled:true};
 const db={from:()=>{const q={select:()=>q,eq:()=>q,limit:()=>q,abortSignal:async()=>({data:[approval]})};return q;},rpc:(name,args)=>({abortSignal:async()=>{calls.push(['queue',name,args]);return {data:state.queueValue,error:state.queueError};}})};
 const deps={now:()=>now,environment:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},
  transport:()=>({acquire:async()=>{calls.push(['acquire']);return {owner,expiresAt:now+120000};},release:async()=>calls.push(['release'])}),
  planning:()=>({context:async()=>{state.onContext?.(++state.reads);calls.push(['context']);return structuredClone(state.context);},
   removal:async(...args)=>{calls.push(['removal',...args]);if(state.removalFail)throw Error('MEDIA_REMOVAL_FAILED');return {};}}),
  capture:async()=>{calls.push(['capture']);return structuredClone(state.capture);}};
 const preview=()=>api.obsoleteMembershipProposal(state.context,state.capture);
 const confirm=()=>({itemId:id.itemId,action:'confirm',proposalHash:preview().proposalHash,approval:'RETIRE_MISSING_GALLERY_KEYS_WITHOUT_MEDIA_CHANGES'});
 return {state,calls,context,observed,db,deps,approval,preview,confirm,run:(command={itemId:id.itemId,action:'preview'},a=actor)=>api.handleObsoleteMembership(db,command,a,now+55000,deps)};
}
test('reproduces missing historical Gallery-only membership and proves a zero-media-change proposal',()=>{
 const f=fixture(),held=core.reconcileMedia(f.context.baselines,f.observed.pair);
 assert.equal(held.conflicts[0].code,'MEDIA_REMOVAL_INTENT_REQUIRED');
 const p=f.preview();assert.deepEqual(p.missingGalleryKeys,[oldKey]);assert.equal(p.mediaChanges,0);assert.equal(p.syncVerified,false);
});
test('preview has no removal, enqueue, baseline, media or success mutation',async()=>{
 const f=fixture(),before=structuredClone(f.context),r=await f.run();assert.equal(r.decisionRecorded,false);assert.equal(r.syncVerified,false);
 assert.deepEqual(f.context,before);assert.deepEqual(f.calls.map(c=>c[0]),['acquire','context','capture','context','release']);
});
test('confirmed exact hash records the server actor and wakes only read/reconcile authority, never editor deletion authority',async()=>{
 const f=fixture(),r=await f.run(f.confirm());assert.equal(r.decisionRecorded,true);assert.equal(r.queued,true);assert.equal(r.syncVerified,false);
 const call=f.calls.find(c=>c[0]==='removal');assert.equal(call[1],owner);assert.equal(call[2],'gallery');assert.equal(call[3],oldKey);assert.deepEqual(call[5],actor);
 assert.equal(call[7],api.obsoleteMembershipRequestId(r.proposalHash,oldKey));
 assert.deepEqual(f.calls.find(c=>c[0]==='queue').slice(1),['enqueue_toptik_shopify_media_work',{p_product_gid:id.productId,p_event_id:null}]);
 assert.equal(f.calls.at(-1)[0],'release');
});
test('strict command accepts no user-supplied actor, snapshot, old key or URL',()=>{
 assert.equal(api.parseObsoleteMembershipCommand({action:'preview',itemId:id.itemId}).action,'preview');
 const c=fixture().confirm();assert.deepEqual(api.parseObsoleteMembershipCommand(c),c);
 for(const input of [null,[],{}, {...c,actor}, {...c,keys:[oldKey]}, {...c,pair:{}}, {...c,url:'https://x.test'}, {...c,approval:true},{...c,proposalHash:'bad'}])assert.throws(()=>api.parseObsoleteMembershipCommand(input),/INPUT_INVALID/);
});
for(const [label,mutate] of [
 ['current ALT',f=>f.observed.pair.gallery.assets[0].alt='different'],
 ['native drift',f=>{for(const side of ['gallery','shopify'])f.observed.pair[side].assets[0].alt='both changed';}],
 ['shared historical identity',f=>f.context.baselines.shopify.assets.push({...f.context.baselines.gallery.assets[1]})],
 ['missing proof',f=>f.observed.proofs=[]],
 ['proof hash',f=>f.observed.proofs[0].proof.decodedSha256='invalid'],
 ['active operation',f=>f.context.operations=[{status:'running'}]],
 ['pending step',f=>f.context.steps=[{}]],
 ['detach receipt',f=>f.context.detached=[{}]],
 ['other removal',f=>f.context.removals=[{side:'gallery',key:'other'}]],
 ['unknown identity',f=>f.observed.pair.gallery.identity.itemId='a0000000-0000-4000-8000-000000000099'],
 ['no missing historical key',f=>f.context.baselines.gallery.assets.pop()],
 ['non-angle historical key',f=>f.context.baselines.gallery.assets[1].key='g-cover:'+id.itemId],
 ['new current duplicate',f=>f.observed.pair.gallery.assets.push({...f.observed.pair.gallery.assets[0],key:'duplicate'})],
])test(`preflight refuses ${label} before any decision`,()=>{const f=fixture();mutate(f);assert.throws(f.preview,/MEDIA_/);assert.equal(f.calls.length,0);});
test('wrong proposal, context drift and ineligible product never record a decision',async()=>{
 const a=fixture();await assert.rejects(a.run({...a.confirm(),proposalHash:'f'.repeat(64)}),/PROPOSAL_CHANGED/);assert(!a.calls.some(c=>c[0]==='removal'));
 const b=fixture();b.state.onContext=n=>{if(n===2)b.context.stateVersion++;};await assert.rejects(b.run(b.confirm()),/SOURCE_CHANGED/);assert(!b.calls.some(c=>c[0]==='removal'));
 const c=fixture();c.approval.enabled=false;await assert.rejects(c.run(),/APPROVAL/);assert.equal(c.calls.length,0);
});
test('proposal binds exact URLs, raw revision, state version and both snapshot revisions',()=>{
 const f=fixture(),h=f.preview().proposalHash;
 for(const mutate of [x=>x.context.stateVersion++,x=>x.context.galleryRaw.revision='d'.repeat(64),x=>x.observed.pair.shopify.revision='later',x=>x.observed.proofs[0].proof.url+='?different=1']){
  const x=fixture();mutate(x);assert.notEqual(x.preview().proposalHash,h);
 }
 const x=fixture();x.observed.proofs[0].proof.verifiedAt='later';assert.equal(x.preview().proposalHash,h,'capture timestamp alone is not a different decision');
});
test('older terminal conflict history is preserved and bound; open, current or foreign history is refused',()=>{
 const f=fixture();f.context.stateVersion=6;
 const old={id:'a0000000-0000-4000-8000-000000000099',product_gid:id.productId,status:'conflict',state_version:3,version:2};
 f.context.operations=[old];f.context.steps=[{operation_id:old.id,status:'started',step_index:0}];
 const before=structuredClone(f.context),p=f.preview();assert.deepEqual(f.context,before);
 old.version++;assert.notEqual(f.preview().proposalHash,p.proposalHash);
 for(const patch of [{status:'running'},{status:'uncertain'},{status:'reserved'},{status:'verified'},{state_version:6},{state_version:7},{product_gid:'foreign'}]){
  const original={...old};Object.assign(old,patch);assert.throws(f.preview,/OPERATION_OR_RECEIPT_PRESENT/);Object.assign(old,original);
 }
});
test('partial acknowledgment can repeat only the identical deterministic request IDs',async()=>{
 const f=fixture(),command=f.confirm();await f.run(command);
 await f.run(command);const decisions=f.calls.filter(c=>c[0]==='removal');assert.equal(decisions[0][7],decisions[1][7]);
 f.context.removals=[{side:'gallery',key:oldKey,kind:'authenticated_editor',requestId:decisions[0][7],expectedBaselineFingerprint:core.mediaSnapshotFingerprint(f.context.baselines.gallery)}];
 assert.equal(f.confirm().proposalHash,command.proposalHash);await f.run(command);
});
test('RPC failure does not enqueue or claim verified; queue ambiguity is not success',async()=>{
 const f=fixture();f.state.removalFail=1;await assert.rejects(f.run(f.confirm()),/REMOVAL_FAILED/);assert(!f.calls.some(c=>c[0]==='queue'));assert.equal(f.calls.at(-1)[0],'release');
 const q=fixture();q.state.queueError={message:'private'};await assert.rejects(q.run(q.confirm()),/QUEUE_UNCONFIRMED/);assert.equal(q.calls.at(-1)[0],'release');
});
test('disabled environment and invalid actor fail before acquiring a lease',async()=>{
 for(const mutate of [f=>f.deps.environment.VERCEL_ENV='preview',f=>f.deps.environment.SHOPIFY_MEDIA_SYNC='no']){const f=fixture();mutate(f);await assert.rejects(f.run(),/DISABLED/);assert.equal(f.calls.length,0);}
 const f=fixture();await assert.rejects(f.run(undefined,{actorType:'admin_panel_token',actorId:'someone'}),/ACTOR_INVALID/);assert.equal(f.calls.length,0);
});
