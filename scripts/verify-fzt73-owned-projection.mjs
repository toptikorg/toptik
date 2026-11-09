import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Isolated in-memory PostgreSQL WASM only; pass the installed PGlite directory.
const engine = process.argv[2];
if (!engine) throw new Error('Usage: node scripts/verify-fzt73-owned-projection.mjs <PGlite package directory>');
const { PGlite } = await import(pathToFileURL(engine + '/dist/index.js').href);
const { pgcrypto } = await import(pathToFileURL(engine + '/dist/contrib/pgcrypto.js').href);
const root = fileURLToPath(new URL('../', import.meta.url));
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema extensions; create extension pgcrypto with schema extensions;');
for (const file of ['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql',
  '20260527_carousel_tech_specs_cache.sql','20260620_carousel_item_colors.sql',
  '20260930_shopify_gallery_sync_inbox.sql','20261001_gallery_editor_cas.sql']) {
  await db.exec(await readFile(root + 'supabase/migrations/' + file, 'utf8'));
}
const id = '341df0c7-7a31-4e77-87c0-a683082c3cd7';
const sku = 'P10FZT73001';
const product = 'gid://shopify/Product/7524873044218';
const variant = 'gid://shopify/ProductVariant/42361904398586';
const owner = '11111111-1111-4111-8111-111111111111';
const version = '2026-10-01T12:00:00.000Z';
const angle = '22222222-2222-4222-8222-222222222222';
const blackUrls=[
  'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_01.jpg?v=1643057405',
  'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_02.jpg?v=1643057423',
  'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_03.jpg?v=1643057436',
  'https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_04.jpg?v=1643057448'];
await db.query(`insert into public.carousel_items(id,title,description,description_html,seo_title,seo_description,
  catalog_number,cover_image_path,cover_image_alt,display_order,is_active,copy_updated_at)
  values($1,'Black','description','<p>description</p>','SEO','Description',$2,$4,'Black',1,true,$3)`,[id,sku,version,blackUrls[0]]);
await db.query(`insert into public.carousel_item_angles(id,item_id,angle_key,angle_order,image_path,image_alt)
  values($1,$2,'1',1,$3,'Black')`,[angle,id,blackUrls[0]]);
for(let i=1;i<blackUrls.length;i++) await db.query(`insert into public.carousel_item_angles(id,item_id,angle_key,angle_order,image_path,image_alt)
 values(gen_random_uuid(),$1,$2,$3,$4,'Black')`,[id,String(i+1),i+1,blackUrls[i]]);
const otherId='78e341a9-90f8-4b5a-a215-8bdf5f4f5321';
await db.query(`insert into public.carousel_items(id,title,catalog_number,cover_image_path,is_active,copy_updated_at)
 values($1,'Blue','P10FZT7308Q','https://example.test/blue.jpg',true,$2)`,[otherId,version]);
await db.query('select public.upsert_shopify_gallery_binding($1,$2,$3,$4,$5,$6,$7)',[sku,id,product,variant,'fzt73',true,version]);
assert.equal((await db.query('select public.acquire_shopify_reconciliation_lease($1,$2) as ok',[product,owner])).rows[0].ok,true);
const row=(await db.query('select * from public.carousel_items where id=$1',[id])).rows[0];
const projected={title:row.title,description:row.description,description_html:row.description_html,seo_title:row.seo_title,
  seo_description:row.seo_description,cover_image_path:row.cover_image_path,cover_image_alt:row.cover_image_alt,
  angles:blackUrls.map((image_path,i)=>({angle_key:String(i+1),angle_order:i+1,image_path,image_alt:'Black'}))};
const initialAngles=(await db.query('select id,item_id,angle_key,angle_order,image_path,image_alt from public.carousel_item_angles where item_id=$1',[id])).rows;
const oldSave=()=>db.query('select * from public.save_gallery_catalog_atomic($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6)',
  [JSON.stringify([{id,title:'Black'}]),JSON.stringify({[id]:version}),JSON.stringify({[id]:row.editor_revision}),
   JSON.stringify(initialAngles),JSON.stringify({autoplay_ms:3500,transition_mode:'shatter-particle'}),1]);
