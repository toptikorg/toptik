/** Execute editor CAS against the existing offline real-schema 82/478/78 fixture.
 * Requires the preserved workspace fixture/PGlite package; no network or live DB.
 * Run from this checkout with bundled Node: node scripts/verify-gallery-editor-cas-sql.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../../..");
const fixtureDir = path.join(root, "work/media-sync-journal-20260930");
const source = await readFile(path.join(fixtureDir, "verify-media-production-chain.mjs"), "utf8");
const marker = "const owner = randomUUID(), other = randomUUID();";
if (source.indexOf(marker) < 0) throw new Error("OFFLINE_SCHEMA_FIXTURE_CHANGED");
const prefix = source.slice(0, source.indexOf(marker))
  .replace("const withCommercial = process.argv.includes('--with-commercial');", "const withCommercial = true;");
const target = path.join(fixtureDir, "generated-gallery-editor-cas.mjs");
const fixture = String.raw`
await migration('20260930_gallery_media_cas.sql');
await migration('20261001_media_planning_runtime.sql');
await migration('20261001_shopify_commerce_edits.sql');
const beforeEditor=await protectedSnapshot();
await migration('20261001_gallery_editor_cas.sql');
const afterEditor=await protectedSnapshot();
const stripEditor=s=>{
 const result=structuredClone(s);
 for(const table of ['public.carousel_items','public.carousel_settings']) result[table]=result[table].map(({editor_revision,...row})=>row);
 return result;
};
eq(stripEditor(afterEditor),beforeEditor,'DDL changes no existing row fields except additive revision defaults');
eq((await query('select count(*)::int n from carousel_items where editor_revision=1'))[0].n,82);
eq((await query('select editor_revision from carousel_settings where id=1'))[0].editor_revision,1);
const allTables=(await query("select schemaname,tablename from pg_tables where schemaname in ('public','toptik_spec_private','toptik_media_private') order by schemaname,tablename")).map(r=>r.schemaname+'.'+r.tablename);
async function allSnapshot(){const out={};for(const t of allTables)out[t]=(await query('select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),\'[]\'::jsonb) v from '+t+' x'))[0].v;return out;}
const stable=await allSnapshot();
const caseResults=[];
async function test(name,fn){await db.exec('begin');try{await fn();await db.exec('rollback');eq(await allSnapshot(),stable,name+': isolated fixture rollback preserves all rows');caseResults.push({name,status:'PASS'});}catch(e){await db.exec('rollback');eq(await allSnapshot(),stable,name+': failure rollback preserves all rows');caseResults.push({name,status:'FAIL',message:e.message.slice(0,1200)});}}
async function rejectLocal(call,pattern){await db.exec('savepoint rejection');try{await rejects(call(),pattern);}finally{await db.exec('rollback to savepoint rejection');await db.exec('release savepoint rejection');}}
async function payload(ids=null){
 const items=(await query('select to_jsonb(x) v from carousel_items x order by id')).map(x=>x.v);
 const selected=ids?items.filter(x=>ids.includes(x.id)):items;
 const angles=(await query('select to_jsonb(x) v from carousel_item_angles x order by item_id,angle_order,id')).map(x=>x.v).filter(x=>selected.some(i=>i.id===x.item_id));
 const settings=(await query('select to_jsonb(x) v from carousel_settings x where id=1'))[0].v;
 return {items:selected,copy:Object.fromEntries(selected.map(x=>[x.id,x.copy_updated_at])),revisions:Object.fromEntries(selected.map(x=>[x.id,x.editor_revision])),angles,
  settings:{autoplay_ms:settings.autoplay_ms,transition_mode:settings.transition_mode},settingsRevision:settings.editor_revision};
}
async function save(p){return db.query('select * from public.save_gallery_catalog_atomic($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7::jsonb)',
 [JSON.stringify(p.items),JSON.stringify(p.copy),JSON.stringify(p.revisions),JSON.stringify(p.angles),JSON.stringify(p.settings),p.settingsRevision,p.mediaActor?JSON.stringify(p.mediaActor):null]);}
async function row(id){return (await query('select * from carousel_items where id=$1',[id]))[0];}
const itemId=manifest.rows.find(x=>x.gallerySku==='BAH08453.001').galleryItemId;
const secondId=manifest.rows.find(x=>x.galleryItemId!==itemId).galleryItemId;
await test('No-op Save All preserves revisions, all 82/478 rows and outbox',async()=>{
 const p=await payload(),before=await allSnapshot();const out=await save(p);eq(out.rows.length,82);eq(await allSnapshot(),before);
});
await test('Authenticated server role can save; browser roles cannot invoke',async()=>{
 const p=await payload([itemId]);
 for(const role of ['anon','authenticated']){await db.exec('set local role '+role);await rejectLocal(()=>save(p),/permission denied/);await db.exec('reset role');}
 await db.exec('set local role service_role');eq((await save(p)).rows.length,1);await db.exec('reset role');
});
const perms=await query("select p.proname,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('save_gallery_catalog_atomic','gallery_editor_revision_bump','gallery_angle_editor_revision_bump') order by p.proname");
eq(perms.length,3);for(const p of perms){eq(p.anon,false);eq(p.authenticated,false);eq(p.service,p.proname==='save_gallery_catalog_atomic');}
for(const [name,edit] of [
 ['copy',p=>{p.items[0].title+=' — בדיקה מקומית';}],
 ['technical specs',p=>{p.items[0].tech_specs={...(p.items[0].tech_specs??{}),offlineFixture:'verified'};}],
 ['cover',p=>{p.items[0].cover_image_path+='?offline=1';}],
 ['cover alt',p=>{p.items[0].cover_image_alt='תמונת מוצר — בדיקה מקומית';}],
 ['angle image',p=>{p.angles[0].image_path+='?offline=1';}],
 ['angle order',p=>{p.angles[0].angle_order+=30;}],
 ['angle alt',p=>{p.angles[0].image_alt='מבט צד';}],
 ['angle insert',p=>{p.angles.push({...p.angles[0],id:randomUUID(),angle_key:'offline-angle',angle_order:29});}],
 ['angle delete',p=>{p.angles.shift();}],
 ])await test(name+' bumps editor revision and rejects old tab',async()=>{
 const p=await payload([itemId]),stale=structuredClone(p),before=await row(itemId);edit(p);await save(p);
 assert.ok((await row(itemId)).editor_revision>before.editor_revision);checks++;
 const saved=await allSnapshot();await rejectLocal(()=>save(stale),/GALLERY_EDITOR_STALE_RELOAD/);eq(await allSnapshot(),saved,'stale request writes nothing');
 if(name==='copy'){const events=await query('select * from shopify_gallery_content_outbox where carousel_item_id=$1',[itemId]);eq(events.length,1);eq(events[0].payload.title,p.items[0].title);}
});
await test('Settings CAS advances only for a real change and rejects stale form',async()=>{
 const p=await payload([itemId]),stale=structuredClone(p);p.settings.autoplay_ms=p.settings.autoplay_ms===3500?4000:3500;await save(p);
 const now=(await query('select * from carousel_settings where id=1'))[0];eq(now.editor_revision,p.settingsRevision+1);
 const saved=await allSnapshot();await rejectLocal(()=>save(stale),/GALLERY_EDITOR_SETTINGS_STALE_RELOAD/);eq(await allSnapshot(),saved);
 const fresh=await payload([itemId]);await save(fresh);eq((await query('select editor_revision from carousel_settings where id=1'))[0].editor_revision,now.editor_revision);
});
await test('Worker copy edit invalidates browser revision',async()=>{
 const p=await payload([itemId]);await db.query('update carousel_items set title=title||$1 where id=$2',[' — worker fixture',itemId]);
 const saved=await allSnapshot();await rejectLocal(()=>save(p),/GALLERY_EDITOR_STALE_RELOAD/);eq(await allSnapshot(),saved);
});
await test('Worker technical spec edit invalidates browser revision',async()=>{
 const p=await payload([itemId]);await db.query('update carousel_items set tech_specs=$1 where id=$2',[JSON.stringify({offline:'worker'}),itemId]);
 const saved=await allSnapshot();await rejectLocal(()=>save(p),/GALLERY_EDITOR_STALE_RELOAD/);eq(await allSnapshot(),saved);
});
await test('Worker angle edit invalidates browser revision',async()=>{
 const p=await payload([itemId]);await db.query('update carousel_item_angles set image_path=image_path||$1 where id=$2',['?worker=1',p.angles[0].id]);
 const saved=await allSnapshot();await rejectLocal(()=>save(p),/GALLERY_EDITOR_STALE_RELOAD/);eq(await allSnapshot(),saved);
});
await test('Missing or spoofed editor revision is rejected',async()=>{
 const p=await payload([itemId]);delete p.revisions[itemId];await rejectLocal(()=>save(p),/REVISION_REQUIRED/);
 p.revisions[itemId]=null;await rejectLocal(()=>save(p),/STALE_RELOAD/);
 p.revisions[itemId]=999999;await rejectLocal(()=>save(p),/STALE_RELOAD/);
});
await test('Foreign angle identity cannot be reassigned',async()=>{
 const p=await payload([itemId]),foreign=(await payload([secondId])).angles[0];p.angles.push({...foreign,item_id:itemId});
 await rejectLocal(()=>save(p),/GALLERY_EDITOR_ANGLE_IDENTITY_CHANGED/);eq(await allSnapshot(),stable);
});
await test('Angle row outside submitted item IDs is rejected',async()=>{
 const p=await payload([itemId]),foreign=(await payload([secondId])).angles[0];p.angles.push(foreign);
 await rejectLocal(()=>save(p),/GALLERY_EDITOR_IDENTITIES_INVALID/);
});
await test('Post-copy angle SQL failure atomically rolls back items, outbox and settings',async()=>{
 const p=await payload([itemId]);p.items[0].title+=' — must roll back';p.settings.autoplay_ms=4500;p.angles[0].image_path=null;
 await rejectLocal(()=>save(p),/null value.*image_path|not-null constraint/);eq(await allSnapshot(),stable);
});
await test('Final settings SQL failure rolls back earlier items, angles and outbox',async()=>{
 await db.exec('alter table carousel_settings add constraint offline_settings_guard check(autoplay_ms<>4500)');
 const p=await payload([itemId]);p.items[0].title+=' — must roll back';p.angles[0].image_path+='?must=rollback';p.settings.autoplay_ms=4500;
 await rejectLocal(()=>save(p),/offline_settings_guard/);eq(await allSnapshot(),stable);
});
await test('Changed item does not alter unrelated 81 rows or other product angles',async()=>{
 const p=await payload([itemId]);p.items[0].title+=' — isolated';await save(p);const after=await allSnapshot();
 eq(after['public.carousel_items'].filter(x=>x.id!==itemId),stable['public.carousel_items'].filter(x=>x.id!==itemId));
 eq(after['public.carousel_item_angles'].filter(x=>x.item_id!==itemId),stable['public.carousel_item_angles'].filter(x=>x.item_id!==itemId));
 for(const table of ['shopify_gallery_bindings','shopify_gallery_copy_eligibility','shopify_gallery_sync_state','shopify_gallery_public_links'])eq(after['public.'+table],stable['public.'+table]);
});
await test('Ordinary SQL cannot forge or roll back revision counters',async()=>{
 await db.query('update carousel_items set editor_revision=999 where id=$1',[itemId]);eq((await row(itemId)).editor_revision,1);
 await db.query('update carousel_items set title=title||$1,editor_revision=999 where id=$2',[' — local',itemId]);eq((await row(itemId)).editor_revision,2);
 await db.query('update carousel_settings set editor_revision=999 where id=1');eq((await query('select editor_revision from carousel_settings where id=1'))[0].editor_revision,1);
});
async function enableFixtureMedia(){
 const entry=manifest.rows.find(x=>x.galleryItemId===itemId),owner=randomUUID();
 const identity={productId:entry.shopifySnapshot.id,variantId:entry.shopifySnapshot.variants[0].id,itemId,
  exactGallerySku:entry.gallerySku,exactShopifySku:entry.shopifySku,productHandle:entry.shopifySnapshot.handle};
 const product=identity.productId,contentId=sha('synthetic-offline-editor-media-proof'),approval=randomUUID();
 const pair=Object.fromEntries(['gallery','shopify'].map(side=>[side,{identity,side,complete:true,revision:'offline-'+side,
  assets:[{key:'offline-editor-image',contentId,alt:'בדיקה מקומית בלבד',evidenceId:'offline-editor-'+side}]}]));
 const proofs=['gallery','shopify'].map(side=>({evidenceId:'offline-editor-'+side,key:'offline-editor-image',side,contentId,proof:{
  platformRef:side==='shopify'?'gid://shopify/MediaImage/990001':'offline-editor',
  url:side==='shopify'?'https://cdn.shopify.com/s/files/1/offline.png':'https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/offline/editor.png',
  decodedSha256:contentId,mime:'image/png',width:10,height:10,byteLength:100,verifiedAt:new Date().toISOString(),ownership:side==='shopify'?'reference_only':'owned_storage'}}));
 await rpc('acquire_shopify_reconciliation_lease',[product,owner]);await rpc('bootstrap_toptik_media',[product,owner,approval,pair,proofs,{evidenceId:'offline-editor-fixture'}]);
 await rpc('set_toptik_media_enabled',[product,owner,randomUUID(),true,approval]);await rpc('release_shopify_reconciliation_lease',[product,owner]);return product;
}
await test('Atomic save queues trusted actor exactly on changes and restores GUC',async()=>{
 const product=await enableFixtureMedia(),actor={actorType:'admin_panel_token',actorId:'configured-admin-panel'};
 await db.query("select set_config('toptik.media_editor_actor','{}',true)");
 const p=await payload([itemId]);p.mediaActor=actor;await save(p);eq((await query('select count(*)::int n from toptik_media_private.work_queue'))[0].n,0);
 p.items[0].cover_image_alt='בדיקת תור';await save(p);
 const queued=(await query('select * from toptik_media_private.work_queue where product_gid=$1',[product]))[0];eq(queued.evidence.gallery,actor);
 eq((await query("select current_setting('toptik.media_editor_actor',true) value"))[0].value,'{}');
 const fresh=await payload([itemId]);fresh.mediaActor=actor;await save(fresh);eq((await query('select generation from toptik_media_private.work_queue where product_gid=$1',[product]))[0].generation,queued.generation);
});
await test('Rollback after transactional media enqueue leaves neither queue nor data change',async()=>{
 await enableFixtureMedia();await db.exec('alter table carousel_settings add constraint offline_queue_guard check(autoplay_ms<>4500)');
 const before=await allSnapshot(),p=await payload([itemId]);p.mediaActor={actorType:'admin_panel_token',actorId:'configured-admin-panel'};
 p.items[0].title+=' — rolls back';p.angles[0].image_alt='זווית';p.settings.autoplay_ms=4500;
 await rejectLocal(()=>save(p),/offline_queue_guard/);eq(await allSnapshot(),before);
 eq((await query('select count(*)::int n from toptik_media_private.work_queue'))[0].n,0);
});
await test('Background media change never acquires merchant deletion authority',async()=>{
 const product=await enableFixtureMedia();await db.query("select set_config('toptik.media_editor_actor','',true)");
 await db.query('update carousel_items set cover_image_alt=$1 where id=$2',['background',itemId]);
 eq((await query('select evidence from toptik_media_private.work_queue where product_gid=$1',[product]))[0].evidence,{});
});
await test('Invalid service-supplied actor is rejected atomically',async()=>{
 await enableFixtureMedia();const before=await allSnapshot(),p=await payload([itemId]);p.mediaActor={actorType:'admin_panel_token',actorId:'invalid'};p.items[0].cover_image_alt='reject';
 await rejectLocal(()=>save(p),/MEDIA_QUEUE_ACTOR_INVALID/);eq(await allSnapshot(),before);
});
eq(await allSnapshot(),stable,'all fixtures leave full actual schema unchanged');
const result={status:caseResults.some(x=>x.status==='FAIL')?'FAIL':'PASS',assertions:checks,migrations:migrations.length,migrationHashes:migrations,caseResults,protectedTables:allTables.length,
 catalog:{products:82,angles:angleCount,enabledCopy:78},externalCalls:0,externalMutations:0,limitations:['Offline PGlite, not a live deployment','Historical verified catalog fixture; timestamps generated by its original setup','No physical-device or external Shopify action tested']};
await writeFile(path.join(root,'outputs/toptik-sync-release-preflight-20261001/qa-gallery-editor-cas-result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,assertions:checks,cases:caseResults.length,failed:caseResults.filter(x=>x.status==='FAIL'),migrations:migrations.length,products:82,angles:angleCount,externalMutations:0}));await db.close();if(result.status==='FAIL')process.exitCode=1;
`;
await writeFile(target, prefix + "\n" + fixture);
await import(pathToFileURL(target).href + "?run=" + Date.now());
