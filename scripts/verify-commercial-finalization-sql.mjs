import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes,createRequire} from 'node:module';
import {p,fixture} from '../tests/helpers/commerce-fixtures.mjs';
const repo=new URL('../',import.meta.url);
const require=createRequire(new URL('package.json',repo));
const {descriptionModuleUrl}=await import(new URL('tests/helpers/description-module.mjs',repo));
const data=s=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString('base64')}`;
const read=path=>readFile(new URL(path,repo),'utf8');
const vendor=data(await read('src/lib/catalog-source/vendor-detect.ts'));
const rules=data((await read('src/lib/shopify/sync-rules.ts')).replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendor)));
const imports=s=>s.replace('"zod"',JSON.stringify(pathToFileURL(require.resolve('zod')).href)).replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rules));
const creationUrl=data(imports(await read('src/lib/shopify/creation-policy.ts')));
const creation=await import(creationUrl);
const pending=await import(data(imports(await read('src/lib/shopify/creation-intent.ts')).replace('"./creation-policy"',JSON.stringify(creationUrl))));
const importSource=await read('src/lib/shopify/creation-import.ts');
const {importedCreationInput}=await import(data(`import {plainDescriptionToHtml,descriptionTextFromHtml} from ${JSON.stringify(descriptionModuleUrl)};\n`+
 importSource.slice(importSource.indexOf('export function importedCreationInput'),importSource.indexOf('/** Exact existing'))));
const engine=new URL('../../sync-sql-validation-20260930/package/',import.meta.url);
const {PGlite}=await import(new URL('dist/index.js',engine));
const {pgcrypto}=await import(new URL('dist/contrib/pgcrypto.js',engine));
const db=new PGlite({extensions:{pgcrypto}});
const bytes=await readFile(new URL('../../../outputs/toptik-verified78-copy-activation-manifest-20260930.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'73dc8b7b0946266ab647c214126f9e23619f674188989e24fe0811a6200bae10');
const manifest=JSON.parse(bytes),migration=name=>read('supabase/migrations/'+name);
await db.exec('create role anon;create role authenticated;create role service_role;create schema extensions;create extension pgcrypto with schema extensions;');
for(const name of ['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql','20260527_carousel_tech_specs_cache.sql','20260620_carousel_item_colors.sql',
 '20260930_shopify_gallery_sync_inbox.sql','20260930_shopify_gallery_sync_patch.sql'])await db.exec(await migration(name));
for(const [index,row]of manifest.expectedGallery.entries()){
 await db.query(`insert into carousel_items(id,catalog_number,title,description,description_html,seo_title,seo_description,copy_updated_at,cover_image_path,display_order,is_active,source_url,tech_specs)
 values($1,$2,$3,$4,$5,$6,$7,$8,'unchanged.webp',$9,true,'https://manufacturer.example/verified',$10)`,[row.id,row.catalog_number,row.copy.title,row.copy.description,row.copy.descriptionHtml,row.copy.seoTitle,row.copy.seoDescription,row.copy_updated_at,index+1,JSON.stringify({category:'carryon',verified:'manufacturer'})]);
 await db.query("insert into carousel_item_angles(item_id,angle_key,image_path,angle_order) values($1,'front','unchanged.webp',1)",[row.id]);
}
for(const row of manifest.rows.filter(r=>r.expectedBinding))for(const [table,value]of [['shopify_gallery_bindings',row.expectedBinding],['shopify_gallery_sync_state',row.expectedState],['shopify_gallery_public_links',row.expectedPublicLink]])
 await db.query(`insert into ${table} select * from jsonb_populate_record(null::${table},$1)`,[JSON.stringify(value)]);
await db.exec(await migration('20260930_verified_catalog_copy_activation.sql'));
await db.query('select activate_shopify_verified_catalog($1::jsonb,true)',[JSON.stringify(manifest)]);
for(const name of ['20260930_gallery_shopify_draft_creation.sql','20260930_gallery_shopify_pending_intents.sql','20260930_gallery_shopify_source_imports.sql'])await db.exec(await migration(name));
// The released atomic editor trigger also runs during final public activation.
// Exercise the complete protocol with the real trigger, not a simulated revision.
await db.exec(await migration('20261001_gallery_editor_cas.sql'));
const protectedTables=['carousel_items','carousel_item_angles','carousel_settings','shopify_gallery_bindings','shopify_gallery_public_links','shopify_gallery_sync_state','shopify_gallery_copy_eligibility','shopify_gallery_copy_activations','shopify_gallery_copy_activation_receipts','shopify_gallery_copy_activation_events','shopify_gallery_content_outbox'];
const snapshot=async(tables=protectedTables)=>{const out={};for(const table of tables)out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from ${table} t`)).rows[0].value;return out;};
const frozen=await snapshot();const sql=await readFile(new URL('../supabase/migrations/20260930_gallery_commercial_finalization.sql',import.meta.url),'utf8');
await db.exec(sql);await db.exec(sql);assert.deepEqual(await snapshot(),frozen);let checks=1,serial=0;
const privateTables=['gallery_creation_commercial_intents','gallery_creation_commercial_intent_events','gallery_creation_commercial_jobs','gallery_creation_commercial_events','gallery_creation_commercial_dispatches','gallery_creation_commercial_receipts'];
const allTables=[...protectedTables,...privateTables,'shopify_gallery_creation_drafts','shopify_gallery_creation_events','shopify_gallery_creation_intents','shopify_gallery_creation_intent_events','shopify_gallery_creation_imports','shopify_gallery_reconciliation_leases'];
// Exact source-import table is discovered from the actual chain, never stubbed.
for(let n=allTables.length-1;n>=0;n--)if(!(await db.query('select to_regclass($1) exists',[allTables[n]])).rows[0].exists)allTables.splice(n,1);
const stamp=()=>new Date().toISOString();
const rpc=async(name,values)=>{await db.exec('set role service_role');const out=await db.query(`select ${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) value`,values.map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));await db.exec('reset role');return out.rows[0].value;};
async function reject(fn,re=/FINALIZE_|SYNC_CREATION_/){await db.exec('reset role');const before=await snapshot(allTables);await assert.rejects(fn,re);await db.exec('reset role');assert.deepEqual(await snapshot(allTables),before);checks++;}
async function txReject(sql,params,fn,re=/FINALIZE_|SYNC_CREATION_/){await db.exec('reset role;begin');await db.query(sql,params);await assert.rejects(fn,re);await db.exec('rollback');checks++;}
async function makeReady({blank=false,imported=false,inventory=true}={}){
 const n=++serial,owner=randomUUID(),item=randomUUID();
 const input={galleryItemId:item,shopifySku:'LOCAL-COMMERCE-'+n,manufacturerSku:null,identityMappingReceiptId:null,brand:"Bric's",category:'carryon',
  copy:{title:'מזוודה אמיתית — בדיקה מקומית בלבד',description:blank?'':'תיאור הגלריה',descriptionHtml:blank?null:'<p>תיאור הגלריה</p>',seoTitle:null,seoDescription:null},
  media:[{url:`https://cdn.shopify.com/s/files/1/local-only-${n}.webp`,alt:'מקור מוצר מדויק'}],
  commerce:{sellingPrice:null,currency:'ILS',compareAtPrice:null,barcode:null,taxable:null,requiresShipping:true,inventory:{status:'unknown'},storeIntent:'publish_when_ready'},sourceReferences:[]};
 let prior=null,rawImport=null;
 if(imported){
  rawImport={id:item,catalogNumber:input.shopifySku,title:input.copy.title,description:input.copy.description,descriptionHtml:input.copy.descriptionHtml,seoTitle:null,seoDescription:null,
   sourceUrl:'https://www.brics.it/example',coverImagePath:input.media[0].url,displayOrder:0,isActive:true,color:'כחול',dimensions:'55 x 40 x 20',weight:'2.4 kg',sizes:['cabin'],availableColors:['blue'],
   angles:[{id:randomUUID(),itemId:item,angleKey:'front',imagePath:input.media[0].url,angleOrder:1}],techSpecs:{category:'carryon',specs:[{heading:'טענת מקור',items:[{label:'חומר',value:'PC'}]}],colors:[]},
   colors:[{name:'כחול',hex:'#0000ff'}],supplierPrice:'999.00',unverifiedAdditionalMetadata:{retained:true}};
  prior=pending.saveCreationIntent(null,importedCreationInput(rawImport,'brics'),{actorId:randomUUID(),requestId:randomUUID(),at:stamp(),expectedRevision:null},{complete:true,capturedAt:stamp(),existing:[]});
  await rpc('stage_gallery_creation_import',[prior,'brics',rawImport.catalogNumber,rawImport]);input.manufacturerSku=input.shopifySku;input.sourceReferences=prior.input.sourceReferences;
 }
 const record=pending.saveCreationIntent(prior,input,{actorId:randomUUID(),requestId:randomUUID(),at:stamp(),expectedRevision:prior?.revision??null},{complete:true,capturedAt:stamp(),existing:[]});
 await rpc('save_gallery_creation_intent',[record,prior?.revision??null]);let draft=await rpc('promote_gallery_creation_intent',[item,record.revision]);
 draft=await rpc('claim_gallery_shopify_draft',[item,owner,300]);const source=draft.source;
 const images=source.media.map(m=>({url:m.url,galleryItemId:item,exactSku:source.shopifySku,sha256:'1'.repeat(64),mime:'image/webp',width:800,height:900,byteLength:12345,verifiedAt:stamp()}));
 const ready={policyVersion:'gallery-shopify-draft-v1',draft:source,catalogKey:draft.catalogKey,sourceFingerprint:creation.galleryCreationIntentFingerprint(source,images),customId:{namespace:'app--123--toptik_gallery',key:'source_item_id',value:`toptikcoil.myshopify.com:gallery:${item}`},imageEvidence:images,readyForPublication:false,outstanding:['selling_price','tax_policy','inventory','publication_not_supported_v1']};
 const advance=async patch=>draft=await rpc('advance_gallery_shopify_draft',[item,owner,draft.version,draft.stage,patch]);
 let receipt={policyVersion:'gallery-shopify-draft-v1',galleryItemId:item,sourceFingerprint:ready.sourceFingerprint,customId:ready.customId,stage:'reserved',productGid:null,variantGid:null,shopifyUpdatedAt:null,commercialFingerprint:null,initialCommercial:null};
 await advance({readyProof:ready,receipt});await advance({receipt:{...receipt,stage:'create_started'},freshReadyProof:ready});
 const commercial={price:'0.00',compareAtPrice:null,barcode:null,taxable:true,requiresShipping:true};
 receipt={...receipt,stage:'draft_found',productGid:`gid://shopify/Product/${9800000+n}`,variantGid:`gid://shopify/ProductVariant/${9900000+n}`,shopifyUpdatedAt:stamp(),initialCommercial:commercial,commercialFingerprint:creation.galleryDraftCommercialFingerprint(commercial)};
 await advance({receipt});await advance({receipt:{...receipt,stage:'variant_started'},freshReadyProof:ready});
 receipt={...receipt,stage:'draft_ready',shopifyUpdatedAt:stamp()};
 const readback={snapshot:{productGid:receipt.productGid,variantGid:receipt.variantGid,variantCount:1,sku:source.shopifySku,status:'DRAFT',publishedAnywhere:false,customId:ready.customId,sourceFingerprint:ready.sourceFingerprint,updatedAt:receipt.shopifyUpdatedAt,
  copy:{title:source.copy.title,descriptionHtml:source.copy.descriptionHtml??'',seoTitle:source.copy.seoTitle,seoDescription:source.copy.seoDescription},brand:source.brand,commercial},
  media:images.map(im=>({...Object.fromEntries(Object.entries(im).filter(([key])=>!['galleryItemId','exactSku'].includes(key))),productGid:receipt.productGid,mediaGid:`gid://shopify/MediaImage/${9700000+n}`,status:'READY',alt:source.media[0].alt})),verifiedAt:stamp()};
 await advance({receipt,readbackProof:readback});
 const row=(await db.query('select * from carousel_items where id=$1',[item])).rows[0];
 const hash=(await db.query('select creation_source_hash($1) value',[item])).rows[0].value;
 const readbackHash=(await db.query('select commercial_readback_hash($1) value',[JSON.stringify(readback)])).rows[0].value;
 const f=fixture();const snapshot={...f.snapshot,identity:{...f.snapshot.identity,itemId:item,productGid:receipt.productGid,variantGid:receipt.variantGid,inventoryItemGid:`gid://shopify/InventoryItem/${9600000+n}`,sku:source.shopifySku,manufacturerSku:source.manufacturerSku,brand:source.brand,customId:ready.customId,sourceFingerprint:ready.sourceFingerprint,handle:'local-only-'+n},
  productUpdatedAt:receipt.shopifyUpdatedAt,variantUpdatedAt:receipt.shopifyUpdatedAt,inventoryUpdatedAt:receipt.shopifyUpdatedAt,decodedImagesVerifiedAt:stamp(),galleryCopyVersion:row.copy_updated_at.toISOString(),galleryRowFingerprint:hash,copyMediaFingerprint:readbackHash,
  galleryCopy:{title:row.title,description:row.description,descriptionHtml:row.description_html,seoTitle:row.seo_title,seoDescription:row.seo_description},
  shopifyCopy:{...readback.snapshot.copy,description:blank?'':'תיאור נפרד לחנות'}};
 const intent=p.buildMerchantIntent({...f.payload,commercial:{...f.payload.commercial,tracked:inventory},stock:inventory?f.payload.stock:[],intentId:randomUUID(),galleryItemId:item,sourceFingerprint:ready.sourceFingerprint,frozenPendingRevision:record.revision,provenance:{...f.payload.provenance,savedAt:stamp()}});
 const proof={receipt,receiptId:item,creationRevision:draft.version,frozenPendingRevision:record.revision,pendingStoreIntent:'publish_when_ready',sourceIdentity:{shopifySku:source.shopifySku,manufacturerSku:source.manufacturerSku,brand:source.brand},readbackCommerce:commercial,readbackCopyMediaFingerprint:readbackHash,readbackGalleryRowFingerprint:hash,readbackGalleryCopyVersion:snapshot.galleryCopyVersion};
 const context={...f.context,now:Date.now(),capturedAt:stamp(),catalogCapturedAt:stamp(),intentRevision:intent.revision,frozenPendingRevision:record.revision,creationRevision:draft.version,leaseOwner:owner,creationLeaseOwner:owner,productLeaseOwner:owner,creationLeaseExpiresAt:new Date(Date.now()+240000).toISOString(),productLeaseExpiresAt:new Date(Date.now()+240000).toISOString(),gallery:[{id:item,sku:source.shopifySku,active:false}],shopify:[{productGid:receipt.productGid,variantGid:receipt.variantGid,sku:source.shopifySku}]};
 if(!inventory){snapshot.levels=[];snapshot.levelsComplete=false;context.locations=[];context.locationsComplete=false;context.scopes=['write_products','write_publications'];}
 const prepared=p.prepareFinalization(intent,proof,snapshot,context);
 return {item,owner,intent,proof,snapshot,context,plan:prepared.plan,state:prepared.state,record,draft,readback,rawImport};
}
const f=await makeReady();checks++;
const saveIntent=(x=f,v=x.intent,expected=null)=>rpc('save_gallery_creation_commerce',[v,expected]);
const reserve=(x=f)=>rpc('reserve_gallery_commercial_finalization',[x.plan,x.state,x.owner]);
const save=(x,next,expected=x.state.version)=>rpc('save_gallery_commercial_finalization',[x.item,x.owner,expected,next,stamp()]);
const dispatch=(x=f)=>rpc('dispatch_gallery_commercial_finalization',[x.item,x.owner,x.state.version]);
const final=(x=f)=>rpc('finalize_gallery_shopify_public_creation',[p.buildFinalizerRequest(x.plan,x.state,x.state.observed,{...x.context,now:Date.now(),capturedAt:stamp()}).args,x.owner]);
// RLS and exact grant matrix; no helper execution is granted to service clients.
for(const table of privateTables){
 const q=(await db.query("select relrowsecurity from pg_class where oid=$1::regclass",[table])).rows[0];assert.equal(q.relrowsecurity,true);checks++;
 for(const role of ['anon','authenticated','service_role']){
  const grants=(await db.query("select has_table_privilege($1,$2,'SELECT') r,has_table_privilege($1,$2,'INSERT') i,has_table_privilege($1,$2,'UPDATE') u,has_table_privilege($1,$2,'DELETE') d",[role,table])).rows[0];
  assert.deepEqual(grants,{r:role==='service_role',i:false,u:false,d:false});checks++;
 }
}
const functions=(await db.query("select p.oid::regprocedure::text signature,p.proname name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'commercial_%' or p.proname in ('save_gallery_creation_commerce','reserve_gallery_commercial_finalization','claim_gallery_commercial_finalization','save_gallery_commercial_finalization','dispatch_gallery_commercial_finalization','finalize_gallery_shopify_public_creation','read_gallery_commerce_source'))")).rows;
for(const fn of functions)for(const role of ['anon','authenticated','service_role']){
 assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') value',[role,fn.signature])).rows[0].value,role==='service_role'&&!fn.name.startsWith('commercial_'));checks++;
}
for(const role of ['anon','authenticated']){
 await db.exec(`set role ${role}`);await assert.rejects(db.query('select save_gallery_creation_commerce($1,null)',[JSON.stringify(f.intent)]),/permission denied/);
 await assert.rejects(db.query('select * from gallery_creation_commercial_intents'),/permission denied/);await db.exec('reset role');checks+=2;
}
await db.exec('set role service_role');await assert.rejects(db.query("insert into gallery_creation_commercial_intents(id,item_id,revision,record) values(gen_random_uuid(),$1,'x','{}')",[f.item]),/permission denied/);await db.exec('reset role');checks++;
// Native JSON hashing exactly matches the TS policy, including Unicode and nulls.
assert.equal((await db.query('select commercial_hash($1) value',[JSON.stringify(f.plan)])).rows[0].value,p.fingerprint(f.plan));checks++;
for(const mutate of [v=>delete v.currency,v=>v.supplierPrice=5,v=>v.commercial.price='0.00',v=>v.commercial.taxable=null,v=>v.commercial.requiresShipping=false,
 v=>v.commercial.tracked=false,v=>v.commercial.inventoryPolicy='CONTINUE',v=>v.stock[0].available=null,v=>v.stock[0].available=-1,v=>v.stock[0].available=1.5,
 v=>v.stock[0].basis='supplier',v=>v.stock.push(structuredClone(v.stock[0])),v=>v.stock[0].locationId=null,v=>v.stock[0].evidenceId=null,
 v=>v.provenance.authority='manufacturer',v=>v.provenance.actorId=null,v=>v.storeIntent='draft',v=>v.targetStatus='DRAFT',v=>v.sourceFingerprint='b'.repeat(64),v=>v.frozenPendingRevision='c'.repeat(64)]){
 const bad=structuredClone(f.intent);mutate(bad);const {revision,...body}=bad;void revision;bad.revision=p.fingerprint(body);await reject(()=>saveIntent(f,bad));
}
await saveIntent();checks++;assert.deepEqual(await saveIntent(),f.intent);checks++;
const changed=p.buildMerchantIntent({...Object.fromEntries(Object.entries(f.intent).filter(([k])=>k!=='revision')),commercial:{...f.intent.commercial,price:'700.00'},provenance:{...f.intent.provenance,savedAt:stamp(),requestId:randomUUID()}});
await reject(()=>saveIntent(f,changed,'f'.repeat(64)),/INTENT_CAS/);
for(const mutate of [x=>x.creation.receiptId=randomUUID(),x=>x.creation.creationRevision++,x=>x.creation.pendingStoreIntent='draft',x=>x.creation.sourceIdentity.shopifySku='CHANGED',
 x=>x.initial.identity.productGid='gid://shopify/Product/1',x=>x.initial.identity.variantGid='gid://shopify/ProductVariant/1',x=>x.initial.galleryRowFingerprint='b'.repeat(64),
 x=>x.initial.commercial.tracked=null,x=>x.initial.shopifyCopy.extra='ignored',x=>x.initial.levels[0].quantities.onHand=4,x=>x.steps.reverse(),x=>x.steps.shift()]){
 const bad=structuredClone(f.plan);mutate(bad);const {hash,...body}=bad;void hash;bad.hash=p.fingerprint(body);const state={...f.state,planHash:bad.hash,observed:bad.initial};await reject(()=>rpc('reserve_gallery_commercial_finalization',[bad,state,f.owner]));
}
await reserve();checks++;assert.equal((await reserve()).state.version,1);checks++;
await reject(()=>saveIntent(f,changed,f.intent.revision),/INTENT_FROZEN/);
await reject(()=>rpc('dispatch_gallery_commercial_finalization',[f.item,f.owner,1]),/DISPATCH_INVALID/);
for(const [sql,values]of [
 ['update carousel_items set title=$2 where id=$1',[f.item,'Changed source']],
 ['update carousel_items set catalog_number=$2 where id=$1',[f.item,'OTHER']],
 ['update carousel_items set is_active=true where id=$1',[f.item]],
 ["update carousel_item_angles set image_path='changed.webp' where item_id=$1",[f.item]],
 ["update shopify_gallery_creation_drafts set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.item]],
 ['update shopify_gallery_reconciliation_leases set owner=$2 where product_gid=$1',[f.proof.receipt.productGid,randomUUID()]],
 ['insert into carousel_items(id,catalog_number,title,cover_image_path,display_order,is_active) values($1,$2,\'collision\',\'x\',9999,false)',[randomUUID(),f.snapshot.identity.sku.replaceAll('-','.')]],
 ]){
 const b=p.beginNextStep(f.plan,f.state,f.state.observed,f.context);await txReject(sql,values,()=>save(f,b.state));
}
await reject(()=>rpc('claim_gallery_commercial_finalization',[f.item,f.owner,10000]),/LEASE_INVALID/);
assert.equal(await rpc('claim_gallery_commercial_finalization',[f.item,randomUUID(),60]),null);checks++;
await reject(()=>rpc('save_gallery_commercial_finalization',[f.item,randomUUID(),1,f.state,stamp()]),/OWNED_LEASE_REQUIRED/);
const first=p.beginNextStep(f.plan,f.state,f.state.observed,f.context);
for(const mutate of [x=>x.index=4,x=>x.pending.request.variables.variants[0].price='999.00',x=>x.pending.request.query+=' invalid',x=>x.pending.expected.commercial.price='999.00',x=>x.pending.attemptId=randomUUID()]){
 const bad=structuredClone(first.state);mutate(bad);await reject(()=>save(f,bad),/START_INVALID/);
}
while(p.nextDisposition(f.plan,f.state)==='begin_next'){
 const started=p.beginNextStep(f.plan,f.state,f.state.observed,{...f.context,now:Date.now(),capturedAt:stamp(),catalogCapturedAt:stamp()});
 const previous=structuredClone(f.state);await save(f,started.state);f.state=started.state;
 assert.equal((await save(f,started.state,previous.version)).state.version,started.state.version);checks++;
 const unsentAck=p.acceptStepReadback(f.plan,f.state,f.state.pending.expected,f.context);await reject(()=>save(f,unsentAck),/DISPATCH_REQUIRED/);
 await dispatch(f);await reject(()=>dispatch(f),/ALREADY_DISPATCHED/);
 const malicious=p.acceptStepReadback(f.plan,f.state,f.state.pending.expected,f.context);malicious.observed.otherProductDataFingerprint='f'.repeat(64);
 await reject(()=>save(f,malicious),/READBACK_CHANGED/);
 const next=p.acceptStepReadback(f.plan,f.state,f.state.pending.expected,{...f.context,now:Date.now(),capturedAt:stamp(),catalogCapturedAt:stamp()});await save(f,next);f.state=next;checks+=3;
}
// Failure inside the final receipt rolls back own activation and all public bindings.
await db.exec("create function force_commercial_failure() returns trigger language plpgsql as $$ begin raise exception 'FORCED_FINAL_RECEIPT';end $$;create trigger forced_receipt before insert on gallery_creation_commercial_receipts for each row execute function force_commercial_failure()");
await reject(()=>final(f),/FORCED_FINAL_RECEIPT/);await db.exec('drop trigger forced_receipt on gallery_creation_commercial_receipts');
// Unexpected queue trigger must roll back, not silently bootstrap a copy write.
await db.exec("create function force_commercial_outbox() returns trigger language plpgsql as $$ begin insert into public.shopify_gallery_content_outbox(carousel_item_id,catalog_key,content_hash,payload) values(new.item_id,'BAD','bad','{}');return new;end $$;create trigger forced_outbox after insert on gallery_creation_commercial_receipts for each row execute function force_commercial_outbox()");
await reject(()=>final(f),/UNEXPECTED_WRITE/);await db.exec('drop trigger forced_outbox on gallery_creation_commercial_receipts');
await db.exec("create function force_wrong_binding() returns trigger language plpgsql as $$ begin new.product_handle:='wrong-handle';return new;end $$;create trigger forced_binding before insert on shopify_gallery_bindings for each row execute function force_wrong_binding()");
await reject(()=>final(f),/UNEXPECTED_WRITE/);await db.exec('drop trigger forced_binding on shopify_gallery_bindings');
// A real sale between publication and final binding remains Shopify-authoritative.
const preFinal=p.buildFinalizerRequest(f.plan,f.state,f.state.observed,{...f.context,now:Date.now(),capturedAt:stamp()}).args;
for(const value of [null,'2000-01-01T00:00:00Z','infinity'])await reject(()=>rpc('finalize_gallery_shopify_public_creation',[{...preFinal,p_verified_at:value},f.owner]),/FINAL_READBACK_CHANGED/);
f.state.observed.levels[0].quantities.available=4;f.state.observed.levels[0].quantities.committed=1;
const request=p.buildFinalizerRequest(f.plan,f.state,f.state.observed,{...f.context,now:Date.now(),capturedAt:stamp()}).args;
const itemBeforeFinal=(await db.query('select to_jsonb(i) value from carousel_items i where id=$1',[f.item])).rows[0].value;
const bound=await rpc('finalize_gallery_shopify_public_creation',[request,f.owner]);assert.equal(bound.productGid,f.proof.receipt.productGid);checks++;
const itemAfterFinal=(await db.query('select to_jsonb(i) value from carousel_items i where id=$1',[f.item])).rows[0].value;
assert.equal(itemAfterFinal.editor_revision,itemBeforeFinal.editor_revision+1);checks++;
delete itemBeforeFinal.updated_at;delete itemAfterFinal.updated_at;
assert.deepEqual(itemAfterFinal,{...itemBeforeFinal,is_active:true,editor_revision:itemBeforeFinal.editor_revision+1});checks++;
const afterBound=await snapshot(allTables);assert.deepEqual(await rpc('finalize_gallery_shopify_public_creation',[request,f.owner]),bound);assert.deepEqual(await snapshot(allTables),afterBound);checks++;
await reject(()=>rpc('finalize_gallery_shopify_public_creation',[{...request,p_exact_sku:'OTHER'},f.owner]),/RECEIPT_CONFLICT/);
const receipt=(await db.query('select snapshot from gallery_creation_commercial_receipts where item_id=$1',[f.item])).rows[0].snapshot;assert.equal(receipt.levels[0].quantities.available,4);checks++;
const sync=(await db.query('select gallery_baseline_payload,shopify_baseline_payload from shopify_gallery_sync_state where catalog_key=$1',[f.draft.catalogKey])).rows[0];assert.deepEqual(sync.gallery_baseline_payload,f.snapshot.galleryCopy);assert.deepEqual(sync.shopify_baseline_payload,f.snapshot.shopifyCopy);checks++;
assert.equal((await db.query('select is_active from carousel_items where id=$1',[f.item])).rows[0].is_active,true);checks++;
assert.deepEqual((await rpc('claim_gallery_commercial_finalization',[f.item,randomUUID(),60])).boundReceipt,bound);checks++;
const classify=async ids=>{await db.exec('set role service_role');const result=await db.query('select read_finalized_gallery_creation_items($1::uuid[]) value',[ids]);await db.exec('reset role');return result.rows[0].value;};
assert.deepEqual(await classify([f.item,...manifest.expectedGallery.slice(0,3).map(x=>x.id)]),{finalizedItemIds:[f.item]});checks++;
assert.deepEqual(await classify([]),{finalizedItemIds:[]});checks++;
for(const ids of [null,[null],[f.item,f.item],Array.from({length:1001},()=>randomUUID())])await reject(()=>classify(ids),/ITEM_IDS_INVALID/);
for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(db.query('select read_finalized_gallery_creation_items($1::uuid[])',[[f.item]]),/permission denied/);await db.exec('reset role');checks++;}
// Inactive Gallery and normal post-creation copy changes stay ordinary products.
await db.exec('begin');await db.query("update carousel_items set is_active=false,title='Normal later edit' where id=$1",[f.item]);assert.deepEqual(await classify([f.item]),{finalizedItemIds:[f.item]});await db.exec('rollback');checks++;
// A missing or drifted binding is never inferred from a loose finalized status.
for(const [sql,values]of [['update shopify_gallery_bindings set variant_gid=$2 where carousel_item_id=$1',[f.item,'gid://shopify/ProductVariant/1']],['update shopify_gallery_bindings set product_handle=$2 where carousel_item_id=$1',[f.item,'wrong-handle']],['delete from shopify_gallery_bindings where carousel_item_id=$1',[f.item]],
 ['update carousel_items set catalog_number=$2 where id=$1',[f.item,'CHANGED']],
 ["insert into carousel_items(id,catalog_number,title,cover_image_path,display_order,is_active) values($1,$2,'duplicate','x',9999,false)",[randomUUID(),f.snapshot.identity.sku.replaceAll('-','.')]]]){
 await db.exec('begin');await db.query(sql,values);assert.deepEqual(await classify([f.item]),{finalizedItemIds:[]});await db.exec('rollback');checks++;
}
// The original82 rows/angles/settings and immutable78 identities remain byte-equal.
const after=await snapshot();for(const table of protectedTables){const current=new Set(after[table].map(p.fingerprint));for(const row of frozen[table])assert.ok(current.has(p.fingerprint(row)),table+' changed existing row');checks++;}
assert.equal(after.shopify_gallery_content_outbox.length,0);checks++;
// Immutable audit records refuse even owner SQL writes, not just RLS clients.
for(const table of ['gallery_creation_commercial_intent_events','gallery_creation_commercial_events','gallery_creation_commercial_dispatches','gallery_creation_commercial_receipts']){
 await assert.rejects(db.query('delete from '+table),/FINALIZE_IMMUTABLE/);checks++;
}
// Actual worker + actual SQL: accepted Shopify response loss is read-only on resume.
const b=await makeReady({blank:true,imported:true});
const workerSource=(await readFile(new URL('../src/lib/shopify/commerce-worker.ts',import.meta.url),'utf8')).replace("'./commerce-finalization'",JSON.stringify(data((await readFile(new URL('../src/lib/shopify/commerce-finalization.ts',import.meta.url),'utf8')).replace("'zod'",JSON.stringify(pathToFileURL(require.resolve('zod')).href)))));
const {runCommercialFinalization}=await import(data(workerSource));
const policyUrl=data((await readFile(new URL('../src/lib/shopify/commerce-finalization.ts',import.meta.url),'utf8')).replace("'zod'",JSON.stringify(pathToFileURL(require.resolve('zod')).href)));
const {commercialDatabase}=await import(data((await readFile(new URL('../src/lib/shopify/commerce-database.ts',import.meta.url),'utf8')).replace("'./commerce-finalization'",JSON.stringify(policyUrl))));
let loseStartedReply=false;
const database=commercialDatabase({rpc:(name,args)=>({abortSignal:async signal=>{
 assert.equal(signal.aborted,false);await db.exec('set role service_role');
 const result=await db.query(`select ${name}(${Object.keys(args).map((key,i)=>key+'=> $'+(i+1)).join(',')}) value`,Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v));await db.exec('reset role');
 if(loseStartedReply&&name==='save_gallery_commercial_finalization'&&args.p_state.pending){loseStartedReply=false;throw new Error('lost accepted database response');}
 return {data:result.rows[0].value,error:null};
}})});
await database.saveMerchant(b.intent,null,Date.now()+3000);await database.reserve(b.plan,b.state,b.owner,Date.now()+3000);
let actual=structuredClone(b.snapshot),sends=0,lost=true;
const ports={...database,mode:'publish_verified_v1',now:Date.now,
 read:async()=>({snapshot:structuredClone(actual),context:{...b.context,now:Date.now(),capturedAt:stamp(),catalogCapturedAt:stamp()}}),
 send:async()=>{sends++;const record=(await db.query('select state from gallery_creation_commercial_jobs where item_id=$1',[b.item])).rows[0];actual=structuredClone(record.state.pending.expected);if(lost){lost=false;throw new Error('lost accepted provider response');}},
 };
