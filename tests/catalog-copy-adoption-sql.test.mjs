import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { loadWrapped, description } from './helpers/owned-edit-harness.mjs';
const engine=pathToFileURL(process.cwd()+'/node_modules/@electric-sql/pglite/dist/').href;
const {PGlite}=await import(engine+'index.js'),{pgcrypto}=await import(engine+'contrib/pgcrypto.js');
const make=await loadWrapped('src/lib/shopify/catalog-copy-adoption.ts',['createHash','assertSafeDescriptionHtml','descriptionTextFromHtml','isSafeShopifyProductHandle','normalizeSyncSku'],['planExistingCopyAdoption']);
const url=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const vendor=await import(url(readFileSync('src/lib/catalog-source/vendor-detect.ts','utf8')));
const rules=(await loadWrapped('src/lib/shopify/sync-rules.ts',['normalizeCatalogKey'],['normalizeSyncSku','isSafeShopifyProductHandle']))(vendor);
const {planExistingCopyAdoption}=make({createHash,...description,...rules});
const owner='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',aid='33333333-3333-4333-8333-333333333333',item='44444444-4444-4444-8444-444444444444';
const source={id:'gid://shopify/Product/123',handle:'ori05500-024',title:'טרולי פורשה',descriptionHtml:'<p>תיאור מאומת</p>',seoTitle:'כותרת SEO',seoDescription:'תיאור SEO',
 status:'ACTIVE',publishedOnPublication:true,vendor:'Porsche Design',productType:'טרולי',updatedAt:'2026-10-20T06:56:42Z',variants:[{id:'gid://shopify/ProductVariant/456',sku:'ORI05500.024',price:'2500',inventoryQuantity:0}],media:[]};
