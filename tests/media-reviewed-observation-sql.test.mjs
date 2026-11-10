import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRestoredRetirementDatabase } from './helpers/media-restored-retirement-sql-fixture.mjs';
import {mod,stripped,coreUrl,galleryUrl,readyUrl,ready,visualOf} from './helpers/media-planning-fixture.mjs';
const f=await createRestoredRetirementDatabase(),{db,rpc}=f;
await db.exec(await readFile('supabase/migrations/20261110191500_reviewed_gallery_observation_refresh.sql','utf8'));
let serial=19000;
async function seed(){const n=serial++,owner=randomUUID(),angle=randomUUID(),product=`gid://shopify/Product/${n}`;
 const identity={productId:product,variantId:`gid://shopify/ProductVariant/${n}`,itemId:randomUUID(),exactGallerySku:'SKU-'+n,exactShopifySku:'SKU'+n,productHandle:'source-'+n};
 const url=`https://cdn.shopify.com/s/files/1/0001/${n}.png`,oldId='g-old-'+n,newId='g-new-'+n;
 await db.query('insert into carousel_items(id,title,cover_image_path,catalog_number,cover_image_alt) values($1,$2,$3,$4,$2)',[identity.itemId,'Photo',url,identity.exactGallerySku]);
 await db.query('insert into carousel_item_angles(id,item_id,angle_key,image_path,angle_order,image_alt) values($1,$2,$3,$4,1,$5)',[angle,identity.itemId,'front',url,'Photo']);
 await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)',[product,identity.exactShopifySku,identity.itemId,identity.variantId,identity.exactGallerySku,identity.exactShopifySku,identity.productHandle]);
 await db.query("insert into shopify_gallery_reconciliation_leases values($1,$2,clock_timestamp()+interval '10 minutes')",[product,owner]);
 const raw=await rpc('read_toptik_gallery_media',[product,owner]);
 const asset=(side,evidence,content='a'.repeat(64))=>({key:'existing',contentId:content,evidenceId:evidence,alt:'Photo'});
 const pair=Object.fromEntries(['gallery','shopify'].map(side=>[side,{identity,side,revision:side==='gallery'?raw.revision:'native-v1',complete:true,assets:[asset(side,side==='gallery'?oldId:'s-old-'+n)]}]));
 const proof=(side,evidence,hash)=>({key:'existing',side,evidenceId:evidence,contentId:hash,proof:{url,platformRef:side==='gallery'?`angle:${angle}`:`gid://shopify/MediaImage/${n}`,decodedSha256:hash,width:40,height:60,mime:'image/png',byteLength:100,ownership:'reference_only',verifiedAt:new Date().toISOString()}});
 const approval=randomUUID();await rpc('bootstrap_toptik_media',[product,owner,approval,pair,[proof('gallery',oldId,'a'.repeat(64)),proof('shopify','s-old-'+n,'a'.repeat(64))],{evidenceId:'approved-'+n}]);
 await rpc('set_toptik_media_enabled',[product,owner,randomUUID(),true,approval]);
 const refs=[{role:'cover',angleId:null,key:'existing',evidenceId:oldId},{role:'angle',angleId:angle,key:'existing',evidenceId:oldId}];
 const old=await rpc('observe_toptik_gallery_media',[product,owner,raw.revision,refs]);
 await rpc('register_toptik_media_provenance',[product,owner,[proof('gallery',newId,'b'.repeat(64))]]);
 const next=refs.map(r=>({...r,evidenceId:newId}));
 const args=[product,owner,raw.revision,next,[newId]];
 return{identity,product,owner,raw,old,refs,next,newId,args,pair};}