assert.equal((await runCommercialFinalization(b.item,b.owner,ports)).code,'FINALIZE_MUTATION_RESPONSE_UNCERTAIN');checks++;
assert.equal((await runCommercialFinalization(b.item,b.owner,ports)).mutationAttempted,false);assert.equal(sends,1);checks++;
let result;for(let n=0;n<8;n++){result=await runCommercialFinalization(b.item,b.owner,ports);if(result.status==='bound')break;}
assert.equal(result.status,'bound');assert.equal(sends,b.plan.steps.length);checks++;
const nullBaseline=(await db.query('select gallery_baseline_payload from shopify_gallery_sync_state where catalog_key=$1',[b.draft.catalogKey])).rows[0].gallery_baseline_payload;assert.equal(nullBaseline.description,null);checks++;
assert.deepEqual((await db.query('select raw_source from shopify_gallery_creation_imports where intent_id=$1',[b.item])).rows[0].raw_source,b.rawImport);checks++;
assert.equal(actual.commercial.price,'699.00');assert.notEqual(actual.commercial.price,b.rawImport.supplierPrice);checks++;
assert.equal((await runCommercialFinalization(b.item,b.owner,ports)).mutationAttempted,false);assert.equal(sends,b.plan.steps.length);checks++;
const c=await makeReady();await database.saveMerchant(c.intent,null,Date.now()+3000);await database.reserve(c.plan,c.state,c.owner,Date.now()+3000);
const cPorts={...database,mode:'publish_verified_v1',now:Date.now,read:async()=>({snapshot:c.snapshot,context:{...c.context,now:Date.now(),capturedAt:stamp(),catalogCapturedAt:stamp()}}),send:async()=>assert.fail('must not dispatch after uncertain SQL start')};
loseStartedReply=true;assert.equal((await runCommercialFinalization(c.item,c.owner,cPorts)).mutationAttempted,false);checks++;
assert.equal((await runCommercialFinalization(c.item,c.owner,cPorts)).status,'review');checks++;
assert.equal((await db.query('select count(*)::int value from gallery_creation_commercial_dispatches where item_id=$1',[c.item])).rows[0].value,0);checks++;
const non=await makeReady({inventory:false});
const server=await rpc('read_gallery_commerce_source',[non.item,non.owner]);
assert.equal(server.identity.itemId,non.item);assert.deepEqual(server.proof,non.proof);assert.equal(server.context.creationLeaseOwner,non.owner);checks+=3;
assert.equal(server.galleryRowFingerprint,non.snapshot.galleryRowFingerprint);assert.deepEqual(server.galleryCopy,non.snapshot.galleryCopy);checks+=2;
await reject(()=>rpc('read_gallery_commerce_source',[non.item,randomUUID()]),/OWNED_LEASE_REQUIRED/);
await database.saveMerchant(non.intent,null,Date.now()+3000);await database.reserve(non.plan,non.state,non.owner,Date.now()+3000);
let noStockActual=structuredClone(non.snapshot),noStockWrites=0;
const noStockPorts={...database,mode:'publish_verified_v1',now:Date.now,
 read:async()=>({snapshot:structuredClone(noStockActual),context:{...non.context,now:Date.now(),capturedAt:stamp(),catalogCapturedAt:stamp()}}),
 send:async request=>{assert.ok(!['activate_location','set_stock'].includes(request.operation));noStockWrites++;const record=(await db.query('select state from gallery_creation_commercial_jobs where item_id=$1',[non.item])).rows[0];noStockActual=structuredClone(record.state.pending.expected);}};
