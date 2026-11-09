import test from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{randomUUID}from'node:crypto';
import{PGlite}from'@electric-sql/pglite';import{pgcrypto}from'@electric-sql/pglite/contrib/pgcrypto';
import{fixture,plan,policy,owner,refresh,clone}from'./helpers/owned-media-fixture.mjs';
const migrations=['20260423_carousel_schema.sql','20260424_carousel_catalog_metadata.sql','20260527_carousel_tech_specs_cache.sql','20260620_carousel_item_colors.sql',
 '20260930_shopify_gallery_sync_inbox.sql','20261001_gallery_editor_cas.sql','20261109130444_fzt73_owned_projection.sql','20261109150500_md20_owned_projection.sql','20261109202034_owned_group_media_registry.sql'];
const j=JSON.stringify;
test('isolated PostgreSQL group registry, atomic projection, CAS, permissions and durable journal',{timeout:60000},async t=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;create extension pgcrypto with schema extensions;');
  for(const name of migrations)await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
  const rpc=async(name,args)=>{const r=await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args.map(a=>a&&typeof a==='object'?j(a):a));return r.rows[0].result;};
  const get=product=>rpc('read_toptik_owned_media_registry',[product]);
  const entries=(f,ctx,manifest=f.manifest,source=f.source)=>ctx.cards.filter(c=>c.isActive).map(c=>({itemId:c.itemId,catalogKey:c.catalogKey,variantGid:f.binding.variants.find(v=>v.itemId===c.itemId).variantGid,
   expectedVersion:c.expectedVersion,expectedRevision:c.expectedRevision,projection:{...c.projection,...plan.ownedMediaProjection(source,manifest,c.itemId)}}));
  for(const product of[policy.FZT73_PRODUCT_GID,policy.MD20_PRODUCT_GID]){
   const f=fixture(product);assert.equal(await get(product).then(c=>c.registered),false);
   for(const [n,v]of f.binding.variants.entries()){
    const p=plan.ownedMediaProjection(f.source,f.manifest,v.itemId);
    await db.query(`insert into public.carousel_items(id,title,description,description_html,seo_title,seo_description,catalog_number,cover_image_path,cover_image_alt,display_order,is_active,copy_updated_at)
      values($1,'Item','description','<p>description</p>','SEO','Description',$2,$3,$4,$5,true,'2026-10-01T12:00:00Z')`,[v.itemId,v.sku,p.cover_image_path,p.cover_image_alt,n]);
    for(const a of p.angles)await db.query(`insert into public.carousel_item_angles(item_id,angle_key,angle_order,image_path,image_alt)values($1,$2,$3,$4,$5)`,[v.itemId,a.angle_key,a.angle_order,a.image_path,a.image_alt]);
    await rpc('upsert_shopify_gallery_binding',[v.sku,v.itemId,product,v.variantGid,'fixture-handle',true,'2026-10-01T12:00:00Z']);
   }
   await rpc('acquire_shopify_reconciliation_lease',[product,owner]);
   const initial=await get(product);await rpc(product===policy.FZT73_PRODUCT_GID?'apply_fzt73_owned_batch':'apply_md20_owned_batch',[product,owner,entries(f,initial)]);
   const before=await get(product),approval={approvedBy:'Tal',approvedAt:'2026-11-09T20:00:00Z',reviewReference:'offline fixture only'};
   // The source fingerprint must use the same Unicode canonical JSON in JS and SQL.
   await db.query('select toptik_owned_media_private.assert_source($1,$2)',[product,j(f.source)]);
   const adopted=await rpc('adopt_toptik_owned_media_registry',[product,owner,randomUUID(),f.source,f.manifest,entries(f,before),approval]);
   assert.equal(adopted.mapVersion,1);assert.equal(adopted.cards.length,f.binding.variants.length);
   await t.test(product+' decoded creation receipt accepts CDN query string but rejects receipt/host mismatch',async()=>{
    const id=randomUUID(),uploadKey=`upload:${id}:0`,receiptId=randomUUID(),sha256='a'.repeat(64),filename=`toptik-group-${id.replaceAll('-','')}-0-${sha256.slice(0,16)}.jpg`;
    const source={itemId:f.command.itemId,receiptId,sha256,mime:'image/jpeg',byteLength:1000,width:1000,height:1000,url:`https://ekgpaoavsavrtbhlbwdg.supabase.co/storage/v1/object/public/carousel-media/sync-owned/${f.command.itemId}/${sha256}.jpg`};
    const request={apiVersion:'2026-07',operationId:id,phaseIndex:0,binding:f.binding,beforeFingerprint:f.source.fingerprint,input:{kind:'create_owned',source,alt:'New exact photo'}};
    const media={...clone(f.source.media[0]),mediaId:'gid://shopify/MediaImage/999999999',alt:request.input.alt,image:{...f.source.media[0].image,url:`https://cdn.shopify.com/s/files/1/${filename}?v=12345`}};
    const artifact={uploadKey,mediaId:media.mediaId,owned:{productGid:product,itemId:f.command.itemId,operationId:id,createPhaseIndex:0,filename,sourceSha256:sha256,mime:source.mime,receiptId,media,decodedSha256:'b'.repeat(64),decodedByteLength:1000}};
    const delta=a=>db.query('select toptik_owned_media_private.assert_delta($1,$2,$3,$4)',[j(request),j(f.source),j(f.source),j(a)]);
    await delta(artifact);
    const wrongReceipt=clone(artifact);wrongReceipt.owned.receiptId=randomUUID();await assert.rejects(delta(wrongReceipt),/UPLOAD_RECEIPT_REQUIRED/);
    const wrongHost=clone(artifact);wrongHost.owned.media.image.url=`https://example.test/${filename}`;await assert.rejects(delta(wrongHost),/UPLOAD_RECEIPT_REQUIRED/);
    await db.exec('begin');try{
     const ctx=await get(product),command={...f.command,requestId:id,desiredImages:[...f.command.desiredImages,{mediaId:null,uploadUrl:source.url,alt:request.input.alt}]};
     const intent=plan.planOwnedMediaChange(f.source,f.manifest,command),key=intent.uploads[0].key;
     const op=await rpc('prepare_toptik_owned_media_operation',[product,owner,id,ctx.mapVersion,f.source.fingerprint,f.source,command,intent,[{kind:'create_owned',uploadKey:key,source,alt:request.input.alt}],{actorType:'system',actorId:'fixture'}]);
     const payload={...request,query:'fixture',variables:{}},req={...payload,requestHash:plan.ownedMediaHash(payload)},attempt=randomUUID(),args=[product,owner,op.id,0,attempt];
     artifact.uploadKey=key;
     await rpc('record_toptik_owned_media_phase',[...args,'begin',req.requestHash,req,null,null]);await rpc('record_toptik_owned_media_phase',[...args,'ack',req.requestHash,req,null,{mediaId:media.mediaId}]);
     const other=clone(artifact);other.mediaId='gid://shopify/MediaImage/999999998';other.owned.media.mediaId=other.mediaId;
     await db.exec('savepoint bad_ack_receipt');
     await assert.rejects(rpc('record_toptik_owned_media_phase',[...args,'recovered',req.requestHash,req,f.source,other]),/CREATE_ACK_MISMATCH/);
     await db.exec('rollback to savepoint bad_ack_receipt');
     await rpc('record_toptik_owned_media_phase',[...args,'recovered',req.requestHash,req,f.source,artifact]);
    }finally{await db.exec('rollback');}
   });
   await t.test(product+' rejects roles, stale lease/map and keeps every card on failure',async()=>{
    await db.exec('set role anon');await assert.rejects(get(product),/permission denied/);await db.exec('reset role;set role authenticated');await assert.rejects(get(product),/permission denied/);await db.exec('reset role;set role service_role');
    await assert.rejects(db.query('select * from toptik_owned_media_private.registry'),/permission denied/);await db.exec('reset role');
    await assert.rejects(rpc('apply_toptik_owned_media_source_projection',[product,randomUUID(),randomUUID(),1,f.source,f.manifest,entries(f,adopted)]),/LEASE_REQUIRED/);
    await assert.rejects(rpc('apply_toptik_owned_media_source_projection',[product,owner,randomUUID(),999,f.source,f.manifest,entries(f,adopted)]),/STALE_MAP/);
    const bad=entries(f,adopted);bad.at(-1).expectedRevision++;
    await assert.rejects(rpc('apply_toptik_owned_media_source_projection',[product,owner,randomUUID(),1,f.source,f.manifest,bad]),/CONCURRENT_UPDATE/);
    assert.deepEqual((await get(product)).cards,adopted.cards);assert.equal((await get(product)).mapVersion,1);
   });
   await t.test(product+' native ID reorder updates dynamic projection atomically',async()=>{
    const next=clone(f.source),row=clone(f.manifest);next.media.reverse();for(const v of row.variants){v.orderedMediaIds.reverse();v.coverMediaId=v.orderedMediaIds[0];const native=next.variants.find(n=>n.variantGid===v.variantGid),image=next.media.find(m=>m.mediaId===v.coverMediaId).image;native.image={id:image.id,url:image.url};}row.globalOrder=next.media.map(m=>m.mediaId);
    const source=refresh(next),ctx=await get(product),applied=await rpc('apply_toptik_owned_media_source_projection',[product,owner,randomUUID(),ctx.mapVersion,source,row,entries(f,ctx,row,source)]);
    assert.equal(applied.mapVersion,2);assert.deepEqual(applied.manifest,row);f.source=source;f.manifest=row;f.command.expectedMapVersion=2;f.command.expectedSourceFingerprint=source.fingerprint;
    f.command.desiredImages=row.variants[0].orderedMediaIds.map(id=>({mediaId:id,alt:source.media.find(m=>m.mediaId===id).alt}));
   });
   await t.test(product+' no-op operation has durable actor-bound receipt and no duplicate permit',async()=>{
    const ctx=await get(product),command={...f.command,requestId:randomUUID()},intent=plan.planOwnedMediaChange(f.source,f.manifest,command),actor={actorType:'session_admin',actorId:'fixture-admin'};
    const op=await rpc('prepare_toptik_owned_media_operation',[product,owner,command.requestId,ctx.mapVersion,f.source.fingerprint,f.source,command,intent,[],actor]);
    assert.deepEqual(op.actor,actor);assert.equal(op.nextPhase,0);
    const receipt=await rpc('read_toptik_owned_media_receipt',[product,command.requestId]);assert.equal(receipt.operation.id,op.id);
    await rpc('commit_toptik_owned_media_operation',[product,owner,op.id,f.source,f.manifest,entries(f,ctx)]);
    const done=await rpc('read_toptik_owned_media_receipt',[product,command.requestId]);assert.equal(done.operation.status,'verified');
    assert.equal((await get(product)).operation,null);
    await assert.rejects(rpc('prepare_toptik_owned_media_operation',[product,owner,command.requestId,ctx.mapVersion,f.source.fingerprint,f.source,{...command,itemId:f.binding.variants[1].itemId},intent,[],actor]),/REQUEST_CONFLICT/);
   });
   await t.test(product+' one-shot reorder journal validates noop readback and cannot be cancelled after begin',async()=>{
    const ctx=await get(product),command={...f.command,requestId:randomUUID()},intent=plan.planOwnedMediaChange(f.source,f.manifest,command),actor={actorType:'admin_token',actorId:'fixture-token'};
    const phase={kind:'reorder',mediaRefs:f.manifest.globalOrder,protectedRefs:[]};
    const op=await rpc('prepare_toptik_owned_media_operation',[product,owner,command.requestId,ctx.mapVersion,f.source.fingerprint,f.source,command,intent,[phase],actor]);
    const payload={apiVersion:'2026-07',operationId:op.id,phaseIndex:0,binding:f.binding,beforeFingerprint:f.source.fingerprint,input:{kind:'reorder',mediaIds:f.manifest.globalOrder,protectedMediaIds:[]},query:'',variables:{},readOnlyNoop:true};
    const req={...payload,requestHash:plan.ownedMediaHash(payload)},attempt=randomUUID(),args=[product,owner,op.id,0,attempt];
    const first=await rpc('record_toptik_owned_media_phase',[...args,'begin',req.requestHash,req,null,null]);assert.equal(first.mayExecute,true);assert.ok(Date.parse(first.leaseExpiresAt)>Date.now());
    assert.equal((await rpc('record_toptik_owned_media_phase',[...args,'begin',req.requestHash,req,null,null])).mayExecute,false);
    await assert.rejects(rpc('cancel_toptik_owned_media_operation',[product,owner,op.id,f.source]),/CANCEL_UNSAFE/);
    await assert.rejects(rpc('record_toptik_owned_media_phase',[...args,'recovered',req.requestHash,req,f.source,{}]),/NOOP_INVALID/);
    assert.equal((await rpc('record_toptik_owned_media_phase',[...args,'recovered',req.requestHash,req,f.source,{verifiedNoop:true}])).status,'verified');
    const readback=await rpc('read_toptik_owned_media_operation',[product,owner,op.id,0]);assert.deepEqual(readback.observedGraph,f.source);assert.equal(readback.artifact.verifiedNoop,true);
    const updated=await rpc('read_toptik_owned_media_receipt',[product,op.id]);assert.equal(updated.operation.nextPhase,1);
    await rpc('commit_toptik_owned_media_operation',[product,owner,op.id,f.source,f.manifest,entries(f,ctx)]);
   });
   await t.test(product+' observation and prepare share one transaction, lost response keeps immutable receipt',async()=>{
    const ctx=await get(product),next=clone(f.source);next.media[0].alt='changed natively';const source=refresh(next),observed=clone(f.manifest);
    const command={...f.command,requestId:randomUUID(),expectedSourceFingerprint:source.fingerprint},normalized={...command,desiredImages:observed.variants[0].orderedMediaIds.map(id=>({mediaId:id,alt:source.media.find(m=>m.mediaId===id).alt}))};
    const intent=plan.planOwnedMediaChange(source,observed,normalized),actor={actorType:'session_admin',actorId:'fixture-admin'};
    const projected=entries(f,ctx,observed,source);
    await assert.rejects(rpc('prepare_toptik_owned_media_operation',[product,owner,command.requestId,ctx.mapVersion,source.fingerprint,source,command,intent,[],actor]),/OBSERVATION_REQUIRED/);
    assert.equal((await get(product)).sourceFingerprint,ctx.sourceFingerprint);
    const bad=clone(projected);bad.at(-1).expectedRevision++;
    await assert.rejects(rpc('prepare_toptik_owned_media_operation',[product,owner,command.requestId,ctx.mapVersion,source.fingerprint,source,command,intent,[],actor,observed,bad]),/CONCURRENT_UPDATE/);
    assert.equal((await get(product)).sourceFingerprint,ctx.sourceFingerprint);assert.deepEqual((await get(product)).cards,ctx.cards);
    const op=await rpc('prepare_toptik_owned_media_operation',[product,owner,command.requestId,ctx.mapVersion,source.fingerprint,source,command,intent,[],actor,observed,projected]);
    assert.equal(op.mapVersion,ctx.mapVersion+1);assert.deepEqual(op.command,command);const fresh=await get(product);assert.equal(fresh.sourceFingerprint,source.fingerprint);
    // Active operations block even a native webhook from projecting an intermediate graph.
    await assert.rejects(rpc('apply_toptik_owned_media_source_projection',[product,owner,randomUUID(),fresh.mapVersion,source,observed,entries(f,fresh,observed,source)]),/OPERATION_BUSY/);
    const claim=await rpc('claim_toptik_owned_media_work',[owner,'{}']);assert.equal(claim.operationId,op.id);assert.deepEqual(claim.actor,actor);assert.equal(claim.nextPhase,0);
    assert.deepEqual(await rpc('claim_toptik_owned_media_work',[randomUUID(),'{}']),{operation:null});
    await assert.rejects(rpc('finish_toptik_owned_media_work',[op.id,owner,randomUUID(),'pending',null,false]),/CLAIM_CONFLICT/);
    await rpc('finish_toptik_owned_media_work',[op.id,owner,claim.claimId,'pending',null,false]);
    await rpc('commit_toptik_owned_media_operation',[product,owner,op.id,source,observed,entries(f,fresh,observed,source)]);
    const receipt=await rpc('read_toptik_owned_media_receipt',[product,op.id]);assert.equal(receipt.operation.status,'verified');f.source=source;f.manifest=observed;
    f.command={...normalized,expectedMapVersion:op.mapVersion};
   });
   await t.test(product+' pre-send native withdrawal records review with no execution permit',async()=>{
    await db.exec('begin');try{
     const ctx=await get(product),command={...f.command,requestId:randomUUID(),expectedMapVersion:ctx.mapVersion},intent=plan.planOwnedMediaChange(f.source,f.manifest,command);
     const spec={kind:'reorder',mediaRefs:f.manifest.globalOrder,protectedRefs:[]},op=await rpc('prepare_toptik_owned_media_operation',[product,owner,command.requestId,ctx.mapVersion,f.source.fingerprint,f.source,command,intent,[spec],{actorType:'system',actorId:'fixture'}]);
     const payload={apiVersion:'2026-07',operationId:op.id,phaseIndex:0,binding:f.binding,beforeFingerprint:f.source.fingerprint,input:{kind:'reorder',mediaIds:f.manifest.globalOrder,protectedMediaIds:[]},query:'',variables:{},readOnlyNoop:true};
     const req={...payload,requestHash:plan.ownedMediaHash(payload)},withdrawn=clone(f.source);withdrawn.product.status='DRAFT';withdrawn.product.publishedOnPublication=false;
     const answer=await rpc('record_toptik_owned_media_phase',[product,owner,op.id,0,randomUUID(),'review',req.requestHash,req,refresh(withdrawn),{reason:'GROUP_MEDIA_NOT_SENT_SOURCE_CHANGED'}]);
     assert.equal(answer.mayExecute,false);assert.equal(answer.status,'review');const saved=await rpc('read_toptik_owned_media_operation',[product,owner,op.id,0]);
     assert.equal(saved.evidence[0].observed_graph.product.status,'DRAFT');assert.equal(saved.evidence[0].artifact.reason,'GROUP_MEDIA_NOT_SENT_SOURCE_CHANGED');
     assert.deepEqual((await get(product)).cards,ctx.cards);assert.equal((await get(product)).mapVersion,ctx.mapVersion);
    }finally{await db.exec('rollback');}
   });
   await t.test(product+' delete phase rejects protected or unrelated native changes',async()=>{
    const ctx=await get(product),removed=f.manifest.variants[0].orderedMediaIds.at(-1),command={...f.command,requestId:randomUUID(),expectedMapVersion:ctx.mapVersion,desiredImages:f.command.desiredImages.filter(m=>m.mediaId!==removed)};
    const intent=plan.planOwnedMediaChange(f.source,f.manifest,command),spec={kind:'variant_detach',variantId:f.binding.variants[0].variantGid,mediaRefs:[removed],removalIntentId:command.requestId};
    const op=await rpc('prepare_toptik_owned_media_operation',[product,owner,command.requestId,ctx.mapVersion,f.source.fingerprint,f.source,command,intent,[spec],{actorType:'system',actorId:'fixture'}]);
    const payload={apiVersion:'2026-07',operationId:op.id,phaseIndex:0,binding:f.binding,beforeFingerprint:f.source.fingerprint,input:{kind:'variant_detach',variantId:spec.variantId,mediaIds:[removed],removalIntentId:op.id},query:'fixture',variables:{}};
    const req={...payload,requestHash:plan.ownedMediaHash(payload)},attempt=randomUUID(),args=[product,owner,op.id,0,attempt];
    await rpc('record_toptik_owned_media_phase',[...args,'begin',req.requestHash,req,null,null]);
    const ack={jobId:'gid://shopify/Job/999'};await rpc('record_toptik_owned_media_phase',[...args,'ack',req.requestHash,req,null,ack]);
    await rpc('record_toptik_owned_media_phase',[...args,'uncertain',req.requestHash,req,null,{reason:'SHOPIFY_MEDIA_USER_ERROR'}]);
    const uncertain=await rpc('read_toptik_owned_media_operation',[product,owner,op.id,0]);assert.deepEqual(uncertain.ack,ack);assert.equal(uncertain.evidence[0].artifact.reason,'SHOPIFY_MEDIA_USER_ERROR');
    const observed=clone(f.source);observed.variants[0].mediaIds=observed.variants[0].mediaIds.filter(id=>id!==removed);
    const wrong=clone(observed);wrong.variants[1].mediaIds.pop();
    await assert.rejects(rpc('record_toptik_owned_media_phase',[...args,'recovered',req.requestHash,req,refresh(wrong),{}]),/READBACK_MISMATCH/);
    await rpc('record_toptik_owned_media_phase',[...args,'recovered',req.requestHash,req,refresh(observed),{}]);
    // Mark this deliberately incomplete fixture operation for review; no partial map/card commit is accepted.
    await assert.rejects(rpc('commit_toptik_owned_media_operation',[product,owner,op.id,refresh(observed),f.manifest,entries(f,ctx)]),/FINAL_MANIFEST_CONFLICT/);
    await db.query("update toptik_owned_media_private.operations set status='review'where id=$1",[op.id]);
   });
  }
  await assert.rejects(db.query("delete from toptik_owned_media_private.events"),/AUDIT_IMMUTABLE/);
  await assert.rejects(db.query("delete from toptik_owned_media_private.phase_evidence"),/AUDIT_IMMUTABLE/);
 }finally{await db.close();}
});
