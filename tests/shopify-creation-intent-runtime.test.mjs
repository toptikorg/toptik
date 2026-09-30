import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {randomUUID} from 'node:crypto';
import {descriptionModuleUrl} from './helpers/description-module.mjs';
const asUrl=s=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString('base64')}`;
const vendor=asUrl(readFileSync('src/lib/catalog-source/vendor-detect.ts','utf8'));
const rules=asUrl(readFileSync('src/lib/shopify/sync-rules.ts','utf8').replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendor)));
const imports=s=>s.replace('"zod"',JSON.stringify(import.meta.resolve('zod'))).replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rules));
const policyUrl=asUrl(imports(readFileSync('src/lib/shopify/creation-policy.ts','utf8')));
const intentUrl=asUrl(imports(readFileSync('src/lib/shopify/creation-intent.ts','utf8')).replace('"./creation-policy"',JSON.stringify(policyUrl)));
const policy=await import(intentUrl);
globalThis.__creationIntent={mode:'draft_only',db:null,scheduled:[],configured:true};
const modeUrl=asUrl('export const galleryDraftCreationMode=()=>globalThis.__creationIntent.mode;export const reserveGalleryDraft=async(db,input,deadline)=>{globalThis.__creationIntent.legacyReserve={input,deadline};return {id:input.galleryItemId,stage:"queued",version:1};};');
const runtimeSource=readFileSync('src/lib/shopify/creation-intent-runtime.ts','utf8');
const runtimeUrl=asUrl(runtimeSource.replace('import "server-only";','').replace('"./creation-intent"',JSON.stringify(intentUrl)).replace('"./creation-runtime"',JSON.stringify(modeUrl)));
const runtime=await import(runtimeUrl);
const responseUrl=asUrl('export const NextRequest=Request;export const NextResponse={json:(data,init)=>Response.json(data,init)};');
const authUrl=asUrl('export const requireAdminToken=request=>request.headers.get("x-admin-token")==="fixture-token"?null:Response.json({error:"Unauthorized"},{status:401});');
const dbUrl=asUrl('export const createSupabaseServiceRoleClient=()=>globalThis.__creationIntent.db;');
const envUrl=asUrl('export const hasSupabaseAdminEnv=()=>globalThis.__creationIntent.configured;');
const schedulerUrl=asUrl('export const MAX_CREATION_HOPS=8;export const scheduleGalleryDraftCreation=(...args)=>globalThis.__creationIntent.scheduled.push(args);');
function routeSource(file){return readFileSync(file,'utf8').replace('"next/server"',JSON.stringify(responseUrl)).replace('"zod"',JSON.stringify(import.meta.resolve('zod')))
 .replace('"@/lib/admin/admin-token"',JSON.stringify(authUrl)).replace('"@/lib/supabase/service-role"',JSON.stringify(dbUrl)).replace('"@/lib/supabase/env"',JSON.stringify(envUrl))
 .replace('"@/lib/shopify/creation-runtime"',JSON.stringify(modeUrl)).replace('"@/lib/shopify/creation-intent"',JSON.stringify(intentUrl))
 .replace('"@/lib/shopify/creation-intent-runtime"',JSON.stringify(runtimeUrl)).replace('"@/lib/shopify/schedule-creation"',JSON.stringify(schedulerUrl));}
const route=await import(asUrl(routeSource('src/app/api/admin/shopify/creation-intents/route.ts')));
const legacy=await import(asUrl(routeSource('src/app/api/admin/shopify/drafts/route.ts')
 .replace('"@/lib/shopify/creation-policy"',JSON.stringify(policyUrl))
 .replace('"@/lib/shopify/admin-api"',JSON.stringify(asUrl('export const isShopifySyncConfigured=()=>true;')))));
function input(complete=false){const v={galleryItemId:randomUUID(),shopifySku:null,manufacturerSku:null,identityMappingReceiptId:null,brand:null,category:null,
 copy:{title:null,description:null,descriptionHtml:null,seoTitle:null,seoDescription:null},media:[],
 commerce:{sellingPrice:null,currency:null,compareAtPrice:null,barcode:null,taxable:null,requiresShipping:null,inventory:{status:'unknown'},storeIntent:'undecided'},sourceReferences:[]};
 return complete?{...v,shopifySku:'NEW-'+randomUUID().slice(0,8),brand:"Bric's",copy:{...v.copy,title:'מזוודה אמיתית',description:'תיאור',descriptionHtml:'<p>תיאור</p>'},
 media:[{url:'https://cdn.shopify.com/s/files/1/exact.webp',alt:'צבע מדויק'}],commerce:{...v.commerce,currency:'ILS',requiresShipping:true,storeIntent:'draft'}}:v;}
function fixture(){
 const tables={shopify_gallery_creation_intents:[],shopify_gallery_creation_mappings:[],carousel_items:[],shopify_gallery_copy_eligibility:[],shopify_gallery_bindings:[],shopify_gallery_creation_drafts:[]};
 const calls=[];let saveError=null;
 function builder(table){const filters=[];let single=false,offset=0,end=Infinity;const query={
  select(columns){calls.push({select:table,columns});return query;},eq(k,v){filters.push([k,v]);return query;},order(){return query;},range(a,b){offset=a;end=b;return query;},limit(n){end=n-1;return query;},abortSignal(signal){assert.equal(signal.aborted,false);return query;},maybeSingle(){single=true;return query;},
  then(resolve,reject){return Promise.resolve().then(()=>{const rows=(tables[table]??[]).filter(row=>filters.every(([k,v])=>row[k]===v)).slice(offset,end+1);return {data:structuredClone(single?(rows[0]??null):rows),error:null};}).then(resolve,reject);}};return query;}
 const db={from:builder,rpc(name,args){calls.push({rpc:name,args:structuredClone(args)});const result=()=>{
  if(name==='save_gallery_creation_intent'){
   if(saveError)return {data:null,error:{message:saveError}};
   const r=args.p_record,prior=tables.shopify_gallery_creation_intents.find(row=>row.id===r.input.galleryItemId);
   if((prior?.record.revision??null)!==args.p_expected_revision)return {data:null,error:{message:'SYNC_CREATION_INTENT_STALE_EDIT'}};
   const row={id:r.input.galleryItemId,record:structuredClone(r),frozen_at:null};tables.shopify_gallery_creation_intents=tables.shopify_gallery_creation_intents.filter(item=>item.id!==row.id);tables.shopify_gallery_creation_intents.push(row);return {data:r,error:null};
  }
  if(name==='promote_gallery_creation_intent'){
   const row=tables.shopify_gallery_creation_intents.find(row=>row.id===args.p_id);
   if(row.record.revision!==args.p_expected_revision)return {data:null,error:{message:'SYNC_CREATION_INTENT_STALE_EDIT'}};
   row.frozen_at=new Date().toISOString();const existing=tables.shopify_gallery_creation_drafts.find(item=>item.id===args.p_id);
   if(!existing)tables.shopify_gallery_creation_drafts.push({id:args.p_id,stage:'reserved',last_error:null});
   return {data:{id:args.p_id,stage:existing?.stage??'reserved'},error:null};
  }throw new Error('unexpected '+name);
 };return {abortSignal(signal){assert.equal(signal.aborted,false);return Promise.resolve().then(result);}};}};
 globalThis.__creationIntent={mode:'draft_only',configured:true,db,scheduled:[]};
 return {db,tables,calls,setSaveError:value=>{saveError=value;}};
}
function request(method,data,token='fixture-token',query=''){const req=new Request('https://example.invalid/api/admin/shopify/creation-intents'+query,{method,headers:{'x-admin-token':token,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});req.nextUrl=new URL(req.url);return req;}

test('save incomplete private item returns exact server provenance and never reserves/queues a product',async()=>{
 const f=fixture(),v=input(),response=await route.PUT(request('PUT',{input:v,expectedRevision:null}));assert.equal(response.status,200);
 const body=await response.json();assert.equal(body.saved,true);assert.equal(body.creation,null);assert.equal(body.record.provenance.sellingPrice.verifiedManufacturerFact,false);
 assert.equal(f.tables.carousel_items.length,0);assert.deepEqual(f.calls.filter(x=>x.rpc).map(x=>x.rpc),['save_gallery_creation_intent']);assert.deepEqual(globalThis.__creationIntent.scheduled,[]);
});
test('completed save automatically reserves only the same inactive private draft and exact replay creates no second one',async()=>{
 const f=fixture(),v=input(true);let response=await route.PUT(request('PUT',{input:v,expectedRevision:null}));assert.equal(response.status,202);
 const body=await response.json();assert.equal(body.frozen,true);assert.equal(body.published,false);assert.equal(f.tables.shopify_gallery_creation_drafts.length,1);
 response=await route.PUT(request('PUT',{input:v,expectedRevision:null}));assert.equal(response.status,202);assert.equal(f.tables.shopify_gallery_creation_drafts.length,1);
 assert.equal(f.calls.filter(x=>x.rpc==='save_gallery_creation_intent').length,1);
 const changed=structuredClone(v);changed.copy.title='שינוי מאוחר';response=await route.PUT(request('PUT',{input:changed,expectedRevision:body.record.revision}));assert.equal(response.status,409);
 assert.equal((await response.json()).error,'SYNC_CREATION_INTENT_FROZEN');
});
test('stale record rejected by atomic save CAS and unknown client provenance rejected before database',async()=>{
 const f=fixture(),v=input();f.setSaveError('SYNC_CREATION_INTENT_STALE_EDIT');const response=await route.PUT(request('PUT',{input:v,expectedRevision:null}));assert.equal(response.status,409);assert.equal(f.tables.shopify_gallery_creation_intents.length,0);
 f.calls.length=0;const forged=await route.PUT(request('PUT',{input:{...v,verifiedManufacturer:true},expectedRevision:null}));assert.equal(forged.status,409);assert.equal(f.calls.length,0);
});
test('server-owned differing-SKU receipt missing holds saved draft; exact private receipt permits promotion',async()=>{
 const f=fixture(),v=input(true);v.manufacturerSku='150700-9199';v.identityMappingReceiptId=randomUUID();
 let response=await route.PUT(request('PUT',{input:v,expectedRevision:null}));assert.equal(response.status,200);let result=await response.json();
 assert.equal(result.saved,true);assert.match(result.creationError,/MAPPING_RECEIPT_MISMATCH/);assert.equal(f.tables.shopify_gallery_creation_drafts.length,0);
 f.tables.shopify_gallery_creation_mappings.push({id:v.identityMappingReceiptId,gallery_item_id:v.galleryItemId,exact_shopify_sku:v.shopifySku,exact_manufacturer_sku:v.manufacturerSku,
  source_url:'https://www.samsonite.co.uk/verified',evidence_sha256:'a'.repeat(64),verified_at:new Date().toISOString(),revoked:false});
 response=await route.POST(request('POST',{id:v.galleryItemId,expectedRevision:result.record.revision}));assert.equal(response.status,202);assert.equal(f.tables.shopify_gallery_creation_drafts.length,1);
});
test('legacy direct POST cannot forge manufacturer/store mapping without pending receipt',async()=>{
 const f=fixture(),v=input(true);const r=policy.saveCreationIntent(null,v,{actorId:randomUUID(),requestId:randomUUID(),at:new Date().toISOString(),expectedRevision:null},{complete:true,capturedAt:new Date().toISOString(),existing:[]});
 const draft=policy.draftFromCreationIntent(r,null,Date.now());draft.manufacturerSku='DIFFERENT';draft.identityMapping={shopifySku:draft.shopifySku,manufacturerSku:'DIFFERENT',sourceUrl:'https://example.invalid/fake',evidenceSha256:'a'.repeat(64),verifiedAt:new Date().toISOString()};
 const response=await legacy.POST(request('POST',{draft}));assert.equal(response.status,409);assert.equal((await response.json()).error,'SYNC_CREATION_USE_VERIFIED_INTENT');assert.equal(f.calls.length,0);
});
test('existing disabled alias/raw item blocks creation, no DB save occurs',async()=>{
 const f=fixture(),v=input(true);f.tables.shopify_gallery_copy_eligibility.push({carousel_item_id:randomUUID(),exact_gallery_sku:'GALLERY-OTHER',exact_shopify_sku:v.shopifySku,enabled:false});
 await assert.rejects(runtime.savePendingCreationIntent(f.db,v,null),/EXISTING_PRODUCT_USE_SYNC/);assert.equal(f.calls.filter(x=>x.rpc).length,0);
});
test('private status and exact frozen resume work without resending a creation source',async()=>{
 const f=fixture(),v=input(true);const saved=await runtime.savePendingCreationIntent(f.db,v,null);
 f.tables.shopify_gallery_creation_drafts[0].stage='uncertain';
 const response=await route.GET(request('GET',undefined,'fixture-token','?id='+v.galleryItemId));assert.equal(response.status,200);assert.equal((await response.json()).creation.stage,'uncertain');
 const resumed=await route.POST(request('POST',{id:v.galleryItemId,expectedRevision:saved.record.revision}));assert.equal(resumed.status,202);assert.equal((await resumed.json()).stage,'uncertain');
 assert.deepEqual(globalThis.__creationIntent.scheduled.map(args=>args[0]),[v.galleryItemId]);
});
test('all endpoints require admin token; default-off refuses writes and no public proof fields are accepted',async()=>{
 const f=fixture();for(const method of ['GET','PUT','POST']) assert.equal((await route[method](request(method,method==='GET'?undefined:{},'invalid'))).status,401);
 assert.equal(f.calls.length,0);globalThis.__creationIntent.mode=undefined;
 for(const method of ['PUT','POST']) assert.equal((await route[method](request(method,{}))).status,503);
 assert.equal(f.calls.length,0);globalThis.__creationIntent.mode='draft_only';
 const v=input();const missing=await route.PUT(request('PUT',{input:v}));assert.equal(missing.status,409);assert.equal(f.calls.length,0);
});
test('shared absolute budget rejects before private write; accepted requests pass one bounded continuation deadline',async()=>{
 const f=fixture();await assert.rejects(runtime.savePendingCreationIntent(f.db,input(),null,Date.now()-1),/TIME_BUDGET/);assert.equal(f.calls.filter(x=>x.rpc).length,0);
 const start=Date.now();await route.PUT(request('PUT',{input:input(true),expectedRevision:null}));const wake=globalThis.__creationIntent.scheduled[0];
 assert.equal(wake[1],0);assert.ok(wake[2]>=start+55000&&wake[2]<=Date.now()+55000);
});
test('legacy completed draft and continuation retain original request deadline',async()=>{
 fixture();const v=input(true),record=policy.saveCreationIntent(null,v,{actorId:randomUUID(),requestId:randomUUID(),at:new Date().toISOString(),expectedRevision:null},{complete:true,capturedAt:new Date().toISOString(),existing:[]});
 const draft=policy.draftFromCreationIntent(record,null,Date.now()),start=Date.now();
 const response=await legacy.POST(request('POST',{draft}));assert.equal(response.status,202);
 assert.ok(globalThis.__creationIntent.legacyReserve.deadline>=start+9000&&globalThis.__creationIntent.legacyReserve.deadline<=Date.now()+9000);
 const first=globalThis.__creationIntent.scheduled[0];assert.equal(first[1],0);assert.ok(first[2]>=start+55000&&first[2]<=Date.now()+55000);
 const nextStart=Date.now(),continued=await legacy.PATCH(request('PATCH',{id:v.galleryItemId,hop:2}));assert.equal(continued.status,202);
 const next=globalThis.__creationIntent.scheduled[1];assert.equal(next[1],2);assert.ok(next[2]>=nextStart+55000&&next[2]<=Date.now()+55000);
});
test('out-of-order UI load/save responses cannot overwrite current editor or clear its busy flag',async()=>{
 const gateModule=await import(asUrl(readFileSync('src/lib/shopify/creation-editor-requests.ts','utf8'))),gate=gateModule.createCreationEditorRequestGate();
 let a,b;const events=[];
 const first=gate.run(()=>new Promise(resolve=>{a=resolve;}),data=>events.push(data),error=>events.push(error),()=>events.push('A-settled'));
 const second=gate.run(()=>new Promise(resolve=>{b=resolve;}),data=>events.push(data),error=>events.push(error),()=>events.push('B-settled'));
 b('B-current');await second;a('A-late');await first;assert.deepEqual(events,['B-current','B-settled']);
 const ui=readFileSync('src/app/admin/shopify/new-product/page.tsx','utf8');assert.match(ui,/<select disabled=\{busy\}/);assert.match(ui,/request\(API, "POST", \{ id: record\.input\.galleryItemId, expectedRevision: record\.revision \}/);
 assert.match(ui,/busy \|\| frozen \|\| !enabled \? <p/);
});
