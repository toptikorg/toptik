import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
const repo=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,repo),'utf8');
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
const protectedTables=['carousel_items','carousel_item_angles','carousel_settings','shopify_gallery_bindings','shopify_gallery_public_links','shopify_gallery_sync_state','shopify_gallery_copy_eligibility','shopify_gallery_copy_activations','shopify_gallery_copy_activation_receipts','shopify_gallery_copy_activation_events','shopify_gallery_content_outbox'];
const snapshot=async(tables=protectedTables)=>{const out={};for(const table of tables)out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from ${table} t`)).rows[0].value;return out;};
const frozen=await snapshot();let checks=0;

const sql=await migration('20261001_osv04_existing_admission.sql');await db.exec(sql);await db.exec(sql);assert.deepEqual(await snapshot(),frozen);checks++;
const product='gid://shopify/Product/15401872654586',variant='gid://shopify/ProductVariant/67612818669818',item='70bce0cd-f69f-4d27-8e98-7632b458bf1f',key='P10OSV0405J',owner=randomUUID();
const rpc=async(name,args)=>{await db.exec('set role service_role');try{return (await db.query(`select ${name}(${Object.keys(args).map((k,i)=>k+'=> $'+(i+1)).join(',')}) value`,Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v))).rows[0].value;}finally{try{await db.exec('reset role')}catch{}}};
const full=async()=>snapshot([...protectedTables,'shopify_existing_osv04_admission']);
let transactionOpen=false;
async function denied(args,regex=/SYNC_OSV04_/){const before=await full();if(transactionOpen)await db.exec('savepoint expected_failure');await assert.rejects(()=>rpc('admit_existing_osv04',args),regex);if(transactionOpen)await db.exec('rollback to savepoint expected_failure;release savepoint expected_failure;reset role');assert.deepEqual(await full(),before);checks++;}
await rpc('acquire_shopify_reconciliation_lease',{p_product_gid:product,p_owner:owner});
const initial=await rpc('read_existing_osv04_admission',{p_lease_owner:owner});assert.equal(initial.admitted,false);checks++;
const now=new Date().toISOString();
const evidence={policyVersion:'existing-osv04-v1',productId:product,variantId:variant,itemId:item,gallerySku:'P10OSV04-05J-TU',shopifySku:key,catalogKey:key,handle:'p10osv0405j',manufacturerUrl:'https://mandarinaduck.com/products/eco-coated-trolley-large-expandable-duck-yellow-osv0405j',price:'1545.00',currency:'ILS',galleryRevision:initial.galleryRevision,sourceUpdatedAt:now,verifiedAt:now,status:'ACTIVE',publishedOnPublication:true,variantCount:1,shopifyCollisionCount:1,inventoryTracked:false,vendor:'mandarinaduck',copy:{title:'Shop current title',description:'Shop current description',descriptionHtml:'<p>Shop current description</p>',seoTitle:'Shop SEO',seoDescription:null},media:[{mediaGid:'gid://shopify/MediaImage/123',url:'https://cdn.shopify.com/s/files/1/official.png?v=1',width:100,height:100,mime:'image/png',sha256:'a'.repeat(64),byteLength:1000}]};
const args={p_lease_owner:owner,p_evidence:evidence};
for(const field of ['policyVersion','productId','variantId','itemId','gallerySku','shopifySku','catalogKey','handle','manufacturerUrl','price','currency','galleryRevision','sourceUpdatedAt','verifiedAt','status','publishedOnPublication','variantCount','shopifyCollisionCount','inventoryTracked','vendor','copy','media']){
 const bad=structuredClone(args);delete bad.p_evidence[field];await denied(bad);
}
for(const [field,value] of [['productId','gid://shopify/Product/1'],['price','1544.00'],['currency','USD'],['vendor','Samsonite'],['gallerySku','P10SJT06-24U-TU'],['inventoryTracked',true],['galleryRevision','0'.repeat(64)],['verifiedAt','2020-01-01T00:00:00Z']]){const bad=structuredClone(args);bad.p_evidence[field]=value;await denied(bad);}
await denied({...args,p_lease_owner:randomUUID()});
for(const field of ['width','height','byteLength','mediaGid','url','sha256','mime']){const bad=structuredClone(args);delete bad.p_evidence.media[0][field];await denied(bad);}
for(const mutate of [e=>e.media.push(e.media[0]),e=>e.media[0].width=0,e=>e.media[0].byteLength=8388609,e=>e.media[0].url='https://evil.example/a.png',e=>e.media[0].width=16001]){const bad=structuredClone(args);mutate(bad.p_evidence);await denied(bad);}
await db.exec('begin');transactionOpen=true;await db.query("update carousel_items set tech_specs=$2::jsonb where id=$1",[item,JSON.stringify({changed:true})]);await denied(args,/GALLERY_CHANGED/);await db.exec('rollback');transactionOpen=false;
await db.exec('begin');transactionOpen=true;await db.query("insert into carousel_items(id,catalog_number,title,cover_image_path,display_order,is_active) values($1,'P10OSV0405J','Duplicate','unchanged.webp',99,false)",[randomUUID()]);await denied(args,/GALLERY_IDENTITY/);await db.exec('rollback');transactionOpen=false;
await db.exec('begin');transactionOpen=true;await db.query("insert into shopify_gallery_public_links(catalog_key,product_handle,variant_id,is_published) values($1,'p10osv0405j','67612818669818',true)",[key]);await denied(args,/ASSOCIATION_CONFLICT/);await db.exec('rollback');transactionOpen=false;
for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(db.query('select read_existing_osv04_admission($1)',[owner]),/permission denied/);await assert.rejects(db.query('select admit_existing_osv04($1,$2)',[owner,JSON.stringify(evidence)]),/permission denied/);await assert.rejects(db.query('select * from shopify_existing_osv04_admission'),/permission denied/);await db.exec('reset role');checks+=3;}
const result=await rpc('admit_existing_osv04',args);assert.deepEqual(result,{admitted:true,replayed:false,enabled:true,itemId:item});checks++;
const after=await snapshot();for(const table of protectedTables){if(['carousel_items','carousel_item_angles','carousel_settings','shopify_gallery_content_outbox'].includes(table))assert.deepEqual(after[table],frozen[table]);else for(const row of frozen[table])assert.ok(after[table].some(x=>JSON.stringify(x)===JSON.stringify(row)),table+' existing row changed');checks++;}
assert.equal(after.shopify_gallery_copy_eligibility.length,79);assert.equal(after.carousel_items.length,82);checks+=2;
const state=after.shopify_gallery_sync_state.find(s=>s.catalog_key===key),original=after.carousel_items.find(i=>i.id===item);
assert.deepEqual(state.gallery_baseline_payload,{title:original.title,description:original.description,descriptionHtml:original.description_html,seoTitle:original.seo_title,seoDescription:original.seo_description});assert.deepEqual(state.shopify_baseline_payload,evidence.copy);checks+=2;
const unchanged=await full();assert.equal((await rpc('admit_existing_osv04',args)).replayed,true);assert.deepEqual(await full(),unchanged);checks++;
await db.query("update shopify_gallery_sync_state set gallery_baseline_payload=gallery_baseline_payload||$2::jsonb where catalog_key=$1",[key,JSON.stringify({title:"later legitimate sync"})]);await db.query('update shopify_gallery_copy_eligibility set enabled=false where product_gid=$1',[product]);
const disabled=await full();assert.equal((await rpc('read_existing_osv04_admission',{p_lease_owner:owner})).enabled,false);assert.equal((await rpc('admit_existing_osv04',args)).enabled,false);assert.deepEqual(await full(),disabled);checks++;
await db.exec('set role service_role');await assert.rejects(db.query('delete from shopify_existing_osv04_admission'),/permission denied/);await db.exec('reset role');await assert.rejects(db.query('delete from shopify_existing_osv04_admission'),/IMMUTABLE/);checks+=2;
console.log(JSON.stringify({status:'PASS',checks,scope:'Actual82/78 schema; exact OSV04 append79; no catalog writes; independent baselines; replay/disabled preservation; lease/CAS/ACL',externalCalls:0,stubbedFunctions:0}));await db.close();
