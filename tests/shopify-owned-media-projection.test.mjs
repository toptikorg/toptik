import test from'node:test';import assert from'node:assert/strict';
import{fixture,plan,policy,loadOwnedModule,clone,refresh}from'./helpers/owned-media-fixture.mjs';
import{description,family,service}from'./helpers/owned-edit-harness.mjs';
const exports=['readOwnedMappedSource','ownedMappedMediaProjection','ownedSourceMediaContext','assertOwnedMappedAlt','readOwnedMediaProjectionEntries'];
const make=await loadOwnedModule('src/lib/shopify/owned-media-projection.ts',[
 'shopifyAdminGraphql','visibleCopyFromProduct','assertSafeDescriptionHtml','readGroupMediaSnapshot','readOwnedMediaRegistry','requireVariantMediaToken',...Object.keys(plan),...Object.keys(policy)],exports);
function setup(product=policy.FZT73_PRODUCT_GID){
 const f=fixture(product),rows=product===policy.FZT73_PRODUCT_GID?policy.FZT73_VARIANTS:policy.MD20_VARIANTS;
 const raw={id:product,handle:f.binding.handle,title:'Live source title',descriptionHtml:'<p>Live source description</p>',status:'ACTIVE',updatedAt:'2026-11-09T20:00:00Z',vendor:'Mandarina Duck',productType:'Bag',publishedOnPublication:true,
  variants:{nodes:rows.map(v=>({id:`gid://shopify/ProductVariant/${v.variantId}`,sku:v.sku,selectedOptions:[{name:'צבע',value:v.color}]})),pageInfo:{hasNextPage:false}},
  media:{nodes:f.source.media.map(m=>({id:m.mediaId,alt:m.alt,status:m.status,mediaContentType:'IMAGE',image:{...m.image,altText:m.alt}})),pageInfo:{hasNextPage:false}},seo:{title:'Source SEO',description:'Source description'}};
 const ctx={registered:true,schemaAvailable:true,binding:f.binding,mapVersion:3,sourceFingerprint:f.source.fingerprint,snapshot:clone(f.source),manifest:clone(f.manifest),cards:[],operation:null};let reads=0;
 const api=make({...plan,...policy,assertSafeDescriptionHtml:description.assertSafeDescriptionHtml,
  visibleCopyFromProduct:p=>({title:p.title,description:description.descriptionTextFromHtml(p.descriptionHtml),descriptionHtml:p.descriptionHtml,seoTitle:p.seoTitle,seoDescription:p.seoDescription}),
  requireVariantMediaToken:()=>{throw new Error('LEGACY_TOKEN_REQUIRED')},readOwnedMediaRegistry:async()=>ctx,readGroupMediaSnapshot:async()=>f.source,
  shopifyAdminGraphql:async()=>{reads++;return{product:clone(raw)}}});
 return{f,raw,ctx,api,reads:()=>reads};
}
for(const product of[policy.FZT73_PRODUCT_GID,policy.MD20_PRODUCT_GID]){
 test(product+' registered map projects exact IDs and source copy/SEO with original card CAS',async()=>{const{f,ctx,api}=setup(product),source=await api.readOwnedMappedSource({},product,Date.now()+10000);
  assert.deepEqual(api.ownedMappedMediaProjection(source,f.binding.variants[0].itemId),plan.ownedMediaProjection(f.source,f.manifest,f.binding.variants[0].itemId));
  const cards=f.binding.variants.map(v=>({itemId:v.itemId,catalogKey:v.sku,expectedVersion:'2026-11-09T20:00:00Z',expectedRevision:8,isActive:true,projection:{}}));
  const result=await api.readOwnedMediaProjectionEntries({},f.binding,f.source,f.manifest,cards,Date.now()+10000);assert.equal(result.length,f.binding.variants.length);assert.equal(result[0].expectedRevision,8);
  assert.match(result[0].projection.title,/Live source title/);assert.match(result[0].projection.seo_title,/Source SEO/);assert.equal(result[0].projection.description_html,'<p>Live source description</p>');
  assert.equal(api.ownedSourceMediaContext(source).registry,ctx);
 });
 test(product+' raw copy rejects renamed color and extra variant after map activation',async()=>{for(const kind of['color','extra']){const s=setup(product);if(kind==='color')s.raw.variants.nodes[0].selectedOptions[0].value='wrong';else s.raw.variants.nodes.push({...s.raw.variants.nodes[0],id:'gid://shopify/ProductVariant/99999'});
  await assert.rejects(s.api.readOwnedMappedSource({},product,Date.now()+10000),/COPY_IDENTITY_INVALID/);}});
}
test('pending operation is retryable busy before any source read; review is distinct',async()=>{const s=setup();s.ctx.operation={status:'running'};await assert.rejects(s.api.readOwnedMappedSource({},s.f.binding.productGid,Date.now()+10000),/SYNC_RECONCILIATION_BUSY/);assert.equal(s.reads(),0);s.ctx.operation.status='review';await assert.rejects(s.api.readOwnedMappedSource({},s.f.binding.productGid,Date.now()+10000),/REVIEW_REQUIRED/);});
test('mapped ALT is descriptive while pre-map QMMM1 retains token guard',async()=>{const s=setup(policy.MD20_PRODUCT_GID),source=await s.api.readOwnedMappedSource({},s.f.binding.productGid,Date.now()+10000),v=policy.MD20_VARIANTS[0];assert.doesNotThrow(()=>s.api.assertOwnedMappedAlt(source,v,'old','New description'));delete source.ownedMediaMap;assert.throws(()=>s.api.assertOwnedMappedAlt(source,v,'old','New description'),/LEGACY_TOKEN_REQUIRED/);});
test('association-only native drift is included in copy source equality identity',async()=>{const s=setup(),a=await s.api.readOwnedMappedSource({},s.f.binding.productGid,Date.now()+10000);s.f.source.variants[0].image=null;s.f.source=refresh(s.f.source);const b=await s.api.readOwnedMappedSource({},s.f.binding.productGid,Date.now()+10000);assert.notEqual(a.ownedMediaMap.graphIdentity,b.ownedMediaMap.graphIdentity);});
test('raw copy and media graph mismatch stops before projection commit',async()=>{const s=setup();s.raw.media.nodes[0].alt='concurrent';await assert.rejects(s.api.readOwnedMappedSource({},s.f.binding.productGid,Date.now()+10000),/CONCURRENT_UPDATE/);});
test('missing registry RPC falls back only before migration; permission/network errors never do',async()=>{
 const reg=(await loadOwnedModule('src/lib/shopify/owned-media-registry.ts',['ownedMediaBinding'],['readOwnedMediaRegistry']))(plan);
 const db=error=>({rpc:()=>Promise.resolve({data:null,error})});
 assert.equal((await reg.readOwnedMediaRegistry(db({code:'PGRST202',message:'missing read_toptik_owned_media_registry'}),policy.FZT73_PRODUCT_GID,Date.now()+10000)).schemaAvailable,false);
 await assert.rejects(reg.readOwnedMediaRegistry(db({code:'42501',message:'permission denied read_toptik_owned_media_registry'}),policy.FZT73_PRODUCT_GID,Date.now()+10000),/RPC_FAILED/);
 await assert.rejects(reg.readOwnedMediaRegistry(db({code:'PGRST202',message:'different function unavailable'}),policy.FZT73_PRODUCT_GID,Date.now()+10000),/RPC_FAILED/);
});
for(const key of['fzt73','md20'])test(key+' real owned-edit service remains bidirectional for copy/SEO/ALT after registered media add/remove/reorder',async()=>{
 const f=await family(key),binding=plan.ownedMediaBinding(f.productGid),target=f.variants[0];
 const all=f.state.product.media.nodes,oldById=new Map(all.map(m=>[m.id,m]));
 const manifest={schemaVersion:1,productGid:f.productGid,handle:binding.handle,globalOrder:all.map(m=>m.id),ignoredMediaIds:[],variants:binding.variants.map(v=>{
  const card=f.cardOf(v.itemId),ids=card.angles.map(a=>all.find(m=>m.image.url===a.image_path).id);
  return{...v,orderedMediaIds:ids,coverMediaId:all.find(m=>m.image.url===card.cover_image_path).id};})};
 // Legacy fixture synthesizes FZT73 fallback ALT on read. Start the registered baseline with the independently reviewed exact native text.
 for(const v of f.variants)for(const a of f.cardOf(v.itemId).angles)all.find(m=>m.image.url===a.image_path).alt=a.image_alt;
 const originalOthers=f.variants.slice(1).map(v=>[v.itemId,clone(f.cardOf(v.itemId).angles)]);
 const newId='gid://shopify/MediaImage/99999001',removed=manifest.variants[0].orderedMediaIds.at(-1),photo={id:newId,alt:'תמונה חדשה ללא אסימון',status:'READY',mediaContentType:'IMAGE',image:{url:'https://cdn.shopify.com/s/files/1/new-native-mapped.jpg',altText:null,width:1000,height:1200}};
 f.state.product.media.nodes=[photo,...all.filter(m=>m.id!==removed)];
 manifest.variants[0].orderedMediaIds=[newId,...manifest.variants[0].orderedMediaIds.filter(id=>id!==removed)];manifest.variants[0].coverMediaId=newId;manifest.globalOrder=f.state.product.media.nodes.map(m=>m.id);
 const graph=()=>refresh({schemaVersion:1,binding,product:{productGid:f.productGid,handle:binding.handle,status:'ACTIVE',publishedOnPublication:true,updatedAt:f.state.product.updatedAt},
  media:f.state.product.media.nodes.map(m=>({mediaId:m.id,mediaContentType:'IMAGE',alt:m.alt,status:'READY',fileStatus:'READY',updatedAt:'2026-11-09T20:00:00Z',image:{id:`gid://shopify/ImageSource/${m.id.split('/').at(-1)}`,url:m.image.url,width:m.image.width,height:m.image.height}})),
  variants:manifest.variants.map(v=>({variantGid:v.variantGid,sku:v.sku,mediaIds:[...v.orderedMediaIds],image:{id:`gid://shopify/ImageSource/${v.coverMediaId.split('/').at(-1)}`,url:f.state.product.media.nodes.find(m=>m.id===v.coverMediaId).image.url}}))});
 const ctx={registered:true,schemaAvailable:true,binding,mapVersion:4,sourceFingerprint:graph().fingerprint,snapshot:graph(),manifest:clone(manifest),cards:[],operation:null};
 const api=make({...plan,...policy,assertSafeDescriptionHtml:description.assertSafeDescriptionHtml,visibleCopyFromProduct:f.deps.visibleCopyFromProduct,
  requireVariantMediaToken:()=>{throw new Error('TOKEN_MUST_NOT_BE_USED_AFTER_MAP')},readOwnedMediaRegistry:async()=>ctx,readGroupMediaSnapshot:async()=>graph(),shopifyAdminGraphql:f.deps.shopifyAdminGraphql});
 f.state.mappedIO={read:api.readOwnedMappedSource,project:api.ownedMappedMediaProjection,context:api.ownedSourceMediaContext,alt:api.assertOwnedMappedAlt,
  apply:async(db,input)=>{const result=await db.rpc(f.batchRpc,{p_product_gid:f.productGid,p_owner:input.owner,p_entries:input.entries});if(result.error)throw new Error(result.error.message);ctx.manifest=clone(input.manifest);ctx.snapshot=clone(input.source);ctx.sourceFingerprint=input.source.fingerprint;return ctx;}};
 const owner='11111111-1111-4111-8111-111111111111';await f.db.rpc('acquire_shopify_reconciliation_lease',{p_product_gid:f.productGid,p_owner:owner});
 await f.reconcile(f.db,Date.now()+45000,owner);
 assert.equal(f.cardOf(target.itemId).angles[0].image_path,photo.image.url);assert.equal(f.cardOf(target.itemId).angles.some(a=>a.image_path===oldById.get(removed).image.url),false);
 for(const[id,angles]of originalOthers)assert.deepEqual(f.cardOf(id).angles,angles);
 const s=service(f),row=f.tables.carousel_items.find(r=>r.id===target.itemId),angle=f.tables.carousel_item_angles.find(a=>a.item_id===target.itemId&&a.image_path===photo.image.url);
 const title='שם חדש מדויק',html='<p>תיאור לאחר שינוי המדיה</p>',alt='תיאור תמונה חדש ללא קוד צבע';
 const result=await s.applyOwnedGalleryEdit(f.db,{itemId:target.itemId,expectedVersion:row.copy_updated_at,expectedRevision:row.editor_revision,patch:{
  title:title+(key==='fzt73'?` בצבע ${target.color}`:''),description:'תיאור לאחר שינוי המדיה',descriptionHtml:html,seoTitle:`SEO חדש בצבע ${target.color}`,seoDescription:`תיאור SEO חדש בצבע ${target.color}.`,angles:[{id:angle.id,imageAlt:alt}]}},owner,Date.now()+45000);
 assert.equal(result.changed,true);assert.equal(s.writes.alt[0][0].mediaId,newId);assert.equal(f.state.product.media.nodes[0].alt,alt);
 for(const v of f.variants){const card=f.cardOf(v.itemId);assert.equal(card.title,title+(key==='fzt73'?` בצבע ${v.color}`:''));assert.equal(card.description_html,html);assert.equal(card.seo_title,`SEO חדש בצבע ${v.color}`);assert.equal(card.seo_description,`תיאור SEO חדש בצבע ${v.color}.`);assert.deepEqual(card,f.state.baselines[v.itemId]);}
 assert.equal(f.cardOf(target.itemId).angles[0].image_alt,alt);for(const[id,angles]of originalOthers)assert.deepEqual(f.cardOf(id).angles,angles);
});
