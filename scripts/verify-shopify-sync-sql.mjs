import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
const engine = process.argv[2];
if (!engine) throw new Error('Usage: node scripts/verify-shopify-sync-sql.mjs <PGlite package directory>');
const { PGlite } = await import(pathToFileURL(engine + '/dist/index.js').href);
const { pgcrypto } = await import(pathToFileURL(engine + '/dist/contrib/pgcrypto.js').href);
const root = fileURLToPath(new URL('../', import.meta.url));
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
// Supabase commonly installs pgcrypto outside public. The sync functions must
// work with their deliberately restricted public,pg_temp search_path.
await db.exec('create schema extensions; create extension pgcrypto with schema extensions;');
for (const migration of ['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql','20260527_carousel_tech_specs_cache.sql','20260620_carousel_item_colors.sql','20260930_shopify_gallery_sync_inbox.sql']) {
  await db.exec(await readFile(root+'supabase/migrations/'+migration,'utf8'));
}
const id='11111111-1111-4111-8111-111111111111';
const product='gid://shopify/Product/123';
const owner='22222222-2222-4222-8222-222222222222';
const nextOwner='33333333-3333-4333-8333-333333333333';
const now='2026-09-30T10:00:00Z';
const later='2026-09-30T10:01:00Z';
const item={id,title:'Original',description:'Text',catalog_number:'P10SZV24-05J-TU',cover_image_path:'real.webp',display_order:1,is_active:true,seo_title:null,seo_description:null,copy_updated_at:now,tech_specs:{specs:[]},color:'Yellow'};
const save=(items,versions)=>db.query('select * from save_gallery_items_with_copy_cas($1::jsonb,$2::jsonb)',[JSON.stringify(items),JSON.stringify(versions)]);
await save([item],{[id]:null});
assert.equal((await db.query('select title from carousel_items')).rows[0].title,'Original');
assert.equal((await db.query('select catalog_key from shopify_gallery_content_outbox')).rows[0].catalog_key,'P10SZV2405J');
await assert.rejects(save([{...item,title:'Stale',copy_updated_at:later}],{[id]:'2026-09-30T09:00:00Z'}),/SYNC_COPY_STALE_EDIT_RELOAD/);
assert.equal((await db.query('select title from carousel_items')).rows[0].title,'Original');
await save([{...item,title:'Edited',copy_updated_at:later}],{[id]:now});
assert.equal((await db.query('select count(*)::int as n from shopify_gallery_content_outbox')).rows[0].n,2);
await save([{...item,title:'Edited',copy_updated_at:later,display_order:2}],{[id]:later});
await assert.rejects(save([],{[id]:later}),/SYNC_GALLERY_DELETE_REQUIRES_ARCHIVE/);
assert.equal((await db.query('select count(*)::int as n from carousel_items')).rows[0].n,1,'canary refuses deletion');
assert.equal((await db.query('select count(*)::int as n from shopify_gallery_content_outbox')).rows[0].n,2,'unchanged copy does not enqueue');
assert.equal((await db.query('select display_order from carousel_items')).rows[0].display_order,2,'non-copy changes preserved');
await db.query('select upsert_shopify_gallery_binding($1,$2,$3,$4,$5,$6,$7)', ['P10SZV2405J',id,product,'gid://shopify/ProductVariant/456','real-product',true,now]);
assert.equal((await db.query('select acquire_shopify_reconciliation_lease($1,$2) as acquired',[product,owner])).rows[0].acquired,true);
assert.equal((await db.query('select acquire_shopify_reconciliation_lease($1,$2) as acquired',[product,nextOwner])).rows[0].acquired,false);
await assert.rejects(save([{...item,title:'Blocked',copy_updated_at:later}],{[id]:later}),/SYNC_COPY_BUSY_RETRY/);
await db.query('select release_shopify_reconciliation_lease($1,$2)',[product,nextOwner]);
assert.equal((await db.query('select count(*)::int as n from shopify_gallery_reconciliation_leases')).rows[0].n,1,'wrong owner cannot release');
await db.query('select release_shopify_reconciliation_lease($1,$2)',[product,owner]);
await db.exec("create function reject_outbox() returns trigger language plpgsql as $$ begin raise exception 'FORCED_OUTBOX_FAILURE'; end; $$; create trigger reject_outbox before insert on shopify_gallery_content_outbox for each row execute function reject_outbox();");
await assert.rejects(save([{...item,title:'Must roll back',copy_updated_at:'2026-09-30T10:02:00Z'}],{[id]:later}),/FORCED_OUTBOX_FAILURE/);
assert.equal((await db.query('select title from carousel_items')).rows[0].title,'Edited','outbox failure rolls back copy');
await db.exec('drop trigger reject_outbox on shopify_gallery_content_outbox;');
const privateTables = ['shopify_webhook_events','shopify_gallery_bindings','shopify_gallery_content_outbox',
  'shopify_gallery_sync_state','shopify_gallery_sync_conflicts','shopify_gallery_reconciliation_leases'];
