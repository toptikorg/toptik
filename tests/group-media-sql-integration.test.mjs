import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {fixture,plan,policy,owner} from './helpers/owned-media-fixture.mjs';
import {load,legacy,transport,operation} from './helpers/group-media-fixture.mjs';

const migrations=['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql','20260527_carousel_tech_specs_cache.sql','20260620_carousel_item_colors.sql',
 '20260930_shopify_gallery_sync_inbox.sql','20261001_gallery_editor_cas.sql','20261109130444_fzt73_owned_projection.sql','20261109150500_md20_owned_projection.sql','20261109202034_owned_group_media_registry.sql'];
const makeShopify=await load('src/lib/shopify/group-media-shopify.ts',
 ['configuredShopifyDomain','shopifyAdminGraphql','verifyOnboardingImage','parseTransportMedia','groupOwnedFilename','process'],
 ['sendGroupMediaMutation','observeGroupOwnedFile']);
test('runtime and real native observer preserve upload receipt across a lost create response into the PostgreSQL journal',{timeout:60000},async()=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;create extension pgcrypto with schema extensions;');
  for(const name of migrations)await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
  const rpc=async(name,args)=>{const r=await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args.map(a=>a&&typeof a==='object'?JSON.stringify(a):a));return r.rows[0].result;};
  const f=fixture(policy.FZT73_PRODUCT_GID),product=f.binding.productGid;
  const entries=ctx=>ctx.cards.map(c=>({itemId:c.itemId,catalogKey:c.catalogKey,variantGid:f.binding.variants.find(v=>v.itemId===c.itemId).variantGid,
   expectedVersion:c.expectedVersion,expectedRevision:c.expectedRevision,projection:{...c.projection,...plan.ownedMediaProjection(f.source,f.manifest,c.itemId)}}));
  for(const [n,v]of f.binding.variants.entries()){
   const p=plan.ownedMediaProjection(f.source,f.manifest,v.itemId);
   await db.query(`insert into public.carousel_items(id,title,description,description_html,seo_title,seo_description,catalog_number,cover_image_path,cover_image_alt,display_order,is_active,copy_updated_at)
    values($1,'Item','description','<p>description</p>','SEO','Description',$2,$3,$4,$5,true,'2026-10-01T12:00:00Z')`,[v.itemId,v.sku,p.cover_image_path,p.cover_image_alt,n]);
   for(const a of p.angles)await db.query('insert into public.carousel_item_angles(item_id,angle_key,angle_order,image_path,image_alt)values($1,$2,$3,$4,$5)',[v.itemId,a.angle_key,a.angle_order,a.image_path,a.image_alt]);
   await rpc('upsert_shopify_gallery_binding',[v.sku,v.itemId,product,v.variantGid,'fixture-handle',true,'2026-10-01T12:00:00Z']);
  }
  await rpc('acquire_shopify_reconciliation_lease',[product,owner]);
  let context=await rpc('read_toptik_owned_media_registry',[product]);
  await rpc('apply_fzt73_owned_batch',[product,owner,entries(context)]);
  context=await rpc('read_toptik_owned_media_registry',[product]);
  await rpc('adopt_toptik_owned_media_registry',[product,owner,randomUUID(),f.source,f.manifest,entries(context),
   {approvedBy:'Tal',approvedAt:'2026-11-09T20:00:00Z',reviewReference:'offline fixture only, no live approval or writes'}]);
  context=await rpc('read_toptik_owned_media_registry',[product]);
  const requestId=randomUUID(),receiptId=randomUUID(),sha256='a'.repeat(64),itemId=f.command.itemId;
  const staged={itemId,receiptId,sha256,mime:'image/jpeg',byteLength:1000,width:1000,height:1000,
   url:`https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/sync-owned/${itemId}/${sha256}.jpg`};
  const command={...f.command,requestId,desiredImages:[...f.command.desiredImages,{mediaId:null,uploadUrl:staged.url,alt:'Exact new photo'}]};
  const intent=plan.planOwnedMediaChange(f.source,f.manifest,command),uploadKey=intent.uploads[0].key;
  const spec={kind:'create_owned',uploadKey,source:staged,alt:'Exact new photo'};
  const op=await rpc('prepare_toptik_owned_media_operation',[product,owner,requestId,context.mapVersion,f.source.fingerprint,f.source,command,intent,[spec],{actorType:'session_admin',actorId:owner}]);
  const request=transport.buildGroupMediaPhase({operationId:op.id,phaseIndex:0,before:f.source,phase:{kind:'create_owned',source:staged,alt:spec.alt}});
  const filename=transport.groupOwnedFilename(requestId,0,sha256,staged.mime),imageUrl=`https://cdn.shopify.com/s/files/1/${filename}?v=123456`;
  const media={id:'gid://shopify/MediaImage/99999999',mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',updatedAt:'2026-11-09T20:00:00Z',alt:spec.alt,
   image:{id:'gid://shopify/ImageSource/99999999',url:imageUrl,width:1000,height:1000}};
  let sends=0,visible=false,decodes=0;
  const adapter=makeShopify({configuredShopifyDomain:()=> 'toptikcoil.myshopify.com',...legacy,...transport,
   process:{env:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'}},
   shopifyAdminGraphql:async query=>{
    if(query.includes('mutation TopTikGroupCreateMedia')){sends++;throw Error('GROUP_MEDIA_NETWORK_RESPONSE_LOST');}
    if(query.includes('query TopTikGroupOwnedFileNode'))return{node:media};
    assert.match(query,/query TopTikGroupOwnedFile/);return{files:{nodes:visible?[media]:[],pageInfo:{hasNextPage:false}}};
   },verifyOnboardingImage:async()=>{decodes++;return{mediaGid:media.id,url:imageUrl,width:1000,height:1000,sha256:'b'.repeat(64),byteLength:1000};}});
  const journal={read:ref=>rpc('read_toptik_owned_media_operation',[ref.productGid,ref.owner,ref.operationId,ref.phaseIndex]),
   record:(ref,r)=>rpc('record_toptik_owned_media_phase',[ref.productGid,ref.owner,ref.operationId,ref.phaseIndex,r.attemptId,r.action,r.requestHash,r.requestJson,r.observedGraph??null,r.artifact??null])};
  const ref={productGid:product,operationId:requestId,phaseIndex:0,owner},ports={journal,readSnapshot:async()=>structuredClone(f.source),
   execute:adapter.sendGroupMediaMutation,observeOwnedFile:adapter.observeGroupOwnedFile};
  assert.equal((await operation.runGroupMediaPhase(ref,request,f.source,Date.now()+45000,ports,{uploadKey})).status,'pending');
  const uncertain=await journal.read(ref);assert.equal(uncertain.status,'uncertain');assert.notEqual(uncertain.attemptId,receiptId);
  visible=true;
  const recovered=await operation.runGroupMediaPhase(ref,request,f.source,Date.now()+45000,ports,{uploadKey});
  assert.equal(recovered.status,'verified');assert.equal(sends,1);assert.equal(decodes,1);assert.equal(recovered.artifact.owned.receiptId,receiptId);
  const stored=await journal.read(ref);assert.equal(stored.status,'verified');assert.equal(stored.artifact.owned.receiptId,receiptId);
  assert.equal(stored.artifact.owned.media.image.url,imageUrl);
  const durable=await rpc('read_toptik_owned_media_receipt',[product,requestId]);assert.equal(durable.operation.nextPhase,1);
  assert.equal(durable.operation.status,'running','file creation alone is not a Gallery projection commit');
 }finally{await db.close();}
});