test('real SQL reproduces reused observation and appends a reviewed epoch without altering history, catalog or baseline',async()=>{
 const x=await seed();await assert.rejects(rpc('observe_toptik_gallery_media',x.args.slice(0,4)),/MEDIA_GALLERY_OBSERVATION_REUSED/);
 const before=(await db.query('select baselines,version from toptik_media_private.state where product_gid=$1',[x.product])).rows[0];
 const after=await rpc('refresh_toptik_reviewed_gallery_observation',x.args);
 assert.equal(after.raw.version,x.raw.version+1);assert.notEqual(after.raw.revision,x.raw.revision);
 assert.deepEqual(after.raw.item,x.raw.item);assert.deepEqual(after.raw.angles,x.raw.angles);assert.deepEqual(after.refs,x.next);
 assert.equal(after.snapshot.assets[0].contentId,'b'.repeat(64));
 assert.deepEqual((await db.query('select baselines,version from toptik_media_private.state where product_gid=$1',[x.product])).rows[0],before);
 assert.deepEqual((await db.query('select raw,refs,snapshot from toptik_media_private.gallery_observations where product_gid=$1 and revision=$2',[x.product,x.raw.revision])).rows[0],x.old);
 assert.equal((await db.query('select count(*)::int n from toptik_media_private.observation_refreshes where product_gid=$1',[x.product])).rows[0].n,1);
 assert.deepEqual(await rpc('observe_toptik_gallery_media',[x.product,x.owner,after.raw.revision,x.next]),after);
 await assert.rejects(db.query('delete from toptik_media_private.observation_refreshes where product_gid=$1',[x.product]),/IMMUTABLE/);
});
for(const [name,edit,expected]of[
 ['missing reviews',x=>x.args[4]=[],/REVIEW_REQUIRED/],
 ['foreign review',x=>x.args[4]=['another-proof'],/REVIEW_REQUIRED/],
 ['duplicate review',x=>x.args[4]=[x.newId,x.newId],/REVIEW_REQUIRED/],
 ['review is not a string',x=>x.args[4]=[{}],/REVIEW_REQUIRED/],
 ['changed logical key',x=>x.args[3]=x.next.map(r=>({...r,key:'other'})),/PROVENANCE|SOURCE_CHANGED/],
 ['changed physical identity',x=>x.args[3][1].angleId=randomUUID(),/REFERENCE_INVALID|SOURCE_CHANGED/],
 ['stale revision',x=>x.args[2]='stale',/CAS_CHANGED/],
 ['foreign lease',x=>x.args[1]=randomUUID(),/LEASE/],
])test('reviewed refresh refuses '+name+' atomically',async()=>{const x=await seed();edit(x);await assert.rejects(rpc('refresh_toptik_reviewed_gallery_observation',x.args),expected);assert.deepEqual(await rpc('read_toptik_gallery_media',[x.product,x.owner]),x.raw);assert.equal((await db.query('select count(*)::int n from toptik_media_private.observation_refreshes where product_gid=$1',[x.product])).rows[0].n,0);});
test('active transport is never rebound',async()=>{const x=await seed();await db.query("insert into toptik_media_private.operations(id,product_gid,state_version,plan,initial_pair,request_hash,observed_pair)values($1,$2,1,'{}',$3,$4,$3)",[randomUUID(),x.product,JSON.stringify(x.pair),'a'.repeat(64)]);await assert.rejects(rpc('refresh_toptik_reviewed_gallery_observation',x.args),/OPERATION_ACTIVE/);});
test('reviewed observation refresh is service only',async()=>{for(const role of['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'public.refresh_toptik_reviewed_gallery_observation(text,uuid,text,jsonb,jsonb)','execute') ok",[role])).rows[0].ok,false);assert.equal((await db.query("select has_function_privilege('service_role','public.refresh_toptik_reviewed_gallery_observation(text,uuid,text,jsonb,jsonb)','execute') ok")).rows[0].ok,true);});

for(const resume of[false,true])test('actual capture, real review gate, transport port and SQL runtime finish byte refresh with zero media writes'+(resume?' after a crash following refresh':''),async()=>{
 const x=await seed(),hash='b'.repeat(64),url=x.raw.item.cover_image_path;
 if(resume)await rpc('refresh_toptik_reviewed_gallery_observation',x.args);
 const client={rpc(name,args){return{abortSignal(){return rpc(name,Object.values(args)).then(data=>({data,error:null}));}};}};
 const gallery=await import(galleryUrl);
 const planning=await import(mod(`import{randomUUID}from'node:crypto';import{mediaSnapshotFingerprint}from'${coreUrl}';import{parseGalleryMediaRaw}from'${galleryUrl}';${stripped('media-planning-rpc')}`));
 const guardUrl=mod('const manifest={items:[],deniedUrls:[],deniedSha256:[]};'+stripped('reviewed-media-guard'));
 const reviews=[{sku:x.identity.exactGallerySku,shopifySku:x.identity.exactShopifySku,productId:x.product,variantId:x.identity.variantId,galleryId:x.identity.itemId,imageUrl:url,decodedSha256:hash}];
 const gateFactory=await import(mod(`import{requireReviewedMedia,reviewedMediaRegistry}from'${guardUrl}';const loadReviewedMedia=()=>{throw Error('NO_REAL_STORAGE');};${stripped('media-reviewed-observation')}`));
 const observation=await import(mod(`import{createHash}from'node:crypto';import{galleryRawToSnapshot}from'${galleryUrl}';import{mediaReadToSnapshot}from'${readyUrl}';import{assertNotDeniedMedia,requireReviewedMedia,isReviewedMediaProof,reviewedMediaRegistry}from'${guardUrl}';const loadReviewedMedia=()=>{throw Error('NO_REAL_STORAGE');};${stripped('media-planning-observation')}`));
 const factory=await import(mod(`import{randomUUID}from'node:crypto';import{reconcileMedia,mediaSnapshotFingerprint}from'${coreUrl}';export function make(gate){const reviewedObservationEvidenceIds=gate;${stripped('media-product-runtime').replace(/^export /gm,'')}return reconcilePersistedMediaProduct;}`));
 const run=factory.make((c,r,p,d)=>gateFactory.reviewedObservationEvidenceIds(c,r,p,d,async()=>reviews));
 const n=x.product.split('/').at(-1),conn=nodes=>({nodes,pageInfo:{hasNextPage:false}});
 const read=ready.parseMediaReadResponse({data:{product:{id:x.product,handle:x.identity.productHandle,status:'ACTIVE',publishedOnPublication:true,updatedAt:new Date().toISOString(),mediaCount:{count:1,precision:'EXACT'},
  media:conn([{id:`gid://shopify/MediaImage/${n}`,mediaContentType:'IMAGE',status:'READY',fileStatus:'READY',alt:'Photo',updatedAt:new Date().toISOString(),image:{id:`gid://shopify/ImageSource/${n}`,url,width:40,height:60}}]),variants:conn([{id:x.identity.variantId,sku:x.identity.exactShopifySku,image:null,media:conn([])}])}}},x.identity);
 const port=gallery.createGalleryMediaTransport(x.identity,{client}),time=Date.now();let writes=0;
 const result=await run(x.product,{},time+120000,{
  environment:{VERCEL_ENV:'production',SHOPIFY_MEDIA_SYNC:'enabled_v1'},
  planning:id=>planning.createMediaPlanningRpc(id,{client}),gallery:()=>port,
  transport:()=>({acquire:async()=>({owner:x.owner,expiresAt:time+600000}),release:async()=>{},recordPlannerConflict:async()=>{throw Error('UNEXPECTED_CONFLICT');}}),
  capture:(c,o,d)=>observation.captureMediaPlanningPair(c,o,d,{capture:async()=>({sha256:hash,mime:'image/png',width:40,height:60,byteLength:100,visual:visualOf('existing')}),shopify:async()=>read,gallery:()=>port,reviewLoader:async()=>reviews}),
  phase:async()=>{writes++;throw Error('UNEXPECTED_MEDIA_WRITE');},
 });
 assert.equal(result.status,'done');assert.equal(writes,0);
 const state=(await db.query('select baselines,version from toptik_media_private.state where product_gid=$1',[x.product])).rows[0];
 assert.equal(state.version,2);assert.equal(state.baselines.gallery.assets[0].contentId,hash);assert.equal(state.baselines.shopify.assets[0].contentId,hash);
 assert.equal((await db.query('select count(*)::int n from toptik_media_private.steps where operation_id in(select id from toptik_media_private.operations where product_gid=$1)',[x.product])).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from toptik_media_private.observation_refreshes where product_gid=$1',[x.product])).rows[0].n,1);
});
test.after(async()=>{await db.close();});
