import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const migration=readFileSync('supabase/migrations/20261109102246_fzt73_review_recovery.sql','utf8');
const versions={
 '341df0c7-7a31-4e77-87c0-a683082c3cd7':{editorRevision:2,copyUpdatedAt:'2026-11-01T00:00:00Z'},
 '78e341a9-90f8-4b5a-a215-8bdf5f4f5321':{editorRevision:2,copyUpdatedAt:'2026-11-01T00:00:00Z'},
 '7bd35662-0989-4b96-aafd-f6a77ba6d72f':{editorRevision:2,copyUpdatedAt:'2026-11-01T00:00:00Z'},
 '8890d9f2-d927-42e2-9006-f287a46ef137':{editorRevision:2,copyUpdatedAt:'2026-11-01T00:00:00Z'},
};
const product='gid://shopify/Product/7524873044218', owner='00000000-0000-4000-8000-000000000001';
const current='00000000-0000-4000-8000-000000000002', old='00000000-0000-4000-8000-000000000003';
async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table public.shopify_gallery_reconciliation_leases(product_gid text primary key,owner uuid,expires_at timestamptz);
 create table public.shopify_webhook_events(id uuid primary key,status text,topic text,payload jsonb,received_at timestamptz,processed_at timestamptz,last_error text,shop_domain text default 'toptikcoil.myshopify.com');
 create table public.carousel_items(id uuid primary key,editor_revision bigint,copy_updated_at timestamptz,catalog_number text,title text);
 create table public.shopify_gallery_bindings(catalog_key text primary key,carousel_item_id uuid,variant_gid text,product_gid text,is_published boolean,source_updated_at timestamptz);
 create table public.shopify_gallery_content_outbox(id uuid primary key,carousel_item_id uuid,status text,payload jsonb);`);
 await db.exec(migration);
 const rows=[['341df0c7-7a31-4e77-87c0-a683082c3cd7','P10FZT73001','42361904398586'],['78e341a9-90f8-4b5a-a215-8bdf5f4f5321','P10FZT7308Q','42449044799738'],['7bd35662-0989-4b96-aafd-f6a77ba6d72f','P10FZT7324B','42449044832506'],['8890d9f2-d927-42e2-9006-f287a46ef137','P10FZT7327D','42449044865274']];
 for(const [id,sku,variant] of rows){await db.query('insert into public.carousel_items values ($1,2,$2,$3,$4)',[id,'2026-11-01T00:00:00Z',sku,'editor copy']);await db.query('insert into public.shopify_gallery_bindings values ($1,$2,$3,$4,true,$5)',[sku,id,`gid://shopify/ProductVariant/${variant}`,product,'2026-11-03T00:00:00Z']);}
 await db.query('insert into public.shopify_gallery_reconciliation_leases values ($1,$2,now()+interval \'5 minutes\')',[product,owner]);
 await db.query('insert into public.shopify_webhook_events(id,status,topic,payload,received_at) values ($1,$2,$3,$4,$5)',[current,'processing','products/update',JSON.stringify({id:'7524873044218',publication_recovery:true}),'2026-11-05T00:00:00Z']);
 await db.query('insert into public.shopify_webhook_events(id,status,topic,payload,received_at,processed_at,last_error) values ($1,$2,$3,$4,$5,now(),$6)',[old,'review','products/update',JSON.stringify({id:'7524873044218',updated_at:'2026-11-02T00:00:00Z'}),'2026-11-04T00:00:00Z','SYNC_FZT73_BASELINE_REQUIRED']);
 return db;
}
const run=db=>db.query('select public.close_verified_fzt73_webhook_reviews($1,$2,$3,$4) as n',[current,owner,'2026-11-03T00:00:00Z',JSON.stringify(versions)]);
test('verified equality supersedes older exact webhook review and preserves payload and content',async()=>{const db=await setup();try{
 assert.equal((await run(db)).rows[0].n,1);const e=(await db.query('select * from public.shopify_webhook_events where id=$1',[old])).rows[0];
 assert.equal(e.status,'processed');assert.equal(e.last_error,'SYNC_FZT73_REVIEW_SUPERSEDED_VERIFIED');assert.equal(e.payload.updated_at,'2026-11-02T00:00:00Z');
 assert.equal((await db.query("select count(*)::int as n from public.carousel_items where title='editor copy'")).rows[0].n,4);
}finally{await db.close()}});
test('pending editor outbox blocks old review closure without changing it',async()=>{const db=await setup();try{
 await db.query('insert into public.shopify_gallery_content_outbox values ($1,$2,$3,$4)', ['00000000-0000-4000-8000-000000000004',Object.keys(versions)[0],'review',JSON.stringify({title:'untouched'})]);
 assert.equal((await run(db)).rows[0].n,0);assert.equal((await db.query('select status from public.shopify_webhook_events where id=$1',[old])).rows[0].status,'review');
 assert.equal((await db.query('select status from public.shopify_gallery_content_outbox')).rows[0].status,'review');
}finally{await db.close()}});
test('newer, unknown, other product and malformed webhook reviews remain visible',async()=>{const db=await setup();try{
 const cases=[
  ['00000000-0000-4000-8000-000000000005',{id:'7524873044218',updated_at:'2026-11-04T00:00:00Z'},'2026-11-04T00:00:00Z','SYNC_FZT73_BASELINE_REQUIRED'],
  ['00000000-0000-4000-8000-000000000006',{id:'7524873044218',updated_at:'2026-99-99T00:00:00Z'},'2026-11-04T00:00:00Z','SYNC_FZT73_BASELINE_REQUIRED'],
  ['00000000-0000-4000-8000-000000000007',{id:'OTHER',updated_at:'2026-11-02T00:00:00Z'},'2026-11-04T00:00:00Z','SYNC_FZT73_BASELINE_REQUIRED'],
  ['00000000-0000-4000-8000-000000000008',{id:'7524873044218',updated_at:'2026-11-02T00:00:00Z'},'2026-11-06T00:00:00Z','SYNC_FZT73_BASELINE_REQUIRED'],
  ['00000000-0000-4000-8000-000000000009',{id:'7524873044218',updated_at:'2026-11-02T00:00:00Z'},'2026-11-04T00:00:00Z','OTHER_REVIEW'],
 ];
 for(const [id,payload,received,error] of cases)await db.query('insert into public.shopify_webhook_events(id,status,topic,payload,received_at,processed_at,last_error) values ($1,$2,$3,$4,$5,now(),$6)',[id,'review','products/update',JSON.stringify(payload),received,error]);
 assert.equal((await run(db)).rows[0].n,1);
 for(const [id] of cases)assert.equal((await db.query('select status from public.shopify_webhook_events where id=$1',[id])).rows[0].status,'review');
}finally{await db.close()}});
test('the recovery function is unavailable to anon and authenticated roles',async()=>{const db=await setup();try{
 const rows=(await db.query("select has_function_privilege('anon','public.close_verified_fzt73_webhook_reviews(uuid,uuid,timestamptz,jsonb)','EXECUTE') as anon, has_function_privilege('authenticated','public.close_verified_fzt73_webhook_reviews(uuid,uuid,timestamptz,jsonb)','EXECUTE') as auth, has_function_privilege('service_role','public.close_verified_fzt73_webhook_reviews(uuid,uuid,timestamptz,jsonb)','EXECUTE') as service")).rows;
 assert.deepEqual(rows[0],{anon:false,auth:false,service:true});
}finally{await db.close()}});
for(const [name,change,code] of [
 ['wrong lease',`update public.shopify_gallery_reconciliation_leases set owner='00000000-0000-4000-8000-000000000099'`,'SYNC_RECONCILIATION_LEASE_FAILED'],
 ['stale gallery',`update public.carousel_items set editor_revision=3 where id='341df0c7-7a31-4e77-87c0-a683082c3cd7'`,'SYNC_COPY_CONCURRENT_UPDATE'],
 ['stale binding',`update public.shopify_gallery_bindings set source_updated_at='2026-11-04T00:00:00Z' where catalog_key='P10FZT73001'`,'SYNC_COPY_CONCURRENT_UPDATE'],
 ['changed sku',`update public.carousel_items set catalog_number='OTHER' where id='341df0c7-7a31-4e77-87c0-a683082c3cd7'`,'SYNC_COPY_CONCURRENT_UPDATE'],
 ['not current event',`update public.shopify_webhook_events set status='review' where id='${current}'`,'SYNC_FZT73_RECOVERY_INVALID'],
])test(name+' cannot close an older review',async()=>{const db=await setup();try{await db.exec(change);await assert.rejects(run(db),new RegExp(code));assert.equal((await db.query('select status from public.shopify_webhook_events where id=$1',[old])).rows[0].status,'review');}finally{await db.close()}});
