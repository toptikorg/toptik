/** Offline NEWONLY onboarding RPC acceptance against the frozen existing78 fixture. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [engine, manifestPath] = process.argv.slice(2);
if (!engine || !manifestPath) throw new Error('Usage: node scripts/verify-shopify-product-onboarding-sql.mjs <PGlite package> <frozen78 manifest>');
const { PGlite } = await import(pathToFileURL(engine + '/dist/index.js').href);
const { pgcrypto } = await import(pathToFileURL(engine + '/dist/contrib/pgcrypto.js').href);
const bytes = await readFile(manifestPath), manifest = JSON.parse(bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'),'73dc8b7b0946266ab647c214126f9e23619f674188989e24fe0811a6200bae10');
const db = new PGlite({extensions:{pgcrypto}});
const readMigration = name => readFile(new URL('../supabase/migrations/' + name,import.meta.url),'utf8');
await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema extensions; create extension pgcrypto with schema extensions;');
for (const name of ['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql','20260527_carousel_tech_specs_cache.sql',
  '20260620_carousel_item_colors.sql','20260930_shopify_gallery_sync_inbox.sql','20260930_shopify_gallery_sync_patch.sql']) await db.exec(await readMigration(name));
for (const [index,row] of manifest.expectedGallery.entries()) {
  await db.query(`insert into carousel_items(id,catalog_number,title,description,description_html,seo_title,seo_description,copy_updated_at,
    cover_image_path,display_order,is_active,source_url,tech_specs) values($1,$2,$3,$4,$5,$6,$7,$8,'unchanged.webp',$9,true,'https://manufacturer.example/verified',$10)`,
    [row.id,row.catalog_number,row.copy.title,row.copy.description,row.copy.descriptionHtml,row.copy.seoTitle,row.copy.seoDescription,row.copy_updated_at,index+1,JSON.stringify({category:'carryon',verified:'manufacturer'})]);
  await db.query("insert into carousel_item_angles(item_id,angle_key,image_path,angle_order) values($1,'front','unchanged.webp',1)",[row.id]);
}
for (const row of manifest.rows.filter(row=>row.expectedBinding)) {
  for (const [table,value] of [['shopify_gallery_bindings',row.expectedBinding],['shopify_gallery_sync_state',row.expectedState],['shopify_gallery_public_links',row.expectedPublicLink]])
    await db.query(`insert into ${table} select * from jsonb_populate_record(null::${table},$1)`,[JSON.stringify(value)]);
}
await db.exec(await readMigration('20260930_verified_catalog_copy_activation.sql'));
await db.query('select activate_shopify_verified_catalog($1::jsonb,true)',[JSON.stringify(manifest)]);
const sql=await readMigration('20260930_shopify_public_product_onboarding.sql');
const frozenTables=['carousel_items','carousel_item_angles','carousel_settings','shopify_gallery_bindings','shopify_gallery_public_links',
  'shopify_gallery_sync_state','shopify_gallery_copy_eligibility','shopify_gallery_copy_activations','shopify_gallery_copy_activation_receipts',
  'shopify_gallery_copy_activation_events','shopify_gallery_content_outbox'];
const snapshot=async (tables=frozenTables) => {
  const result={}; for (const table of tables) result[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from ${table} t`)).rows[0].value;
  return result;
};
const frozen=await snapshot();
await db.exec(sql); await db.exec(sql);
assert.deepEqual(await snapshot(),frozen,'schema alone must not ingest or change frozen rows');
const owner=randomUUID(), otherOwner=randomUUID();
const norm=sku=>sku.toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^(P[0-9]{2}.*)TU$/,'$1');
let serial=100;
function fixture() {
  const n=serial++, sourceUpdatedAt=new Date(Date.now()-60000).toISOString();
  return {policyVersion:'published-shopify-v1',eventId:randomUUID(),productGid:`gid://shopify/Product/99000000${n}`,
    variantGid:`gid://shopify/ProductVariant/99000000${n}`,exactSku:`NEW-BRICS-${n}`,catalogKey:`NEWBRICS${n}`,
    handle:`מזוודה-חדשה-${n}`,sourceUpdatedAt,brandLabel:"Bric's",category:'suitcase',
    copy:{title:'מזוודה חדשה',description:'תיאור מדויק',descriptionHtml:'<p dir="rtl">תיאור <strong>מדויק</strong></p><table><tr><td>מידה</td></tr></table>',seoTitle:null,seoDescription:'תיאור חיפוש'},
    media:[1,2].map((i)=>({mediaGid:`gid://shopify/MediaImage/990000${n}${i}`,url:`https://cdn.shopify.com/s/files/1/0001/${n}-${i}.png?v=1`,width:800,height:900,mime:'image/png',sha256:String(i).repeat(64),byteLength:12345})),
    verifiedAt:new Date().toISOString(),shopifyCollisionCount:1,status:'ACTIVE',publishedOnPublication:true,variantCount:1,shopDomain:'toptikcoil.myshopify.com'};
}
async function prepare(e) {
  await db.query(`insert into shopify_webhook_events(id,delivery_id,topic,shop_domain,payload,status,claimed_at)
    values($1,$2,'products/create','toptikcoil.myshopify.com',$3,'processing',clock_timestamp())`,
    [e.eventId,randomUUID(),JSON.stringify({id:e.productGid.split('/').at(-1),admin_graphql_api_id:e.productGid,updated_at:e.sourceUpdatedAt})]);
  await db.query('select acquire_shopify_reconciliation_lease($1,$2)',[e.productGid,owner]);
}
const onboard=(e,lease=owner)=>db.query('select onboard_public_shopify_product($1::jsonb,$2) result',[JSON.stringify(e),lease]);
let cases=0;
async function reject(e,pattern=/SYNC_ONBOARDING_/,lease=owner) {
  const before=await snapshot([...frozenTables,'shopify_gallery_product_onboarding_receipts']);
  await assert.rejects(onboard(e,lease),pattern);
  assert.deepEqual(await snapshot([...frozenTables,'shopify_gallery_product_onboarding_receipts']),before,'rejected input must not mutate rows'); cases++;
}
const valid=fixture(); await prepare(valid);
for (const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`);
  await assert.rejects(onboard(valid),/permission denied/);
  await assert.rejects(db.query('select * from shopify_gallery_product_onboarding_receipts'),/permission denied/);
  await assert.rejects(db.query('delete from shopify_gallery_product_onboarding_receipts'),/permission denied/);
  await db.exec('reset role'); cases+=3;
}
await db.exec('set role service_role');
assert.deepEqual((await db.query('select * from shopify_gallery_product_onboarding_receipts')).rows,[]);
await assert.rejects(db.query('delete from shopify_gallery_product_onboarding_receipts'),/permission denied/);
await db.exec('reset role'); cases++;
const malformed=[
  e=>{e.unapproved=true;},e=>{delete e.status;},e=>{e.status='DRAFT';},e=>{e.publishedOnPublication=false;},
  e=>{e.variantCount=2;},e=>{e.shopifyCollisionCount=2;},e=>{e.shopDomain='other.myshopify.com';},
  e=>{e.brandLabel='American Tourister';},e=>{e.policyVersion='new-policy';},e=>{e.productGid='gid://shopify/Product/0';},
  e=>{e.variantGid='123';},e=>{e.exactSku=' NEW-BRICS-100';},e=>{e.catalogKey='WRONG';},e=>{e.exactSku='מוצר';},
  e=>{e.handle='../x';},e=>{e.handle='a/b';},e=>{e.handle='a\\b';},e=>{e.handle='a%2fb';},e=>{e.category='unsupported';},
  e=>{e.sourceUpdatedAt='infinity';},e=>{e.verifiedAt=new Date(Date.now()-360000).toISOString();},
  e=>{e.verifiedAt=new Date(Date.now()+60000).toISOString();},e=>{e.sourceUpdatedAt=new Date(Date.now()+60000).toISOString();},
  e=>{e.copy.price=1;},e=>{e.copy.title='';},e=>{e.copy.title='a'.repeat(121);},e=>{e.copy.descriptionHtml=null;},
  e=>{e.copy.seoTitle=3;},e=>{e.media=[];},e=>{e.media[0].url='https://cdn.shopify.com.evil.test/s/files/x.png';},
  e=>{e.media[0].url='https://cdn.shopify.com:443/s/files/x.png';},e=>{e.media[0].url='https://cdn.shopify.com/x.png';},
  e=>{e.media[0].url='https://cdn.shopify.com/s/files/x.png#frag';},e=>{e.media[0].url='https://cdn.shopify.com/s/files/a\\b.png';},
  e=>{e.media[0].url='https://cdn.shopify.com/s/files/a b.png';},e=>{e.media[0].mime='image/svg+xml';},
  e=>{e.media[0].sha256='bad';},e=>{e.media[0].width='800';},e=>{e.media[0].width=16001;},
  e=>{e.media[0].width=4001;e.media[0].height=4000;},e=>{e.media[0].byteLength=8388609;},
  e=>{e.media[1]=e.media[0];},e=>{e.media[0].extra=true;},e=>{e.eventId=randomUUID();},
];
for (const mutate of malformed) { const e=structuredClone(valid); mutate(e); await reject(e); }
for (const sku of ['P10OSV04-05J-TU','P10ZJT06-24U-TU','ORI05500909','ORI05500024']) {
  const e={...valid,exactSku:sku,catalogKey:norm(sku)}; await reject(e,/HELD_PRODUCT/);
}
await reject({...valid,productGid:'gid://shopify/Product/9399665819898'},/HELD_PRODUCT/);
await reject(valid,/LEASE_LOST/,otherOwner); await reject(valid,/LEASE_LOST/,null);
await db.query("update shopify_gallery_reconciliation_leases set expires_at=clock_timestamp()-interval '1 second' where product_gid=$1",[valid.productGid]);
await reject(valid,/LEASE_LOST/);
await db.query('select acquire_shopify_reconciliation_lease($1,$2)',[valid.productGid,owner]);
for (const [sql,params,pattern] of [
  ["update shopify_webhook_events set status='pending' where id=$1",[valid.eventId],/EVENT_INVALID/],
  ["update shopify_webhook_events set claimed_at=clock_timestamp()-interval '16 minutes' where id=$1",[valid.eventId],/EVENT_INVALID/],
  ["update shopify_webhook_events set payload=jsonb_set(payload,'{id}','\"1\"') where id=$1",[valid.eventId],/EVENT_INVALID/],
  ["update shopify_webhook_events set payload=jsonb_set(payload,'{updated_at}',to_jsonb(clock_timestamp()::text)) where id=$1",[valid.eventId],/SOURCE_STALE/],
]) {
  await db.exec('begin'); await db.query(sql,params); await assert.rejects(onboard(valid),pattern); await db.exec('rollback'); cases++;
}
const frozenIdentity=manifest.rows[0];
await reject({...valid,exactSku:frozenIdentity.gallerySku,catalogKey:frozenIdentity.catalogKey},/GALLERY_SKU_COLLISION/);
const collision=fixture(); await prepare(collision);
await db.query("insert into carousel_items(catalog_number,title,cover_image_path,display_order,is_active) values($1,'Hidden preserved','hidden.webp',83,false)",[collision.exactSku.toLowerCase().replaceAll('-','.')]);
await reject(collision,/GALLERY_SKU_COLLISION/);
await db.query('delete from carousel_items where catalog_number=$1',[collision.exactSku.toLowerCase().replaceAll('-','.')]);
await db.query("insert into shopify_gallery_sync_state(catalog_key,last_synced_payload,last_synced_hash) values($1,'{}','orphan')",[collision.catalogKey]);
await reject(collision,/GALLERY_SKU_COLLISION/);
await db.query('delete from shopify_gallery_sync_state where catalog_key=$1',[collision.catalogKey]);
await db.query("insert into shopify_gallery_public_links(catalog_key,product_handle,variant_id,is_published) values($1,'orphan','99900000',false)",[collision.catalogKey]);
await reject(collision,/GALLERY_SKU_COLLISION/);
await db.query('delete from shopify_gallery_public_links where catalog_key=$1',[collision.catalogKey]);
await db.exec("create function fail_onboarding_receipt() returns trigger language plpgsql as $$ begin raise exception 'FORCED_RECEIPT_FAILURE'; end $$; create trigger fail_onboarding_receipt before insert on shopify_gallery_product_onboarding_receipts for each row execute function fail_onboarding_receipt();");
await reject(valid,/FORCED_RECEIPT_FAILURE/);
await db.exec('drop trigger fail_onboarding_receipt on shopify_gallery_product_onboarding_receipts');
await db.exec("create function unexpected_onboarding_outbox() returns trigger language plpgsql as $$ begin insert into shopify_gallery_content_outbox(carousel_item_id,catalog_key,content_hash,payload) values(new.carousel_item_id,new.catalog_key,'unexpected','{}'); return new; end $$; create trigger unexpected_onboarding_outbox after insert on shopify_gallery_product_onboarding_receipts for each row execute function unexpected_onboarding_outbox();");
await reject(valid,/UNEXPECTED_OUTBOX/);
await db.exec('drop trigger unexpected_onboarding_outbox on shopify_gallery_product_onboarding_receipts');
await db.exec('begin');
await db.query('update carousel_items set display_order=9999 where id=$1',[manifest.expectedGallery[0].id]);
await assert.rejects(onboard(valid),/CATALOG_CAPACITY/); await db.exec('rollback'); cases++;
await db.exec('begin');
await db.exec("insert into carousel_items(title,cover_image_path,display_order,is_active) select 'Capacity fixture','fixture.webp',83,false from generate_series(1,4918)");
await assert.rejects(onboard(valid),/CATALOG_CAPACITY/); await db.exec('rollback'); cases++;
await db.exec('set role service_role');
const result=(await onboard(valid)).rows[0].result;
assert.equal(result.changed,true); assert.equal(result.catalogKey,valid.catalogKey);
assert.equal(result.approvalId,'published-shopify-v1:'+valid.productGid.split('/').at(-1));
await db.exec('reset role');
const item=(await db.query('select * from carousel_items where id=$1',[result.itemId])).rows[0];
assert.equal(item.title,valid.copy.title); assert.equal(item.description_html,valid.copy.descriptionHtml); assert.equal(item.source_url,null);
assert.equal(item.catalog_number,valid.exactSku); assert.equal(item.is_active,true); assert.equal(item.cover_image_path,valid.media[0].url);
assert.deepEqual(item.tech_specs,{specs:[{heading:'פרטי מוצר',items:[{label:'מותג',value:"Bric's"}]}],colors:[],category:'suitcase'});
assert.deepEqual((await db.query('select image_path,angle_order,angle_key from carousel_item_angles where item_id=$1 order by angle_order',[result.itemId])).rows,
  valid.media.map((m,i)=>({image_path:m.url,angle_order:i+1,angle_key:i===0?'front':`view-${i+1}`})));
const state=(await db.query('select * from shopify_gallery_sync_state where catalog_key=$1',[valid.catalogKey])).rows[0];
assert.deepEqual(state.gallery_baseline_payload,valid.copy); assert.deepEqual(state.shopify_baseline_payload,valid.copy);
const receipt=(await db.query("select r.*,encode(sha256(convert_to(evidence::text,'UTF8')),'hex') computed from shopify_gallery_product_onboarding_receipts r where product_gid=$1",[valid.productGid])).rows[0];
assert.deepEqual(receipt.evidence,valid); assert.equal(receipt.evidence_sha256,receipt.computed);
assert.equal((await db.query('select enabled from shopify_gallery_copy_eligibility where product_gid=$1',[valid.productGid])).rows[0].enabled,true);
assert.equal((await db.query('select count(*)::int count from shopify_gallery_content_outbox')).rows[0].count,0);
assert.equal((await onboard(valid)).rows[0].result.changed,false); cases+=10;
// Model an uncertain RPC response: the first transaction committed, its caller
// lost the response, then a later claimed delivery re-verifies the same identity.
// The ingestion lane must return the existing identity and not refresh copy.
const laterDelivery=structuredClone(valid); laterDelivery.eventId=randomUUID();
laterDelivery.sourceUpdatedAt=new Date().toISOString(); laterDelivery.verifiedAt=new Date().toISOString();
laterDelivery.copy.title='Newer Shopify copy belongs to the normal copy worker';
laterDelivery.media[0].url='https://cdn.shopify.com/s/files/1/0001/later.png';
await prepare(laterDelivery);
const beforeReplay=await snapshot([...frozenTables,'shopify_gallery_product_onboarding_receipts']);
assert.deepEqual((await onboard(laterDelivery)).rows[0].result,{...result,changed:false});
assert.deepEqual(await snapshot([...frozenTables,'shopify_gallery_product_onboarding_receipts']),beforeReplay);
cases++;
await db.query("update carousel_items set title='Subsequent editor copy',is_active=false where id=$1",[result.itemId]);
await db.query('update shopify_gallery_copy_eligibility set enabled=false where product_gid=$1',[valid.productGid]);
assert.equal((await onboard(valid)).rows[0].result.changed,false);
assert.deepEqual((await db.query('select title,is_active from carousel_items where id=$1',[result.itemId])).rows[0],{title:'Subsequent editor copy',is_active:false});
assert.equal((await db.query('select enabled from shopify_gallery_copy_eligibility where product_gid=$1',[valid.productGid])).rows[0].enabled,false);
await reject({...valid,variantGid:'gid://shopify/ProductVariant/999999999'},/IDEMPOTENCY_CONFLICT/);
await reject({...valid,handle:'different-handle'},/IDEMPOTENCY_CONFLICT/);
await assert.rejects(db.query("update shopify_gallery_product_onboarding_receipts set exact_sku='CHANGED' where product_gid=$1",[valid.productGid]),/IMMUTABLE/);
await assert.rejects(db.query('delete from shopify_gallery_product_onboarding_receipts where product_gid=$1',[valid.productGid]),/IMMUTABLE/);
await assert.rejects(db.query("update shopify_gallery_copy_activations set manifest='{}' where approval_id=$1",[result.approvalId]),/IMMUTABLE/); cases+=6;
const repeated=fixture(); await prepare(repeated);
const sameProduct=await Promise.all([onboard(repeated),onboard(repeated)]);
assert.deepEqual(sameProduct.map(r=>r.rows[0].result.changed).sort(),[false,true]); cases++;
const first=fixture(),second=fixture(); second.exactSku=first.exactSku; second.catalogKey=first.catalogKey;
await prepare(first); await prepare(second);
const competing=await Promise.allSettled([onboard(first),onboard(second)]);
assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);
assert.match(competing.find(r=>r.status==='rejected').reason.message,/GALLERY_SKU_COLLISION/); cases++;
// PGlite serializes a single connection. These queued races test RPC lock/idempotence
// behavior, not a claim of two independent PostgreSQL network sessions.
const after=await snapshot();
for (const table of frozenTables) {
  const existing=after[table].filter(row=>frozen[table].some(old=>JSON.stringify(old)===JSON.stringify(row)));
  assert.deepEqual(existing,frozen[table],`all frozen rows preserved in ${table}`);
}
assert.equal(after.carousel_items.length,85); assert.equal(after.shopify_gallery_copy_eligibility.length,81);
assert.equal(after.shopify_gallery_copy_activations.length,4);
assert.equal((await db.query('select count(*)::int count from shopify_gallery_product_onboarding_receipts')).rows[0].count,3);
await db.exec(sql);
assert.deepEqual(await snapshot(),after,'reapplying migration preserves all content and approvals');
await db.close();
console.log(JSON.stringify({status:'PASS',cases,frozenGalleryRowsPreserved:82,frozenApprovedRowsPreserved:78,newProducts:3,
  initialOutbox:0,externalCalls:0,parallelism:'queued single-connection PGlite; real multi-session concurrency not tested'}));