await assert.rejects(oldSave(),/SYNC_COPY_BUSY_RETRY/,'legacy save blocks its own worker lease');
await db.exec(await readFile(root+'supabase/migrations/20261109130444_fzt73_owned_projection.sql','utf8'));
// This new, item-scoped path must accept the actual lease owner when the source
// and gallery are already identical. It must not grant the generic editor path a bypass.
const call=(leaseOwner, data=projected, skuArg=sku, variantArg=variant, itemId=id, revision=row.editor_revision, copyVersion=version)=>
  db.query('select public.apply_fzt73_owned_projection($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as result',
    [product,leaseOwner,itemId,skuArg,variantArg,copyVersion,revision,JSON.stringify(data)]);
await assert.rejects(call(owner,{...projected,title:'Different before baseline'}),/SYNC_FZT73_BASELINE_REQUIRED/);
assert.equal((await db.query('select count(*)::int as n from toptik_fzt73_private.baselines')).rows[0].n,0,
  'baseline cannot be invented when source and gallery disagree');
const first=await call(owner);
assert.equal(first.rows[0].result.status,'baseline_recorded');
await assert.rejects(oldSave(),/SYNC_COPY_BUSY_RETRY/,'editor remains blocked during worker lease');
await assert.rejects(call('33333333-3333-4333-8333-333333333333'),/SYNC_FZT73_LEASE_REQUIRED/);
await assert.rejects(call(owner,projected,'P10FZT7308Q'),/SYNC_FZT73_INPUT_INVALID/);
await assert.rejects(call(owner,projected,sku,variant,id,row.editor_revision+1),/SYNC_COPY_CONCURRENT_UPDATE/);
await db.exec('set role anon');
await assert.rejects(call(owner),/permission denied/);
await db.exec('reset role');
await db.exec('set role authenticated');
await assert.rejects(call(owner),/permission denied/);
await db.exec('reset role');
await db.query(`insert into public.shopify_gallery_content_outbox(carousel_item_id,catalog_key,content_hash,payload,status)
 values($1,$2,'local-test','{}','pending')`,[id,sku]);
await assert.rejects(call(owner),/SYNC_FZT73_BASELINE_REQUIRED/,'pending editorial edit must block source write');
await db.query("delete from public.shopify_gallery_content_outbox where content_hash='local-test'");
const wrongColor={...projected,cover_image_path:'https://example.test/blue.jpg',
  angles:[{...projected.angles[0],image_path:'https://example.test/blue.jpg'},...projected.angles.slice(1)]};
await assert.rejects(call(owner,wrongColor),/SYNC_VARIANT_MEDIA_ASSIGNMENT_REQUIRED/,'a different color cannot be projected');
const updated={...projected,title:'Updated source',cover_image_alt:'Black new',
  angles:projected.angles.map(a=>({...a,image_alt:'Black new'}))};
