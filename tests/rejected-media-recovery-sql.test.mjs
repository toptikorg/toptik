import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {fixture,plan,policy,owner,refresh} from './helpers/owned-media-fixture.mjs';
const migrations=['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql','20260527_carousel_tech_specs_cache.sql','20260620_carousel_item_colors.sql','20260930_shopify_gallery_sync_inbox.sql','20261001_gallery_editor_cas.sql','20261109130444_fzt73_owned_projection.sql','20261109150500_md20_owned_projection.sql','20261109202034_owned_group_media_registry.sql'];
const migration='20261110052632_reviewed_media_recovery_and_live_queue_priority.sql';const j=JSON.stringify;
test('restored rejected native write is cancelled with immutable audit only after exact preimage, CAS and approval',{timeout:60000},async t=>{
 const db=new PGlite({extensions:{pgcrypto}});try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;create extension pgcrypto with schema extensions;');
  for(const m of migrations)await db.exec(await readFile('supabase/migrations/'+m,'utf8'));
  const rpc=async(name,args)=>{const r=await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args.map(a=>a&&typeof a==='object'?j(a):a));return r.rows[0].result;};
  const f=fixture(policy.FZT73_PRODUCT_GID),product=f.binding.productGid;
  for(const v of f.source.variants)v.mediaIds=[f.manifest.variants.find(m=>m.variantGid===v.variantGid).coverMediaId];f.source=refresh(f.source);
  for(const [n,v]of f.binding.variants.entries()){
   const p=plan.ownedMediaProjection(f.source,f.manifest,v.itemId);
   await db.query(`insert into public.carousel_items(id,title,description,description_html,seo_title,seo_description,catalog_number,cover_image_path,cover_image_alt,display_order,is_active,copy_updated_at) values($1,'Item','description','<p>description</p>','SEO','Description',$2,$3,$4,$5,true,'2026-10-01T12:00:00Z')`,[v.itemId,v.sku,p.cover_image_path,p.cover_image_alt,n]);
   for(const a of p.angles)await db.query('insert into public.carousel_item_angles(item_id,angle_key,angle_order,image_path,image_alt)values($1,$2,$3,$4,$5)',[v.itemId,a.angle_key,a.angle_order,a.image_path,a.image_alt]);
   await rpc('upsert_shopify_gallery_binding',[v.sku,v.itemId,product,v.variantGid,'fixture-handle',true,'2026-10-01T12:00:00Z']);
  }
  await rpc('acquire_shopify_reconciliation_lease',[product,owner]);
  const get=()=>rpc('read_toptik_owned_media_registry',[product]);
  const entries=ctx=>ctx.cards.map(c=>({itemId:c.itemId,catalogKey:c.catalogKey,variantGid:f.binding.variants.find(v=>v.itemId===c.itemId).variantGid,expectedVersion:c.expectedVersion,expectedRevision:c.expectedRevision,projection:{...c.projection,...plan.ownedMediaProjection(f.source,f.manifest,c.itemId)}}));
  await rpc('apply_fzt73_owned_batch',[product,owner,entries(await get())]);
  const approved={approvedBy:'Tal',approvedAt:'2026-11-10T05:00:00Z',reviewReference:'LOCAL TEST ONLY'};
  await rpc('adopt_toptik_owned_media_registry',[product,owner,randomUUID(),f.source,f.manifest,entries(await get()),approved]);
  const before=await get(),op=randomUUID(),attempt=randomUUID(),requestHash='a'.repeat(64),phase={kind:'variant_append',variantId:f.binding.variants[0].variantGid,mediaRefs:f.manifest.variants[0].orderedMediaIds.slice(1)};
  // Explicit historical fixture: this rejected request was valid under the old
  // transport. Never mutate a production journal to construct this scenario.
  await db.query(`insert into toptik_owned_media_private.operations(id,product_gid,request_hash,map_version,source_fingerprint,command,actor,plan,phases,expected_cards,before_graph,cursor_graph,status)values($1,$2,$3,1,$4,'{}','{}',$5,$6,$7,$8,$8,'review')`,[op,product,requestHash,f.source.fingerprint,j({beforeManifest:f.manifest}),j([phase]),j(before.cards),j(f.source)]);
  await db.query(`insert into toptik_owned_media_private.phase_attempts(operation_id,phase_index,attempt_id,request_hash,request,before_graph,status)values($1,0,$2,$3,$4,$5,'review')`,[op,attempt,requestHash,j({input:{kind:'variant_append'}}),j(f.source)]);
  await db.query(`insert into toptik_owned_media_private.phase_evidence(operation_id,phase_index,evidence_hash,action,artifact)values($1,0,$2,'review',$3)`,[op,'b'.repeat(64),j({reason:'GROUP_MEDIA_WRITE_REJECTED',providerCodes:['TOO_MANY_MEDIA_PER_INPUT_PAIR']})]);
  await db.exec(await readFile('supabase/migrations/'+migration,'utf8'));
  let es=entries(await get());const resolution=randomUUID();
  const proofHash=()=>plan.ownedMediaHash([op,requestHash,1,f.source,es]);
  const resolve=(patch={})=>rpc('resolve_restored_toptik_owned_media_review',[product,owner,op,resolution,1,patch.source??f.source,patch.entries??es,{...approved,packageHash:proofHash(),...patch.approval}]);
  await t.test('anonymous and authenticated roles cannot resolve a review',async()=>{
   const p=await db.query("select has_function_privilege('anon','public.resolve_restored_toptik_owned_media_review(text,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb)','EXECUTE') as anon,has_function_privilege('authenticated','public.resolve_restored_toptik_owned_media_review(text,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb)','EXECUTE') as member");assert.deepEqual(p.rows[0],{anon:false,member:false});
  });
  await t.test('owner approval and exact reviewed package are mandatory',async()=>{
   await assert.rejects(resolve({approval:{approvedBy:'Other'}}),/APPROVAL_REQUIRED/);await assert.rejects(resolve({approval:{packageHash:'f'.repeat(64)}}),/APPROVAL_CHANGED/);
  });
  await t.test('changed source bytes or ALT, missing card and stale CAS are rejected',async()=>{
   const changed=structuredClone(f.source);changed.media[0].alt+=' different';const fresh=refresh(changed);
   await assert.rejects(resolve({source:fresh}),/PREIMAGE_REQUIRED/);
   await assert.rejects(resolve({entries:es.slice(1)}),/ENTRIES_INVALID/);
   const stale=structuredClone(es);stale[0].expectedRevision++;await assert.rejects(resolve({entries:stale}),/CONCURRENT_UPDATE/);
  });
  await t.test('uncertain dispatches and asynchronous reorder attempts cannot be cancelled',async()=>{
   await db.query("update toptik_owned_media_private.phase_attempts set status='uncertain'where operation_id=$1",[op]);await assert.rejects(resolve(),/DISPATCH_UNSAFE/);
   await db.query("update toptik_owned_media_private.phase_attempts set status='review',request=$2 where operation_id=$1",[op,j({input:{kind:'reorder'}})]);await assert.rejects(resolve(),/DISPATCH_UNSAFE/);
   await db.query("update toptik_owned_media_private.phase_attempts set request=$2 where operation_id=$1",[op,j({input:{kind:'variant_append'}})]);
  });
  await t.test('expired or missing lease cannot change terminal state',async()=>{
   await rpc('release_shopify_reconciliation_lease',[product,owner]);await assert.rejects(resolve(),/LEASE_REQUIRED/);await rpc('acquire_shopify_reconciliation_lease',[product,owner]);
  });
  await t.test('exact restoration is audited as cancelled, never as verified or synced',async()=>{
   const result=await resolve();assert.equal(result.status,'cancelled');
   const after=await get();assert.deepEqual(after.cards,before.cards);assert.deepEqual(after.manifest,before.manifest);assert.equal(after.mapVersion,1);assert.equal(after.operation,null);
   const evidence=await db.query('select action,artifact from toptik_owned_media_private.phase_evidence where operation_id=$1',[op]);assert.equal(evidence.rows.length,1);assert.equal(evidence.rows[0].action,'review');assert.equal(evidence.rows[0].artifact.reason,'GROUP_MEDIA_WRITE_REJECTED');
   const event=await db.query('select kind from toptik_owned_media_private.events where request_id=$1',[resolution]);assert.equal(event.rows[0].kind,'restored_rejected_review');
   assert.equal((await resolve()).status,'cancelled');await assert.rejects(resolve({approval:{reviewReference:'Changed package'}}),/REQUEST_CONFLICT/);
   await assert.rejects(db.query('delete from toptik_owned_media_private.events where request_id=$1',[resolution]),/AUDIT_IMMUTABLE/);
  });
  await t.test('new SQL phase guards reject the exact multiple-image append that Shopify rejected live',async()=>{
   const bad={operationId:op,phaseIndex:0,binding:f.binding,beforeFingerprint:f.source.fingerprint,input:{kind:'variant_append',variantId:phase.variantId,mediaIds:phase.mediaRefs},apiVersion:'2026-07'};
   bad.requestHash=plan.ownedMediaHash(bad);
   const r=await db.query('select o from toptik_owned_media_private.operations o where id=$1',[op]);
   await assert.rejects(db.query('select toptik_owned_media_private.assert_request($1::toptik_owned_media_private.operations,0,$2)',[r.rows[0].o,j(bad)]),/SINGLE_IMAGE_REQUIRED/);
  });
  await t.test('SQL accepts only an exact one-primary replacement and rejects a change to another color',async()=>{
   const target=f.source.variants[0],media=f.source.media.find(m=>m.mediaId===f.manifest.variants[0].orderedMediaIds[1]);
   const request={input:{kind:'variant_cover',variantId:target.variantGid,mediaId:media.mediaId}},next=structuredClone(f.source);
   next.variants[0].image={id:'gid://shopify/ProductImage/998877',url:media.image.url};next.variants[0].mediaIds=[media.mediaId];
   const observed=refresh(next);await db.query('select toptik_owned_media_private.assert_delta($1,$2,$3,$4)',[j(request),j(f.source),j(observed),'{}']);
   next.variants[1].mediaIds=[];await assert.rejects(db.query('select toptik_owned_media_private.assert_delta($1,$2,$3,$4)',[j(request),j(f.source),j(refresh(next)),'{}']),/READBACK_MISMATCH/);
  });
  await t.test('signed updates cannot be starved behind a large daily recovery sweep',async()=>{
   await db.exec("insert into public.shopify_webhook_events(id,delivery_id,topic,shop_domain,payload,status,received_at)select md5('recovery-'||n)::uuid,'publication-recovery:2026-11-10:'||n,'products/update','toptikcoil.myshopify.com','{\"id\":1,\"publication_recovery\":true}'::jsonb,'pending','2026-11-10 04:00:00Z' from generate_series(1,240)n");
   const live=randomUUID();await db.query("insert into public.shopify_webhook_events(id,delivery_id,topic,shop_domain,payload,status,received_at)values($1,$2,'products/update','toptikcoil.myshopify.com','{\"id\":7524873044218}'::jsonb,'pending','2026-11-10 05:00:00Z')",[live,randomUUID()]);
   const claimed=await db.query('select id,status,attempts from public.claim_shopify_webhook_events(1)');assert.equal(claimed.rows.length,1);assert.equal(claimed.rows[0].id,live);assert.equal(claimed.rows[0].status,'processing');assert.equal(claimed.rows[0].attempts,1);
   const next=await db.query('select count(*)::int as count from public.claim_shopify_webhook_events(999)');assert.equal(next.rows[0].count,50);
  });
 }finally{await db.close();}
});
