import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {descriptionModuleUrl, descriptionHelpers} from './helpers/description-module.mjs';
const asUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const vendor = asUrl(readFileSync('src/lib/catalog-source/vendor-detect.ts','utf8'));
const rules = asUrl(readFileSync('src/lib/shopify/sync-rules.ts','utf8').replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendor)));
const replaceImports = source => source.replace('"zod"',JSON.stringify(import.meta.resolve('zod')))
 .replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rules));
const policyUrl = asUrl(replaceImports(readFileSync('src/lib/shopify/creation-policy.ts','utf8')));
const policy = await import(policyUrl);
const source = readFileSync('src/lib/shopify/creation-intent.ts','utf8');
const p = await import(asUrl(replaceImports(source).replace('"./creation-policy"',JSON.stringify(policyUrl))));
const now = Date.parse('2026-09-30T19:00:00Z'), ts = new Date(now).toISOString();
const id='00000000-0000-4000-8000-000000000081', actor='00000000-0000-4000-8000-000000000082';
const request='00000000-0000-4000-8000-000000000083', mappingId='00000000-0000-4000-8000-000000000084';
const namespace='app--12345--toptik_gallery', image='https://cdn.shopify.com/s/files/1/exact.webp';
function input() {return {
 galleryItemId:id,shopifySku:null,manufacturerSku:null,identityMappingReceiptId:null,brand:null,category:null,
 copy:{title:null,description:null,descriptionHtml:null,seoTitle:null,seoDescription:null},media:[],
 commerce:{sellingPrice:null,currency:null,compareAtPrice:null,barcode:null,taxable:null,requiresShipping:null,
  inventory:{status:'unknown'},storeIntent:'undecided'},sourceReferences:[],
};}
function complete() {const v=input();return {...v,shopifySku:'NEW-BRIC.078',manufacturerSku:'NEW-BRIC.078',brand:"Bric's",category:'carryon',
 copy:{title:'מזוודה חדשה אמיתית',description:'תיאור',descriptionHtml:'<p>תיאור</p>',seoTitle:'SEO',seoDescription:null},
 media:[{url:image,alt:'מזוודה ירוקה'}],commerce:{...v.commerce,currency:'ILS',requiresShipping:true,storeIntent:'draft'}};}
function identities() {return {complete:true,capturedAt:ts,existing:Array.from({length:78},(_,i)=>({
 galleryItemId:`existing-${i}`,exactGallerySku:`EXISTING-${i}`,exactShopifySku:`STORE-${i}`}))};}
function edit(revision=null, at=ts) {return {actorId:actor,requestId:request,at,expectedRevision:revision};}
function save(value=complete(),previous=null, context=edit(previous?.revision??null), proof=identities()) {
 return p.saveCreationIntent(previous,value,context,proof);
}
function context(value=complete()) {return {
 mode:'draft_only',now,shopDomain:'toptikcoil.myshopify.com',shopCurrency:'ILS',expectedAppNamespace:namespace,
 definition:{namespace,key:'source_item_id',ownerType:'PRODUCT',type:'id',uniqueValuesEnabled:true},
 catalog:{complete:true,capturedAt:ts,gallery:[{id,catalogNumber:value.shopifySku,isActive:false}],shopify:[]},
 images:value.media.map(item=>({url:item.url,galleryItemId:id,exactSku:value.shopifySku,sha256:'a'.repeat(64),mime:'image/webp',
  width:600,height:800,byteLength:12000,verifiedAt:ts})),
};}
function freeze(record=save(),ctx=context(record.input),identity=identities(),mapping=null) {
 return p.freezeCreationIntent(record,ctx,identity,mapping);
}
function receipt(frozen,stage='reserved') {return {policyVersion:policy.GALLERY_CREATION_POLICY,galleryItemId:id,
 sourceFingerprint:frozen.ready.sourceFingerprint,customId:{...frozen.ready.customId},stage,
 productGid:null,variantGid:null,shopifyUpdatedAt:null,commercialFingerprint:null,initialCommercial:null};}