const read=file=>readFileSync('supabase/migrations/'+file,'utf8');
function exactFunction(file,name){const s=read(file),start=s.search(new RegExp('create(?: or replace)? function public\\.'+name+'\\('));assert.ok(start>=0,name);return s.slice(start,s.indexOf('$$;',start)+3);}
test('actual adoption SQL preserves metadata, enforces review/CAS/lease and never lowers a poisoned watermark',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  for(const file of ['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql','20260527_carousel_tech_specs_cache.sql','20260620_carousel_item_colors.sql','20260930_shopify_gallery_sync_inbox.sql','20261001_gallery_editor_cas.sql','20260930_verified_catalog_copy_activation.sql'])await db.exec(read(file));
  await db.exec(exactFunction('20260930_media_transport_runtime.sql','read_toptik_media_lease'));
  await db.exec(exactFunction('20260930_gallery_commercial_finalization.sql','commercial_canonical'));
  await db.exec(read('20261109202211_catalog_copy_reviewed_adoption.sql'));
  async function seed(mode='preserve_both'){
   await db.query("insert into public.carousel_items(id,title,description,cover_image_path,catalog_number,display_order,is_active) values($1,'Porsche Carry-On','Legacy text','https://example.test/old.jpg','ORI05500.024',23,true)",[item]);
   await db.query("insert into public.shopify_gallery_bindings(catalog_key,carousel_item_id,product_gid,variant_gid,product_handle,is_published,source_updated_at) values('ORI05500024',$1,$2,'gid://shopify/ProductVariant/456','ori05500-024',true,'2026-10-31T23:43:29.091554Z')",[item,source.id]);
   await db.query("insert into public.shopify_gallery_public_links(catalog_key,product_handle,variant_id,is_published) values('ORI05500024','ori05500-024','456',true)");
   assert.equal((await db.query('select public.acquire_shopify_reconciliation_lease($1,$2) ok',[source.id,owner])).rows[0].ok,true);
   const rows=(await db.query("select to_jsonb(c) gallery,to_jsonb(b) binding,to_jsonb(l) link from public.carousel_items c join public.shopify_gallery_bindings b on b.carousel_item_id=c.id join public.shopify_gallery_public_links l using(catalog_key) where c.id=$1",[item])).rows[0];
   const plan=planExistingCopyAdoption({shopDomain:'toptikcoil.myshopify.com',source,gallery:rows.gallery,binding:rows.binding,publicLink:rows.link,approval:null,state:null,unresolvedOutbox:[]},mode);
   const approval={approvalId:aid,planHash:plan.planHash,sourceHash:plan.sourceHash,galleryHash:plan.galleryHash,observedSourceWatermark:plan.observedSourceWatermark,actorId:actor,approvedAt:new Date().toISOString(),reviewReference:'explicit reviewed fixture'};
   return {plan,approval,rows};
  }
  const apply=(f,lease=owner)=>db.query('select public.commit_reviewed_copy_adoption($1::jsonb,$2::jsonb,$3::uuid) receipt',[JSON.stringify(f.plan),JSON.stringify(f.approval),lease]);
  for(const mode of ['preserve_both','adopt_shopify'])await t.test(mode+' commits exact selected copy, independent baselines and one immutable receipt',async()=>{
   await db.exec('begin');try{const f=await seed(mode);
    const fingerprint=(await db.query("select public.fingerprint_reviewed_copy_adoption($1::jsonb-'planHash') hash",[JSON.stringify(f.plan)])).rows[0].hash;assert.equal(fingerprint,f.plan.planHash);
    await db.exec('set local role service_role');const result=(await apply(f)).rows[0].receipt;assert.equal(result.planHash,f.plan.planHash);
    const replay=(await apply(f)).rows[0].receipt;assert.deepEqual(replay,result);
    await db.exec('reset role');const row=(await db.query('select to_jsonb(c) gallery,to_jsonb(b) binding,to_jsonb(s) state from public.carousel_items c join public.shopify_gallery_bindings b on b.carousel_item_id=c.id join public.shopify_gallery_sync_state s using(catalog_key) where c.id=$1',[item])).rows[0];
    assert.equal(row.binding.source_updated_at,f.rows.binding.source_updated_at);assert.equal(row.gallery.display_order,23);assert.equal(row.gallery.cover_image_path,f.rows.gallery.cover_image_path);
    assert.equal(row.gallery.title,mode==='adopt_shopify'?source.title:'Porsche Carry-On');assert.deepEqual(row.state.gallery_baseline_payload,f.plan.proposedGalleryCopy);assert.deepEqual(row.state.shopify_baseline_payload,f.plan.shopifyCopy);
    assert.equal(row.state.last_synced_hash,createHash('sha256').update(JSON.stringify(f.plan.proposedGalleryCopy)).digest('hex'));
    assert.equal((await db.query('select count(*)::int n from toptik_copy_adoption_private.receipts')).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from public.shopify_gallery_content_outbox')).rows[0].n,0,'adoption never manufactures an outbound edit');
   }finally{await db.exec('rollback');}
  });
  for(const kind of ['review','gallery','watermark','open-edit','lease'])await t.test(kind+' drift refuses all writes atomically',async()=>{
   await db.exec('begin');try{const f=await seed('adopt_shopify');
    if(kind==='review')f.approval.planHash='bad';
    if(kind==='gallery')await db.query("update public.carousel_items set title='Independent edit' where id=$1",[item]);
    if(kind==='watermark')await db.query("update public.shopify_gallery_bindings set source_updated_at='2026-11-01T00:00:00Z' where catalog_key='ORI05500024'");
    if(kind==='open-edit')await db.query("insert into public.shopify_gallery_content_outbox(carousel_item_id,catalog_key,content_hash,payload,status) values($1,'ORI05500024','held','{}','review')",[item]);
    await db.exec('savepoint before_attempt');await assert.rejects(apply(f,kind==='lease'?actor:owner),/COPY_ADOPTION_REVIEW_REQUIRED|COPY_ADOPTION_OBSERVATION_CHANGED|MEDIA_LEASE_LOST/);await db.exec('rollback to before_attempt');
    assert.equal((await db.query('select count(*)::int n from public.shopify_gallery_copy_eligibility')).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from toptik_copy_adoption_private.receipts')).rows[0].n,0);
   }finally{await db.exec('rollback');}
  });
  await t.test('anonymous/session roles have no adoption capability or private receipt access',async()=>{
   for(const role of ['anon','authenticated']){await db.exec('begin');try{await db.exec('set local role '+role);
    await db.exec('savepoint denied');await assert.rejects(db.query('select public.read_reviewed_copy_adoption_receipt($1)',[aid]),/permission denied/);await db.exec('rollback to denied');
    await assert.rejects(db.query('select * from toptik_copy_adoption_private.receipts'),/permission denied/);
   }finally{await db.exec('rollback');}}
  });
  await t.test('stale publication reads perform zero writes only for an already identical binding and public link',async()=>{
   await db.exec('begin');try{const f=await seed();const call=(published=true,handle='ori05500-024',variants=['gid://shopify/ProductVariant/456'])=>db.query('select public.refresh_shopify_gallery_publication($1,$2,$3,$4,$5,$6::text[]) n',[source.id,owner,published,source.updatedAt,handle,variants]);
    assert.equal((await call()).rows[0].n,0);assert.deepEqual((await db.query("select to_jsonb(b) row from public.shopify_gallery_bindings b where catalog_key='ORI05500024'")).rows[0].row,f.rows.binding);
    assert.deepEqual((await db.query("select to_jsonb(l) row from public.shopify_gallery_public_links l where catalog_key='ORI05500024'")).rows[0].row,f.rows.link);
    for(const args of [[false,null,[]],[true,'new-handle',['gid://shopify/ProductVariant/456']],[true,'ori05500-024',[]]]){await db.exec('savepoint stale');await assert.rejects(call(...args),/SYNC_PUBLICATION_STALE_SNAPSHOT/);await db.exec('rollback to stale');}
    await db.query("update public.shopify_gallery_public_links set is_published=false where catalog_key='ORI05500024'");await db.exec('savepoint mismatch');await assert.rejects(call(),/SYNC_PUBLICATION_STALE_SNAPSHOT/);await db.exec('rollback to mismatch');
   }finally{await db.exec('rollback');}
  });
 }finally{await db.close();}
});
