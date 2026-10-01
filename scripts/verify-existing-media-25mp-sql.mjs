/** Offline real-migration integration. No network, credentials, or external mutations. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../../..');
const withCommercial = process.argv.includes('--with-commercial');
const repo = path.join(root, 'work/typed-spec-sync-runtime-20260930');
const engine = path.join(root, 'work/sync-sql-validation-20260930/package');
const { PGlite } = await import(pathToFileURL(engine + '/dist/index.js'));
const { pgcrypto } = await import(pathToFileURL(engine + '/dist/contrib/pgcrypto.js'));
const db = new PGlite({ extensions: { pgcrypto } });
const bytes = await readFile(path.join(root, 'outputs/toptik-verified78-copy-activation-manifest-20260930.json'));
const manifest = JSON.parse(bytes);
const captureBytes = await readFile(path.join(root, 'outputs/toptik-verified78-copy-activation-live-20260930/before.json'));
const capture = JSON.parse(captureBytes);
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha(bytes), '73dc8b7b0946266ab647c214126f9e23619f674188989e24fe0811a6200bae10');
const coreCode = stripTypeScriptTypes(await readFile(path.join(repo, 'src/lib/shopify/media-sync-core.ts'), 'utf8'));
const core = await import('data:text/javascript;base64,' + Buffer.from(coreCode).toString('base64'));
let checks = 0;
const eq = (a, b, note) => { assert.deepEqual(a, b, note); checks++; };
const rejects = async (call, pattern) => { await assert.rejects(call, pattern); checks++; };
const query = async (sql, args = []) => (await db.query(sql, args)).rows;
const rpc = async (name, args) => (await query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) result`, args.map(value => value && typeof value === 'object' ? JSON.stringify(value) : value)))[0].result;
const migrations = [];
async function migration(name) {
  const text = await readFile(path.join(repo, 'supabase/migrations', name), 'utf8');
  migrations.push({ name, sha256: sha(text) }); await db.exec(text);
}
process.on('uncaughtException', error => { console.error(JSON.stringify({ status: 'FAIL', message: error.message, where: error.where, position: error.position })); process.exit(1); });
await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;create extension pgcrypto with schema extensions;');
for (const name of ['20260423_carousel_schema.sql', '20260424_carousel_catalog_metadata.sql', '20260527_carousel_tech_specs_cache.sql', '20260620_admin_vault.sql',
  '20260620_carousel_item_colors.sql', '20260930_shopify_gallery_sync_inbox.sql', '20260930_shopify_gallery_sync_patch.sql', '20260930_samsonite_gallery_baseline_seed.sql']) await migration(name);
eq(capture.admin.items.length, 82);
let angleCount = 0;
for (const row of manifest.expectedGallery) {
  const item = capture.admin.items.find(i => i.id === row.id);
  eq(item.catalogNumber, row.catalog_number);
  eq({ title: item.title, description: item.description, descriptionHtml: item.descriptionHtml, seoTitle: item.seoTitle, seoDescription: item.seoDescription }, row.copy);
  eq(Date.parse(item.copyUpdatedAt), Date.parse(row.copy_updated_at));
  await db.query(`insert into carousel_items(id,catalog_number,title,description,description_html,seo_title,seo_description,copy_updated_at,
    cover_image_path,display_order,is_active,source_url,tech_specs,colors) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [item.id, item.catalogNumber, item.title, item.description, item.descriptionHtml, item.seoTitle, item.seoDescription, item.copyUpdatedAt,
    item.coverImagePath, item.displayOrder, item.isActive, item.sourceUrl, item.techSpecs === null ? null : JSON.stringify(item.techSpecs), item.colors === null ? null : JSON.stringify(item.colors)]);
  for (const angle of item.angles) { await db.query('insert into carousel_item_angles(id,item_id,angle_key,image_path,angle_order) values($1,$2,$3,$4,$5)',
    [angle.id, angle.itemId, angle.angleKey, angle.imagePath, angle.angleOrder]); angleCount++; }
}
await db.query('update carousel_settings set autoplay_ms=$1,transition_mode=$2 where id=1', [capture.admin.settings.autoplayMs, capture.admin.settings.transitionMode]);
for (const row of manifest.rows.filter(r => r.expectedBinding)) for (const [table, value] of [
  ['shopify_gallery_bindings', row.expectedBinding], ['shopify_gallery_sync_state', row.expectedState], ['shopify_gallery_public_links', row.expectedPublicLink]]) {
  await db.query(`insert into ${table} select * from jsonb_populate_record(null::${table},$1)`, [JSON.stringify(value)]);
}
await migration('20260930_verified_catalog_copy_activation.sql');
eq((await rpc('activate_shopify_verified_catalog', [manifest, true])).eligibleCount, 78);
for (const name of ['20260930_shopify_public_product_onboarding.sql', '20260930_verified_typed_spec_sync.sql', '20260930_gallery_shopify_draft_creation.sql',
  '20260930_gallery_shopify_pending_intents.sql', '20260930_gallery_shopify_source_imports.sql']) await migration(name);
const protectedTables = (await query(`select schemaname,tablename from pg_tables where schemaname in ('public','toptik_spec_private') order by schemaname,tablename`)).map(r => `${r.schemaname}.${r.tablename}`);
async function protectedSnapshot() {
  const out = {};
  for (const table of protectedTables) out[table] = (await query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) v from ${table} x`))[0].v;
  return out;
}
const frozen = await protectedSnapshot();
const schemaCode = await readFile(path.join(repo, 'supabase/migrations/20260930_media_sync_journal.sql'), 'utf8');
const transportCode = await readFile(path.join(repo, 'supabase/migrations/20260930_media_transport_substeps.sql'), 'utf8');
eq(sha(schemaCode), '54d37c485e90d57bc2ab49c108f474b132c450d7b344366aa2e8aa83c6c831a9');
eq(sha(transportCode), 'ea639a65041c6acf603985d4ccf614edbce827c96a1d273ab068b92dc54e054c');
await db.exec('begin'); await db.exec(schemaCode); await db.exec(transportCode); await db.exec('rollback');
eq((await query("select count(*)::int n from pg_namespace where nspname='toptik_media_private'"))[0].n, 0, 'DDL transaction rollback leaves no private schema');
eq(await protectedSnapshot(), frozen, 'DDL rollback preserves every existing actual-schema row');
await migration('20260930_media_sync_journal.sql'); await migration('20260930_media_transport_substeps.sql');
await migration('20260930_media_transport_runtime.sql');
const commercialTables=[];
if(withCommercial){
 await migration('20260930_gallery_commercial_finalization.sql');
 commercialTables.push(...(await query("select tablename from pg_tables where schemaname='public' and tablename like 'gallery_creation_commercial_%' order by tablename")).map(r=>r.tablename));
 eq(commercialTables.length,6);
 for(const table of commercialTables)eq((await query(`select count(*)::int n from public.${table}`))[0].n,0,'commercial migration creates no jobs/intents/dispatches');
}
eq(await protectedSnapshot(), frozen, 'applying both media migrations changes no existing data');
eq((await query('select count(*)::int n from toptik_media_private.products'))[0].n, 0, 'schema creates no enabled products');
eq((await query('select count(*)::int n from toptik_spec_private.eligibility'))[0].n, 0, 'typed feature remains off');

// Targeted forward-DDL proof: same actual frozen82/78 fixture, no remote calls.
const names=['toptik_media_private.register(text,jsonb)','toptik_media_private.assert_transport_guard(jsonb,jsonb,text)','public.accept_toptik_media_transport(text,uuid,uuid,integer,integer,uuid,jsonb,jsonb)'];
const functions=async()=>query(`select p.oid::text oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,p.proowner::text owner,p.prosecdef,p.proconfig,p.proacl::text acl,p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid=any($1::regprocedure[]) order by p.oid`,[names]);
const beforeFunctions=await functions(),beforeRows=await protectedSnapshot();
const forward=await readFile(path.join(repo,'supabase/migrations/20261001_existing_media_25mp.sql'),'utf8');
await db.exec(forward);await db.exec(forward);
const afterFunctions=await functions();eq(afterFunctions.length,3);
const rollback=await readFile(path.join(root,'outputs/existing-media-25mp-20261001/guarded-rollback.sql'),'utf8');
await db.exec(rollback);eq(await functions(),beforeFunctions,'guarded rollback succeeds before any25MP evidence');await db.exec(forward);
for(let i=0;i<3;i++){
 const before=beforeFunctions[i],after=afterFunctions[i];eq(after,{...before,prosrc:before.prosrc.replace('16000000','25000000')},'only cap changes; owner/security/ACL/signature/OID preserved');
}
eq(await protectedSnapshot(),beforeRows,'forward DDL changes no protected rows');
const row=manifest.rows[0],owner=randomUUID(),contentId=sha('offline-25mp'),approval=randomUUID();
const identity={productId:row.shopifySnapshot.id,variantId:row.shopifySnapshot.variants[0].id,itemId:row.galleryItemId,exactGallerySku:row.gallerySku,exactShopifySku:row.shopifySku,productHandle:row.shopifySnapshot.handle};
await rpc('acquire_shopify_reconciliation_lease',[identity.productId,owner]);
const media={mediaId:'gid://shopify/MediaImage/900001',mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',updatedAt:new Date().toISOString(),alt:'fixture',image:{id:'gid://shopify/ImageSource/900001',url:'https://cdn.shopify.com/s/files/1/0001/offline.png',width:5000,height:5000}};
const raw={identity,side:'shopify',complete:true,revision:'',updatedAt:media.updatedAt,media:[media],variantMediaIds:[media.mediaId],variantImage:{id:'gid://shopify/ProductImage/900002',url:media.image.url}};
const stampRaw=async raw=>{raw.revision=(await query('select toptik_media_private.raw_transport_fingerprint($1::jsonb) v',[JSON.stringify(raw)]))[0].v;return raw;};
await stampRaw(raw);
const ready=(await query('select toptik_media_private.ready_transport_fingerprint($1::jsonb) v',[JSON.stringify(raw)]))[0].v;
const pair=Object.fromEntries(['gallery','shopify'].map(side=>[side,{identity,side,revision:side==='shopify'?ready:'gallery-old',complete:true,assets:[{key:'existing25',contentId,alt:'fixture',evidenceId:side+'-25'}]}]));
const proofs=['gallery','shopify'].map(side=>({evidenceId:side+'-25',key:'existing25',side,contentId,proof:{platformRef:side==='shopify'?media.mediaId:'fixture25.png',url:side==='shopify'?media.image.url:'https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/fixture25.png',decodedSha256:contentId,mime:'image/png',width:5000,height:5000,byteLength:513139,verifiedAt:new Date().toISOString(),ownership:side==='shopify'?'reference_only':'owned_storage'}}));
await db.exec('set role service_role');
for(const change of [p=>p[0].proof.width=5001,p=>p[0].proof.byteLength=8388609]){const bad=structuredClone(proofs);change(bad);await rejects(rpc('bootstrap_toptik_media',[identity.productId,owner,approval,pair,bad,{evidenceId:'offline25'}]),/MEDIA_PROVENANCE_INVALID/);}
eq((await rpc('bootstrap_toptik_media',[identity.productId,owner,approval,pair,proofs,{evidenceId:'offline25'}])).enabled,false);
await rpc('set_toptik_media_enabled',[identity.productId,owner,randomUUID(),true,approval]);
await db.exec('reset role');
const current=structuredClone(pair);current.gallery.assets[0].alt='changed locally';current.gallery.revision='gallery-new';
const guard={sourceFingerprint:core.mediaSnapshotFingerprint(current.gallery),target:raw,observedAt:new Date().toISOString()};
const checkGuard=g=>db.query('select toptik_media_private.assert_transport_guard($1::jsonb,$2::jsonb,$3)',[JSON.stringify(g),JSON.stringify(identity),'shopify']);
await checkGuard(guard);checks++;
for(const change of [r=>r.media[0].image.width=5001,r=>{r.media[0].image.width=16001;r.media[0].image.height=1;},r=>r.media[0].image.url='https://evil.example/x']){const bad=structuredClone(guard);change(bad.target);await stampRaw(bad.target);await rejects(checkGuard(bad),/MEDIA_TRANSPORT_/);}
const op=randomUUID();await db.exec('set role service_role');
eq((await rpc('reserve_toptik_media_operation',[identity.productId,owner,op,1,current,core.reconcileMedia(pair,current)])).steps,1);
eq((await rpc('begin_toptik_media_step',[identity.productId,owner,op,0,randomUUID(),current])).transportRequired,true);
const phases=['stage_source','create_owned','associate','variant_reassign','detach_old','reorder'];
eq((await rpc('prepare_toptik_media_transport',[identity.productId,owner,op,0,randomUUID(),phases,guard])).status,'ready');
const storagePath=`sync-media/${identity.itemId}/${contentId}.png`;
const request={mutationSha256:'9'.repeat(64),sourceEvidenceId:'shopify-25',storagePath,upsert:false};
const permit=await rpc('begin_toptik_media_transport',[identity.productId,owner,op,0,0,randomUUID(),request,guard]);eq(permit.mayExecute,true);
const artifact={contentId,decodedSha256:contentId,ready:true,url:'https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/'+storagePath,width:5000,height:5000,byteLength:513139,mime:'image/png',storagePath};
const accept=a=>rpc('accept_toptik_media_transport',[identity.productId,owner,op,0,0,randomUUID(),guard,{requestHash:permit.requestHash,readbackSha256:raw.revision,artifact:a}]);
for(const change of [a=>a.height=5001,a=>a.byteLength=8388609,a=>a.decodedSha256='f'.repeat(64)]){const bad=structuredClone(artifact);change(bad);await rejects(accept(bad),/MEDIA_TRANSPORT_ARTIFACT_INVALID/);}
eq((await accept(artifact)).status,'verified');
await rpc('release_shopify_reconciliation_lease',[identity.productId,owner]);await db.exec('reset role');
await rejects(db.exec(rollback),/MEDIA25_ROLLBACK_HAS_LARGE_IMAGE_EVIDENCE/);await db.exec('rollback');eq(await functions(),afterFunctions,'refused rollback keeps25MP-capable functions');eq(await protectedSnapshot(),beforeRows,'only private synthetic test records changed');
for(const role of ['anon','authenticated']){await db.exec('set role '+role);await rejects(db.query('select * from toptik_media_private.provenance'),/permission denied/);await rejects(rpc('read_toptik_media_journal',[identity.productId,owner,null]),/permission denied/);await db.exec('reset role');}
console.log(JSON.stringify({status:'PASS',checks,forwardSha256:sha(forward),existingCatalog:82,existingBindings:78,functionsReplaced:3,ddlReplays:2,externalCalls:0,scope:'real25MP SQL proof/raw transport/artifact acceptance; >25MP/byte/hash/host/ACL rejects; exact other-function-properties and protected rows'}));await db.close();