test('incomplete product remains saveable private intent with exact missing reasons and no invented facts',()=>{
 const record=save(input()), report=p.assessCreationIntent(record);
 assert.equal(report.state,'needs_details'); assert.equal(report.readyForPublication,false);
 assert.deepEqual(report.draftBlockers,['store_sku','brand','title','description','media','currency','shipping_policy','store_intent']);
 assert.deepEqual(report.publicBlockers,[...report.draftBlockers,'selling_price','tax_policy','server_verification']);
 assert.deepEqual(record.input,input()); assert.throws(()=>freeze(record),/DETAILS_REQUIRED/);
});
test('full snapshot is strict and preserves missing versus explicitly blank copy',()=>{
 const absent=input();delete absent.copy.description;assert.throws(()=>save(absent),/INPUT_INVALID/);
 const blank=complete();blank.copy.description='';blank.copy.descriptionHtml='';blank.copy.seoDescription='';
 const frozen=freeze(save(blank));assert.equal(frozen.ready.draft.copy.descriptionHtml,'');assert.equal(frozen.ready.draft.copy.seoDescription,'');
 const unknown=complete();unknown.copy.description=null;unknown.copy.descriptionHtml=null;
 assert.deepEqual(p.assessCreationIntent(save(unknown)).draftBlockers,['description']);
});
test('CAS requires explicit own null/revision and rejects concurrent stale editor without mutating prior',()=>{
 const record=save(), before=structuredClone(record), changed=complete();changed.copy.title='כותרת שונה';
 const next=save(changed,record);assert.equal(next.parentRevision,record.revision);assert.notEqual(next.revision,record.revision);
 assert.throws(()=>save(changed,next,edit(record.revision)),/STALE_EDIT/);assert.deepEqual(record,before);
 for(const context of [{actorId:actor,requestId:request,at:ts},{...edit(),expectedRevision:undefined},Object.assign(Object.create({expectedRevision:null}),{actorId:actor,requestId:request,at:ts})]) {
  assert.throws(()=>save(complete(),null,context),/EDIT_CONTEXT_INVALID/);
 }
 assert.deepEqual(save(record.input,record),record);
});
test('identity may be filled once but exact store/manufacturer UUID/SKU never silently changes',()=>{
 const blank=save(input()), ready=save(complete(),blank);
 assert.equal(ready.input.shopifySku,'NEW-BRIC.078');
 for(const change of [v=>{v.shopifySku='NEWBRIC078';},v=>{v.shopifySku=null;},v=>{v.manufacturerSku='different';},v=>{v.manufacturerSku=null;},v=>{v.galleryItemId=actor;}]) {
  const value=structuredClone(ready.input);change(value);assert.throws(()=>save(value,ready),/IDENTITY_IMMUTABLE/);
 }
});
test('all 78 existing approvals plus disabled aliases stay outside creation even with changed store punctuation',()=>{
 const proof=identities(), before=structuredClone(proof);
 for(const row of proof.existing) {
  for(const patch of [{galleryItemId:row.galleryItemId},{shopifySku:row.exactGallerySku},{shopifySku:row.exactShopifySku.toLowerCase().replace('-','.')}]) {
   const value=complete();Object.assign(value,patch);
   // Existing UUID identifiers in this fixture are strings; SKU paths exercise normalized aliases.
   assert.throws(()=>p.assertNewCreationIdentity(value,proof,now),/EXISTING_PRODUCT_USE_SYNC/);
  }
 }
 assert.deepEqual(proof,before);
 for(const patch of [{complete:false},{capturedAt:new Date(now-300001).toISOString()},{capturedAt:'2026-09-30'}])
  assert.throws(()=>save(complete(),null,edit(),{...proof,...patch}),/IDENTITY_PROOF_REQUIRED/);
});
test('held two products and hidden products are excluded using both exact identity fields',()=>{
 for(const sku of ['P10OSV04-05J-TU','p10osv0405j','P10ZJT06-24U-TU','p10zjt06.24u.tu','ORI05500909','ORI05500024']) {
  for(const field of ['shopifySku','manufacturerSku']) {const value=complete();value[field]=sku;assert.throws(()=>save(value),/HELD_IDENTITY/);}
 }
});
test('provenance belongs to server edit context, only changed fields advance and description pair is atomic',()=>{
 const record=save(), value=complete();value.copy.descriptionHtml='<p><b>תיאור</b></p>';
 const next=save(value,record,{...edit(record.revision),requestId:actor});
 assert.deepEqual(next.provenance.description,{actorId:actor,requestId:actor,at:ts,authority:'merchant_copy_pair',verifiedManufacturerFact:false});
 for(const field of Object.keys(p.CREATION_FIELD_AUTHORITY).filter(field=>field!=='description')) assert.deepEqual(next.provenance[field],record.provenance[field]);
 for(const field of Object.keys(next.provenance)) assert.equal(next.provenance[field].verifiedManufacturerFact,false);
 assert.throws(()=>save({...value,provenance:record.provenance}),/INPUT_INVALID/);
 const bad=structuredClone(record);bad.provenance.sellingPrice.authority='manufacturer_verified';assert.throws(()=>p.assessCreationIntent(bad),/RECORD_INVALID|RECORD_CHANGED/);
 const mismatch=complete();mismatch.copy.descriptionHtml='<p>different</p>';assert.throws(()=>save(mismatch),/DESCRIPTION_PAIR_MISMATCH/);
});
test('rich HTML tables, links and lists remain exact while unsafe HTML/source references fail',()=>{
 const value=complete();value.copy.descriptionHtml='<p dir="rtl"><a href="https://www.bricsmilano.com/">מותג</a></p><table><tr><td>55</td></tr></table><ul><li>א</li></ul>';
 value.copy.description=descriptionHelpers.descriptionTextFromHtml(value.copy.descriptionHtml);
 assert.equal(freeze(save(value)).ready.draft.copy.descriptionHtml,value.copy.descriptionHtml);
 value.copy.descriptionHtml='<script>alert(1)</script>';assert.throws(()=>save(value),/HTML_UNSAFE/);
 for(const url of ['http://example.com/','https://a:b@example.com/','javascript:alert(1)']) {const v=complete();v.sourceReferences=[url];assert.throws(()=>save(v),/REFERENCE_INVALID|INPUT_INVALID/);}
});
test('manufacturer SKU never becomes store SKU and mapping is a server-read exact receipt',()=>{
 const value=complete();value.brand='Samsonite';value.shopifySku='NEW-KJ007';value.manufacturerSku='150700-9199';
 value.sourceReferences=['https://www.samsonite.co.uk/example'];
 assert.ok(p.assessCreationIntent(save(value)).draftBlockers.includes('manufacturer_mapping_receipt'));
 value.identityMappingReceiptId=mappingId;const record=save(value);
 assert.throws(()=>freeze(record),/MAPPING_RECEIPT_MISMATCH/);
 const mapping={id:mappingId,galleryItemId:id,shopifySku:value.shopifySku,manufacturerSku:value.manufacturerSku,
  sourceUrl:value.sourceReferences[0],evidenceSha256:'b'.repeat(64),verifiedAt:ts};
 const frozen=freeze(record,context(value),identities(),mapping);
 assert.equal(frozen.ready.draft.shopifySku,value.shopifySku);assert.equal(frozen.ready.draft.manufacturerSku,'150700-9199');
 assert.equal(frozen.ready.draft.identityMapping.evidenceSha256,mapping.evidenceSha256);
 for(const patch of [{galleryItemId:actor},{shopifySku:'OTHER'},{manufacturerSku:'OTHER'},{id:actor},{verifiedAt:new Date(now+30001).toISOString()},{sourceUrl:'https://u:p@example.com/'}])
  assert.throws(()=>freeze(record,context(value),identities(),{...mapping,...patch}),/MAPPING_RECEIPT_MISMATCH/);
});
test('merchant price/currency/tax authority rejects inferred supplier or inventory knobs and never pretends publish readiness',()=>{
 for(const change of [v=>{v.commerce.supplierPrice='100';},v=>{v.commerce.inventory={status:'known',quantity:10};},v=>{v.commerce.netWeight='2.4';},v=>{v.commerce.shippingWeight='2.4';},v=>{v.commerce.sellingPrice='0';},v=>{v.commerce.sellingPrice='1e2';},v=>{v.commerce.currency='USD';}]) {
  const value=complete();change(value);assert.throws(()=>freeze(save(value)),/INPUT_INVALID|CURRENCY_MISMATCH/);
 }
 const value=complete();value.commerce.storeIntent='publish_when_ready';value.commerce.sellingPrice='599.90';value.commerce.taxable=true;
 const record=save(value), frozen=freeze(record);
 assert.equal(frozen.requestedStoreIntent,'publish_when_ready');assert.equal(frozen.ready.draft.commerce.storeIntent,'draft');
 assert.equal(policy.buildGalleryDraftCreateVariables(frozen.ready).product.status,'DRAFT');
 assert.deepEqual(p.assessCreationIntent(record).publicBlockers,['server_verification']);
});
test('all image proof/custom-ID/catalog gates still run at freeze, no local draft bypass',()=>{
 const record=save();for(const change of [c=>{c.mode=undefined;},c=>{c.images=[];},c=>{c.definition.uniqueValuesEnabled=false;},c=>{c.catalog.complete=false;},c=>{c.images[0].exactSku='OTHER';},c=>{c.catalog.shopify=[{productGid:'gid://shopify/Product/10',variantGid:'gid://shopify/ProductVariant/11',sku:'NEWBRIC078',status:'ARCHIVED'}];}]) {
  const ctx=context(record.input);change(ctx);assert.throws(()=>freeze(record,ctx),/SYNC_CREATION_/);
 }
});
test('source edits after freeze cannot replace a reserved or uncertain external operation',()=>{
 const record=save(), frozen=freeze(record), value=complete();value.copy.title='נערך אחרי הקפאה';
 const updated=save(value,record);
 for(const stage of ['reserved','create_started','variant_started','uncertain','draft_ready'])
  assert.throws(()=>p.planCreationIntentRetry(frozen,updated,receipt(frozen,stage),{complete:true,found:null}),/SOURCE_CHANGED_REVIEW/);
 const bad=structuredClone(record);bad.input.commerce.sellingPrice='9';assert.throws(()=>p.assessCreationIntent(bad),/RECORD_CHANGED/);
});
test('retry delegates to exact custom identity: create once, lookup-only after uncertain sends, no automatic reset',()=>{
 const record=save(), frozen=freeze(record);
 assert.equal(p.planCreationIntentRetry(frozen,record,receipt(frozen),{complete:true,found:null}).kind,'create_draft');
 for(const stage of ['create_started','variant_started','uncertain','draft_ready'])
  assert.equal(p.planCreationIntentRetry(frozen,record,receipt(frozen,stage),{complete:true,found:null}).kind,'lookup_custom_id');
 assert.equal(p.planCreationIntentRetry(frozen,record,receipt(frozen,'review'),{complete:true,found:null}).kind,'stop');
 const r=receipt(frozen);r.customId.value='other';assert.throws(()=>p.planCreationIntentRetry(frozen,record,r,{complete:true,found:null}),/RECEIPT_CHANGED/);
});
test('new preparation module is pure and has no fallback create/publication/inventory mutation',()=>{
 assert.doesNotMatch(source,/\bfetch\s*\(|createSupabase|process\.env|publishablePublish\s*\(|productSet\s*\(|productDelete\s*\(/);
 assert.equal(p.creationIntentInputSchema.safeParse({...complete(),productGid:'gid://shopify/Product/1'}).success,false);
});
