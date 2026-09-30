import {createHash} from 'node:crypto';
import {z} from 'zod';

/** Pure policy only. All proof/context inputs are server-loaded; none are browser authority. */
export const POLICY='gallery-commerce-finalization-v1';
export const SHOP='toptikcoil.myshopify.com';
export const PUBLICATION='gid://shopify/Publication/79538258170';
export const API_VERSION='2026-07';
const HASH=z.string().regex(/^[a-f0-9]{64}$/),UUID=z.string().uuid(),ISO=z.string().datetime({offset:true});
const gid=(kind:string)=>z.string().regex(new RegExp(`^gid://shopify/${kind}/[1-9][0-9]*$`));
const SKU=z.string().min(2).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._ /-]*$/).refine(s=>s===s.trim());
const money=z.string().regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,2})?$/).transform(v=>Number(v).toFixed(2));
const positiveMoney=money.refine(v=>Number(v)>0);
const customId=z.object({namespace:z.string().regex(/^app--[1-9][0-9]*--toptik_gallery$/),key:z.literal('source_item_id'),value:z.string().max(255)}).strict();
const copy=z.object({title:z.string().min(1).max(120),description:z.string().max(50000).nullable(),descriptionHtml:z.string().max(250000).nullable(),seoTitle:z.string().max(512).nullable(),seoDescription:z.string().max(5000).nullable()}).strict();
const commercial=z.object({price:money,compareAtPrice:money.nullable(),barcode:z.string().max(64).nullable(),taxable:z.boolean(),requiresShipping:z.boolean()}).strict();
const merchantValues=commercial.extend({price:positiveMoney,requiresShipping:z.literal(true),inventoryPolicy:z.literal('DENY'),tracked:z.literal(true)}).strict();
const quantities=z.object({available:z.number().int().min(0).max(1000000),onHand:z.number().int().min(0).max(1000000),committed:z.number().int().min(0).max(1000000),
 reserved:z.number().int().min(0).max(1000000),damaged:z.number().int().min(0).max(1000000),safetyStock:z.number().int().min(0).max(1000000),qualityControl:z.number().int().min(0).max(1000000),incoming:z.number().int().min(0).max(1000000)}).strict();
const level=z.object({locationId:gid('Location'),active:z.boolean(),quantities}).strict();
const identity=z.object({itemId:UUID,productGid:gid('Product'),variantGid:gid('ProductVariant'),inventoryItemGid:gid('InventoryItem'),sku:SKU,
 manufacturerSku:SKU.nullable(),brand:z.enum(['Mandarina Duck',"Bric's",'Samsonite']),handle:z.string().min(1).max(255).regex(/^[A-Za-z0-9א-ת][A-Za-z0-9א-ת-]*$/),customId,sourceFingerprint:HASH}).strict();
export const snapshotSchema=z.object({identity,variantCount:z.literal(1),productStatus:z.enum(['DRAFT','ACTIVE']),productUpdatedAt:ISO,variantUpdatedAt:ISO,inventoryUpdatedAt:ISO,
 publicationIds:z.array(gid('Publication')).max(100),variantOnlinePublished:z.boolean(),commercial:commercial.extend({inventoryPolicy:z.enum(['DENY','CONTINUE']),tracked:z.boolean()}).strict(),
 levels:z.array(level).max(100),levelsComplete:z.literal(true),copyMediaFingerprint:HASH,decodedImagesVerifiedAt:ISO,
 galleryRowFingerprint:HASH,galleryCopyVersion:ISO,galleryCopy:copy,shopifyCopy:copy,
 otherProductDataFingerprint:HASH,otherInventoryDataFingerprint:HASH}).strict();
export type Snapshot=z.infer<typeof snapshotSchema>;
const payloadSchema=z.object({intentId:UUID,galleryItemId:UUID,sourceFingerprint:HASH,frozenPendingRevision:HASH,currency:z.string().regex(/^[A-Z]{3}$/),
 targetStatus:z.literal('ACTIVE'),storeIntent:z.literal('publish_when_ready'),commercial:merchantValues,
 stock:z.array(z.object({locationId:gid('Location'),available:z.number().int().min(0).max(1000000),basis:z.literal('merchant_count'),evidenceId:UUID}).strict()).min(1).max(20),
 provenance:z.object({authority:z.literal('authenticated_gallery_editor'),actorId:UUID,requestId:UUID,savedAt:ISO}).strict()}).strict();
