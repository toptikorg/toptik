import {test} from 'node:test';
import assert from 'node:assert/strict';
import {p,H,cp,id,gid,time,fixture} from './helpers/commerce-fixtures.mjs';
function prepare(f){return p.prepareFinalization(f.intent,f.proof,f.snapshot,f.context);}
function finish(f){const x=prepare(f);let state=x.state;const requests=[];
 while(p.nextDisposition(x.plan,state)==='begin_next'){
  const b=p.beginNextStep(x.plan,state,state.observed,f.context);requests.push(b.request);
  state=p.acceptStepReadback(x.plan,b.state,b.state.pending.expected,f.context);
 }return {...x,state,requests};
}

test('explicit no-inventory publication needs no stock, locations or inventory scope',()=>{
 const f=fixture();f.payload.commercial.tracked=false;f.payload.stock=[];f.intent=p.buildMerchantIntent(f.payload);
 f.context.intentRevision=f.intent.revision;f.context.scopes=['write_products','write_publications'];
 f.context.locations=[];f.context.locationsComplete=false;f.snapshot.levels=[];f.snapshot.levelsComplete=false;
 const result=finish(f);
 assert.deepEqual(result.plan.steps.map(s=>s.kind),['commerce','activate_product','publish_product']);
 assert.equal(result.requests[0].variables.variants[0].inventoryItem.tracked,false);
 assert.ok(result.requests.every(r=>!['activate_location','set_stock'].includes(r.operation)));
 assert.equal(p.buildFinalizerRequest(result.plan,result.state,result.state.observed,f.context).args.p_live_commerce.tracked,false);
 assert.deepEqual(result.state.observed.levels,[]);
});