const entry={itemId:id,catalogKey:sku,variantGid:variant,expectedVersion:version,expectedRevision:row.editor_revision,projection:updated};
const batch=entries=>db.query('select public.apply_fzt73_owned_batch($1,$2,$3::jsonb) as result',[product,owner,JSON.stringify(entries)]);
await db.exec('set role service_role');
await assert.rejects(call(owner,updated),/permission denied/,'single-item function is not callable by service role');
await assert.rejects(batch([entry,{...entry,itemId:otherId,catalogKey:'P10FZT7308Q'}]),/SYNC_FZT73_INPUT_INVALID/);
await db.exec('reset role');
assert.equal((await db.query('select title from public.carousel_items where id=$1',[id])).rows[0].title,'Black','bad second color rolls back first');
await db.exec('set role service_role');
const saved=await batch([entry]);
await db.exec('reset role');
assert.equal(saved.rows[0].result.items[0].result.status,'updated');
const after=(await db.query('select title,is_active,copy_updated_at,editor_revision from public.carousel_items where id=$1',[id])).rows[0];
assert.equal(after.title,'Updated source');
assert.equal(after.is_active,true);
assert.deepEqual((await db.query('select image_path from public.carousel_item_angles where item_id=$1 order by angle_order',[id])).rows.map(r=>r.image_path),blackUrls);
assert.equal((await db.query('select cover_image_path from public.carousel_items where id=$1',[otherId])).rows[0].cover_image_path,'https://example.test/blue.jpg','another color is untouched');
assert.equal((await db.query('select count(*)::int as n from public.shopify_gallery_content_outbox where carousel_item_id=$1',[id])).rows[0].n,0);
const changedVersion=new Date(after.copy_updated_at).toISOString();
await db.query('update public.carousel_items set title=$2 where id=$1',[id,'Editorial choice']);
const edited=(await db.query('select editor_revision from public.carousel_items where id=$1',[id])).rows[0];
await assert.rejects(call(owner,updated,sku,variant,id,edited.editor_revision,changedVersion),/SYNC_FZT73_EDITORIAL_CHANGED/);
assert.equal((await db.query('select title from public.carousel_items where id=$1',[id])).rows[0].title,'Editorial choice');
await db.query('update public.carousel_items set is_active=false where id=$1',[id]);
const hidden=(await db.query('select editor_revision from public.carousel_items where id=$1',[id])).rows[0];
await assert.rejects(call(owner,updated,sku,variant,id,hidden.editor_revision,changedVersion),/SYNC_FZT73_REMOVED_OR_HIDDEN/);
assert.equal((await db.query('select is_active from public.carousel_items where id=$1',[id])).rows[0].is_active,false);
await db.query("update public.shopify_gallery_reconciliation_leases set expires_at=clock_timestamp()-interval '1 second' where product_gid=$1",[product]);
await assert.rejects(call(owner,updated,sku,variant,id,hidden.editor_revision,changedVersion),/SYNC_FZT73_LEASE_REQUIRED/);
// A separate explicit adoption must capture the exact current image/copy and
// specific outbox evidence, keep an immutable audit, and never label discard synced.
await db.query('update public.carousel_items set is_active=true where id=$1',[id]);
await db.query("update public.shopify_gallery_reconciliation_leases set expires_at=clock_timestamp()+interval '2 minutes' where product_gid=$1",[product]);
const before=(await db.query('select copy_updated_at,editor_revision from public.carousel_items where id=$1',[id])).rows[0];
const outboxId='55555555-5555-4555-8555-555555555555',outboxHash='b'.repeat(64),outboxCreated='2026-11-09T12:00:00Z';
await db.query("insert into public.shopify_gallery_content_outbox(id,carousel_item_id,catalog_key,content_hash,payload,status,created_at) values($1,$2,$3,$4,'{}','review',$5)",[outboxId,id,sku,outboxHash,outboxCreated]);
const manifest={productGid:product,action:'adopt_shopify_source',entries:[{itemId:id,catalogKey:sku,variantGid:variant,
  expectedVersion:new Date(before.copy_updated_at).toISOString(),expectedRevision:before.editor_revision,
  before:{...updated,title:'Editorial choice'},projection:updated,
  outbox:[{id:outboxId,contentHash:outboxHash,createdAt:outboxCreated,status:'review',payload:{},decision:'discarded'}]}]};
const approval='66666666-6666-4666-8666-666666666666';
const approvalEvidence={approvedBy:'Tal',approvedAt:'2026-11-09T12:30:00Z',reviewReference:'local-test-only'};
const manifestHash=(await db.query("select encode(pg_catalog.sha256(pg_catalog.convert_to(($1::jsonb)::text,'UTF8')),'hex') as h",[JSON.stringify(manifest)])).rows[0].h;
const adopt=(m=manifest,h=manifestHash)=>db.query('select public.resolve_fzt73_source_adoption($1,$2,$3,$4::jsonb,$5,$6::jsonb) as receipt',
  [product,owner,approval,JSON.stringify(m),h,JSON.stringify(approvalEvidence)]);