let noStockResult;for(let n=0;n<8;n++){noStockResult=await runCommercialFinalization(non.item,non.owner,noStockPorts);if(noStockResult.status==='bound')break;}
assert.equal(noStockResult.status,'bound');assert.equal(noStockWrites,non.plan.steps.length);assert.equal(noStockActual.commercial.tracked,false);assert.equal(noStockActual.levelsComplete,false);checks+=4;
assert.deepEqual(noStockActual.levels,[]);checks++;
// Existing bound native edits: same real schema, no external calls or inventory writes.
const editSql=await migration('20261001_shopify_commerce_edits.sql');await db.exec(editSql);await db.exec(editSql);checks++;
const edits=['shopify_gallery_commerce_commands','shopify_gallery_commerce_edit_receipts'];allTables.push(...edits);
const {existing:ep,boundFixture,runtime:editRuntime,enabled}=await import('../tests/helpers/commerce-existing-fixtures.mjs');
const ei=manifest.rows[0].galleryItemId,eo=randomUUID(),actor=randomUUID();
const identity=await rpc('read_bound_commerce_identity',[ei]);
assert.equal(identity.itemId,ei);assert.equal(identity.sku,manifest.rows[0].shopifySku);checks++;
await rpc('acquire_shopify_reconciliation_lease',[identity.productGid,eo]);
const baseline={...boundFixture().snapshot,identity,productUpdatedAt:stamp(),variantUpdatedAt:stamp(),inventoryUpdatedAt:stamp()};
const stage=(id,patch={price:'550.00'},base=baseline,owner=eo,observed=stamp())=>rpc('stage_bound_commerce_edit',[id,ei,actor,owner,p.fingerprint(base),base,patch,observed]);
const ack=(id,back,owner=eo,observed=stamp())=>rpc('ack_bound_commerce_edit',[id,owner,back,observed]);
for(const table of edits){assert.equal((await db.query('select relrowsecurity from pg_class where oid=$1::regclass',[table])).rows[0].relrowsecurity,true);checks++;
 for(const role of ['anon','authenticated','service_role']){assert.deepEqual((await db.query("select has_table_privilege($1,$2,'SELECT') r,has_table_privilege($1,$2,'INSERT') i,has_table_privilege($1,$2,'UPDATE') u,has_table_privilege($1,$2,'DELETE') d",[role,table])).rows[0],{r:role==='service_role',i:false,u:false,d:false});checks++;}}