test('no-inventory snapshots never pretend unknown stock is complete or accept stock input',()=>{
 const f=fixture();f.payload.commercial.tracked=false;
 assert.throws(()=>p.buildMerchantIntent(f.payload),/STOCK_MODE_MISMATCH/);
 f.payload.stock=[];f.intent=p.buildMerchantIntent(f.payload);f.context.intentRevision=f.intent.revision;
 assert.throws(()=>prepare(f),/STOCK_MODE_MISMATCH/);
});
test('minimal complete plan is deterministic, immutable, explicitly merchant sourced',()=>{
 const f=fixture(),before=cp(f),a=prepare(f),b=prepare(f);
 assert.deepEqual(a,b);assert.deepEqual(f,before);assert.equal(f.intent.commercial.price,'699.00');
 assert.deepEqual(a.plan.steps.map(x=>x.kind),['commerce','set_stock','activate_product','publish_product']);
 assert.equal(a.state.observed.galleryCopy.description,'Gallery text');
});
test('default-off, preview, wrong store/version/currency and missing scope all fail before a request',()=>{
 for(const mutate of [f=>f.context.mode='off',f=>f.context.environment='preview',f=>f.context.shopDomain='wrong.myshopify.com',f=>f.context.apiVersion='2026-04',f=>f.context.shopCurrency='USD',
 f=>f.context.scopes=['write_products','write_publications'],f=>f.context.scopes=['write_inventory','write_publications'],f=>f.context.scopes=['write_inventory','write_products']]){
  const f=fixture();mutate(f);assert.throws(()=>prepare(f),/FINALIZE_/);
 }
});
test('supplier authority, absent fields, zero price, guessed stock, invalid sale and extra fields reject',()=>{
 for(const mutate of [v=>v.provenance.authority='supplier',v=>delete v.commercial.taxable,v=>delete v.currency,v=>v.commercial.price='0',v=>v.commercial.compareAtPrice='600',v=>v.commercial.price='1e3',
 v=>v.commercial.tracked=false,v=>v.commercial.inventoryPolicy='CONTINUE',v=>v.stock[0].basis='supplier_quantity',v=>v.stock[0].available=null,v=>v.supplierPrice=99,v=>v.commercial.requiresShipping=false]){
  const v=fixture().payload;mutate(v);assert.throws(()=>p.buildMerchantIntent(v),/FINALIZE_/);
 }
});
test('zero stock is explicit and allowed without promising stock availability',()=>{
 const f=fixture();f.payload.stock[0].available=0;f.intent=p.buildMerchantIntent(f.payload);f.context.intentRevision=f.intent.revision;
 assert.deepEqual(prepare(f).plan.steps.map(x=>x.kind),['commerce','activate_product','publish_product']);
});
test('source revision, creation revision, metadata/media/copy version and old proofs reject',()=>{
 for(const mutate of [f=>f.context.intentRevision=H('changed'),f=>f.context.frozenPendingRevision=H('changed'),f=>f.context.creationRevision++,
 f=>f.proof.frozenPendingRevision=H('changed'),f=>f.snapshot.copyMediaFingerprint=H('changed'),f=>f.snapshot.galleryRowFingerprint=H('changed'),f=>f.snapshot.galleryCopyVersion='2026-09-30T12:00:01Z',
 f=>f.context.capturedAt='2026-09-30T11:59:00Z',f=>f.context.catalogCapturedAt='2026-09-30T11:59:00Z',f=>f.snapshot.decodedImagesVerifiedAt='2026-09-30T11:50:00Z']){
  const f=fixture();mutate(f);assert.throws(()=>prepare(f),/FINALIZE_/);
 }
});
test('both live owned leases are required',()=>{
 for(const mutate of [f=>f.context.productLeaseOwner=id(99),f=>f.context.creationLeaseOwner=id(99),f=>f.context.productLeaseExpiresAt=time,f=>f.context.creationLeaseExpiresAt=time]){
  const f=fixture();mutate(f);assert.throws(()=>prepare(f),/OWNED_LEASE_REQUIRED/);
 }
});
test('exact receipt IDs, custom-ID namespace/value, source SKU and brand cannot drift',()=>{
 for(const mutate of [f=>f.snapshot.identity.productGid=gid('Product',99),f=>f.snapshot.identity.variantGid=gid('ProductVariant',99),f=>f.snapshot.identity.itemId=id(99),
 f=>f.snapshot.identity.customId={...f.snapshot.identity.customId,value:'other'},f=>f.snapshot.identity.customId={...f.snapshot.identity.customId,namespace:'app--123--other'},
 f=>{f.snapshot.identity.sku='CHANGED';f.context.gallery[0].sku='CHANGED';f.context.shopify[0].sku='CHANGED';},f=>f.snapshot.identity.brand="Bric's",f=>f.snapshot.identity.manufacturerSku='OTHER',
 f=>f.proof.receipt.stage='draft_found',f=>f.proof.receipt.commercialFingerprint=H('wrong')]){
  const f=fixture();mutate(f);assert.throws(()=>prepare(f),/FINALIZE_/);
 }
});
test('held identities, existing approvals and normalized collisions cannot be adopted',()=>{
 for(const held of ['P10OSV04-05J-TU','P10ZJT06-24U-TU','ORI05500.909','ORI05500.024']){
  const f=fixture();f.snapshot.identity.manufacturerSku=held;f.proof.sourceIdentity.manufacturerSku=held;assert.throws(()=>prepare(f),/HELD_IDENTITY/);
 }
 for(const mutate of [f=>f.context.approved.push({itemId:id(80),productGid:f.snapshot.identity.productGid,variantGid:gid('ProductVariant',81),sku:'EXISTING'}),
 f=>f.context.gallery.push({id:id(80),sku:'SYNTHETICNEW001',active:false}),
 f=>f.context.shopify.push({productGid:gid('Product',80),variantGid:gid('ProductVariant',81),sku:'SYNTHETICNEW001'}),
 f=>f.context.shopify.push({productGid:f.snapshot.identity.productGid,variantGid:gid('ProductVariant',81),sku:'OTHER'}),
 f=>f.context.gallery[0].active=true,f=>f.context.catalogComplete=false]){
  const f=fixture();mutate(f);assert.throws(()=>prepare(f),/FINALIZE_/);
 }
});
test('location proof must be complete, active, merchant-managed and permitted',()=>{
 for(const mutate of [f=>f.context.locationsComplete=false,f=>f.context.locations=[],f=>f.context.locations[0].active=false,f=>f.context.locations[0].fulfillsOnlineOrders=false,
 f=>f.context.locations[0].merchantManaged=false,f=>f.context.locations[0].inventoryWriteAllowed=false,f=>f.context.locations.push(cp(f.context.locations[0])),f=>f.snapshot.levelsComplete=false]){
  const f=fixture();mutate(f);assert.throws(()=>prepare(f),/FINALIZE_/);
 }
});
test('unpublished DRAFT and creation commercial/version readback required',()=>{
 for(const mutate of [f=>f.snapshot.productStatus='ACTIVE',f=>f.snapshot.publicationIds=[p.PUBLICATION],f=>f.snapshot.productUpdatedAt='2026-09-30T12:00:01Z',f=>f.snapshot.commercial.price='1.00']){
  const f=fixture();mutate(f);assert.throws(()=>prepare(f),/DRAFT_READY_READBACK_CHANGED/);
 }
});
test('commerce request updates exactly one new variant and no product copy/media/weight/cost',()=>{
 const f=fixture(),{plan,state}=prepare(f),b=p.beginNextStep(plan,state,state.observed,f.context);
 assert.equal(b.expectedVersion,1);assert.equal(b.state.version,2);assert.equal(b.request.apiVersion,'2026-07');
 assert.deepEqual(b.request.variables,{productId:gid('Product',9001),variants:[{id:gid('ProductVariant',9002),price:'699.00',compareAtPrice:null,barcode:'1234567890123',taxable:true,inventoryPolicy:'DENY',inventoryItem:{tracked:true,requiresShipping:true}}]});
 assert.match(b.request.query,/allowPartialUpdates:false/);assert.doesNotMatch(JSON.stringify(b.request),/description|media|weight|cost|sku|delete|userErrors\{field message code/);
});
test('stock CAS uses current API changeFromQuantity and stable directive key',()=>{
 const f=fixture(),x=prepare(f),b=p.beginNextStep(x.plan,x.state,x.state.observed,f.context),s=p.acceptStepReadback(x.plan,b.state,b.state.pending.expected,f.context),a=p.beginNextStep(x.plan,s,s.observed,f.context);
 assert.equal(a.request.variables.input.quantities[0].changeFromQuantity,0);assert.equal(a.request.variables.input.quantities[0].quantity,5);
 assert.match(a.request.query,/@idempotent\(key:\$key\)/);assert.equal(a.request.variables.key,a.request.idempotencyKey);
 assert.doesNotMatch(JSON.stringify(a.request),/compareQuantity|ignoreCompareQuantity/);
 assert.equal(a.request.idempotencyKey,p.beginNextStep(x.plan,s,s.observed,f.context).request.idempotencyKey);
});
test('missing location activation sets exact merchant count and is idempotent',()=>{
 const f=fixture();f.snapshot.levels=[];const done=finish(f),r=done.requests.find(r=>r.operation==='activate_location');
 assert.equal(r.variables.available,5);assert.match(r.query,/@idempotent/);assert.equal(done.requests.some(r=>r.operation==='set_stock'),false);
});
test('inactive existing location activation omits quantity entirely then uses CAS',()=>{
 const f=fixture();f.snapshot.levels[0].active=false;const done=finish(f),r=done.requests.find(r=>r.operation==='activate_location');
 assert.equal(Object.hasOwn(r.variables,'available'),false);assert.doesNotMatch(r.query,/available|onHand/);
 assert.equal(done.requests.filter(r=>r.operation==='set_stock').length,1);
});
test('matching existing commerce/stock produces only status and Online Store publication',()=>{
 const f=fixture();f.snapshot.commercial=cp(f.intent.commercial);f.proof.readbackCommerce=Object.fromEntries(Object.entries(f.snapshot.commercial).filter(([k])=>!['tracked','inventoryPolicy'].includes(k)));
 f.snapshot.levels[0].quantities.available=5;f.snapshot.levels[0].quantities.onHand=5;
 assert.deepEqual(finish(f).requests.map(r=>r.operation),['activate_product','publish_product']);
});
test('optional variant opt-in is exact and before product visibility',()=>{
 const f=fixture();f.snapshot.variantOnlinePublished=false;const {requests}=finish(f);
 assert.deepEqual(requests.map(r=>r.operation),['commerce','set_stock','publish_variant','activate_product','publish_product']);
 const v=requests.find(r=>r.operation==='publish_variant');assert.equal(v.variables.id,gid('ProductVariant',9002));assert.deepEqual(v.variables.input,[{publicationId:p.PUBLICATION}]);
});
test('started state prevents a second write after any lost response',()=>{
 const f=fixture(),{plan,state}=prepare(f),b=p.beginNextStep(plan,state,state.observed,f.context);
 assert.equal(p.nextDisposition(plan,b.state),'readback_only');assert.throws(()=>p.beginNextStep(plan,b.state,state.observed,f.context),/READBACK_REQUIRED_NO_RETRY/);
 const s=p.acceptStepReadback(plan,b.state,b.state.pending.expected,f.context);assert.equal(s.index,1);assert.equal(s.pending,null);
 assert.throws(()=>p.acceptStepReadback(plan,s,s.observed,f.context),/STEP_NOT_PENDING/);
});
test('lost/unaccepted or partial response becomes review, never repeat mutation',()=>{
 const f=fixture(),{plan,state}=prepare(f),b=p.beginNextStep(plan,state,state.observed,f.context),s=p.acceptStepReadback(plan,b.state,state.observed,f.context);
 assert.equal(p.nextDisposition(plan,s),'review');assert.throws(()=>p.beginNextStep(plan,s,s.observed,f.context),/NO_RETRY|REVIEW_REQUIRED/);
 assert.throws(()=>p.buildFinalizerRequest(plan,s,s.observed,f.context),/PUBLICATION_NOT_VERIFIED/);
});
test('concurrent unrelated fields or timestamps never count as successful readback',()=>{
 for(const mutate of [s=>s.shopifyCopy.title='Changed',s=>s.otherProductDataFingerprint=H('changed'),s=>s.otherInventoryDataFingerprint=H('changed'),s=>s.commercial.price='700.00',
 s=>s.levels[0].quantities.incoming=1,s=>s.publicationIds=[gid('Publication',2)],s=>s.productUpdatedAt='2026-09-30T11:59:00Z']){
  const f=fixture(),{plan,state}=prepare(f),b=p.beginNextStep(plan,state,state.observed,f.context),read=cp(b.state.pending.expected);mutate(read);
  assert.equal(p.nextDisposition(plan,p.acceptStepReadback(plan,b.state,read,f.context)),'review');
 }
});
test('fresh immediate prewrite blocks commerce, copy and source-version drift',()=>{
 for(const mutate of [s=>s.commercial.price='10.00',s=>s.shopifyCopy.title='changed',s=>s.variantUpdatedAt='2026-09-30T12:00:01Z',s=>s.identity.inventoryItemGid=gid('InventoryItem',99)]){
  const f=fixture(),{plan,state}=prepare(f),read=cp(state.observed);mutate(read);assert.throws(()=>p.beginNextStep(plan,state,read,f.context),/PREWRITE_SNAPSHOT_CHANGED/);
 }
});
test('plan/state corruption and skipping stages reject',()=>{
 const f=fixture(),x=prepare(f);const badPlan=cp(x.plan);badPlan.steps.shift();assert.throws(()=>p.nextDisposition(badPlan,x.state),/PLAN_CHANGED/);
 for(const mutate of [s=>s.index++,s=>s.version++,s=>s.planHash=H('other')]){const s=cp(x.state);mutate(s);assert.throws(()=>p.nextDisposition(x.plan,s),/STATE_INVALID/);}
 const b=p.beginNextStep(x.plan,x.state,x.state.observed,f.context);b.state.pending.step.kind='publish_product';assert.throws(()=>p.nextDisposition(x.plan,b.state),/STATE_INVALID/);
});
test('finalizer preserves independent copy, only own inactive row and exact binding identity',()=>{
 const f=fixture(),done=finish(f),r=p.buildFinalizerRequest(done.plan,done.state,done.state.observed,f.context);
 assert.equal(r.rpc,'finalize_gallery_shopify_public_creation');assert.deepEqual(r.existingRowsToUpdate,[id(2)]);assert.equal(r.activateGallery,true);
 assert.equal(r.args.p_gallery_baseline.description,'Gallery text');assert.equal(r.args.p_shopify_baseline.description,'Shop text');assert.equal(r.args.p_exact_sku,'SYNTHETIC-NEW-001');
 assert.equal(r.args.p_expected_state_version,9);assert.equal(r.args.p_publication_id,p.PUBLICATION);assert.doesNotMatch(JSON.stringify(r),/outbox|settings|delete/);
});
test('cannot finalize early or after unrelated drift, even when publication is set',()=>{
 const f=fixture(),x=prepare(f);assert.throws(()=>p.buildFinalizerRequest(x.plan,x.state,x.state.observed,f.context),/PUBLICATION_NOT_VERIFIED/);
 const done=finish(f),read=cp(done.state.observed);read.commercial.price='999.00';assert.throws(()=>p.buildFinalizerRequest(done.plan,done.state,read,f.context),/FINAL_READBACK_CHANGED/);
});
test('post-publication sale preserves current stock; no initial-count rewrite',()=>{
 const f=fixture(),done=finish(f),read=cp(done.state.observed);read.levels[0].quantities.available=4;read.levels[0].quantities.committed=1;
 read.inventoryUpdatedAt='2026-09-30T12:00:02Z';const r=p.buildFinalizerRequest(done.plan,done.state,read,f.context);
 assert.equal(r.args.p_live_inventory[0].quantities.available,4);assert.equal(r.args.p_live_inventory[0].quantities.committed,1);
 assert.equal(p.nextDisposition(done.plan,done.state),'finalize_binding');assert.throws(()=>p.beginNextStep(done.plan,done.state,done.state.observed,f.context),/FINALIZER_REQUIRED/);
});
test('unrelated existing location quantities preserved during all writes',()=>{
 const f=fixture(),extra=cp(f.snapshot.levels[0]);extra.locationId=gid('Location',9);extra.quantities.available=7;extra.quantities.onHand=9;extra.quantities.damaged=2;f.snapshot.levels.push(extra);
 const done=finish(f);assert.deepEqual(done.state.observed.levels.find(l=>l.locationId===extra.locationId),extra);
 assert.equal(done.requests.filter(r=>r.variables?.input?.quantities?.some(q=>q.locationId===extra.locationId)).length,0);
});
test('full frozen82/78 context is untouched and no owned new identity collides',()=>{
 const f=fixture();for(let n=100;n<182;n++)f.context.gallery.push({id:id(n),sku:`OLD-${n}`,active:true});
 for(let n=100;n<178;n++){const a={itemId:id(n),productGid:gid('Product',n),variantGid:gid('ProductVariant',n),sku:`OLD-${n}`};f.context.approved.push(a);f.context.shopify.push({productGid:a.productGid,variantGid:a.variantGid,sku:a.sku});}
 const before=cp(f.context);const done=finish(f);p.buildFinalizerRequest(done.plan,done.state,done.state.observed,f.context);assert.deepEqual(f.context,before);
});
test('exact frozen pending intent must explicitly request publication',()=>{
 for(const value of [undefined,null,'draft','undecided']){const f=fixture();f.proof.pendingStoreIntent=value;assert.throws(()=>prepare(f),/CREATION_RECEIPT_INVALID/);}
});
test('raw Gallery null description baseline stays null, separately from Shopify empty text',()=>{
 const f=fixture();f.snapshot.galleryCopy.description=null;f.snapshot.shopifyCopy.description='';const done=finish(f);
 const r=p.buildFinalizerRequest(done.plan,done.state,done.state.observed,f.context);
 assert.equal(r.args.p_gallery_baseline.description,null);assert.equal(r.args.p_shopify_baseline.description,'');
});
test('sale immediately after final publish is preserved, while pre-publication stock drift conflicts',()=>{
 const f=fixture(),x=prepare(f);let s=x.state;
 while(x.plan.steps[s.index].kind!=='publish_product'){const b=p.beginNextStep(x.plan,s,s.observed,f.context);s=p.acceptStepReadback(x.plan,b.state,b.state.pending.expected,f.context);}
 const b=p.beginNextStep(x.plan,s,s.observed,f.context),read=cp(b.state.pending.expected);read.levels[0].quantities.available=4;read.levels[0].quantities.committed=1;
 const done=p.acceptStepReadback(x.plan,b.state,read,f.context);assert.equal(done.review,null);assert.equal(p.nextDisposition(x.plan,done),'finalize_binding');
 assert.equal(p.buildFinalizerRequest(x.plan,done,read,f.context).args.p_live_inventory[0].quantities.available,4);
});