const withoutOutbox={...manifest,entries:[{...manifest.entries[0],outbox:[]}]};
const hashFor=async m=>(await db.query("select public.fingerprint_fzt73_adoption_manifest($1::jsonb) as h",[JSON.stringify(m)])).rows[0].h;
await assert.rejects(db.query('select public.resolve_fzt73_source_adoption($1,$2,$3,$4::jsonb,$5,$6::jsonb)',
  [product,owner,approval,JSON.stringify(manifest),manifestHash,JSON.stringify({...approvalEvidence,approvedAt:null})]),/SYNC_FZT73_MANIFEST_INVALID/);
await assert.rejects(adopt(withoutOutbox,await hashFor(withoutOutbox)),/SYNC_FZT73_OUTBOX_CHANGED/);
const staleManifest={...manifest,entries:[{...manifest.entries[0],expectedRevision:before.editor_revision-1}]};
await assert.rejects(adopt(staleManifest,await hashFor(staleManifest)),/SYNC_COPY_CONCURRENT_UPDATE/);
assert.equal((await db.query('select count(*)::int as n from toptik_fzt73_private.adoption_audit')).rows[0].n,0,'rejected review cannot leave an audit or partial change');
await db.exec('set role anon');
await assert.rejects(adopt(),/permission denied/);
await db.exec('reset role');
const adopted=(await adopt()).rows[0].receipt;
assert.equal(adopted.status,'adopted');
assert.equal((await db.query('select title from public.carousel_items where id=$1',[id])).rows[0].title,'Updated source');
assert.equal((await db.query('select status from public.shopify_gallery_content_outbox where id=$1',[outboxId])).rows[0].status,'review');
assert.equal((await db.query('select count(*)::int as n from toptik_fzt73_private.adoption_audit')).rows[0].n,1);
assert.equal((await adopt()).rows[0].receipt.status,'adopted','same approval is idempotent');
await assert.rejects(db.query('select public.read_fzt73_adoption_receipt($1,$2,$3::jsonb)',
  [approval,manifestHash,JSON.stringify({...approvalEvidence,reviewReference:'different'})]),/SYNC_FZT73_APPROVAL_CONFLICT/,
  'approval evidence cannot silently change on replay');
await assert.rejects(adopt({...manifest,entries:[{...manifest.entries[0],before:{...manifest.entries[0].before,title:'tampered'}}]}),/SYNC_FZT73_MANIFEST_MISMATCH/);
await db.query("update public.shopify_gallery_content_outbox set payload='{\"title\":\"new\"}'::jsonb where id=$1",[outboxId]);
const alteredPayload=(await db.query('select copy_updated_at,editor_revision from public.carousel_items where id=$1',[id])).rows[0];
await assert.rejects(call(owner,updated,sku,variant,id,alteredPayload.editor_revision,new Date(alteredPayload.copy_updated_at).toISOString()),/SYNC_FZT73_BASELINE_REQUIRED/,
  'same ID and hash with changed payload is not treated as discarded');
await db.query("update public.shopify_gallery_content_outbox set payload='{}'::jsonb,created_at=clock_timestamp(),status='pending' where id=$1",[outboxId]);
const fresh=(await db.query('select copy_updated_at,editor_revision from public.carousel_items where id=$1',[id])).rows[0];
await assert.rejects(call(owner,updated,sku,variant,id,fresh.editor_revision,new Date(fresh.copy_updated_at).toISOString()),/SYNC_FZT73_BASELINE_REQUIRED/,
  'reused outbox ID with a new generation must not inherit discarded status');
await db.close();
console.log('PASS: legacy self-lock reproduced and scoped owner projection succeeds');