export type MerchantPayload=z.input<typeof payloadSchema>;
export type MerchantIntent=z.infer<typeof payloadSchema>&{revision:string};
const draftReceipt=z.object({policyVersion:z.literal('gallery-shopify-draft-v1'),galleryItemId:UUID,sourceFingerprint:HASH,customId,stage:z.literal('draft_ready'),
 productGid:gid('Product'),variantGid:gid('ProductVariant'),shopifyUpdatedAt:ISO,commercialFingerprint:HASH,initialCommercial:commercial}).strict();
const creationProofSchema=z.object({receipt:draftReceipt,receiptId:UUID,creationRevision:z.number().int().positive(),frozenPendingRevision:HASH,
 pendingStoreIntent:z.literal('publish_when_ready'),
 sourceIdentity:z.object({shopifySku:SKU,manufacturerSku:SKU.nullable(),brand:identity.shape.brand}).strict(),
 readbackCommerce:commercial,readbackCopyMediaFingerprint:HASH,readbackGalleryRowFingerprint:HASH,readbackGalleryCopyVersion:ISO}).strict();
export type CreationProof=z.infer<typeof creationProofSchema>;
const contextSchema=z.object({now:z.number().finite(),mode:z.literal('publish_verified_v1'),environment:z.literal('production'),shopDomain:z.literal(SHOP),apiVersion:z.literal(API_VERSION),shopCurrency:z.string().regex(/^[A-Z]{3}$/),
 scopes:z.array(z.string()).max(100),capturedAt:ISO,intentRevision:HASH,frozenPendingRevision:HASH,creationRevision:z.number().int().positive(),
 leaseOwner:UUID,creationLeaseOwner:UUID,productLeaseOwner:UUID,creationLeaseExpiresAt:ISO,productLeaseExpiresAt:ISO,
 locations:z.array(z.object({id:gid('Location'),active:z.boolean(),fulfillsOnlineOrders:z.boolean(),merchantManaged:z.boolean(),inventoryWriteAllowed:z.boolean()}).strict()).max(100),locationsComplete:z.literal(true),
 catalogComplete:z.literal(true),catalogCapturedAt:ISO,
 gallery:z.array(z.object({id:UUID,sku:SKU.nullable(),active:z.boolean()}).strict()).max(6000),
 shopify:z.array(z.object({productGid:gid('Product'),variantGid:gid('ProductVariant'),sku:SKU.nullable()}).strict()).max(10000),
 approved:z.array(z.object({itemId:UUID,productGid:gid('Product'),variantGid:gid('ProductVariant'),sku:SKU}).strict()).max(6000)}).strict();
export type Context=z.infer<typeof contextSchema>;
export type Step={kind:'commerce'|'activate_location'|'set_stock'|'publish_variant'|'activate_product'|'publish_product';locationId?:string};
export type Request={apiVersion:typeof API_VERSION;operation:string;query:string;variables:Record<string,unknown>;idempotencyKey?:string};
export type Plan={policyVersion:typeof POLICY;intent:MerchantIntent;creation:CreationProof;initial:Snapshot;steps:Step[];hash:string};
export type State={planHash:string;version:number;index:number;observed:Snapshot;pending:null|{step:Step;attemptId:string;request:Request;expected:Snapshot};review:string|null};

