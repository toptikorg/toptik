// Offline PostgreSQL execution of the production migration. No external writes.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {PGlite}=await import(pathToFileURL(process.argv[2]+'/dist/index.js'));
const db=new PGlite();
const base=readFileSync('supabase/migrations/20260930_shopify_gallery_sync_inbox.sql','utf8');
const runtime=readFileSync('supabase/migrations/20260930_media_transport_runtime.sql','utf8');
const extract=(source,name)=>source.slice(source.indexOf('create '+(source.includes('create or replace function public.'+name)?'or replace ':'')+'function public.'+name)).split(/\$\$;/)[0]+'$$;';
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create table public.carousel_items(id uuid primary key,is_active boolean,content text);
create table public.shopify_gallery_bindings(catalog_key text primary key,carousel_item_id uuid references carousel_items,product_gid text,variant_gid text,product_handle text,is_published boolean,source_updated_at timestamptz,synced_at timestamptz default now());
create table public.shopify_gallery_public_links(catalog_key text primary key,product_handle text,variant_id text,is_published boolean,updated_at timestamptz,
 check(not is_published or (product_handle~'^[A-Za-z0-9א-ת][A-Za-z0-9א-ת-]*$' and variant_id~'^[0-9]+$')));
create table public.shopify_gallery_reconciliation_leases(product_gid text primary key,owner uuid,expires_at timestamptz);
grant select,update on public.shopify_gallery_bindings to service_role;
grant select,insert,update on public.shopify_gallery_public_links to service_role;
`);
await db.exec(extract(base,'acquire_shopify_reconciliation_lease'));
await db.exec(extract(base,'release_shopify_reconciliation_lease'));
await db.exec(extract(runtime,'read_toptik_media_lease'));
await db.exec(`revoke all on function public.read_toptik_media_lease(text,uuid) from public,anon,authenticated;
grant execute on function public.read_toptik_media_lease(text,uuid) to service_role;`);
await db.exec(readFileSync('supabase/migrations/20261012_gallery_publication_sync.sql','utf8'));
const gid='gid://shopify/Product/123',owner='00000000-0000-4000-8000-000000000099';
await db.exec(`insert into carousel_items values('00000000-0000-4000-8000-000000000001',true,'preserve'),('00000000-0000-4000-8000-000000000002',false,'manual'),('00000000-0000-4000-8000-000000000003',true,'gallery-only');
insert into shopify_gallery_bindings(catalog_key,carousel_item_id,product_gid,variant_gid,product_handle,is_published,source_updated_at) values
('SKU1','00000000-0000-4000-8000-000000000001','${gid}','gid://shopify/ProductVariant/1','bag',true,'2026-10-01'),
('SKU2','00000000-0000-4000-8000-000000000002','${gid}','gid://shopify/ProductVariant/2','bag',true,'2026-10-01');`);
const original=(await db.query('select * from carousel_items order by id')).rows;
const call=async(published,variants=[],stamp='2026-10-12T10:00:00Z',who=owner)=>{
 await db.exec('set role service_role');
 try{return (await db.query('select public.refresh_shopify_gallery_publication($1,$2,$3,$4,$5,$6) as changed',[gid,who,published,stamp,published?'תיק-bag':null,variants])).rows[0].changed;}
 finally{await db.exec('reset role');}
};
await assert.rejects(call(false),/MEDIA_LEASE_LOST/);
await db.query('select acquire_shopify_reconciliation_lease($1,$2)',[gid,owner]);
await assert.rejects(call(false,[],undefined,'00000000-0000-4000-8000-000000000088'),/MEDIA_LEASE_LOST/);
assert.equal(await call(false),2);
assert.equal((await db.query('select count(*)::int n from shopify_gallery_public_links where is_published')).rows[0].n,0);
const first=(await db.query('select * from shopify_gallery_public_links order by catalog_key')).rows;
assert.equal(await call(false),0);
assert.deepEqual((await db.query('select * from shopify_gallery_public_links order by catalog_key')).rows,first);
assert.equal(await call(true,['gid://shopify/ProductVariant/1']),1,'same timestamp republishes only existing variant');
assert.deepEqual((await db.query('select is_published from shopify_gallery_bindings order by catalog_key')).rows,[{is_published:true},{is_published:false}]);
await assert.rejects(call(false,[],'2026-09-01'),/STALE_SNAPSHOT/);
assert.equal(await call(false,[],null),1,'confirmed deleted product');
assert.deepEqual((await db.query('select * from carousel_items order by id')).rows,original);
for(const role of ['anon','authenticated']){
 await db.exec('set role '+role);
 await assert.rejects(db.query('select public.refresh_shopify_gallery_publication($1,$2,false,null,null,array[]::text[])',[gid,owner]),/permission denied/);
 await db.exec('reset role');
}
await db.query('select release_shopify_reconciliation_lease($1,$2)',[gid,owner]);
await assert.rejects(call(false),/MEDIA_LEASE_LOST/);
await db.close();
console.log('PASS: SQL roles, missing/wrong/released lease, draft hide, repeated no-op, equal-time republish, removed variant, stale rejection, delete, preserved manual/gallery-only data');
