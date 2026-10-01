import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {descriptionModuleUrl} from './helpers/description-module.mjs';
const asUrl=s=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString('base64')}`;
const vendor=asUrl(readFileSync('src/lib/catalog-source/vendor-detect.ts','utf8'));
const rules=asUrl(readFileSync('src/lib/shopify/sync-rules.ts','utf8').replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendor)));
const policyUrl=asUrl(readFileSync('src/lib/shopify/creation-policy.ts','utf8').replace('"zod"',JSON.stringify(import.meta.resolve('zod'))).replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rules)));
const p=await import(policyUrl);
const workerSource=readFileSync('src/lib/shopify/creation-worker.ts','utf8');
const {runGalleryDraftCreation:run}=await import(asUrl(workerSource.replace('"./creation-policy"',JSON.stringify(policyUrl))));
const id='00000000-0000-4000-8000-000000000061',owner='00000000-0000-4000-8000-000000000062';
const now=Date.parse('2026-09-30T19:00:00Z'),ts=new Date(now).toISOString(),namespace='app--12345--toptik_gallery';
function fixture(flags={}){
 const source={galleryItemId:id,copyUpdatedAt:ts,shopifySku:'NEW.999',manufacturerSku:'NEW.999',identityMapping:null,brand:"Bric's",category:'carryon',
  copy:{title:'מוצר אמיתי',description:'תיאור',descriptionHtml:'<p>תיאור</p>',seoTitle:null,seoDescription:null},media:[{url:'https://cdn.shopify.com/s/files/1/exact.webp',alt:'תמונה אמיתית'}],
  commerce:{sellingPrice:'999',currency:'ILS',compareAtPrice:null,barcode:null,taxable:true,requiresShipping:true,inventory:{status:'unknown'},storeIntent:'draft'}};
 const image={url:source.media[0].url,galleryItemId:id,exactSku:source.shopifySku,sha256:'a'.repeat(64),mime:'image/webp',width:600,height:800,byteLength:12000,verifiedAt:ts};
 const ready=p.readyGalleryCreationDraft(source,{mode:'draft_only',now,shopDomain:p.CREATION_SHOP,shopCurrency:'ILS',expectedAppNamespace:namespace,
  definition:{namespace,key:'source_item_id',ownerType:'PRODUCT',type:'id',uniqueValuesEnabled:true},catalog:{complete:true,capturedAt:ts,gallery:[{id,catalogNumber:source.shopifySku,isActive:false}],shopify:[]},images:[image]});
 let record={id,source,catalogKey:'NEW999',stage:'reserved',version:0,readyProof:null,receipt:null},remote=null,locked=false;
 const sent={create:0,configure:0,publication:0};const events=[];
 const ports={mode:'draft_only',now:()=>now,beforeWrite:()=>{if(flags.lowBudget)throw new Error('SYNC_CREATION_TIME_BUDGET');},
  claim:async()=>{if(locked)return null;locked=true;return structuredClone(record);},release:async()=>{locked=false;},
  recordFailure:async(_id,_owner,code)=>{record.last_error=code;},
  advance:async(before,_owner,patch)=>{
   if(before.version!==record.version)throw new Error('SYNC_CREATION_SOURCE_CAS');
   if(flags.sourceChangedAt===patch.receipt.stage)throw new Error('SYNC_CREATION_SOURCE_CAS');
   events.push(patch.receipt.stage);record={...record,stage:patch.receipt.stage,receipt:structuredClone(patch.receipt),version:record.version+1,
    ...(patch.readyProof?{readyProof:structuredClone(patch.readyProof)}:{}),...(patch.readbackProof?{readbackProof:structuredClone(patch.readbackProof)}:{})};
   if(flags.lostAdvance===record.stage){flags.lostAdvance=null;throw new Error('SYNC_CREATION_TRANSACTION_FAILED');}
   return {...structuredClone(record),replayed:flags.replayed===record.stage};
  },
  prepare:async()=>structuredClone(ready),lookup:async()=>{
   if(remote&&flags.merchantEditBeforeConfigure&&record.stage==='draft_found'){remote.commercial.price='88';flags.merchantEditBeforeConfigure=false;}
   return structuredClone(remote);
  },
  create:async()=>{
   assert.equal(record.stage,'create_started');sent.create++;
   remote={productGid:'gid://shopify/Product/999',variantGid:'gid://shopify/ProductVariant/888',variantCount:1,sku:'',status:'DRAFT',publishedAnywhere:false,
    customId:ready.customId,sourceFingerprint:ready.sourceFingerprint,updatedAt:ts,brand:source.brand,copy:{title:source.copy.title,descriptionHtml:source.copy.descriptionHtml,seoTitle:null,seoDescription:null},
    commercial:{price:'0.00',compareAtPrice:null,barcode:null,taxable:false,requiresShipping:true}};
   if(flags.lostCreate){flags.lostCreate=false;throw new Error('SYNC_CREATION_RESPONSE_LOST');}
   return structuredClone(remote);
  },
  configure:async variables=>{
   assert.equal(record.stage,'variant_started');sent.configure++;const v=variables.variants[0];remote.sku=v.inventoryItem.sku;
   Object.assign(remote.commercial,Object.fromEntries(['price','compareAtPrice','barcode','taxable'].filter(key=>key in v).map(key=>[key,v[key]])));
   if(flags.lostConfigure){flags.lostConfigure=false;throw new Error('SYNC_CREATION_RESPONSE_LOST');}
  },
  media:async()=>{
   if(flags.mediaPending){flags.mediaPending=false;throw new Error('SYNC_CREATION_MEDIA_PENDING');}
   return [{...image,productGid:remote.productGid,mediaGid:'gid://shopify/MediaImage/12',status:'READY',alt:source.media[0].alt,
    ...(flags.mediaChanged?{sha256:'b'.repeat(64)}:{})}];
  }};
 return {ports,ready,sent,events,get record(){return record;},get remote(){return remote;},setBusy(){locked=true;}};
}

test('executable creation→configure→media readback produces one unpublished ready draft',async()=>{
 const f=fixture();assert.deepEqual(await run(id,owner,f.ports),{id,stage:'draft_ready',pending:false});
 assert.deepEqual(f.events,['reserved','create_started','draft_found','variant_started','draft_ready']);
 assert.deepEqual(f.sent,{create:1,configure:1,publication:0});assert.equal(f.remote.status,'DRAFT');
 assert.equal(f.record.readbackProof.media[0].sha256,'a'.repeat(64));
 await run(id,owner,f.ports);assert.equal(f.sent.create,1);assert.equal(f.sent.configure,1);
});
test('lost create response: exact custom-ID recovery never creates again or guesses commercial baseline',async()=>{
 const f=fixture({lostCreate:true});assert.equal((await run(id,owner,f.ports)).stage,'uncertain');
 assert.equal((await run(id,owner,f.ports)).stage,'review');assert.deepEqual(f.sent,{create:1,configure:0,publication:0});
 assert.equal(f.remote.sku,'');
});
test('lost configure response: readback completes without repeating the mutation',async()=>{
 const f=fixture({lostConfigure:true});assert.equal((await run(id,owner,f.ports)).stage,'uncertain');
 assert.equal((await run(id,owner,f.ports)).stage,'draft_ready');assert.equal(f.sent.configure,1);assert.equal(f.sent.create,1);
});
test('database committed started receipt but response was lost: no external send or replay',async()=>{
 const f=fixture({lostAdvance:'create_started'});await run(id,owner,f.ports);
 assert.equal(f.record.stage,'create_started');assert.equal(f.sent.create,0);
 const result=await run(id,owner,f.ports);assert.equal(result.pending,true);assert.equal(f.sent.create,0);
});
test('source CAS rejects concurrent source edits before external create',async()=>{
 const f=fixture({sourceChangedAt:'create_started'});const result=await run(id,owner,f.ports);
 assert.equal(result.code,'SYNC_CREATION_SOURCE_CAS');assert.equal(f.sent.create,0);
});
test('replayed started acknowledgement is never authority to resend',async()=>{
 for(const stage of ['create_started','variant_started']){
  const f=fixture({replayed:stage});const result=await run(id,owner,f.ports);assert.equal(result.pending,true);
  assert.equal(stage==='create_started'?f.sent.create:f.sent.configure,0);
 }
});
test('busy lease and disabled policy execute no external calls',async()=>{
 const f=fixture();f.setBusy();assert.equal((await run(id,owner,f.ports)).stage,'busy');assert.equal(f.sent.create,0);
 f.ports.mode=undefined;await assert.rejects(run(id,owner,f.ports),/NOT_ENABLED/);assert.equal(f.sent.create,0);
});
test('insufficient write budget stops before started so a safe later attempt can proceed',async()=>{
 const flags={lowBudget:true},f=fixture(flags);assert.equal((await run(id,owner,f.ports)).pending,true);
 assert.equal(f.record.stage,'reserved');assert.equal(f.sent.create,0);
 flags.lowBudget=false;assert.equal((await run(id,owner,f.ports)).stage,'draft_ready');assert.equal(f.sent.create,1);
});
test('merchant edit at unchanged product version is preserved and quarantined',async()=>{
 const f=fixture({merchantEditBeforeConfigure:true});const result=await run(id,owner,f.ports);
 assert.equal(result.stage,'review');assert.equal(result.code,'SYNC_CREATION_DRAFT_COMMERCE_CHANGED');
 assert.equal(f.sent.configure,0);assert.equal(f.remote.commercial.price,'88');
 assert.equal(f.record.last_error,'SYNC_CREATION_DRAFT_COMMERCE_CHANGED');
});
test('readiness failure before Shopify creation is visible in durable private status',async()=>{
 const f=fixture();f.ports.prepare=async()=>{throw new Error('SYNC_CREATION_CUSTOM_ID_DEFINITION_MISSING');};
 const result=await run(id,owner,f.ports);assert.equal(result.pending,false);assert.equal(f.sent.create,0);
 assert.equal(f.record.last_error,'SYNC_CREATION_CUSTOM_ID_DEFINITION_MISSING');
});
test('media processing resumes readback, while changed image never becomes ready',async()=>{
 const f=fixture({mediaPending:true});assert.equal((await run(id,owner,f.ports)).pending,true);
 assert.equal((await run(id,owner,f.ports)).stage,'draft_ready');assert.equal(f.sent.configure,1);
 const drift=fixture({mediaChanged:true});assert.equal((await run(id,owner,drift.ports)).stage,'review');assert.equal(drift.record.readbackProof,undefined);
});
test('authenticated route is default-off, bounded, fixed-origin and isolated from old copy queues',()=>{
 const route=readFileSync('src/app/api/admin/shopify/drafts/route.ts','utf8');
 assert.equal((route.match(/const denied = requireAdminToken\(request\)/g)||[]).length,3);
 assert.match(route,/getReader\(\)/);assert.match(route,/length > LIMIT/);assert.match(route,/saveSchema.*strict\(\)/s);
 const runtime=readFileSync('src/lib/shopify/creation-runtime.ts','utf8');
 assert.match(runtime,/VERCEL_ENV === "production" && process.env.SHOPIFY_GALLERY_CREATE_MODE === "draft_only"/);
 for(const source of [workerSource,runtime,route])assert.doesNotMatch(source,/publishablePublish|productSet\(|inventorySetQuantities|shopify_gallery_copy_eligibility|shopify_gallery_content_outbox/);
 const scheduler=readFileSync('src/lib/shopify/schedule-creation.ts','utf8');
 assert.match(scheduler,/https:\/\/landing\.toptik\.co\.il\/api\/admin\/shopify\/drafts/);assert.match(scheduler,/MAX_CREATION_HOPS = 8/);
});
