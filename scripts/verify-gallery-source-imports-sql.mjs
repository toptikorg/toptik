import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {descriptionModuleUrl} from '../tests/helpers/description-module.mjs';

/** Runs inside the real migration/frozen82+78 PGlite harness. No external calls. */
export async function verifySourceImports(db,manifest) {
 const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
 const asUrl=s=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString('base64')}`;
 const vendor=asUrl(await read('src/lib/catalog-source/vendor-detect.ts'));
 const rules=asUrl((await read('src/lib/shopify/sync-rules.ts')).replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendor)));
 const imports=s=>s.replace('"zod"',JSON.stringify(import.meta.resolve('zod'))).replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rules));
 const policy=asUrl(imports(await read('src/lib/shopify/creation-policy.ts')));
 const p=await import(asUrl(imports(await read('src/lib/shopify/creation-intent.ts')).replace('"./creation-policy"',JSON.stringify(policy))));
 const importedSource=await read('src/lib/shopify/creation-import.ts');
 const pure=importedSource.slice(importedSource.indexOf('export function importedCreationInput'),importedSource.indexOf('/** Exact existing'));
 const {importedCreationInput}=await import(asUrl(`import {plainDescriptionToHtml,descriptionTextFromHtml} from ${JSON.stringify(descriptionModuleUrl)};\n${pure}`));
 const protectedTables=['carousel_items','carousel_item_angles','carousel_settings','shopify_gallery_bindings','shopify_gallery_sync_state',
  'shopify_gallery_public_links','shopify_gallery_copy_eligibility','shopify_gallery_content_outbox','shopify_gallery_creation_drafts','shopify_gallery_creation_events','shopify_gallery_creation_mappings'];
 const snapshot=async tables=>{const v={};for(const t of tables)v[t]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) v from ${t} t`)).rows[0].v;return v;};
 await db.exec('reset role');const frozen=await snapshot(protectedTables);
 const priorIntents=await snapshot(['shopify_gallery_creation_intents','shopify_gallery_creation_intent_events']);
 const sql=await read('supabase/migrations/20260930_gallery_shopify_source_imports.sql');await db.exec(sql);await db.exec(sql);
 let checks=0;const ok=(a,b)=>{assert.deepEqual(a,b);checks++;};
 ok(await snapshot(protectedTables),frozen);
 const privateTables=['shopify_gallery_creation_intents','shopify_gallery_creation_intent_events','shopify_gallery_creation_imports'];
 const actor=randomUUID(),stamp=()=>new Date().toISOString();
 const record=(item,vendor='brics',previous=null)=>p.saveCreationIntent(previous,importedCreationInput(item,vendor),
  {actorId:actor,requestId:randomUUID(),at:stamp(),expectedRevision:previous?.revision??null},{complete:true,capturedAt:stamp(),existing:[]});
 const edit=(prev,patch)=>p.saveCreationIntent(prev,{...prev.input,...patch},{actorId:actor,requestId:randomUUID(),at:stamp(),expectedRevision:prev.revision},
  {complete:true,capturedAt:stamp(),existing:[]});
 const source=(sku='IMPORT-'+randomUUID().slice(0,8))=>{const id=randomUUID();return {id,catalogNumber:sku,title:'מוצר יצרן חדש',description:'תיאור מקורי\n\nשורה נוספת',
  descriptionHtml:null,seoTitle:null,seoDescription:'',sourceUrl:'https://www.brics.it/example',coverImagePath:'https://cdn.shopify.com/s/files/1/front.webp',displayOrder:0,isActive:true,
  color:'כחול',dimensions:'55 x 40 x 20',weight:'2.4 kg',sizes:['cabin'],availableColors:['blue'],
  angles:[{id:randomUUID(),itemId:id,angleKey:'front',imagePath:'https://cdn.shopify.com/s/files/1/front.webp',angleOrder:1},
   {id:randomUUID(),itemId:id,angleKey:'back',imagePath:'https://cdn.shopify.com/s/files/1/back.webp',angleOrder:2}],
  techSpecs:{category:'carryon',specs:[{heading:'יצרן',items:[{label:'חומר',value:'PC'}]}],colors:[]},
  colors:[{name:'כחול',hex:'#0000ff',colorCode:'123',imagePath:'https://cdn.shopify.com/s/files/1/front.webp',sourceUrl:'https://www.brics.it/example',catalogNumber:sku}],
  supplierPrice:'999.00',unverifiedAdditionalMetadata:{retained:true}};};
 const newIds=item=>{const x=structuredClone(item);x.id=randomUUID();x.angles=x.angles.map(a=>({...a,id:randomUUID(),itemId:x.id}));return x;};
 const stage=(item,vendor='brics',r=record(item,vendor),sku=item.catalogNumber)=>db.query('select stage_gallery_creation_import($1::jsonb,$2,$3,$4::jsonb) v',
  [JSON.stringify(r),vendor,sku,JSON.stringify(item)]).then(r=>r.rows[0].v);
 const save=r=>db.query('select save_gallery_creation_intent($1::jsonb,$2) v',[JSON.stringify(r),r.parentRevision]).then(r=>r.rows[0].v);
 async function rejects(fn,re=/SYNC_CREATION_/){await db.exec('reset role');const a=await snapshot(protectedTables),b=await snapshot(privateTables);
  await db.exec('set role service_role');await assert.rejects(fn,re);await db.exec('reset role');ok(await snapshot(protectedTables),a);ok(await snapshot(privateTables),b);}
 const s=source(),r=record(s);
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(stage(s,'brics',r),/permission denied/);
  await assert.rejects(db.query('select * from shopify_gallery_creation_imports'),/permission denied/);checks+=2;}
 await db.exec('reset role');
 ok((await db.query("select relrowsecurity from pg_class where oid='shopify_gallery_creation_imports'::regclass")).rows[0].relrowsecurity,true);
 await db.exec('set role service_role');const first=await stage(s,'brics',r);ok(first,{record:r,sourceChanged:false,replayed:false});
 ok((await db.query('select raw_source,original_record from shopify_gallery_creation_imports where intent_id=$1',[s.id])).rows[0],{raw_source:s,original_record:r});
 await assert.rejects(db.query('delete from shopify_gallery_creation_imports'),/permission denied/);checks++;
 await assert.rejects(db.query("update shopify_gallery_creation_imports set source_hash=repeat('a',64)"),/permission denied/);checks++;
 await assert.rejects(db.query('select creation_import_source_hash($1::jsonb)',[JSON.stringify(s)]),/permission denied/);checks++;
 await assert.rejects(db.query('insert into shopify_gallery_creation_imports select * from shopify_gallery_creation_imports'),/permission denied/);checks++;
 ok(await stage(newIds(s)),{record:r,sourceChanged:false,replayed:true});
 const changed=newIds(s);changed.techSpecs.specs[0].items[0].value='Changed claim';
 ok(await stage(changed),{record:r,sourceChanged:true,replayed:true});
 const reordered=newIds(s);reordered.angles.reverse();ok((await stage(reordered)).sourceChanged,true);
 const merchant=edit(r,{shopifySku:'STORE-'+randomUUID().slice(0,8),copy:{...r.input.copy,title:'Merchant edited'},commerce:{...r.input.commerce,sellingPrice:'149.00',currency:'ILS',storeIntent:'draft'}});
 ok(await save(merchant),merchant);ok(await stage(newIds(s)),{record:merchant,sourceChanged:false,replayed:true});
 await db.exec('reset role');const receipt=(await db.query('select * from shopify_gallery_creation_imports where intent_id=$1',[s.id])).rows[0];
 ok(receipt.raw_source,s);ok(receipt.original_record,r);
 await assert.rejects(db.query("update shopify_gallery_creation_imports set source_hash=repeat('a',64)"),/IMMUTABLE/);checks++;
 await db.query('update shopify_gallery_creation_intents set frozen_at=now() where id=$1',[s.id]);
 await db.exec('set role service_role');ok(await stage(newIds(s)),{record:merchant,sourceChanged:false,replayed:true});
 // Two independent unknown store identities must both save (SQL NULL, never unique empty string).
 const a=source(),b=source();await stage(a);await stage(b);checks+=2;
 ok((await db.query('select catalog_key from shopify_gallery_creation_intents where id=any($1::uuid[]) order by id',[[a.id,b.id]])).rows,[{catalog_key:null},{catalog_key:null}]);
 const parallel=source();const paired=await Promise.all([stage(parallel),stage(newIds(parallel))]);
 ok(paired[0].record,paired[1].record);ok(paired.map(x=>x.replayed),[false,true]);
 const large=source();large.angles=Array.from({length:30},(_,n)=>({id:randomUUID(),itemId:large.id,angleKey:'view'+n,
  imagePath:`https://cdn.shopify.com/s/files/1/large-${n}.webp`,angleOrder:n+1}));large.coverImagePath=large.angles[0].imagePath;
 ok((await stage(large)).record.input.media.length,30);
 ok((await stage(newIds(large))).replayed,true);
 const rich=source();rich.descriptionHtml='<p>Rich <strong>text</strong></p><ul><li>A</li><li>B</li></ul>';
 ok((await stage(rich)).record.input.copy.descriptionHtml,rich.descriptionHtml);
 const escaped=source();escaped.description='Literal <b> "quotes" & apostrophe\'\r\nline\n\nnext';
 ok((await stage(escaped)).record.input.copy.descriptionHtml,record(escaped).input.copy.descriptionHtml);
 for(const vendor of ['brics','mandarina']){const c=source(s.catalogNumber.toLowerCase().replaceAll('-','.'));await rejects(()=>stage(c,vendor),/IDENTITY_RESERVED/);}
 // Every frozen Gallery ID rejects even when the imported SKU is otherwise new.
 for(const row of manifest.expectedGallery){const c=source();c.id=row.id;c.angles.forEach(a=>a.itemId=c.id);await rejects(()=>stage(c),/EXISTING_PRODUCT_USE_SYNC/);}
 const existingSku=source(manifest.expectedGallery[0].catalog_number);await rejects(()=>stage(existingSku),/EXISTING_PRODUCT_USE_SYNC/);
 for(const sku of ['P10OSV04-05J-TU','P10ZJT06-24U-TU','ORI05500-909','ORI05500-024']){
  const c=source(sku),bad=structuredClone(r);bad.input.galleryItemId=c.id;bad.input.manufacturerSku=sku;bad.input.shopifySku=null;bad.parentRevision=null;
  await rejects(()=>stage(c,'brics',bad),/HELD_IDENTITY/);
 }
 for(const mutate of [x=>x.input.shopifySku='STORE-INVENTED',x=>x.input.identityMappingReceiptId=randomUUID(),x=>x.input.commerce.sellingPrice='99.00',
  x=>x.input.commerce.currency='ILS',x=>x.input.commerce.inventory={status:'known',quantity:4},x=>x.input.commerce.storeIntent='draft',
  x=>x.input.brand='Samsonite',x=>x.input.copy.title='not source',x=>x.input.copy.descriptionHtml='<p>not source</p>',
  x=>x.input.media.reverse(),x=>x.input.sourceReferences=[],x=>x.provenance.manufacturerSku.verifiedManufacturerFact=true]){
  const c=source(),bad=record(c);mutate(bad);await rejects(()=>stage(c,'brics',bad));
 }
 // Reverse arrival order: ordinary private editor cannot reserve an imported identity later.
 const collide=record(source(s.catalogNumber.toLowerCase().replaceAll('-','.')));await rejects(()=>save(collide),/IDENTITY_RESERVED/);
 const manual=source(),manualRecord=record(manual);await db.exec('set role service_role');await save(manualRecord);
 await rejects(()=>stage(newIds(manual)),/IDENTITY_RESERVED/);
 // A receipt insertion failure rolls back both the newly saved intent and its audit event.
 await db.exec("reset role; create function fail_source_receipt() returns trigger language plpgsql as $$begin raise exception 'SYNC_CREATION_IMPORT_INJECTED_FAILURE';end$$; create trigger fail_source_receipt before insert on shopify_gallery_creation_imports for each row execute function fail_source_receipt();");
 await rejects(()=>stage(source()),/INJECTED_FAILURE/);
 await db.exec('drop trigger fail_source_receipt on shopify_gallery_creation_imports');
 ok(await snapshot(protectedTables),frozen);
 const finalPrior=await snapshot(['shopify_gallery_creation_intents','shopify_gallery_creation_intent_events']);
 for(const table of Object.keys(priorIntents))for(const old of priorIntents[table])ok(finalPrior[table].find(v=>v.id===old.id&&(table.endsWith('_events')?v.revision===old.revision:true)),old);
 return {assertions:checks,rawMetadataPreserved:true,merchantEditsPreserved:true,repeatNewIdsResume:true,sourceChangeNoOverwrite:true,
  publicRowsChanged:0,outboxAdded:0,noManufacturerProof:true};
}
