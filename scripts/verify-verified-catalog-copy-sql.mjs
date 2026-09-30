/** Offline execution of the exact reviewed activation and runtime copy RPCs. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [engine, manifestPath, mode] = process.argv.slice(2);
if (!engine || !manifestPath) throw new Error('Usage: node scripts/verify-verified-catalog-copy-sql.mjs <PGlite package> <reviewed manifest> [--pins]');
const { PGlite } = await import(pathToFileURL(engine + '/dist/index.js').href);
const { pgcrypto } = await import(pathToFileURL(engine + '/dist/contrib/pgcrypto.js').href);
const bytes = await readFile(manifestPath), manifest = JSON.parse(bytes);
const db = new PGlite({ extensions: { pgcrypto } });
const hash = (await db.query("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') hash", [JSON.stringify(manifest)])).rows[0].hash;
const sourceHash = createHash('sha256').update(bytes).digest('hex');
if (mode === '--pins') { console.log(JSON.stringify({ hash, sourceHash })); await db.close(); process.exit(0); }
const migration = await readFile(new URL('../supabase/migrations/20260930_verified_catalog_copy_activation.sql', import.meta.url), 'utf8');
assert.ok(migration.includes(hash)); assert.ok(migration.includes(sourceHash));
await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema extensions; create extension pgcrypto with schema extensions;');
for (const name of ['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql','20260527_carousel_tech_specs_cache.sql',
  '20260620_carousel_item_colors.sql','20260930_shopify_gallery_sync_inbox.sql','20260930_shopify_gallery_sync_patch.sql']) {
  await db.exec(await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
}
for (const [index, row] of manifest.expectedGallery.entries()) {
  await db.query(`insert into carousel_items(id,catalog_number,title,description,description_html,seo_title,seo_description,
    copy_updated_at,cover_image_path,display_order,is_active,source_url,tech_specs) values($1,$2,$3,$4,$5,$6,$7,$8,'exact-product.webp',$9,true,'https://manufacturer.example/product',$10)`,
  [row.id,row.catalog_number,row.copy.title,row.copy.description,row.copy.descriptionHtml,row.copy.seoTitle,row.copy.seoDescription,row.copy_updated_at,index+1,JSON.stringify({category:'carryon',weight:'manufacturer evidence'})]);
}
for (const row of manifest.rows.filter(row => row.expectedBinding)) {
  for (const [table, value] of [['shopify_gallery_bindings',row.expectedBinding],['shopify_gallery_sync_state',row.expectedState],['shopify_gallery_public_links',row.expectedPublicLink]]) {
    await db.query(`insert into ${table} select * from jsonb_populate_record(null::${table},$1)`, [JSON.stringify(value)]);
  }
}
await db.exec(migration); await db.exec(migration);
const seed = (value=manifest, enabled=false) => db.query('select activate_shopify_verified_catalog($1::jsonb,$2) result',[JSON.stringify(value),enabled]);
const protectedRows = async () => (await db.query('select verified_copy_protected_tables() value')).rows[0].value;
const states = async () => (await db.query('select to_jsonb(s) value from shopify_gallery_sync_state s order by catalog_key')).rows.map(row=>row.value);
const counts = async () => (await db.query(`select (select count(*)::int from shopify_gallery_bindings) bindings,
  (select count(*)::int from shopify_gallery_sync_state) states,(select count(*)::int from shopify_gallery_public_links) links,
  (select count(*)::int from shopify_gallery_copy_eligibility) eligible,(select count(*)::int from shopify_gallery_copy_activations) approvals,
  (select count(*)::int from shopify_gallery_copy_activation_receipts) receipts,(select count(*)::int from shopify_gallery_content_outbox) outbox`)).rows[0];
const initialCounts=await counts(), initialProtected=await protectedRows(), initialStates=await states();
const existing=manifest.rows.find(row=>row.expectedBinding), fresh=manifest.rows.find(row=>!row.expectedBinding);
const alias=manifest.rows.find(row=>row.gallerySku!==row.shopifySku);
assert.ok(alias, 'fixture includes audited paired alias');
const owner='11111111-1111-4111-8111-111111111111', otherOwner='22222222-2222-4222-8222-222222222222';
const product=fresh.shopifySnapshot.id, variant=fresh.shopifySnapshot.variants[0].id;
const patch = (copy=fresh.galleryCopy, version=fresh.galleryCopyUpdatedAt, sku=fresh.shopifySku) => db.query('select patch_shopify_verified_copy($1,$2,$3,$4,$5,$6,$7::jsonb,$8) result',
  [fresh.galleryItemId,fresh.catalogKey,fresh.gallerySku,product,variant,version,JSON.stringify(copy),sku]);
const apply = (copy=fresh.galleryCopy, version=fresh.galleryCopyUpdatedAt, lease=owner) => db.query('select apply_shopify_verified_copy($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) result',
  [fresh.galleryItemId,fresh.catalogKey,fresh.gallerySku,product,variant,version,JSON.stringify(copy),fresh.shopifySku,lease]);
const authorize = (version=fresh.galleryCopyUpdatedAt,lease=owner) => db.query('select assert_shopify_verified_copy_write($1,$2,$3,$4,$5,$6,$7,$8) result',
  [fresh.galleryItemId,fresh.catalogKey,fresh.gallerySku,product,variant,version,fresh.shopifySku,lease]);
for (const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`);
  for (const call of [()=>seed(),()=>patch(),()=>apply(),()=>authorize(),()=>db.query('select * from shopify_gallery_copy_eligibility'),()=>db.query('select verified_copy_protected_tables()')]) await assert.rejects(call(), /permission denied/);
  for (const table of ['shopify_gallery_copy_activations','shopify_gallery_copy_activation_receipts','shopify_gallery_copy_activation_events']) {
    await assert.rejects(db.query(`select * from ${table}`),/permission denied/);
    await assert.rejects(db.query(`delete from ${table}`),/permission denied/);
  }
  await db.exec('reset role');
}
await db.exec('set role service_role');
await assert.rejects(db.query('delete from shopify_gallery_copy_eligibility'), /permission denied/);
await assert.rejects(db.query('update shopify_gallery_copy_eligibility set enabled=true'), /permission denied/);
await db.exec('reset role');
for (const mutate of [m=>{m.rows[0].shopifySku='UNKNOWN';},m=>{m.rows[1]=m.rows[0];},m=>m.rows.pop(),m=>{m.rows[0].eligibility.allowed_fields.push('price');},m=>{m.rows[0].identityEvidence.liveVariantGid='gid://shopify/ProductVariant/1';}]) {
  const modified=structuredClone(manifest); mutate(modified); await assert.rejects(seed(modified),/SYNC_COPY_ACTIVATION_MANIFEST_MISMATCH/);
}
const rejectChange = async (sql,params,pattern) => {
  await db.exec('begin'); await db.query(sql,params); await assert.rejects(seed(),pattern); await db.exec('rollback');
  assert.deepEqual(await counts(),initialCounts);
};
await rejectChange("update carousel_items set title='Concurrent copy' where id=$1",[fresh.galleryItemId],/CATALOG_CHANGED/);
await rejectChange("update carousel_items set copy_updated_at=copy_updated_at+interval '1 microsecond' where id=$1",[fresh.galleryItemId],/CATALOG_CHANGED/);
await rejectChange("update carousel_items set catalog_number='CHANGED' where id=$1",[fresh.galleryItemId],/CATALOG_CHANGED/);
await rejectChange("update shopify_gallery_sync_state set last_synced_hash='changed' where catalog_key=$1",[existing.catalogKey],/BASELINE_CHANGED/);
await rejectChange("update shopify_gallery_bindings set source_updated_at=source_updated_at+interval '1 second' where catalog_key=$1",[existing.catalogKey],/BASELINE_CHANGED/);
await rejectChange("insert into shopify_gallery_sync_state(catalog_key,last_synced_hash,last_synced_payload) values($1,'conflict','{}')",[fresh.catalogKey],/BINDING_CONFLICT/);
await db.query('select acquire_shopify_reconciliation_lease($1,$2)',[product,owner]);
await assert.rejects(seed(),/SYNC_COPY_BUSY_RETRY/);
await db.query('select release_shopify_reconciliation_lease($1,$2)',[product,owner]);
await db.exec("create function fail_activation_midway() returns trigger language plpgsql as $$ begin if (select count(*) from shopify_gallery_copy_eligibility)>5 then raise exception 'FORCED_ACTIVATION_FAILURE'; end if; return new; end $$; create trigger fail_activation_midway before insert on shopify_gallery_copy_eligibility for each row execute function fail_activation_midway();");
await assert.rejects(seed(),/FORCED_ACTIVATION_FAILURE/);
assert.deepEqual(await counts(),initialCounts); assert.deepEqual(await protectedRows(),initialProtected);
await db.exec('drop trigger fail_activation_midway on shopify_gallery_copy_eligibility');
await db.exec("create function unexpected_activation_outbox() returns trigger language plpgsql as $$ begin insert into shopify_gallery_content_outbox(carousel_item_id,catalog_key,content_hash,payload) values(new.carousel_item_id,new.catalog_key,'unexpected','{}'); return new; end $$; create trigger unexpected_activation_outbox after insert on shopify_gallery_copy_eligibility for each row execute function unexpected_activation_outbox();");
await assert.rejects(seed(),/SYNC_COPY_ACTIVATION_UNEXPECTED_WRITE/);
assert.deepEqual(await counts(),initialCounts);
await db.exec('drop trigger unexpected_activation_outbox on shopify_gallery_copy_eligibility');
for (const handle of ['logoduck-i-טרולי', ...manifest.rows.map(row=>row.shopifySnapshot.handle)]) assert.equal((await db.query('select shopify_safe_product_handle($1) valid',[handle])).rows[0].valid,true,handle);
for (const handle of ['../x','a/b','a\\b','a%b','a?b','a#b','a@b','a:b','a b','a\nb','_a','-a','\u0301a','a💰','a'.repeat(256),'café','e\u0301','שָׁלוֹם','٣','Ⅳ','²','中']) assert.equal((await db.query('select shopify_safe_product_handle($1) valid',[handle])).rows[0].valid,false,handle);
await db.exec('set role service_role');
assert.deepEqual((await seed()).rows[0].result,{changed:true,eligibleCount:78,newBaselineCount:20,enabled:false});
assert.deepEqual(await counts(),{bindings:78,states:78,links:78,eligible:78,approvals:1,receipts:78,outbox:0});
assert.deepEqual(await protectedRows(),initialProtected);
assert.deepEqual((await states()).filter(row=>initialStates.some(old=>old.catalog_key===row.catalog_key)),initialStates,'all58 existing baselines, including active canary, unchanged');
for (const row of manifest.rows.filter(row=>!row.expectedState)) {
  const stored=(await states()).find(state=>state.catalog_key===row.catalogKey);
  assert.deepEqual(stored.gallery_baseline_payload,row.proposedBaseline.gallery_baseline_payload);
  assert.deepEqual(stored.shopify_baseline_payload,row.proposedBaseline.shopify_baseline_payload);
}
await assert.rejects(patch(),/APPROVAL_MISSING_OR_CHANGED/);
assert.deepEqual((await seed()).rows[0].result,{changed:false,eligibleCount:78,newBaselineCount:0,enabled:false});
assert.deepEqual((await seed(manifest,true)).rows[0].result,{changed:true,eligibleCount:78,newBaselineCount:0,enabled:true});
assert.equal((await seed(manifest,true)).rows[0].result.changed,false);
await db.exec('reset role'); await db.exec(migration);
await assert.rejects(db.query("update shopify_gallery_copy_eligibility set exact_shopify_sku='ALTERED' where product_gid=$1",[product]),/IMMUTABLE/);
await assert.rejects(db.query('delete from shopify_gallery_copy_activations'),/IMMUTABLE/);
await db.exec('begin'); await db.query("update shopify_gallery_sync_state set shopify_updated_at=shopify_updated_at+interval '1 second' where catalog_key=$1",[fresh.catalogKey]);
await assert.rejects(seed(manifest,true),/RECEIPT_CHANGED/); await db.exec('rollback');
await db.exec('set role service_role');
await assert.rejects(patch(fresh.galleryCopy,fresh.galleryCopyUpdatedAt,'FORGED-ALIAS'),/APPROVAL_MISSING_OR_CHANGED/);
await assert.rejects(patch({...fresh.galleryCopy,price:'1'}),/PATCH_INVALID/);
await assert.rejects(apply(),/LEASE_LOST/);
await assert.rejects(authorize(),/LEASE_LOST/);
const edited={...fresh.galleryCopy,seoTitle:'Reviewed edit'};
const race=await Promise.allSettled([patch(edited),patch({...edited,seoTitle:'Competing edit'})]);
assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
assert.match(race.find(result=>result.status==='rejected').reason.message,/STALE_EDIT_RELOAD/);
const version=race.find(result=>result.status==='fulfilled').value.rows[0].result.copyUpdatedAt;
assert.equal((await patch(edited,version)).rows[0].result.changed,false);
await db.query('select acquire_shopify_reconciliation_lease($1,$2)',[product,owner]);
assert.equal((await authorize(version)).rows[0].result,true);
await assert.rejects(authorize(version,otherOwner),/LEASE_LOST/);
await assert.rejects(authorize(fresh.galleryCopyUpdatedAt),/STALE_EDIT_RELOAD/);
await assert.rejects(patch({...edited,title:'Busy'},version),/BUSY_RETRY/);
await assert.rejects(apply(edited,version,otherOwner),/LEASE_LOST/);
await assert.rejects(apply(edited,fresh.galleryCopyUpdatedAt),/STALE_EDIT_RELOAD/);
await assert.rejects(apply({...edited,inventory:1},version),/PATCH_INVALID/);
const imported={...edited,description:'Actual Shopify copy',descriptionHtml:'<p>Actual Shopify copy</p>'};
const importedResult=(await apply(imported,version)).rows[0].result;
assert.equal(importedResult.changed,true);
assert.equal((await apply(imported,importedResult.copyUpdatedAt)).rows[0].result.changed,false);
assert.equal((await counts()).outbox,1,'worker copy does not echo into outbox');
await db.query('select release_shopify_reconciliation_lease($1,$2)',[product,owner]);
await assert.rejects(apply(imported,importedResult.copyUpdatedAt),/LEASE_LOST/);
await db.exec('reset role');
await db.query('insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()-interval \'1 second\')',[product,owner]);
await assert.rejects(apply(imported,importedResult.copyUpdatedAt),/LEASE_LOST/);
await db.query('delete from shopify_gallery_reconciliation_leases where product_gid=$1',[product]);
await db.query('update shopify_gallery_copy_eligibility set enabled=false where product_gid=$1',[product]);
await db.query('select acquire_shopify_reconciliation_lease($1,$2)',[product,owner]);
await assert.rejects(apply(imported,importedResult.copyUpdatedAt),/APPROVAL_MISSING_OR_CHANGED/);
await assert.rejects(authorize(importedResult.copyUpdatedAt),/APPROVAL_MISSING_OR_CHANGED/);
await assert.rejects(patch(imported,importedResult.copyUpdatedAt),/APPROVAL_MISSING_OR_CHANGED/);
const actualAlias=(await db.query('select exact_gallery_sku,exact_shopify_sku,alias_evidence from shopify_gallery_copy_eligibility where catalog_key=$1',[alias.catalogKey])).rows[0];
assert.equal(actualAlias.exact_gallery_sku,alias.gallerySku); assert.equal(actualAlias.exact_shopify_sku,alias.shopifySku); assert.deepEqual(actualAlias.alias_evidence,alias.identityEvidence);
await db.close();
console.log('PASS: actual78 activation,82 copy/identity CAS,20 independent inserts,58 preserved,default disabled,explicit enable,idempotence,ACL,immutable aliases,rollback,no initial writes/outbox,Unicode handles,owned lease,concurrent edit CAS,no worker echo.');