const editFns=(await db.query("select oid::regprocedure::text signature,proname name from pg_proc where pronamespace='public'::regnamespace and (proname like 'commerce_edit_%' or proname in ('read_bound_commerce_identity','stage_bound_commerce_edit','dispatch_bound_commerce_edit','ack_bound_commerce_edit'))")).rows;
for(const fn of editFns)for(const role of ['anon','authenticated','service_role']){assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') value",[role,fn.signature])).rows[0].value,role==='service_role'&&!fn.name.startsWith('commerce_edit_'));checks++;}
for(const patch of [null,{}, {price:null},{taxable:null},{requiresShipping:null},{status:null},{tracked:false},{available:1},{price:'0.00'},{price:'500.00'},{price:'900.00'},{status:'DRAFT',price:'550.00'}])await reject(()=>stage(randomUUID(),patch));
for(const mutate of [s=>delete s.fields,s=>s.fields=null,s=>s.fields.taxable=null,s=>s.tracked=null,s=>s.identity=null,s=>s.protectedHash=null,s=>s.productUpdatedAt=null,s=>s.fields.price='550.00']){
 const bad=structuredClone(baseline);mutate(bad);await reject(()=>rpc('stage_bound_commerce_edit',[randomUUID(),ei,actor,eo,p.fingerprint(baseline),bad,{price:'550.00'},stamp()]));}
await reject(()=>stage(randomUUID(),{price:'550.00'},baseline,randomUUID()),/LEASE/);
await reject(()=>stage(randomUUID(),{price:'550.00'},baseline,eo,null),/FRESH/);
await reject(()=>stage(randomUUID(),{price:'550.00'},baseline,eo,'2000-01-01T00:00:00Z'),/FRESH/);
for(const [sql,args]of [
 ['update shopify_gallery_reconciliation_leases set expires_at=clock_timestamp() where product_gid=$1',[identity.productGid]],
 ["update carousel_items set catalog_number='CHANGED' where id=$1",[ei]],
 ['update shopify_gallery_copy_eligibility set enabled=false where carousel_item_id=$1',[ei]],
 ["update shopify_gallery_bindings set variant_gid='gid://shopify/ProductVariant/1' where carousel_item_id=$1",[ei]],
 ["insert into carousel_items(id,catalog_number,title,cover_image_path,display_order,is_active) values($1,$2,'dup','x',9999,false)",[randomUUID(),identity.exactGallerySku.replaceAll('-','.')]],
 ])await txReject(sql,args,()=>stage(randomUUID()));
const beforeEdit=await snapshot();const cid=randomUUID(),plan=ep.planBoundCommerceEdit(baseline,{price:'550.00'});
const command=await stage(cid);assert.deepEqual(command.request,plan.request);assert.deepEqual(await stage(cid),command);checks+=2;
await reject(()=>stage(cid,{price:'560.00'}),/REUSED/);await reject(()=>stage(randomUUID()),/PENDING/);
await reject(()=>rpc('dispatch_bound_commerce_edit',[cid,randomUUID()]),/LEASE/);
assert.deepEqual(await rpc('dispatch_bound_commerce_edit',[cid,eo]),plan.request);checks++;
await reject(()=>rpc('dispatch_bound_commerce_edit',[cid,eo]),/DISPATCHED/);
await reject(()=>ack(cid,null));await reject(()=>ack(cid,plan.desired,eo,null),/FRESH/);
assert.equal((await ack(cid,plan.desired)).state,'confirmed');checks++;assert.equal((await ack(cid,plan.desired)).state,'confirmed');checks++;
assert.deepEqual(await snapshot(),beforeEdit);checks++;
await reject(()=>db.query('delete from shopify_gallery_commerce_edit_receipts'),/IMMUTABLE/);
// Status readback may change purchase visibility only; rollback keeps frozen catalog fixture.
await db.exec('begin');const sid=randomUUID(),sp=ep.planBoundCommerceEdit(baseline,{status:'DRAFT'});await stage(sid,{status:'DRAFT'});await rpc('dispatch_bound_commerce_edit',[sid,eo]);
const hidden={...sp.desired,publication:false,variantPublication:false};assert.equal((await ack(sid,hidden)).state,'confirmed');checks++;
assert.equal((await db.query('select is_published from shopify_gallery_bindings where carousel_item_id=$1',[ei])).rows[0].is_published,false);checks++;
const afterHide=await snapshot();for(const table of protectedTables.filter(t=>!['shopify_gallery_bindings','shopify_gallery_public_links'].includes(t))){assert.deepEqual(afterHide[table],beforeEdit[table]);checks++;}await db.exec('rollback');
// Accepted stage with no dispatch can only finish review; stale/protected readback never compensates.
for(const dispatched of [false,true]){const rid=randomUUID();await stage(rid);if(dispatched)await rpc('dispatch_bound_commerce_edit',[rid,eo]);const observed=structuredClone(plan.desired);observed.protectedHash='d'.repeat(64);assert.equal((await ack(rid,observed)).state,'review');checks++;}
await rpc('release_shopify_reconciliation_lease',[identity.productGid,eo]);
// Real bound runtime against actual RPCs, including lost provider response; exactly one send.
let native=structuredClone(baseline),editSends=0;const realEditDb={from(table){assert.equal(table,'shopify_gallery_commerce_commands');let match;return{select(){return this},eq(k,v){match={k,v};return this},abortSignal(){return this},async maybeSingle(){assert.equal(match.k,'id');return{data:(await db.query('select * from shopify_gallery_commerce_commands where id=$1',[match.v])).rows[0]??null,error:null}}}},rpc(name,args){return{abortSignal:async()=>{await db.exec('set role service_role');try{return{data:(await db.query(`select ${name}(${Object.keys(args).map((k,i)=>k+'=> $'+(i+1)).join(',')}) value`,Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v))).rows[0].value,error:null}}finally{await db.exec('reset role')}}}}};
globalThis.__existingCommerce={read:async()=>structuredClone(native),send:async()=>{editSends++;native=structuredClone(plan.desired);throw Error('accepted provider response lost')}};
const requestEdit={id:randomUUID(),itemId:ei,expectedHash:p.fingerprint(baseline),patch:{price:'550.00'}};
await enabled(async()=>{assert.equal((await editRuntime.editExistingCommerce(realEditDb,requestEdit,actor)).status,'pending');checks++;assert.equal((await editRuntime.editExistingCommerce(realEditDb,requestEdit,actor)).status,'confirmed');checks++;});
assert.equal(editSends,1);assert.deepEqual(await snapshot(),beforeEdit);checks+=2;

console.log(JSON.stringify({status:'PASS',checks,scope:'actual migration chain + real worker; frozen82/78 preserved; no-inventory finalization',stubbedFunctions:0,externalCalls:0}));
await db.close();
