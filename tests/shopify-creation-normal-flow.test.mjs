import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {randomUUID} from 'node:crypto';
import {descriptionModuleUrl} from './helpers/description-module.mjs';
const read=p=>readFileSync(p,'utf8'),url=s=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString('base64')}`;
const vendor=url(read('src/lib/catalog-source/vendor-detect.ts'));
const rules=url(read('src/lib/shopify/sync-rules.ts').replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendor)));
const base=s=>s.replace('"zod"',JSON.stringify(import.meta.resolve('zod'))).replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rules));
const policy=url(base(read('src/lib/shopify/creation-policy.ts'))),intent=url(base(read('src/lib/shopify/creation-intent.ts')).replace('"./creation-policy"',JSON.stringify(policy)));
const pure=await import(intent),schema=url(read('src/lib/validation/carousel.ts').replace('"zod"',JSON.stringify(import.meta.resolve('zod'))));
const service=url('export const createSupabaseServiceRoleClient=()=>globalThis.__normalCreation.db;');
const mode=url('export const galleryDraftCreationMode=()=>globalThis.__normalCreation.enabled;');
const finalized=url(read('src/lib/shopify/creation-finalization-read.ts').replace('import "server-only";','')
 .replace('"@/lib/supabase/service-role"',JSON.stringify(service)));
const inject=s=>base(s).replace('import "server-only";','').replace('"@/lib/supabase/service-role"',JSON.stringify(service))
 .replace('"./creation-runtime"',JSON.stringify(mode)).replace('"./creation-finalization-read"',JSON.stringify(finalized))
 .replace('"./creation-intent"',JSON.stringify(intent)).replace('"@/lib/validation/carousel"',JSON.stringify(schema));
const flow=await import(url(inject(read('src/lib/shopify/creation-import.ts'))));
const bridge=await import(url(inject(read('src/lib/shopify/creation-catalog-bridge.ts'))));
function item(sku='NEW-MANUFACTURER-001') {const id=randomUUID();return {id,title:'מזוודה',description:'תיאור מקור',catalogNumber:sku,sourceUrl:'https://www.bricsmilano.com/products/exact',
 coverImagePath:'https://cdn.shopify.com/s/files/1/exact.webp',displayOrder:1,isActive:false,color:'שחור',dimensions:'75 × 52 × 28',weight:'3.6 kg',
 techSpecs:{specs:[{heading:'מידע מקור',items:[{label:'חומר',value:'PC'}]}],colors:[],category:null},colors:[],
 angles:[{id:randomUUID(),itemId:id,angleKey:'front',imagePath:'https://cdn.shopify.com/s/files/1/exact.webp',angleOrder:1}]};}
function fixture(rows=[]) {
 const f=globalThis.__normalCreation={enabled:true,rows,privateIds:[],finalizedIds:[],calls:[],records:new Map(),db:null};
 f.db={from(table){f.calls.push({table});const filters={};return {select(){return this;},order(){return this;},range(){return this;},eq(key,value){filters[key]=value;return this;},abortSignal(){
  const data=table==='carousel_items'?f.rows.map(r=>({id:r.id,catalog_number:r.catalogNumber})):table==='shopify_gallery_creation_imports'
   ? [...f.records.entries()].filter(([key])=>key===filters.vendor+':'+filters.exact_manufacturer_sku).map(([,record])=>({intent_id:record.input.galleryItemId}))
   : f.privateIds.filter(id=>!filters.id||id===filters.id).map(id=>({id}));
  return {then(resolve,reject){return Promise.resolve({error:null,data}).then(resolve,reject);},maybeSingle(){return Promise.resolve({error:null,data:data[0]??null});}};}};},
  rpc(name,args){return {abortSignal(){f.calls.push({name,args});
   if(name==='read_finalized_gallery_creation_items')return Promise.resolve({data:{finalizedItemIds:f.finalizedIds.filter(id=>args.p_item_ids.includes(id))},error:null});
   assert.equal(name,'stage_gallery_creation_import');const key=args.p_vendor+':'+args.p_exact_manufacturer_sku;
   const previous=f.records.get(key);if(previous)return Promise.resolve({data:{record:previous,sourceChanged:false,replayed:true},error:null});
   f.records.set(key,args.p_record);return Promise.resolve({data:{record:args.p_record,sourceChanged:false,replayed:false},error:null});}};}};
 return f;
}
function importerFor(result,calls){return async(vendor,source,target)=>{calls.push({vendor,source,target});return {ok:true,item:structuredClone(result),source:{vendor,catalogNumber:result.catalogNumber,sourceUrl:result.sourceUrl,importedImages:1}};};}
const sourceFor=result=>({catalogNumber:result.catalogNumber,title:result.title,description:result.description,imageUrls:[result.coverImagePath],sourceUrl:result.sourceUrl});
test('new manufacturer/Excel import persists shared source fields privately without creating a catalog row or commerce',async()=>{
 const f=fixture(),product=item(),calls=[];const result=await flow.runAdminManufacturerImport('brics',sourceFor(product),undefined,product.catalogNumber,importerFor(product,calls));
 assert.equal(calls[0].target,undefined);assert.equal(result.pendingCreation.id,product.id);assert.deepEqual(f.rows,[]);
 const saved=f.calls.find(c=>c.name).args;assert.deepEqual(saved.p_source,product);
 assert.equal(saved.p_record.input.shopifySku,null);assert.equal(saved.p_record.input.manufacturerSku,product.catalogNumber);
 assert.deepEqual(saved.p_record.input.commerce,{sellingPrice:null,currency:null,compareAtPrice:null,barcode:null,taxable:null,requiresShipping:null,inventory:{status:'unknown'},storeIntent:'undecided'});
 assert.equal(saved.p_record.input.category,null);assert.equal(saved.p_record.input.copy.descriptionHtml,'<p>תיאור מקור</p>');
 assert.equal(f.calls.filter(c=>c.name).length,1);
});
test('reimport resumes current exact pending identity and preserves intervening merchant changes',async()=>{
 const f=fixture(),first=item(),calls=[];await flow.runAdminManufacturerImport('brics',sourceFor(first),undefined,first.catalogNumber,importerFor(first,calls));
 const key='brics:'+first.catalogNumber,prior=f.records.get(key),changed=structuredClone(prior.input);changed.commerce.sellingPrice='320.00';changed.copy.title='כותרת שערך מנהל';
 const at=new Date().toISOString(),edited=pure.saveCreationIntent(prior,changed,{actorId:randomUUID(),requestId:randomUUID(),at,expectedRevision:prior.revision},{complete:true,capturedAt:at,existing:[]});f.records.set(key,edited);
 const second=item(first.catalogNumber);const result=await flow.runAdminManufacturerImport('brics',sourceFor(second),undefined,second.catalogNumber,importerFor(second,calls));
 assert.equal(result.pendingCreation.id,first.id);assert.equal(result.pendingCreation.replayed,true);assert.deepEqual(f.records.get(key),edited);
});
test('exact existing inactive import remains an update; ambiguous aliases/target IDs never write side data',async()=>{
 const existing=item('BAH08453.001'),f=fixture([existing]),calls=[];
 const result=await flow.runAdminManufacturerImport('brics',sourceFor(existing),undefined,existing.catalogNumber,importerFor(existing,calls));
 assert.equal(calls[0].target,existing.id);assert.equal(result.pendingCreation,undefined);assert.equal(f.calls.filter(c=>c.name).length,0);
 await assert.rejects(flow.runAdminManufacturerImport('brics',{...sourceFor(existing),catalogNumber:'BAH08453001'},undefined,'BAH08453001',importerFor(existing,calls)),/IDENTITY_AMBIGUOUS/);
 await assert.rejects(flow.runAdminManufacturerImport('brics',sourceFor(existing),randomUUID(),existing.catalogNumber,importerFor(existing,calls)),/TARGET_MISMATCH/);
 assert.equal(calls.length,1);
});
test('held identities and disabled creation stop before import/upload or private reservation',async()=>{
 const f=fixture(),calls=[];for(const sku of ['P10OSV04-05J-TU','P10ZJT06-24U-TU']){const product=item(sku);
  await assert.rejects(flow.runAdminManufacturerImport('mandarina',sourceFor(product),undefined,sku,importerFor(product,calls)),/HELD_IDENTITY/);}
 f.enabled=false;const product=item();await assert.rejects(flow.runAdminManufacturerImport('brics',sourceFor(product),undefined,product.catalogNumber,importerFor(product,calls)),/NOT_ENABLED/);
 assert.equal(calls.length,0);assert.equal(f.calls.filter(c=>c.name).length,0);
});
test('promoted private reimport resumes receipt and never writes ordinary importer side data, including flag off',async()=>{
 const f=fixture(),first=item(),calls=[];await flow.runAdminManufacturerImport('brics',sourceFor(first),undefined,first.catalogNumber,importerFor(first,calls));
 f.rows.push(first);f.privateIds.push(first.id);const before=structuredClone(first);
 const next=item(first.catalogNumber),result=await flow.runAdminManufacturerImport('brics',sourceFor(next),undefined,next.catalogNumber,importerFor(next,calls));
 assert.equal(result.pendingCreation.id,first.id);assert.equal(calls[1].target,undefined);assert.deepEqual(f.rows[0],before);
 f.enabled=false;await assert.rejects(flow.runAdminManufacturerImport('brics',sourceFor(first),undefined,first.catalogNumber,importerFor(first,calls)),/NOT_ENABLED/);
 assert.equal(calls.length,2);f.enabled=true;f.records.clear();
 await assert.rejects(flow.runAdminManufacturerImport('brics',sourceFor(first),undefined,first.catalogNumber,importerFor(first,calls)),/PRIVATE_ITEM_USE_INTENT/);
 assert.equal(calls.length,2);
});
test('long imported gallery keeps every image privately and blocks promotion until ten are selected',()=>{
 fixture();const product=item();for(let n=1;n<=14;n++)product.angles.push({id:randomUUID(),itemId:product.id,angleKey:'view-'+n,imagePath:`https://cdn.shopify.com/s/files/1/exact-${n}.webp`,angleOrder:n+1});
 const input=flow.importedCreationInput(product,'brics'),at=new Date().toISOString();assert.equal(input.media.length,15);
 const record=pure.saveCreationIntent(null,input,{actorId:randomUUID(),requestId:randomUUID(),at,expectedRevision:null},{complete:true,capturedAt:at,existing:[]});
 assert.ok(pure.assessCreationIntent(record).draftBlockers.includes('media_limit'));
});
test('normal existing catalog saves retain private reservations byte-for-byte and refuse unknown/private IDs',async()=>{
 const existing=item('EXISTING'),privateRow=item('PRIVATE'),f=fixture([existing,privateRow]);f.privateIds=[privateRow.id];
 const current={items:[existing,privateRow],settings:{autoplayMs:3500,transitionMode:'curtain-fade'}};
 const visible=await bridge.visibleAdminCatalog(current);assert.deepEqual(visible.items,[existing]);
 const edited=structuredClone(visible);edited.items[0].title='עריכה קיימת';const next=await bridge.prepareExistingCatalogSave(edited,current);
 assert.equal(next.items[0].title,'עריכה קיימת');assert.deepEqual(next.items[1],privateRow);assert.deepEqual(current.items,[existing,privateRow]);
 await assert.rejects(bridge.prepareExistingCatalogSave({...visible,items:[item('UNKNOWN')]},current),/NEW_ITEM_USE_INTENT/);
 await assert.rejects(bridge.prepareExistingCatalogSave(current,current),/PRIVATE_ITEM_USE_INTENT/);
 f.enabled=false;assert.deepEqual((await bridge.visibleAdminCatalog(current)).items,[existing]);
 assert.deepEqual((await bridge.prepareExistingCatalogSave(visible,current)).items,[existing,privateRow]);
 await assert.rejects(bridge.prepareExistingCatalogSave(current,current),/PRIVATE_ITEM_USE_INTENT/);
});
test('original Add Item and all import paths use the same embedded intent editor, preserving unsaved catalog context',()=>{
 const admin=read('src/app/admin/page.tsx'),add=admin.slice(admin.indexOf('function addItem()'),admin.indexOf('function removeItem('));
 assert.match(add,/setCreationSelection/);assert.doesNotMatch(add,/setPayload|hero-web-airport/);
 assert.match(admin,/<NewProductEditor key=\{creationSelection.key\} adminToken=\{token\}/);
 assert.match(admin,/data.pendingCreation \? \{ next: workingPayload, mode: "pending"/);
 // The atomic save returns a fresh catalog with its new concurrency revisions.
 assert.match(admin,/if \(existingUpdates\) \{ setPayload\(await persistPayload\(workingPayload\)\)/);
 assert.match(read('src/app/api/admin/import/by-url/route.ts'),/runAdminManufacturerImport/);
 assert.match(read('src/lib/import/import-handler.ts'),/runAdminManufacturerImport\(vendor, sourceProduct, targetItemId, catalogNumber, importSourceProduct\)/);
 const editor=read('src/components/admin/NewProductEditor.tsx');assert.match(editor,/input: prepared, expectedRevision: null/);assert.match(editor,/type="file"/);
});

test('finalized exact receipt releases active and inactive products to normal editor and reimport even when creation is disabled',async()=>{
 const live=item('CREATED-LIVE'),inactive=item('CREATED-INACTIVE'),pending=item('PRIVATE-PENDING');live.isActive=true;
 const f=fixture([live,inactive,pending]);f.privateIds=[live.id,inactive.id,pending.id];f.finalizedIds=[live.id,inactive.id];f.enabled=false;
 const current={items:[live,inactive,pending],settings:{autoplayMs:3500,transitionMode:'curtain-fade'}};
 const visible=await bridge.visibleAdminCatalog(current);assert.deepEqual(visible.items,[live,inactive]);
 const edited=structuredClone(visible);edited.items[0].title='עריכה לאחר פרסום';
 const saved=await bridge.prepareExistingCatalogSave(edited,current);assert.equal(saved.items[0].title,'עריכה לאחר פרסום');
 assert.deepEqual(saved.items[2],pending);assert.deepEqual(current.items,[live,inactive,pending]);
 const calls=[];for(const product of [live,inactive]){
  const result=await flow.runAdminManufacturerImport('brics',sourceFor(product),product.id,product.catalogNumber,importerFor(product,calls));
  assert.equal(result.pendingCreation,undefined);
 }
 assert.deepEqual(calls.map(c=>c.target),[live.id,inactive.id]);
 assert.equal(f.calls.filter(c=>c.name==='stage_gallery_creation_import').length,0);
});