// Execute the worker's direct table access as service_role, not as superuser.
await db.exec('set role service_role');
await db.query(`insert into shopify_webhook_events(delivery_id,topic,shop_domain,payload)
  values ('permission-probe','products/update','test.myshopify.com','{}')`);
await db.query("update shopify_webhook_events set status='processed' where delivery_id='permission-probe'");
assert.equal((await db.query("select status from shopify_webhook_events where delivery_id='permission-probe'")).rows[0].status,'processed');
await db.query("update shopify_gallery_content_outbox set status='synced' where carousel_item_id=$1",[id]);
assert.equal((await db.query("select status from shopify_gallery_content_outbox where carousel_item_id=$1 limit 1",[id])).rows[0].status,'synced');
await db.query(`insert into shopify_gallery_content_outbox(carousel_item_id,catalog_key,content_hash,payload)
  values ($1,'P10SZV2405J','permission-probe','{}')`,[id]);
await db.query(`insert into shopify_gallery_sync_state(catalog_key,last_synced_payload,last_synced_hash)
  values ('P10SZV2405J','{}','probe') on conflict(catalog_key) do update set last_synced_hash=excluded.last_synced_hash`);
await db.query("update shopify_gallery_sync_state set last_synced_hash='updated' where catalog_key='P10SZV2405J'");
assert.equal((await db.query("select last_synced_hash from shopify_gallery_sync_state where catalog_key='P10SZV2405J'")).rows[0].last_synced_hash,'updated');
assert.equal((await db.query('select catalog_key from shopify_gallery_bindings')).rows[0].catalog_key,'P10SZV2405J');
await db.query(`insert into shopify_gallery_sync_conflicts(conflict_key,catalog_key,carousel_item_id,product_gid,
  field_name,gallery_value,shopify_value,winner,gallery_updated_at,shopify_updated_at)
  values ('permission-probe','P10SZV2405J',$1,$2,'title','Gallery','Shopify','shopify',$3,$3)
  on conflict(conflict_key) do nothing`,[id,product,later]);
assert.equal((await db.query('select count(*)::int as n from shopify_gallery_sync_conflicts')).rows[0].n,1);
assert.equal((await db.query('update carousel_items set seo_title=$1 where id=$2 and copy_updated_at=$3 returning id',['SEO',id,later])).rows[0].id,id);
await assert.rejects(db.query('select * from shopify_gallery_reconciliation_leases'),/permission denied/);
await assert.rejects(db.query("update shopify_gallery_bindings set is_published=false"),/permission denied/);
await assert.rejects(db.query("update shopify_gallery_public_links set is_published=false"),/permission denied/);
assert.equal((await db.query('select acquire_shopify_reconciliation_lease($1,$2) as acquired',[product,owner])).rows[0].acquired,true);
await db.query('select release_shopify_reconciliation_lease($1,$2)',[product,owner]);
await db.exec('reset role');
for (const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`);
  await assert.rejects(save([item],{[id]:later}),/permission denied/);
  await assert.rejects(db.query('select acquire_shopify_reconciliation_lease($1,$2)',[product,owner]),/permission denied/);
  for (const table of privateTables) {
    await assert.rejects(db.query(`select * from ${table}`),/permission denied/);
    await assert.rejects(db.query(`delete from ${table}`),/permission denied/);
  }
  assert.equal((await db.query('select catalog_key from shopify_gallery_public_links')).rows[0].catalog_key,'P10SZV2405J');
  await assert.rejects(db.query("update shopify_gallery_public_links set is_published=false"),/permission denied/);
  await db.exec('reset role');
}
await db.exec(await readFile(root+'supabase/migrations/20260930_shopify_gallery_sync_inbox.sql','utf8'));
console.log('PASS: complete SQL migration compiles and is idempotent with pgcrypto in extensions; create/update/outbox atomicity, unchanged copy, metadata preservation, stale version rejection, deletion rejection, lease contention/ownership, lease-editor exclusion, outbox-failure rollback, service_role direct worker operations, RPC-only leases/binding writes, anon/authenticated private table+RPC denial, public projection read-only.');
await db.close();
