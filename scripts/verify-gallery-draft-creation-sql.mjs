/** Offline execution of the NEW-only creation reservation/lease/receipt contract. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { descriptionModuleUrl } from '../tests/helpers/description-module.mjs';
const [engine,manifestPath]=process.argv.slice(2);
if(!engine||!manifestPath) throw new Error('Usage: node scripts/verify-gallery-draft-creation-sql.mjs <PGlite package> <frozen78 manifest>');
const {PGlite}=await import(pathToFileURL(engine+'/dist/index.js').href);
const {pgcrypto}=await import(pathToFileURL(engine+'/dist/contrib/pgcrypto.js').href);
const bytes=await readFile(manifestPath),manifest=JSON.parse(bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'),'73dc8b7b0946266ab647c214126f9e23619f674188989e24fe0811a6200bae10');
const db=new PGlite({extensions:{pgcrypto}});
const migration=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
await db.exec('create role anon;create role authenticated;create role service_role;create schema extensions;create extension pgcrypto with schema extensions;');
for(const name of ['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql','20260527_carousel_tech_specs_cache.sql',
 '20260620_carousel_item_colors.sql','20260930_shopify_gallery_sync_inbox.sql','20260930_shopify_gallery_sync_patch.sql']) await db.exec(await migration(name));
for(const [index,row] of manifest.expectedGallery.entries()) {
 await db.query(`insert into carousel_items(id,catalog_number,title,description,description_html,seo_title,seo_description,copy_updated_at,
 cover_image_path,display_order,is_active,source_url,tech_specs) values($1,$2,$3,$4,$5,$6,$7,$8,'unchanged.webp',$9,true,'https://manufacturer.example/verified',$10)`,
 [row.id,row.catalog_number,row.copy.title,row.copy.description,row.copy.descriptionHtml,row.copy.seoTitle,row.copy.seoDescription,row.copy_updated_at,index+1,JSON.stringify({category:'carryon',verified:'manufacturer'})]);
 await db.query("insert into carousel_item_angles(item_id,angle_key,image_path,angle_order) values($1,'front','unchanged.webp',1)",[row.id]);
}
for(const row of manifest.rows.filter(row=>row.expectedBinding)) for(const [table,value] of [['shopify_gallery_bindings',row.expectedBinding],['shopify_gallery_sync_state',row.expectedState],['shopify_gallery_public_links',row.expectedPublicLink]])
 await db.query(`insert into ${table} select * from jsonb_populate_record(null::${table},$1)`,[JSON.stringify(value)]);
await db.exec(await migration('20260930_verified_catalog_copy_activation.sql'));
await db.query('select activate_shopify_verified_catalog($1::jsonb,true)',[JSON.stringify(manifest)]);
const protectedTables=['carousel_items','carousel_item_angles','carousel_settings','shopify_gallery_bindings','shopify_gallery_public_links','shopify_gallery_sync_state',
 'shopify_gallery_copy_eligibility','shopify_gallery_copy_activations','shopify_gallery_copy_activation_receipts','shopify_gallery_copy_activation_events','shopify_gallery_content_outbox'];
const snapshot=async(tables=protectedTables)=>{
 const out={};for(const table of tables) out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from ${table} t`)).rows[0].value;return out;
};
const frozen=await snapshot(),sql=await migration('20260930_gallery_shopify_draft_creation.sql');
await db.exec(sql);await db.exec(sql);assert.deepEqual(await snapshot(),frozen);
const allTables=[...protectedTables,'shopify_gallery_creation_drafts','shopify_gallery_creation_events','shopify_gallery_reconciliation_leases'];
let checks=1,serial=0;
const owner=randomUUID(),other=randomUUID(),stamp=()=>new Date().toISOString();
const norm=sku=>sku.toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^(P[0-9]{2}.*)TU$/,'$1');
const commercial={price:'0.00',compareAtPrice:null,barcode:null,taxable:true,requiresShipping:true};
const commercialHash=c=>createHash('sha256').update(JSON.stringify({...c,price:Number(c.price).toFixed(2),compareAtPrice:c.compareAtPrice===null?null:Number(c.compareAtPrice).toFixed(2)})).digest('hex');
function source(){const n=++serial;return {galleryItemId:randomUUID(),copyUpdatedAt:stamp(),shopifySku:`NEW-DRAFT-${n}`,manufacturerSku:null,identityMapping:null,brand:"Bric's",category:'suitcase',
 copy:{title:'מזוודה חדשה אמיתית',description:'תיאור מדויק',descriptionHtml:'<p>תיאור מדויק</p>',seoTitle:null,seoDescription:'תיאור חיפוש'},
 media:[1,2].map(i=>({url:`https://cdn.shopify.com/s/files/1/0001/draft-${n}-${i}.png`,alt:`תמונה ${i}`})),
 commerce:{sellingPrice:null,currency:'ILS',compareAtPrice:null,barcode:null,taxable:null,requiresShipping:true,inventory:{status:'unknown'},storeIntent:'draft'}};}
function ready(s){return {policyVersion:'gallery-shopify-draft-v1',draft:s,catalogKey:norm(s.shopifySku),sourceFingerprint:'a'.repeat(64),
 customId:{namespace:'app--123--toptik_gallery',key:'source_item_id',value:`toptikcoil.myshopify.com:gallery:${s.galleryItemId}`},
 imageEvidence:s.media.map((m,i)=>({url:m.url,galleryItemId:s.galleryItemId,exactSku:s.shopifySku,sha256:String(i+1).repeat(64),mime:'image/png',width:800,height:900,byteLength:12345,verifiedAt:stamp()})),
 readyForPublication:false,outstanding:[...(s.commerce.sellingPrice===null?['selling_price']:[]),...(s.commerce.taxable===null?['tax_policy']:[]),'inventory','publication_not_supported_v1']};}
function receipt(s,p){return {policyVersion:'gallery-shopify-draft-v1',galleryItemId:s.galleryItemId,sourceFingerprint:p.sourceFingerprint,customId:p.customId,
 stage:'reserved',productGid:null,variantGid:null,shopifyUpdatedAt:null,commercialFingerprint:null,initialCommercial:null};}
const reserve=s=>db.query('select reserve_gallery_shopify_draft($1::jsonb) result',[JSON.stringify(s)]).then(r=>r.rows[0].result);
const claim=(id,o=owner,seconds=60)=>db.query('select claim_gallery_shopify_draft($1,$2,$3) result',[id,o,seconds]).then(r=>r.rows[0].result);
const release=(id,o=owner)=>db.query('select release_gallery_shopify_draft($1,$2) result',[id,o]).then(r=>r.rows[0].result);
const recordFailure=(id,o,code)=>db.query('select record_gallery_shopify_draft_error($1,$2,$3) result',[id,o,code]).then(r=>r.rows[0].result);
const advance=(r,patch,o=owner)=>db.query('select advance_gallery_shopify_draft($1,$2,$3,$4,$5::jsonb) result',[r.id,o,r.version,r.stage,JSON.stringify(patch)]).then(r=>r.rows[0].result);
async function reject(fn,pattern=/SYNC_CREATION_/){await db.exec('reset role');const before=await snapshot(allTables);await db.exec('set role service_role');await assert.rejects(fn,pattern);await db.exec('reset role');assert.deepEqual(await snapshot(allTables),before);checks++;}
async function transactionReject(command,params,fn,pattern=/SYNC_CREATION_/){await db.exec('reset role;begin');await db.query(command,params);await db.exec('set role service_role');await assert.rejects(fn,pattern);await db.exec('rollback');checks++;}
const s=source();
for(const role of ['anon','authenticated']){
 await db.exec(`set role ${role}`);await assert.rejects(reserve(s),/permission denied/);
 for(const table of ['shopify_gallery_creation_drafts','shopify_gallery_creation_events']) await assert.rejects(db.query('select * from '+table),/permission denied/);
 await db.exec('reset role');checks+=3;
}
for(const mutate of [
 x=>{x.price=5;},x=>{x.brand='Other';},x=>{x.brand=null;},x=>{x.commerce.inventory={status:'known',quantity:0};},x=>{x.commerce.storeIntent='active';},
 x=>{x.commerce.requiresShipping=false;},x=>{x.commerce.sellingPrice='0';},x=>{x.commerce.sellingPrice='10';x.commerce.compareAtPrice='9';},
 x=>{x.copy.title='מוצר חדש';},x=>{x.media=[];},x=>{x.media[0].url='https://evil.example/x';},x=>{x.media[0].url='https://cdn.shopify.com/s/files/%2e%2e/x';},
 x=>{x.media[1]=x.media[0];},x=>{x.media=Array.from({length:11},(_,i)=>({url:`https://cdn.shopify.com/s/files/${i}.png`,alt:'valid'}));},
 x=>{x.shopifySku='P10OSV04-05J-TU';},x=>{x.manufacturerSku='OTHER';},x=>{x.shopifySku=manifest.expectedGallery[0].catalog_number;},x=>{x.galleryItemId=manifest.expectedGallery[0].id;},
 ]){const bad=structuredClone(s);mutate(bad);await reject(()=>reserve(bad));}
await db.exec("create function unexpected_creation_outbox() returns trigger language plpgsql as $$ begin insert into public.shopify_gallery_content_outbox(carousel_item_id,catalog_key,content_hash,payload) select id,catalog_key,'unexpected','{}' from public.shopify_gallery_creation_drafts where id=new.draft_id;return new;end $$;create trigger unexpected_creation_outbox after insert on shopify_gallery_creation_events for each row execute function unexpected_creation_outbox();");
await reject(()=>reserve(s),/UNEXPECTED_OUTBOX/);
await db.exec('drop trigger unexpected_creation_outbox on shopify_gallery_creation_events');
await db.exec('set role service_role');let r=await reserve(s);assert.equal(r.version,1);assert.equal(r.stage,'reserved');checks++;
const repeat=await reserve(s);assert.equal(repeat.replayed,true);assert.equal(repeat.version,1);checks++;
await db.exec('reset role');
const inserted=(await db.query('select * from carousel_items where id=$1',[s.galleryItemId])).rows[0];
assert.equal(inserted.is_active,false);assert.equal(inserted.description_html,s.copy.descriptionHtml);assert.equal(inserted.catalog_number,s.shopifySku);
assert.equal(inserted.tech_specs.category,s.category);assert.ok(!JSON.stringify(inserted).includes('sellingPrice'));checks++;
assert.deepEqual((await db.query('select image_path,angle_order from carousel_item_angles where item_id=$1 order by angle_order',[s.galleryItemId])).rows,
 s.media.map((m,i)=>({image_path:m.url,angle_order:i+1})));checks++;
await reject(()=>reserve({...s,copy:{...s.copy,title:'changed'}}),/RESERVATION_CONFLICT/);
await reject(()=>reserve({...source(),shopifySku:s.shopifySku.toLowerCase().replaceAll('-','.')}),/COLLISION/);
await db.exec('set role service_role');
await assert.rejects(db.query("update shopify_gallery_creation_drafts set stage='draft_ready'"),/permission denied/);checks++;
await assert.rejects(db.query('delete from shopify_gallery_creation_events'),/permission denied/);checks++;
await assert.rejects(db.query('select creation_record($1)',[s.galleryItemId]),/permission denied/);checks++;
r=await claim(s.galleryItemId);assert.equal(r.id,s.galleryItemId);assert.equal(await claim(s.galleryItemId,other),null);assert.equal(await release(s.galleryItemId,other),false);checks+=3;
assert.equal(await recordFailure(s.galleryItemId,other,'SYNC_CREATION_MEDIA_PENDING'),false);checks++;
assert.equal(await recordFailure(s.galleryItemId,owner,'SYNC_CREATION_MEDIA_PENDING'),true);checks++;
assert.equal((await claim(s.galleryItemId)).lastError,'SYNC_CREATION_MEDIA_PENDING');checks++;
assert.equal((await claim(s.galleryItemId)).version,r.version);checks++;
await reject(()=>recordFailure(s.galleryItemId,owner,'private token raw diagnostic'),/ERROR_CODE_INVALID/);
await reject(()=>claim(s.galleryItemId,other,99999),/LEASE_INVALID/);
const p=ready(s),rec=receipt(s,p),prep={readyProof:p,receipt:rec};
await reject(()=>advance(r,prep,other),/LEASE_LOST/);
for(const mutate of [x=>{x.readyProof.draft.copy.title='changed';},x=>{x.readyProof.sourceFingerprint=null;},x=>{x.readyProof.customId.namespace='unowned';},
 x=>{x.readyProof.readyForPublication=true;},x=>{x.readyProof.outstanding=[];},x=>{x.readyProof.imageEvidence[0].sha256=null;},
 x=>{x.readyProof.imageEvidence[0].width=20000;},x=>{x.readyProof.imageEvidence[0].verifiedAt='2000-01-01T00:00:00Z';}]){
 const bad=structuredClone(prep);mutate(bad);await reject(()=>advance(r,bad));
}
await db.exec('set role service_role');const unprepared=r;r=await advance(r,prep);assert.equal(r.version,2);checks++;
assert.equal(r.lastError,null);checks++;
assert.equal((await advance(unprepared,prep)).replayed,true);checks++;
await reject(()=>advance(unprepared,{...prep,receipt:{...rec,stage:'review'}}),/REQUEST_REUSED/);
await reject(()=>advance(r,{receipt:{...rec,stage:'draft_ready'}}),/STAGE_TRANSITION/);
for(const [command,params] of [
 ['update carousel_items set title=$2 where id=$1',[s.galleryItemId,'changed']],
 ['update carousel_items set description_html=$2 where id=$1',[s.galleryItemId,'<p>changed</p>']],
 ['update carousel_items set seo_title=$2 where id=$1',[s.galleryItemId,'changed']],
 ['update carousel_items set catalog_number=$2 where id=$1',[s.galleryItemId,'OTHER']],
 ['update carousel_items set is_active=true where id=$1',[s.galleryItemId]],
 ["update carousel_items set tech_specs='{}' where id=$1",[s.galleryItemId]],
 ['update carousel_item_angles set angle_order=9 where item_id=$1',[s.galleryItemId]],
 ['update carousel_item_angles set image_path=$2 where item_id=$1',[s.galleryItemId,'changed.webp']],
 ])await transactionReject(command,params,()=>advance(r,{receipt:{...rec,stage:'create_started'}}),/SOURCE_CHANGED/);
await transactionReject("update shopify_gallery_creation_drafts set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[s.galleryItemId],()=>advance(r,{receipt:{...rec,stage:'create_started'}}),/LEASE_LOST/);
await reject(()=>advance(r,{receipt:{...rec,stage:'create_started'}}),/READY_PROOF/);
await reject(()=>advance(r,{receipt:{...rec,stage:'create_started'},freshReadyProof:{...p,imageEvidence:p.imageEvidence.map(im=>({...im,sha256:'9'.repeat(64)}))}}),/READY_PROOF_CHANGED/);
await db.exec('set role service_role');const prepared=r;const freshP={...p,imageEvidence:p.imageEvidence.map(im=>({...im,verifiedAt:stamp()}))};
// Model elapsed time without waiting: only persisted image verification times age.
await db.exec('reset role;begin;alter table shopify_gallery_creation_drafts disable trigger creation_draft_immutable');
await db.query('update shopify_gallery_creation_drafts set ready_proof=$2 where id=$1',[s.galleryItemId,JSON.stringify({...p,imageEvidence:p.imageEvidence.map(im=>({...im,verifiedAt:'2000-01-01T00:00:00Z'}))})]);
await db.exec('alter table shopify_gallery_creation_drafts enable trigger creation_draft_immutable;set role service_role');
assert.equal((await advance(r,{receipt:{...rec,stage:'create_started'},freshReadyProof:freshP})).stage,'create_started');checks++;
await db.exec('rollback;set role service_role');
const startPatch={receipt:{...rec,stage:'create_started'},freshReadyProof:freshP};r=await advance(r,startPatch);assert.equal(r.stage,'create_started');checks++;
assert.equal((await advance(prepared,startPatch)).replayed,true);checks++;
const product='gid://shopify/Product/990000001',variant='gid://shopify/ProductVariant/990000002';
const found={...r.receipt,stage:'draft_found',productGid:product,variantGid:variant,shopifyUpdatedAt:stamp(),initialCommercial:commercial,commercialFingerprint:commercialHash(commercial)};
await reject(()=>advance(r,{receipt:{...found,commercialFingerprint:'b'.repeat(64)}}),/INITIAL_COMMERCE/);
await transactionReject('insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval \'5 minutes\')',[product,other],()=>advance(r,{receipt:found}),/PRODUCT_BUSY/);
await reject(()=>advance(r,{receipt:{...found,productGid:manifest.rows[0].eligibility.product_gid,variantGid:manifest.rows[0].eligibility.variant_gid}}),/PRODUCT_COLLISION/);
await db.exec('set role service_role');r=await advance(r,{receipt:found});assert.equal(r.stage,'draft_found');checks++;
await db.exec('reset role');assert.equal((await db.query('select owner from shopify_gallery_reconciliation_leases where product_gid=$1',[product])).rows[0].owner,owner);checks++;
await reject(()=>advance(r,{receipt:{...found,stage:'variant_started',initialCommercial:{...commercial,price:'5.00'},commercialFingerprint:commercialHash({...commercial,price:'5.00'})},freshReadyProof:freshP}),/INITIAL_COMMERCE/);
await transactionReject('update shopify_gallery_reconciliation_leases set owner=$2 where product_gid=$1',[product,other],()=>advance(r,{receipt:{...found,stage:'variant_started'}}),/LEASE_LOST/);
await db.exec('set role service_role');r=await advance(r,{receipt:{...found,stage:'variant_started'},freshReadyProof:freshP});assert.equal(r.stage,'variant_started');checks++;
// A lost configure response may be verified later, but is never resent.
r=await advance(r,{receipt:{...r.receipt,stage:'uncertain'}});assert.equal(r.stage,'uncertain');checks++;
await reject(()=>advance(r,{receipt:{...r.receipt,stage:'variant_started'},freshReadyProof:freshP}),/STAGE_TRANSITION/);
const doneAt=stamp(),done={...r.receipt,stage:'draft_ready',shopifyUpdatedAt:doneAt};
const proof={snapshot:{productGid:product,variantGid:variant,variantCount:1,sku:s.shopifySku,status:'DRAFT',publishedAnywhere:false,customId:p.customId,
 sourceFingerprint:p.sourceFingerprint,updatedAt:doneAt,copy:{title:s.copy.title,descriptionHtml:s.copy.descriptionHtml,seoTitle:s.copy.seoTitle,seoDescription:s.copy.seoDescription},brand:s.brand,commercial},
 media:p.imageEvidence.map((im,i)=>({productGid:product,mediaGid:`gid://shopify/MediaImage/${99000000+i}`,status:'READY',url:im.url,alt:s.media[i].alt,
 sha256:im.sha256,mime:im.mime,width:im.width,height:im.height,byteLength:im.byteLength,verifiedAt:stamp()})),verifiedAt:stamp()};
await reject(()=>advance(r,{receipt:done}),/READBACK_REQUIRED/);
for(const mutate of [x=>{x.snapshot.status='ACTIVE';},x=>{x.snapshot.publishedAnywhere=true;},x=>{x.snapshot.sku='changed';},
 x=>{x.snapshot.commercial.price='5.00';},x=>{x.snapshot.commercial.taxable=false;},x=>{x.snapshot.commercial.barcode='NEW';},
 x=>{x.snapshot.copy.title='changed';},x=>{x.media[0].sha256='9'.repeat(64);},x=>{x.media.reverse();},x=>{x.media[0].status='PROCESSING';}]){
 const bad=structuredClone(proof);mutate(bad);await reject(()=>advance(r,{receipt:done,readbackProof:bad}));
}
await db.exec('reset role');await db.exec("create function fail_creation_receipt() returns trigger language plpgsql as $$ begin raise exception 'FORCED_RECEIPT_FAILURE';end $$;create trigger forced_receipt_failure before insert on shopify_gallery_creation_events for each row execute function fail_creation_receipt();");
await reject(()=>advance(r,{receipt:done,readbackProof:proof}),/FORCED_RECEIPT_FAILURE/);
await db.exec('drop trigger forced_receipt_failure on shopify_gallery_creation_events;set role service_role');
await db.exec('reset role;create trigger unexpected_creation_outbox after insert on shopify_gallery_creation_events for each row execute function unexpected_creation_outbox()');
await reject(()=>advance(r,{receipt:done,readbackProof:proof}),/UNEXPECTED_OUTBOX/);
await db.exec('drop trigger unexpected_creation_outbox on shopify_gallery_creation_events;set role service_role');
const beforeReady=r,finalPatch={receipt:done,readbackProof:proof};r=await advance(r,finalPatch);assert.equal(r.stage,'draft_ready');assert.equal((await advance(beforeReady,finalPatch)).replayed,true);checks+=2;
assert.equal(await release(s.galleryItemId),true);checks++;
await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from shopify_gallery_reconciliation_leases where product_gid=$1',[product])).rows[0].n,0);checks++;
await assert.rejects(db.query("update shopify_gallery_creation_events set result='{}'"),/IMMUTABLE/);checks++;
await assert.rejects(db.query("update shopify_gallery_creation_drafts set source='{}'"),/IMMUTABLE/);checks++;
// A committed create with a lost response never authorizes a new create/configure.
const u=source(),up=ready(u),ur=receipt(u,up);await db.exec('set role service_role');let uncertain=await reserve(u);await claim(u.galleryItemId);
uncertain=await advance(uncertain,{readyProof:up,receipt:ur});uncertain=await advance(uncertain,{receipt:{...ur,stage:'create_started'},freshReadyProof:up});
uncertain=await advance(uncertain,{receipt:{...uncertain.receipt,stage:'uncertain'}});await release(u.galleryItemId);
uncertain=await claim(u.galleryItemId,other);assert.equal(uncertain.stage,'uncertain');checks++;
await reject(()=>advance(uncertain,{receipt:{...uncertain.receipt,stage:'create_started'}},other),/STAGE_TRANSITION/);
await reject(()=>advance(uncertain,{receipt:{...found,galleryItemId:u.galleryItemId,sourceFingerprint:up.sourceFingerprint,customId:up.customId}},other),/STAGE_TRANSITION/);
await db.exec('set role service_role');uncertain=await advance(uncertain,{receipt:{...uncertain.receipt,stage:'review'}},other);assert.equal(uncertain.stage,'review');await release(u.galleryItemId,other);checks++;
// Explicit commerce is applied only to this new draft; unknown fields remain private/untouched.
const explicit=source();explicit.commerce={...explicit.commerce,sellingPrice:'149.9',compareAtPrice:'199',taxable:false,barcode:'NEW-123'};
const ep=ready(explicit),er=receipt(explicit,ep);let ex=await reserve(explicit);await claim(explicit.galleryItemId);
ex=await advance(ex,{readyProof:ep,receipt:er});ex=await advance(ex,{receipt:{...er,stage:'create_started'},freshReadyProof:ep});
const exFound={...ex.receipt,stage:'draft_found',productGid:'gid://shopify/Product/990000009',variantGid:'gid://shopify/ProductVariant/990000010',shopifyUpdatedAt:stamp(),initialCommercial:commercial,commercialFingerprint:commercialHash(commercial)};
ex=await advance(ex,{receipt:exFound});ex=await advance(ex,{receipt:{...exFound,stage:'variant_started'},freshReadyProof:ep});
const exAt=stamp(),exProof={snapshot:{...proof.snapshot,productGid:exFound.productGid,variantGid:exFound.variantGid,sku:explicit.shopifySku,
 customId:ep.customId,updatedAt:exAt,commercial:{price:'149.90',compareAtPrice:'199.00',barcode:'NEW-123',taxable:false,requiresShipping:true}},
 media:ep.imageEvidence.map((im,i)=>({...proof.media[i],productGid:exFound.productGid,mediaGid:`gid://shopify/MediaImage/${99000010+i}`,url:im.url,verifiedAt:stamp()})),verifiedAt:stamp()};
ex=await advance(ex,{receipt:{...ex.receipt,stage:'draft_ready',shopifyUpdatedAt:exAt},readbackProof:exProof});assert.equal(ex.stage,'draft_ready');checks++;
await release(explicit.galleryItemId);
// Execute the real TS policy + worker over the actual RPCs; only Shopify is fake.
const asUrl=src=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(src)).toString('base64')}`;
const vendorUrl=asUrl(await readFile(new URL('../src/lib/catalog-source/vendor-detect.ts',import.meta.url),'utf8'));
const rulesUrl=asUrl((await readFile(new URL('../src/lib/shopify/sync-rules.ts',import.meta.url),'utf8')).replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendorUrl)));
const policyUrl=asUrl((await readFile(new URL('../src/lib/shopify/creation-policy.ts',import.meta.url),'utf8'))
 .replace('"zod"',JSON.stringify(import.meta.resolve('zod'))).replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rulesUrl)));
const policy=await import(policyUrl),{runGalleryDraftCreation:run}=await import(asUrl((await readFile(new URL('../src/lib/shopify/creation-worker.ts',import.meta.url),'utf8')).replace('"./creation-policy"',JSON.stringify(policyUrl))));
const integrated=source();integrated.commerce.sellingPrice='749.9';integrated.commerce.taxable=false;await reserve(integrated);
let remote=null,lostConfigure=true;const sent={create:0,configure:0};
const images=()=>integrated.media.map((im,i)=>({url:im.url,galleryItemId:integrated.galleryItemId,exactSku:integrated.shopifySku,
 sha256:String(i+4).repeat(64),mime:'image/png',width:800,height:900,byteLength:12345,verifiedAt:stamp()}));
const ports={mode:'draft_only',now:()=>Date.now(),beforeWrite:()=>{},claim,release,advance,recordFailure,
 prepare:async(s,recovery)=>policy.readyGalleryCreationDraft(s,{mode:'draft_only',now:Date.now(),shopDomain:policy.CREATION_SHOP,shopCurrency:'ILS',expectedAppNamespace:'app--123--toptik_gallery',
  definition:{namespace:'app--123--toptik_gallery',key:'source_item_id',ownerType:'PRODUCT',type:'id',uniqueValuesEnabled:true},
  catalog:{complete:true,capturedAt:stamp(),gallery:[...manifest.expectedGallery.map(g=>({id:g.id,catalogNumber:g.catalog_number,isActive:true})),{id:s.galleryItemId,catalogNumber:s.shopifySku,isActive:false}],
   shopify:remote?[{productGid:remote.productGid,variantGid:remote.variantGid,sku:remote.sku,status:remote.status}]:[]},images:images(),...(recovery?{recovery}:{})}),
 lookup:async()=>structuredClone(remote),
 create:async proof=>{sent.create++;remote={productGid:'gid://shopify/Product/990000099',variantGid:'gid://shopify/ProductVariant/990000098',variantCount:1,sku:'',status:'DRAFT',publishedAnywhere:false,
  customId:proof.customId,sourceFingerprint:proof.sourceFingerprint,updatedAt:stamp(),copy:{title:integrated.copy.title,descriptionHtml:integrated.copy.descriptionHtml,seoTitle:integrated.copy.seoTitle,seoDescription:integrated.copy.seoDescription},
  brand:integrated.brand,commercial:structuredClone(commercial)};return structuredClone(remote);},
 configure:async input=>{sent.configure++;const v=input.variants[0];remote.sku=v.inventoryItem.sku;
  for(const key of ['price','compareAtPrice','barcode','taxable'])if(key in v)remote.commercial[key]=v[key];remote.updatedAt=stamp();
  if(lostConfigure){lostConfigure=false;throw new Error('SYNC_CREATION_RESPONSE_LOST');}},
 media:async()=>images().map((im,i)=>({productGid:remote.productGid,mediaGid:`gid://shopify/MediaImage/${99000098+i}`,status:'READY',url:im.url,alt:integrated.media[i].alt,
  sha256:im.sha256,mime:im.mime,width:im.width,height:im.height,byteLength:im.byteLength,verifiedAt:im.verifiedAt}))};
// Worker port order is (record,owner,patch), while the local convenience helper is (record,patch,owner).
ports.advance=(record,lease,patch)=>advance(record,patch,lease);
const firstRun=await run(integrated.galleryItemId,owner,ports);assert.equal(firstRun.stage,'uncertain',JSON.stringify(firstRun));checks++;
const resumed=await run(integrated.galleryItemId,other,ports);assert.equal(resumed.stage,'draft_ready',JSON.stringify(resumed));checks++;
assert.deepEqual(sent,{create:1,configure:1});assert.equal(remote.commercial.price,'749.90');assert.equal(remote.status,'DRAFT');checks+=3;
assert.equal((await run(integrated.galleryItemId,owner,ports)).stage,'draft_ready');assert.deepEqual(sent,{create:1,configure:1});checks+=2;
await db.exec('reset role');
const after=await snapshot();
for(const table of protectedTables){
 const newIds=[s.galleryItemId,u.galleryItemId,explicit.galleryItemId,integrated.galleryItemId];
 const rows=table==='carousel_items'?after[table].filter(row=>!newIds.includes(row.id)):
 table==='carousel_item_angles'?after[table].filter(row=>!newIds.includes(row.item_id)):after[table];
 assert.deepEqual(rows,frozen[table],table+' frozen rows must remain unchanged');checks++;
}
assert.equal(after.carousel_items.length,86);assert.equal(after.shopify_gallery_copy_eligibility.length,78);assert.equal(after.shopify_gallery_content_outbox.length,0);checks+=3;
await db.close();console.log(JSON.stringify({ok:true,assertions:checks,realWorkerLostConfigureRecovery:true,frozenGallery:82,frozenCopyApprovals:78,newInactiveDrafts:4,newBindings:0,outbox:0}));