function fail(code:string):never{throw new Error(`FINALIZE_${code}`);}
function parse<T>(schema:z.ZodType<T>,v:unknown,code:string):T{const r=schema.safeParse(v);if(!r.success)fail(code);return r.data;}
function canonical(v:unknown):string {if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';const result=JSON.stringify(v);if(result===undefined)fail('NON_JSON_PROOF');return result;}
export function fingerprint(v:unknown):string{return createHash('sha256').update(canonical(v)).digest('hex');}
const key=(sku:string|null)=>sku?.toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^(P[0-9]{2}.*)TU$/,'$1')??'';
const held=new Set(['P10OSV0405J','P10ZJT0624U','ORI05500909','ORI05500024']);
const clone=structuredClone;
function same(a:unknown,b:unknown){return canonical(a)===canonical(b);}
function fresh(at:string,now:number,ms:number){return Date.parse(at)<=now+10000&&Date.parse(at)>=now-ms;}
function normalizeSnapshot(raw:unknown):Snapshot {
 const s=parse(snapshotSchema,raw,'SNAPSHOT_INVALID');
 s.levels.sort((a,b)=>a.locationId.localeCompare(b.locationId));s.publicationIds.sort();
 if(new Set(s.levels.map(l=>l.locationId)).size!==s.levels.length||new Set(s.publicationIds).size!==s.publicationIds.length)fail('DUPLICATE_IDENTITY');
 for(const {quantities:q} of s.levels)if(q.onHand!==q.available+q.committed+q.reserved+q.damaged+q.safetyStock+q.qualityControl)fail('INVENTORY_STATES_INCONSISTENT');
 return s;
}
/** Called only after authenticated server provenance and private SQL CAS persistence. */
export function buildMerchantIntent(raw:MerchantPayload):MerchantIntent {
 const value=parse(payloadSchema,raw,'MERCHANT_DETAILS_REQUIRED');
 if(value.commercial.compareAtPrice!==null&&Number(value.commercial.compareAtPrice)<=Number(value.commercial.price))fail('COMPARE_PRICE_INVALID');
 if(new Set(value.stock.map(x=>x.locationId)).size!==value.stock.length)fail('DUPLICATE_LOCATION');
 value.stock.sort((a,b)=>a.locationId.localeCompare(b.locationId));
 return {...value,revision:fingerprint(value)};
}
function assertIntent(raw:MerchantIntent):MerchantIntent {
 if(!raw||!Object.hasOwn(raw,'revision'))fail('INTENT_REVISION_REQUIRED');
 const {revision,...value}=raw;const parsed=buildMerchantIntent(value);
 if(revision!==parsed.revision)fail('INTENT_CHANGED');return parsed;
}
function assertPlan(p:Plan){if(!p||p.policyVersion!==POLICY||p.hash!==fingerprint({policyVersion:p.policyVersion,intent:p.intent,creation:p.creation,initial:p.initial,steps:p.steps}))fail('PLAN_CHANGED');assertIntent(p.intent);}
function guard(intent:MerchantIntent,proof:CreationProof,s:Snapshot,raw:Context):Context {
 const c=parse(contextSchema,raw,'CONTEXT_INVALID');
 if(!['write_products','write_inventory','write_publications'].every(scope=>c.scopes.includes(scope)))fail('SCOPES_REQUIRED');
 if(!fresh(c.capturedAt,c.now,30000)||!fresh(c.catalogCapturedAt,c.now,30000)||!fresh(s.decodedImagesVerifiedAt,c.now,300000))fail('FRESH_PROOF_REQUIRED');
 if(c.intentRevision!==intent.revision||c.frozenPendingRevision!==intent.frozenPendingRevision||proof.frozenPendingRevision!==intent.frozenPendingRevision||c.creationRevision!==proof.creationRevision)fail('SOURCE_CAS_CHANGED');
 if(c.leaseOwner!==c.creationLeaseOwner||c.leaseOwner!==c.productLeaseOwner||Date.parse(c.creationLeaseExpiresAt)<c.now+10000||Date.parse(c.productLeaseExpiresAt)<c.now+10000)fail('OWNED_LEASE_REQUIRED');
 if(intent.currency!==c.shopCurrency)fail('CURRENCY_MISMATCH');
 const i=s.identity,r=proof.receipt;
 if(proof.receiptId!==i.itemId||i.itemId!==intent.galleryItemId||i.sourceFingerprint!==intent.sourceFingerprint||i.itemId!==r.galleryItemId||i.productGid!==r.productGid||i.variantGid!==r.variantGid||i.sourceFingerprint!==r.sourceFingerprint||!same(i.customId,r.customId)||i.customId.value!==`${SHOP}:gallery:${i.itemId}`||i.sku!==proof.sourceIdentity.shopifySku||i.manufacturerSku!==proof.sourceIdentity.manufacturerSku||i.brand!==proof.sourceIdentity.brand)fail('CREATION_IDENTITY_CHANGED');
 if(held.has(key(i.sku))||held.has(key(i.manufacturerSku)))fail('HELD_IDENTITY');
 if(c.approved.some(a=>a.itemId===i.itemId||a.productGid===i.productGid||a.variantGid===i.variantGid||key(a.sku)===key(i.sku)))fail('EXISTING_APPROVED_PRODUCT');
 const ownGallery=c.gallery.filter(x=>x.id===i.itemId),ownShop=c.shopify.filter(x=>x.productGid===i.productGid);
 if(ownGallery.length!==1||ownGallery[0].sku!==i.sku||ownGallery[0].active||ownShop.length!==1||ownShop[0].variantGid!==i.variantGid||ownShop[0].sku!==i.sku||
  c.gallery.some(x=>x.id!==i.itemId&&key(x.sku)===key(i.sku))||c.shopify.some(x=>x.productGid!==i.productGid&&(key(x.sku)===key(i.sku)||x.variantGid===i.variantGid)))fail('CATALOG_IDENTITY_CHANGED');
 if(new Set(c.locations.map(l=>l.id)).size!==c.locations.length)fail('DUPLICATE_LOCATION');
 for(const stock of intent.stock){const l=c.locations.find(l=>l.id===stock.locationId);if(!l||!l.active||!l.fulfillsOnlineOrders||!l.merchantManaged||!l.inventoryWriteAllowed)fail('LOCATION_NOT_ALLOWED');}
 if(s.copyMediaFingerprint!==proof.readbackCopyMediaFingerprint||s.galleryRowFingerprint!==proof.readbackGalleryRowFingerprint||s.galleryCopyVersion!==proof.readbackGalleryCopyVersion)fail('PROTECTED_SOURCE_CHANGED');
 return c;
}
const commercialOnly=(s:Snapshot)=>({price:s.commercial.price,compareAtPrice:s.commercial.compareAtPrice,barcode:s.commercial.barcode,taxable:s.commercial.taxable,requiresShipping:s.commercial.requiresShipping});
export function prepareFinalization(rawIntent:MerchantIntent,rawProof:CreationProof,rawSnapshot:Snapshot,context:Context):{plan:Plan;state:State} {
 const intent=assertIntent(rawIntent),creation=parse(creationProofSchema,rawProof,'CREATION_RECEIPT_INVALID'),s=normalizeSnapshot(rawSnapshot);
 guard(intent,creation,s,context);
 // The creation receipt hashes the initial create response, not the later configured variant.
 const initial={...creation.receipt.initialCommercial};
 if(createHash('sha256').update(JSON.stringify(initial)).digest('hex')!==creation.receipt.commercialFingerprint)fail('CREATION_RECEIPT_INVALID');
 if(s.productStatus!=='DRAFT'||s.publicationIds.length||s.productUpdatedAt!==creation.receipt.shopifyUpdatedAt||!same(commercialOnly(s),creation.readbackCommerce))fail('DRAFT_READY_READBACK_CHANGED');
 const steps:Step[]=[];
 if(!same(s.commercial,intent.commercial))steps.push({kind:'commerce'});
 for(const stock of intent.stock){const current=s.levels.find(l=>l.locationId===stock.locationId);
  if(!current||!current.active)steps.push({kind:'activate_location',locationId:stock.locationId});
  if(current&&current.quantities.available!==stock.available)steps.push({kind:'set_stock',locationId:stock.locationId});
 }
 if(!s.variantOnlinePublished)steps.push({kind:'publish_variant'});
 steps.push({kind:'activate_product'},{kind:'publish_product'});
 const body={policyVersion:POLICY as typeof POLICY,intent,creation,initial:s,steps};const plan:Plan={...body,hash:fingerprint(body)};
 return {plan,state:{planHash:plan.hash,version:1,index:0,observed:s,pending:null,review:null}};
}
function request(kind:Step['kind'],variables:Record<string,unknown>,idempotencyKey:string):Request {
 const queries={
  commerce:'mutation FinalizeVariant($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){productVariants{id} userErrors{field message}}}',
  activate_location:'mutation FinalizeLocation($inventoryItemId:ID!,$locationId:ID!,$available:Int,$key:String!){inventoryActivate(inventoryItemId:$inventoryItemId,locationId:$locationId,available:$available) @idempotent(key:$key){inventoryLevel{id} userErrors{field message}}}',
  set_stock:'mutation FinalizeStock($input:InventorySetQuantitiesInput!,$key:String!){inventorySetQuantities(input:$input) @idempotent(key:$key){inventoryAdjustmentGroup{createdAt} userErrors{field message}}}',
  publish_variant:'mutation FinalizeVariantPublication($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){publishable{__typename} userErrors{field message}}}',
  activate_product:'mutation FinalizeStatus($product:ProductUpdateInput!){productUpdate(product:$product){product{id status} userErrors{field message}}}',
  publish_product:'mutation FinalizePublication($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){publishable{__typename} userErrors{field message}}}',
 };
 const query=kind==='activate_location'&&!Object.hasOwn(variables,'available')
  ?queries[kind].replace(',$available:Int','').replace(',available:$available',''):queries[kind];
 return {apiVersion:API_VERSION,operation:kind,query,variables,...(['activate_location','set_stock'].includes(kind)?{idempotencyKey}:{})};
}
function attemptKey(plan:Plan,index:number){const h=fingerprint({plan:plan.hash,index});return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function semantic(s:Snapshot){const {productUpdatedAt,variantUpdatedAt,inventoryUpdatedAt,decodedImagesVerifiedAt,...rest}=s;void productUpdatedAt;void variantUpdatedAt;void inventoryUpdatedAt;void decodedImagesVerifiedAt;return rest;}
function publishedStable(s:Snapshot){return {...semantic(s),levels:s.levels.map(({locationId,active})=>({locationId,active}))};}
function precondition(s:Snapshot){const {decodedImagesVerifiedAt,...rest}=s;void decodedImagesVerifiedAt;return rest;}
function assertState(plan:Plan,state:State){assertPlan(plan);if(!state||state.planHash!==plan.hash||!Number.isSafeInteger(state.version)||state.version<1||!Number.isSafeInteger(state.index)||state.index<0||state.index>plan.steps.length)fail('STATE_INVALID');
 normalizeSnapshot(state.observed);
 if(state.version!==1+2*state.index+(state.pending?1:0)+(state.review?1:0)||
  (state.review!==null&&state.review!=='FINALIZE_READBACK_CONCURRENT_OR_UNCERTAIN')||
  (state.pending&&(!same(state.pending.step,plan.steps[state.index])||state.pending.attemptId!==attemptKey(plan,state.index))))fail('STATE_INVALID');
}
/** Caller MUST persist returned state with expected version in SQL BEFORE sending request. */
export function beginNextStep(plan:Plan,state:State,current:Snapshot,context:Context):{state:State;request:Request;expectedVersion:number} {
 assertState(plan,state);if(state.pending)fail('READBACK_REQUIRED_NO_RETRY');if(state.review)fail('REVIEW_REQUIRED');
 const s=normalizeSnapshot(current);guard(plan.intent,plan.creation,s,context);
 if(!same(precondition(s),precondition(state.observed)))fail('PREWRITE_SNAPSHOT_CHANGED');
 const step=plan.steps[state.index];if(!step)fail('FINALIZER_REQUIRED');
 const expected=clone(s),i=s.identity,desired=plan.intent.commercial;const id=attemptKey(plan,state.index);let variables:Record<string,unknown>;
 if(step.kind==='commerce'){
  variables={productId:i.productGid,variants:[{id:i.variantGid,price:desired.price,compareAtPrice:desired.compareAtPrice,barcode:desired.barcode,taxable:desired.taxable,inventoryPolicy:'DENY',inventoryItem:{tracked:true,requiresShipping:true}}]};
  expected.commercial=clone(desired);
 }else if(step.kind==='activate_location'){
  const target=expected.levels.find(l=>l.locationId===step.locationId),stock=plan.intent.stock.find(l=>l.locationId===step.locationId)!;
  variables={inventoryItemId:i.inventoryItemGid,locationId:step.locationId,key:id};
  if(target)target.active=true; // Omit quantity for a previously existing inactive level; never reset it.
  else {variables.available=stock.available;expected.levels.push({locationId:stock.locationId,active:true,quantities:{available:stock.available,onHand:stock.available,committed:0,reserved:0,damaged:0,safetyStock:0,qualityControl:0,incoming:0}});}
 }else if(step.kind==='set_stock'){
  const target=expected.levels.find(l=>l.locationId===step.locationId),stock=plan.intent.stock.find(l=>l.locationId===step.locationId)!;
  if(!target?.active)fail('LOCATION_NOT_ACTIVE');
  variables={key:id,input:{name:'available',reason:'correction',referenceDocumentUri:`gid://toptik-gallery/CreationStock/${plan.intent.intentId}`,
   quantities:[{inventoryItemId:i.inventoryItemGid,locationId:stock.locationId,quantity:stock.available,changeFromQuantity:target.quantities.available}]}};
  target.quantities.onHand+=stock.available-target.quantities.available;target.quantities.available=stock.available;
 }else if(step.kind==='activate_product'){
  variables={product:{id:i.productGid,status:'ACTIVE'}};expected.productStatus='ACTIVE';
 }else{
  variables={id:step.kind==='publish_variant'?i.variantGid:i.productGid,input:[{publicationId:PUBLICATION}]};
  if(step.kind==='publish_variant')expected.variantOnlinePublished=true;else expected.publicationIds=[PUBLICATION];
 }
 const req=request(step.kind,variables,id),next=clone(state);next.version++;next.pending={step:clone(step),attemptId:id,request:req,expected:normalizeSnapshot(expected)};
 return {state:next,request:req,expectedVersion:state.version};
}
/** Any started step, including lost responses, may only be resolved by fresh readback. */
export function acceptStepReadback(plan:Plan,state:State,observed:Snapshot,context:Context):State {
 assertState(plan,state);if(!state.pending||state.review)fail('STEP_NOT_PENDING');
 const s=normalizeSnapshot(observed);guard(plan.intent,plan.creation,s,context);
 const next=clone(state);next.version++;
 // A real order may arrive immediately after the final publish. All initial stock
 // commands already have independent accepted readbacks; never reset a later sale.
 const projection=state.pending.step.kind==='publish_product'?publishedStable:semantic;
 if(!same(projection(s),projection(state.pending.expected))||
  ['productUpdatedAt','variantUpdatedAt','inventoryUpdatedAt'].some(k=>Date.parse(s[k as keyof Snapshot] as string)<Date.parse(state.observed[k as keyof Snapshot] as string))){next.review='FINALIZE_READBACK_CONCURRENT_OR_UNCERTAIN';return next;}
 next.observed=s;next.pending=null;next.index++;return next;
}
/** Read-only instruction, never a second write after a lost mutation response. */
export function nextDisposition(plan:Plan,state:State):'readback_only'|'review'|'begin_next'|'finalize_binding' {
 assertState(plan,state);return state.review?'review':state.pending?'readback_only':state.index===plan.steps.length?'finalize_binding':'begin_next';
}
/** Payload for a NEW-only atomic DB finalizer, not a claim that it has run. */
export function buildFinalizerRequest(plan:Plan,state:State,current:Snapshot,context:Context) {
 assertState(plan,state);if(nextDisposition(plan,state)!=='finalize_binding')fail('PUBLICATION_NOT_VERIFIED');
 const s=normalizeSnapshot(current);guard(plan.intent,plan.creation,s,context);
 // After publication, Shopify sales/stock changes stay authoritative. Never restore initial counts.
 if(!same(publishedStable(s),publishedStable(state.observed)))fail('FINAL_READBACK_CHANGED');
 if(s.productStatus!=='ACTIVE'||!same(s.publicationIds,[PUBLICATION])||!s.variantOnlinePublished||!same(s.commercial,plan.intent.commercial))fail('PUBLICATION_NOT_VERIFIED');
 for(const stock of plan.intent.stock)if(!s.levels.some(l=>l.locationId===stock.locationId&&l.active))fail('STOCK_READBACK_REQUIRED');
 return {rpc:'finalize_gallery_shopify_public_creation',args:{p_intent_id:plan.intent.intentId,p_intent_revision:plan.intent.revision,p_creation_receipt_id:plan.creation.receiptId,
  p_creation_revision:plan.creation.creationRevision,p_plan_hash:plan.hash,p_expected_state_version:state.version,p_lease_owner:context.leaseOwner,
  p_item_id:s.identity.itemId,p_exact_sku:s.identity.sku,p_product_gid:s.identity.productGid,p_variant_gid:s.identity.variantGid,p_inventory_item_gid:s.identity.inventoryItemGid,
  p_handle:s.identity.handle,p_source_fingerprint:s.identity.sourceFingerprint,p_expected_gallery_row_hash:s.galleryRowFingerprint,p_expected_copy_version:s.galleryCopyVersion,
  p_gallery_baseline:clone(s.galleryCopy),p_shopify_baseline:clone(s.shopifyCopy),p_live_commerce:clone(s.commercial),p_live_inventory:clone(s.levels),
  p_publication_id:PUBLICATION,p_verified_at:context.capturedAt,p_snapshot_hash:fingerprint(s),p_snapshot:clone(s)},
  insertsOnly:['exact_binding','independent_copy_baselines','creation_copy_approval','public_link'],activateGallery:true,existingRowsToUpdate:[s.identity.itemId]};
}
