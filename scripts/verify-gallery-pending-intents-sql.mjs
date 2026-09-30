import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {descriptionModuleUrl} from '../tests/helpers/description-module.mjs';

/** Invoked by the existing actual-schema/frozen78 harness; no external DB. */
export async function verifyPendingIntents(db, manifest) {
 const asUrl=s=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString('base64')}`;
 const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
 const vendor=asUrl(await read('src/lib/catalog-source/vendor-detect.ts'));
 const rules=asUrl((await read('src/lib/shopify/sync-rules.ts')).replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendor)));
 const imports=s=>s.replace('"zod"',JSON.stringify(import.meta.resolve('zod'))).replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rules));
 const policy=asUrl(imports(await read('src/lib/shopify/creation-policy.ts')));
 const p=await import(asUrl(imports(await read('src/lib/shopify/creation-intent.ts')).replace('"./creation-policy"',JSON.stringify(policy))));
 const tables=['carousel_items','carousel_item_angles','carousel_settings','shopify_gallery_copy_eligibility','shopify_gallery_bindings','shopify_gallery_sync_state','shopify_gallery_public_links','shopify_gallery_content_outbox'];
 const snapshot=async()=>{const value={};for(const table of tables)value[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from ${table} t`)).rows[0].value;return value;};
 await db.exec('reset role'); const before=await snapshot();
 const sql=await read('supabase/migrations/20260930_gallery_shopify_pending_intents.sql');await db.exec(sql);await db.exec(sql);
 assert.deepEqual(await snapshot(),before);let checks=1;
 const actor=randomUUID(),requestId=randomUUID(), now=()=>new Date().toISOString();
 const newInput=()=>({galleryItemId:randomUUID(),shopifySku:null,manufacturerSku:null,identityMappingReceiptId:null,brand:null,category:null,
  copy:{title:null,description:null,descriptionHtml:null,seoTitle:null,seoDescription:null},media:[],
  commerce:{sellingPrice:null,currency:null,compareAtPrice:null,barcode:null,taxable:null,requiresShipping:null,inventory:{status:'unknown'},storeIntent:'undecided'},sourceReferences:[]});
 const complete=()=>{const v=newInput();return {...v,shopifySku:'PENDING-'+randomUUID().slice(0,8),manufacturerSku:null,brand:"Bric's",category:'carryon',
  copy:{title:'מוצר חדש מאומת',description:'תיאור',descriptionHtml:'<p>תיאור</p>',seoTitle:null,seoDescription:''},
  media:[{url:'https://cdn.shopify.com/s/files/1/verified.webp',alt:'הצבע הנכון'}],commerce:{...v.commerce,currency:'ILS',requiresShipping:true,storeIntent:'draft'}};};
 const record=(input,previous=null)=>p.saveCreationIntent(previous,input,{actorId:actor,requestId,at:now(),expectedRevision:previous?.revision??null},{complete:true,capturedAt:now(),existing:[]});
 const save=(r,rev=r.parentRevision)=>db.query('select save_gallery_creation_intent($1::jsonb,$2) value',[JSON.stringify(r),rev]).then(r=>r.rows[0].value);
 const promote=(r,rev=r.revision)=>db.query('select promote_gallery_creation_intent($1,$2) value',[r.input.galleryItemId,rev]).then(r=>r.rows[0].value);
 const rawReserve=d=>db.query('select reserve_gallery_shopify_draft($1::jsonb) value',[JSON.stringify(d)]);
 const rawTables=['shopify_gallery_creation_intents','shopify_gallery_creation_intent_events','shopify_gallery_creation_mappings'];
 const privateSnapshot=async()=>{const value={};for(const table of rawTables)value[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from ${table} t`)).rows[0].value;return value;};
 async function rejects(fn,re=/SYNC_CREATION_/){await db.exec('reset role');const a=await snapshot(),b=await privateSnapshot();await db.exec('set role service_role');await assert.rejects(fn,re);await db.exec('reset role');assert.deepEqual(await snapshot(),a);assert.deepEqual(await privateSnapshot(),b);checks++;}
 const incomplete=record(newInput());
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(save(incomplete),/permission denied/);await assert.rejects(promote(incomplete),/permission denied/);
  for(const table of rawTables)await assert.rejects(db.query('select * from '+table),/permission denied/);await db.exec('reset role');checks+=5;}
 await db.exec('set role service_role');assert.deepEqual(await save(incomplete),incomplete);checks++;
 assert.deepEqual(await save(incomplete),incomplete);checks++;
 await db.exec('reset role');assert.deepEqual(await snapshot(),before);checks++;
 await rejects(()=>promote(incomplete),/DETAILS_REQUIRED/);
 const filled=complete();filled.galleryItemId=incomplete.input.galleryItemId;const r=record(filled,incomplete);
 await db.exec('set role service_role');assert.deepEqual(await save(r),r);checks++;
 const edited=structuredClone(r.input);edited.copy.title='כותרת מתוקנת';const r2=record(edited,r);
 await db.exec('set role service_role');await save(r2);checks++;
 await rejects(()=>save(record({...r.input,copy:{...r.input.copy,title:'עריכה מיושנת'}},r)),/STALE_EDIT/);
 await rejects(()=>promote(r),/STALE_EDIT/);
 const other=record({...complete(),shopifySku:r.input.shopifySku.toLowerCase().replaceAll('-','.')});
 await rejects(()=>save(other),/SKU_RESERVED/);
 // Direct service RPC cannot change an assigned identity even if the JSON is forged.
 const forged=structuredClone(r2);forged.input.shopifySku='DIFFERENT';forged.revision='f'.repeat(64);forged.parentRevision=r2.revision;
 await rejects(()=>save(forged),/IDENTITY_IMMUTABLE/);
 for(const row of manifest.expectedGallery){const collision=record({...complete(),galleryItemId:row.id});await rejects(()=>save(collision),/EXISTING_PRODUCT_USE_SYNC/);}
 for(const sku of ['P10OSV04-05J-TU','P10ZJT06-24U-TU']){const held=structuredClone(r2);held.input.galleryItemId=randomUUID();held.input.shopifySku=sku;held.parentRevision=null;await rejects(()=>save(held,null),/HELD_IDENTITY/);}
 // The legacy completed-draft entry cannot steal a reserved key or alter its source.
 const direct=p.draftFromCreationIntent(r2,null,Date.now());
 await rejects(()=>rawReserve({...direct,galleryItemId:randomUUID()}),/SKU_RESERVED/);
 await rejects(()=>rawReserve({...direct,copy:{...direct.copy,title:'נסה לעקוף'}}),/SOURCE_CHANGED/);
 const fakeMappingDraft={...direct,galleryItemId:randomUUID(),shopifySku:'UNTRUSTED-MAP-'+randomUUID().slice(0,8),manufacturerSku:'150700-9199'};
 fakeMappingDraft.identityMapping={shopifySku:fakeMappingDraft.shopifySku,manufacturerSku:fakeMappingDraft.manufacturerSku,
  sourceUrl:'https://example.invalid/not-a-verification',evidenceSha256:'a'.repeat(64),verifiedAt:now()};
 await rejects(()=>rawReserve(fakeMappingDraft),/MAPPING_RECEIPT_REQUIRED/);
 await db.exec('set role service_role');const promoted=await promote(r2);assert.equal(promoted.id,r2.input.galleryItemId);assert.equal(promoted.stage,'reserved');checks++;
 assert.equal((await promote(r2)).replayed,true);checks++;
 await rejects(()=>save(record({...r2.input,copy:{...r2.input.copy,title:'לא לדרוס'}},r2)),/FROZEN/);
 await db.exec('reset role');const inactive=(await db.query('select is_active from carousel_items where id=$1',[r2.input.galleryItemId])).rows[0];assert.equal(inactive.is_active,false);checks++;
 // Only a pre-existing, trusted private receipt may bridge manufacturer/store SKUs.
 const mv=complete();mv.manufacturerSku='150700-9199';mv.identityMappingReceiptId=randomUUID();const mr=record(mv);
 await db.exec('set role service_role');await save(mr);checks++;
 await rejects(()=>promote(mr),/MAPPING_RECEIPT_MISMATCH/);
 await db.exec('set role service_role');await assert.rejects(db.query('insert into shopify_gallery_creation_mappings(id,gallery_item_id,exact_shopify_sku,exact_manufacturer_sku,source_url,evidence_sha256,verified_at) values($1,$2,$3,$4,$5,$6,now())',
  [mv.identityMappingReceiptId,mv.galleryItemId,mv.shopifySku,mv.manufacturerSku,'https://www.samsonite.co.uk/verified','a'.repeat(64)]),/permission denied/);checks++;
 await db.exec('reset role');await db.query('insert into shopify_gallery_creation_mappings(id,gallery_item_id,exact_shopify_sku,exact_manufacturer_sku,source_url,evidence_sha256,verified_at,revoked) values($1,$2,$3,$4,$5,$6,now(),true)',
  [mv.identityMappingReceiptId,mv.galleryItemId,mv.shopifySku,mv.manufacturerSku,'https://www.samsonite.co.uk/verified','a'.repeat(64)]);
 await rejects(()=>promote(mr),/MAPPING_RECEIPT_MISMATCH/);
 await db.exec('reset role');await db.query('update shopify_gallery_creation_mappings set revoked=false where id=$1',[mv.identityMappingReceiptId]);
 await db.exec('set role service_role');const mp=await promote(mr);assert.equal(mp.source.identityMapping.shopifySku,mv.shopifySku);assert.equal(mp.source.manufacturerSku,mv.manufacturerSku);checks+=2;
 for(const table of rawTables){await assert.rejects(db.query(`delete from ${table}`),/permission denied/);checks++;}
 await db.exec('reset role');const after=await snapshot(),created=[r2.input.galleryItemId,mr.input.galleryItemId];
 for(const table of tables){const rows=table==='carousel_items'?after[table].filter(row=>!created.includes(row.id)):
   table==='carousel_item_angles'?after[table].filter(row=>!created.includes(row.item_id)):after[table];assert.deepEqual(rows,before[table],table);checks++;}
 return {assertions:checks,newInactiveDrafts:2,existingRowsPreserved:true,mappingServiceWriteDenied:true};
}
