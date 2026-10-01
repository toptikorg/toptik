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
await db.exec(await migration('20260930_verified_typed_spec_sync.sql'));
for(const name of ['20261001_typed_spec_explicit_clears.sql','20261001_typed_spec_copy_admission.sql']){await db.exec(await migration(name));await db.exec(await migration(name));checks++;}
const {core,workerFor}=await import('../tests/helpers/typed-spec-modules.mjs');
const rpc=async(name,args)=>{await db.exec('set role service_role');try{return (await db.query(`select ${name}(${Object.keys(args).map((k,i)=>k+'=> $'+(i+1)).join(',')}) value`,Object.values(args).map(v=>v!==null&&typeof v==='object'?JSON.stringify(v):v))).rows[0].value;}finally{try{await db.exec('reset role')}catch{}}};
const beforePrivate=async()=>({fields:(await db.query('select * from toptik_spec_private.field_state order by product_gid,field_key')).rows,receipts:(await db.query('select * from toptik_spec_private.receipts order by request_id')).rows});
async function rejects(call,re=/SPEC_|SYNC_COPY_/){const before=await beforePrivate();await assert.rejects(call,re);assert.deepEqual(await beforePrivate(),before);checks++;}
assert.equal(await rpc('recover_toptik_spec_work',{}),78);checks++;assert.equal((await db.query('select count(*)::int n from toptik_spec_private.eligibility')).rows[0].n,0);checks++;
const owner=randomUUID(),product=manifest.rows[0].eligibility.product_gid;await rpc('acquire_shopify_reconciliation_lease',{p_product_gid:product,p_owner:owner});
const admission=await rpc('read_toptik_spec_admission',{p_product_gid:product,p_lease_owner:owner}),identity=admission.identity;assert.equal(identity.itemId,manifest.rows[0].galleryItemId);checks++;
await rejects(()=>rpc('read_toptik_spec_admission',{p_product_gid:product,p_lease_owner:randomUUID()}),/LEASE/);
const snapshotBefore=await snapshot();
// Execute real runtime automatic initialization against actual SQL and synthetic read-only Shopify.
await rpc('release_shopify_reconciliation_lease',{p_product_gid:product,p_owner:owner});
const fake={db:{rpc:(name,args)=>({abortSignal:async()=>({data:await rpc(name,args),error:null})})},fetch:async(expected,provenance)=>{const raw={id:'gid://shopify/Metafield/1',namespace:'toptik_specs',key:'material',type:'single_line_text_field',value:'PC',compareDigest:'digest-current',updatedAt:new Date().toISOString()};return {identity:expected,updatedAt:raw.updatedAt,clearState:{version:1,cleared:{}},document:{fields:Object.fromEntries(core.SPEC_KEYS.map(key=>[key,key==='material'?core.observe(core.makeSpecValue(key,'PC',provenance(key,raw)),raw.compareDigest):core.absent()]))}};},write:async()=>assert.fail('admission must not mutate Shopify')};
const originalEnv=[process.env.VERCEL_ENV,process.env.SHOPIFY_TYPED_SPEC_SYNC];process.env.VERCEL_ENV='production';process.env.SHOPIFY_TYPED_SPEC_SYNC='enabled_v1';
try{const worker=await workerFor(fake),result=await worker.reconcileTypedSpecProduct(fake.db,product);assert.equal(result.fields,19);checks++;}finally{for(const[key,value]of[['VERCEL_ENV',originalEnv[0]],['SHOPIFY_TYPED_SPEC_SYNC',originalEnv[1]]])if(value===undefined)delete process.env[key];else process.env[key]=value;}
const fields=(await db.query('select * from toptik_spec_private.field_state where product_gid=$1',[product])).rows;assert.equal(fields.length,19);assert.ok(fields.every(f=>f.gallery_observation.cell.state==='absent'));assert.equal(fields.find(f=>f.field_key==='material').shopify_observation.cell.value,'PC');checks+=3;assert.deepEqual(await snapshot(),snapshotBefore);checks++;
await rpc('acquire_shopify_reconciliation_lease',{p_product_gid:product,p_owner:owner});
const request=randomUUID();const clear=(key,previousValue=null)=>({key,expectedVersion:1,observation:core.observe(core.makeSpecClear(key,{authority:'merchant',producer:'gallery_typed_editor',observedAt:new Date().toISOString(),evidenceId:request,intentId:`${request}:${key}`,raw:{intent:'clear',previousValue}}),`${request}:${key}`)});
const edit=changes=>rpc('edit_toptik_spec_fields',{p_product_gid:product,p_lease_owner:owner,p_request_id:request,p_edits:changes,p_evidence:{evidenceId:request,operation:'authenticated_editor'}});
const changes=[clear('material','PC'),clear('height'),clear('additional_specs',[{heading:'Known',items:[{label:'Keep raw',value:'Old'}]}])];
for(const mutate of [v=>v[0].observation.cell.provenance.producer=null,v=>v[0].observation.cell.provenance.evidenceId=null,v=>v[0].observation.cell.provenance.intentId=null,v=>v[0].observation.cell.provenance.raw.intent=null,v=>v[0].observation.revision=null,v=>v[0].expectedVersion=2]){const bad=structuredClone(changes);mutate(bad);await rejects(()=>edit(bad));}
await rejects(()=>rpc('edit_toptik_spec_fields',{p_product_gid:product,p_lease_owner:owner,p_request_id:request,p_edits:changes,p_evidence:null}));
const saved=await edit(changes);assert.equal(saved.length,3);checks++;assert.deepEqual(await edit(changes),saved);checks++;
const beforeProjection=await beforePrivate();for(const role of ['anon','authenticated','service_role']){await db.exec(`set role ${role}`);const rows=(await db.query('select public_toptik_typed_specs() value')).rows[0].value;assert.equal(rows.length,1);assert.deepEqual(rows[0].fields,{});assert.deepEqual(rows[0].cleared,{material:null,height:null,additional_specs:[{heading:'Known',items:[{label:'Keep raw',value:'Old'}]}]});assert.doesNotMatch(JSON.stringify(rows),/provenance|intentId|evidenceId|digest-current/);checks+=4;await db.exec('reset role');}assert.deepEqual(await beforePrivate(),beforeProjection);checks++;
// Existing data remain unchanged; clear changes only private field state/audit/work queue.
assert.deepEqual(await snapshot(),frozen);checks++;
for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(db.query('select read_toptik_spec_admission($1,$2)',[product,owner]),/permission denied/);await assert.rejects(db.query('select * from toptik_spec_private.field_state'),/permission denied/);await db.exec('reset role');checks+=2;}
assert.equal((await db.query("select has_function_privilege('service_role','toptik_spec_private.queue_copy_admission()','EXECUTE') value")).rows[0].value,false);checks++;
// An explicitly disabled typed identity is not reactivated by recovery.
await db.query('update toptik_spec_private.eligibility set enabled=false where product_gid=$1',[product]);await rejects(()=>rpc('read_toptik_spec_admission',{p_product_gid:product,p_lease_owner:owner}),/APPROVAL/);assert.equal(await rpc('enqueue_toptik_spec_work',{p_product_gid:product,p_reason:'recovery'}),false);checks++;
// New copy-approved products are queued by the transaction, never populated from legacy specs.
await db.exec('begin');const copy=manifest.rows[1].eligibility;await db.query('delete from toptik_spec_private.work_queue where product_gid=$1',[copy.product_gid]);await db.query('update shopify_gallery_copy_eligibility set enabled=true where product_gid=$1',[copy.product_gid]);assert.equal((await db.query('select count(*)::int n from toptik_spec_private.work_queue where product_gid=$1',[copy.product_gid])).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from toptik_spec_private.eligibility where product_gid=$1',[copy.product_gid])).rows[0].n,0);checks+=2;await db.exec('rollback');
// Raw SKU/handle drift cannot be admitted despite a queued approval.
const next=manifest.rows[1].eligibility,nextOwner=randomUUID();await rpc('acquire_shopify_reconciliation_lease',{p_product_gid:next.product_gid,p_owner:nextOwner});await db.exec('begin');await db.query("update carousel_items set catalog_number='DRIFTED' where id=$1",[next.carousel_item_id]);await assert.rejects(()=>rpc('read_toptik_spec_admission',{p_product_gid:next.product_gid,p_lease_owner:nextOwner}),/APPROVAL/);await db.exec('rollback');checks++;
console.log(JSON.stringify({status:'PASS',checks,scope:'actual82/78 schema; real automatic initialization; explicit clear CAS/projection/ACL; no native writes',externalCalls:0,stubbedFunctions:0}));await db.close();
