import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {fixture,plan,policy,owner,refresh} from './helpers/owned-media-fixture.mjs';
const migrations=['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql','20260527_carousel_tech_specs_cache.sql','20260620_carousel_item_colors.sql','20260930_shopify_gallery_sync_inbox.sql','20261001_gallery_editor_cas.sql','20261109130444_fzt73_owned_projection.sql','20261109150500_md20_owned_projection.sql','20261109202034_owned_group_media_registry.sql','20261110052632_reviewed_media_recovery_and_live_queue_priority.sql','20261110060051_verified_owned_reorder_contract.sql'];
const j=JSON.stringify,later='2026-11-10T06:00:00Z';
test('native reorder accepts only moved-object timestamp metadata and audits exact semantic restoration',{timeout:60000},async t=>{
 const db=new PGlite({extensions:{pgcrypto}});try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;create extension pgcrypto with schema extensions;');
  for(const m of migrations)await db.exec(await readFile('supabase/migrations/'+m,'utf8'));
  const rpc=async(name,args)=>{const r=await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args.map(a=>a&&typeof a==='object'?j(a):a));return r.rows[0].result;};
  const f=fixture(policy.FZT73_PRODUCT_GID),product=f.binding.productGid;
  for(const v of f.source.variants)v.mediaIds=[f.manifest.variants.find(m=>m.variantGid===v.variantGid).coverMediaId];f.source=refresh(f.source);
  const added={...structuredClone(f.source.media[0]),mediaId:'gid://shopify/MediaImage/999900',image:{...f.source.media[0].image,id:'gid://shopify/ImageSource/999900',url:'https://cdn.shopify.com/s/files/1/0622/8082/7130/files/new-real-photo.jpg'}};
  const attached=refresh({...structuredClone(f.source),media:[...structuredClone(f.source.media),added]});
  const desired=[attached.media[0],added,...attached.media.slice(1,-1)].map(m=>m.mediaId);
  const reordered=refresh({...structuredClone(attached),media:desired.map((id,i)=>{const m=structuredClone(attached.media.find(m=>m.mediaId===id));if(attached.media.findIndex(m=>m.mediaId===id)!==i)m.updatedAt=later;return m;})});
  const request={input:{kind:'reorder',mediaIds:desired,protectedMediaIds:[]}};
  const delta=(r,b,o)=>db.query('select toptik_owned_media_private.assert_delta($1,$2,$3,$4)',[j(r),j(b),j(o),'{}']);
  await t.test('the exact live shape with moved original images changing updatedAt is accepted',async()=>{await delta(request,attached,reordered);});
  await t.test('unchanged-position timestamps and backwards timestamps remain conflicts',async()=>{
   const unchanged=structuredClone(reordered);unchanged.media[0].updatedAt=later;await assert.rejects(delta(request,attached,refresh(unchanged)),/READBACK_MISMATCH/);
   const backwards=structuredClone(reordered);backwards.media[1].updatedAt='2000-01-01T00:00:00Z';await assert.rejects(delta(request,attached,refresh(backwards)),/READBACK_MISMATCH/);
   const infinite=structuredClone(reordered);infinite.media[1].updatedAt='infinity';await assert.rejects(delta(request,attached,refresh(infinite)),/READBACK_MISMATCH/);
  });
  await t.test('media content, order and another native color remain exact',async()=>{
   for(const [field,value]of [['alt','Changed'],['status','PROCESSING']]){const changed=structuredClone(reordered);changed.media[2][field]=value;await assert.rejects(delta(request,attached,refresh(changed)),/READBACK_MISMATCH|SOURCE_INVALID|SOURCE_NOT_READY/);}
   const url=structuredClone(reordered);url.media[2].image.url+='different';await assert.rejects(delta(request,attached,refresh(url)),/READBACK_MISMATCH/);
   const order=structuredClone(reordered);[order.media[2],order.media[3]]=[order.media[3],order.media[2]];await assert.rejects(delta(request,attached,refresh(order)),/READBACK_MISMATCH/);
   const variant=structuredClone(reordered);variant.variants[1].mediaIds=[];await assert.rejects(delta(request,attached,refresh(variant)),/READBACK_MISMATCH/);
  });
  for(const [n,v]of f.binding.variants.entries()){
   const p=plan.ownedMediaProjection(f.source,f.manifest,v.itemId);
   await db.query(`insert into public.carousel_items(id,title,description,description_html,seo_title,seo_description,catalog_number,cover_image_path,cover_image_alt,display_order,is_active,copy_updated_at)values($1,'Item','description','<p>description</p>','SEO','Description',$2,$3,$4,$5,true,'2026-10-01T12:00:00Z')`,[v.itemId,v.sku,p.cover_image_path,p.cover_image_alt,n]);
   for(const a of p.angles)await db.query('insert into public.carousel_item_angles(item_id,angle_key,angle_order,image_path,image_alt)values($1,$2,$3,$4,$5)',[v.itemId,a.angle_key,a.angle_order,a.image_path,a.image_alt]);
   await rpc('upsert_shopify_gallery_binding',[v.sku,v.itemId,product,v.variantGid,'fixture-handle',true,'2026-10-01T12:00:00Z']);
  }
  await rpc('acquire_shopify_reconciliation_lease',[product,owner]);const get=()=>rpc('read_toptik_owned_media_registry',[product]);
  const entries=ctx=>ctx.cards.map(c=>({itemId:c.itemId,catalogKey:c.catalogKey,variantGid:f.binding.variants.find(v=>v.itemId===c.itemId).variantGid,expectedVersion:c.expectedVersion,expectedRevision:c.expectedRevision,projection:{...c.projection,...plan.ownedMediaProjection(f.source,f.manifest,c.itemId)}}));
  await rpc('apply_fzt73_owned_batch',[product,owner,entries(await get())]);
  const approval={approvedBy:'Tal',approvedAt:later,reviewReference:'LOCAL ISOLATED TEST ONLY'};
  await rpc('adopt_toptik_owned_media_registry',[product,owner,randomUUID(),f.source,f.manifest,entries(await get()),approval]);
  const before=await get(),op=randomUUID(),requestHash='a'.repeat(64),resolution=randomUUID();
  await db.query(`insert into toptik_owned_media_private.operations(id,product_gid,request_hash,map_version,source_fingerprint,command,actor,plan,phases,expected_cards,before_graph,cursor_graph,status,next_phase)values($1,$2,$3,1,$4,'{}','{}',$5,$6,$7,$8,$9,'review',2)`,[op,product,requestHash,f.source.fingerprint,j({beforeManifest:f.manifest}),j([{kind:'create_owned'},{kind:'product_attach'},{kind:'reorder'}]),j(before.cards),j(f.source),j(attached)]);
  const reorderRequest={...request,operationId:op,phaseIndex:2,variables:{moves:[{id:added.mediaId,newPosition:'1'}]}};
  for(const [index,,status,body,artifact]of [[0,'create_owned','verified',{input:{kind:'create_owned'}},{mediaId:added.mediaId,owned:{operationId:op,media:{mediaId:added.mediaId}}}],[1,'product_attach','verified',{input:{kind:'product_attach'}},{}],[2,'reorder','review',reorderRequest,null]])await db.query(`insert into toptik_owned_media_private.phase_attempts(operation_id,phase_index,attempt_id,request_hash,request,before_graph,status,artifact)values($1,$2,$3,$4,$5,$6,$7,$8)`,[op,index,randomUUID(),'b'.repeat(64),j(body),j(attached),status,artifact?j(artifact):null]);
  await db.query(`insert into toptik_owned_media_private.phase_evidence(operation_id,phase_index,evidence_hash,action,artifact)values($1,2,$2,'review',$3)`,[op,'c'.repeat(64),j({reason:'GROUP_MEDIA_READBACK_MISMATCH'})]);
  const restored=refresh({...structuredClone(f.source),media:f.source.media.map(m=>{const photo=structuredClone(m);if(m.mediaId!==f.source.media[0].mediaId)photo.updatedAt=later;return photo;})});
  const es=entries(before),proof=source=>plan.ownedMediaHash([op,requestHash,1,source,es]);
  const resolve=(source=restored,patch={})=>rpc('resolve_restored_toptik_owned_reorder_review',[product,owner,op,resolution,1,source,patch.entries??es,{...approval,packageHash:proof(source),...patch.approval}]);
  await t.test('the recovery RPC is server-only and requires the exact owner package',async()=>{
   const p=await db.query("select has_function_privilege('anon','public.resolve_restored_toptik_owned_reorder_review(text,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb)','EXECUTE') as anon,has_function_privilege('authenticated','public.resolve_restored_toptik_owned_reorder_review(text,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb)','EXECUTE') as member");assert.deepEqual(p.rows[0],{anon:false,member:false});
   await assert.rejects(resolve(restored,{approval:{approvedBy:'Other'}}),/APPROVAL_REQUIRED/);await assert.rejects(resolve(restored,{approval:{packageHash:'f'.repeat(64)}}),/APPROVAL_CHANGED/);
  });
  await t.test('retained new photo, changed ALT, changed primary and stale card cannot be adopted',async()=>{
   await assert.rejects(resolve(reordered),/DISPATCH_UNSAFE/);
   const alt=structuredClone(restored);alt.media[1].alt+=' different';await assert.rejects(resolve(refresh(alt)),/PREIMAGE_REQUIRED/);
   const variant=structuredClone(restored);variant.variants[1].mediaIds=[];await assert.rejects(resolve(refresh(variant)),/PREIMAGE_REQUIRED/);
   const stale=structuredClone(es);stale[0].expectedRevision++;await assert.rejects(resolve(restored,{entries:stale}),/CONCURRENT_UPDATE/);
  });
  await t.test('a delayed reorder targeting any pre-existing image cannot be cancelled',async()=>{
   const unsafe=structuredClone(reorderRequest);unsafe.variables.moves[0].id=f.source.media[1].mediaId;
   await db.query('update toptik_owned_media_private.phase_attempts set request=$2 where operation_id=$1 and phase_index=2',[op,j(unsafe)]);await assert.rejects(resolve(),/DISPATCH_UNSAFE/);
   await db.query('update toptik_owned_media_private.phase_attempts set request=$2 where operation_id=$1 and phase_index=2',[op,j(reorderRequest)]);
  });
  await t.test('uncertain prior phases, unshifted metadata and missing lease are refused',async()=>{
   await db.query("update toptik_owned_media_private.phase_attempts set status='uncertain'where operation_id=$1 and phase_index=0",[op]);await assert.rejects(resolve(),/DISPATCH_UNSAFE/);await db.query("update toptik_owned_media_private.phase_attempts set status='verified'where operation_id=$1 and phase_index=0",[op]);
   const changed=structuredClone(restored);changed.media[0].updatedAt=later;await assert.rejects(resolve(refresh(changed)),/PREIMAGE_REQUIRED/);
   const infinite=structuredClone(restored);infinite.media[1].updatedAt='infinity';await assert.rejects(resolve(refresh(infinite)),/PREIMAGE_REQUIRED/);
   await rpc('release_shopify_reconciliation_lease',[product,owner]);await assert.rejects(resolve(),/LEASE_REQUIRED/);await rpc('acquire_shopify_reconciliation_lease',[product,owner]);
  });
  await t.test('semantic restoration refreshes only source metadata and cancels with immutable history',async()=>{
   const after=await resolve();assert.equal(after.operation,null);assert.equal(after.mapVersion,2);assert.equal(after.sourceFingerprint,restored.fingerprint);assert.deepEqual(after.cards,before.cards);assert.deepEqual(after.manifest,before.manifest);
   const status=await db.query('select status,work_error from toptik_owned_media_private.operations where id=$1',[op]);assert.equal(status.rows[0].status,'cancelled');assert.equal(status.rows[0].work_error,'OWNED_MEDIA_RESTORED_AFTER_REORDER_REVIEW');
   const attempts=await db.query('select count(*)::int n from toptik_owned_media_private.phase_attempts where operation_id=$1',[op]);assert.equal(attempts.rows[0].n,3);
   assert.deepEqual((await resolve()).cards,before.cards);await assert.rejects(resolve(restored,{approval:{reviewReference:'different'}}),/REQUEST_CONFLICT/);
   await assert.rejects(db.query('delete from toptik_owned_media_private.events where request_id=$1',[resolution]),/AUDIT_IMMUTABLE/);
  });
 }finally{await db.close();}
});
