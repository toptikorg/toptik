import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// This test refuses anything other than a caller-selected loopback test port.
const [psql,port]=process.argv.slice(2);
if(!psql || port!=='55479') throw new Error('Expected the isolated test psql and port 55479');
const database='fzt73_test_'+randomBytes(6).toString('hex');
const args=['-h','127.0.0.1','-p',port,'-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-q','-t','-A'];
const created=spawnSync(psql,['-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c',`create database ${database}`],{encoding:'utf8'});
if(created.status!==0)throw new Error('Could not create isolated test database: '+created.stderr.slice(-1000));
const run=(sql)=>{const p=spawnSync(psql,args,{input:sql,encoding:'utf8'});if(p.status!==0)throw new Error('local PostgreSQL failed: '+p.stderr.slice(-1200));return p.stdout.trim();};
const asyncSql=(sql)=>{const child=spawn(psql,args,{stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.stdin.end(sql);return new Promise(resolve=>child.on('close',status=>resolve({status,out,err})));};
const root=fileURLToPath(new URL('../',import.meta.url));
let setup="do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if; end $$; create schema extensions; create extension pgcrypto with schema extensions;\n";
for(const file of ['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql','20260527_carousel_tech_specs_cache.sql','20260620_carousel_item_colors.sql','20260930_shopify_gallery_sync_inbox.sql','20261001_gallery_editor_cas.sql','20261109130444_fzt73_owned_projection.sql']) setup+=await readFile(root+'supabase/migrations/'+file,'utf8')+'\n';
run(setup);
const id='341df0c7-7a31-4e77-87c0-a683082c3cd7',sku='P10FZT73001',product='gid://shopify/Product/7524873044218';
const variant='gid://shopify/ProductVariant/42361904398586',owner='11111111-1111-4111-8111-111111111111';
const urls=['https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_01.jpg?v=1643057405','https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_02.jpg?v=1643057423','https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_03.jpg?v=1643057436','https://cdn.shopify.com/s/files/1/0622/8082/7130/products/FZT73_001_04.jpg?v=1643057448'];
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
run(`insert into public.carousel_items(id,title,description,description_html,seo_title,seo_description,catalog_number,cover_image_path,cover_image_alt,is_active,copy_updated_at) values(${quote(id)},'Black','description','<p>description</p>','SEO','Description',${quote(sku)},${quote(urls[0])},'Black',true,'2026-10-01T12:00:00Z');`+
 urls.map((u,i)=>`insert into public.carousel_item_angles(item_id,angle_key,angle_order,image_path,image_alt) values(${quote(id)},${quote(i+1)},${i+1},${quote(u)},'Black');`).join('')+
 `select public.upsert_shopify_gallery_binding(${quote(sku)},${quote(id)},${quote(product)},${quote(variant)},'fzt73',true,'2026-10-01T12:00:00Z');select public.acquire_shopify_reconciliation_lease(${quote(product)},${quote(owner)});`);
const rev=run(`select editor_revision from public.carousel_items where id=${quote(id)}`);
const projection={title:'Black',description:'description',description_html:'<p>description</p>',seo_title:'SEO',seo_description:'Description',cover_image_path:urls[0],cover_image_alt:'Black',angles:urls.map((image_path,i)=>({angle_key:String(i+1),angle_order:i+1,image_path,image_alt:'Black'}))};
const entry={itemId:id,catalogKey:sku,variantGid:variant,expectedVersion:'2026-10-01T12:00:00Z',expectedRevision:Number(rev),projection};
const operation=`select public.apply_fzt73_owned_batch(${quote(product)},${quote(owner)},${quote(JSON.stringify([entry]))}::jsonb);`;
assert.match(run(operation),/baseline_recorded/);
// Lock the same resource held by editor/worker; poll for the granted lock,
// then start a second SQL session and prove it waits instead of bypassing it.
run(`update public.shopify_gallery_reconciliation_leases set expires_at=clock_timestamp()+interval '2 seconds' where product_gid=${quote(product)}`);
const holder=asyncSql("begin; select pg_advisory_xact_lock(hashtext('toptik-gallery-copy-sync')); select pg_sleep(4); commit;");
let found=false;for(let i=0;i<30;i++){if(run("select exists(select 1 from pg_locks where locktype='advisory' and granted)")==='t'){found=true;break;}await new Promise(r=>setTimeout(r,100));}
assert.ok(found,'holder acquired shared advisory lock');
const waiting=await asyncSql(operation);
assert.notEqual(waiting.status,0,'expired owner must be rejected after waiting for lock');
assert.match(waiting.err,/SYNC_FZT73_LEASE_REQUIRED/);
assert.equal((await holder).status,0);
assert.equal(run(`select title from public.carousel_items where id=${quote(id)}`),'Black');
console.log('PASS: PostgreSQL 17 separate sessions respect shared lock and recheck expired owner before any write');
