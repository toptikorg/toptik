import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { p,fixture,time,id } from './helpers/commerce-fixtures.mjs';
const data=s=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString('base64')}`;
const read=p=>readFileSync(new URL('../src/lib/shopify/'+p,import.meta.url),'utf8');
const policyUrl=data(read('commerce-finalization.ts').replace("'zod'",JSON.stringify(import.meta.resolve('zod'))));
const dbUrl=data(read('commerce-database.ts').replace("'./commerce-finalization'",JSON.stringify(policyUrl)));
const modeUrl=data(read('commerce-mode.ts'));
const transportUrl=data(read('commerce-transport.ts').replace("'./commerce-finalization'",JSON.stringify(policyUrl)));
const workerUrl=data(read('commerce-worker.ts').replace("'./commerce-finalization'",JSON.stringify(policyUrl)));
globalThis.__commerce={};
const source=read('commerce-runtime.ts').replace('import "server-only";','')
 .replace('from "zod"',`from ${JSON.stringify(import.meta.resolve('zod'))}`)
 .replace('from "./commerce-finalization"',`from ${JSON.stringify(policyUrl)}`)
 .replace('from "./commerce-mode"',`from ${JSON.stringify(modeUrl)}`)
 .replace('from "./commerce-database"',`from ${JSON.stringify(dbUrl)}`)
 .replace('from "./commerce-worker"',`from ${JSON.stringify(workerUrl)}`)
 .replace('from "./commerce-transport"',`from ${JSON.stringify(transportUrl)}`)
 .replace(/import \{ configuredShopifyDomain, shopifyAdminGraphql \} from "\.\/admin-api";/,
  'const configuredShopifyDomain=()=>"toptikcoil.myshopify.com";const shopifyAdminGraphql=(...a)=>globalThis.__commerce.send(...a);')
 .replace(/import \{ readCommerceShopify, assembleCommerceRead,[\s\S]*?from "\.\/commerce-shopify-read";/,
  'const readCommerceShopify=(...a)=>globalThis.__commerce.read(...a); const assembleCommerceRead=(r,s)=>({snapshot:{...r.snapshot,galleryRowFingerprint:s.galleryRowFingerprint,galleryCopyVersion:s.galleryCopyVersion,galleryCopy:s.galleryCopy},context:{...s.context,...r.context}});');
const m=await import(data(source));
function setup(){
 const f=fixture();f.payload.commercial.tracked=false;f.payload.stock=[];f.intent=p.buildMerchantIntent(f.payload);
 f.context.intentRevision=f.intent.revision;f.context.scopes=['write_products','write_publications'];f.context.locations=[];f.context.locationsComplete=false;f.snapshot.levels=[];f.snapshot.levelsComplete=false;
 const loaded={intent:f.intent,identity:f.snapshot.identity,proof:f.proof,galleryRowFingerprint:f.snapshot.galleryRowFingerprint,galleryCopyVersion:time,galleryCopy:f.snapshot.galleryCopy,
 context:f.context,pendingCommerce:{sellingPrice:'699.00',compareAtPrice:null,barcode:null,taxable:true,requiresShipping:true,currency:'ILS',storeIntent:'publish_when_ready'}};
 const calls=[];let job=null;
 const db={from(table){return{select(){return this},eq(){return this},abortSignal(){return this},async maybeSingle(){calls.push(table);return {data:job?{item_id:f.intent.galleryItemId}:null,error:null}}}},
 rpc(name,args){return{abortSignal:async()=>{calls.push({name,args});if(name==='read_gallery_commerce_source')return {data:structuredClone(loaded),error:null};
 if(name==='claim_gallery_shopify_draft') {loaded.context.leaseOwner=args.p_owner;loaded.context.creationLeaseOwner=args.p_owner;loaded.context.productLeaseOwner=args.p_owner;return{data:{id:args.p_id},error:null}};
 if(name==='reserve_gallery_commercial_finalization'){job={id:f.intent.galleryItemId,plan:args.p_plan,state:args.p_state,boundReceipt:null};return{data:job,error:null}};
 if(name==='release_gallery_shopify_draft')return{data:true,error:null};
 if(name==='save_gallery_creation_commerce')return{data:args.p_intent,error:null};
 throw Error('UNEXPECTED_RPC_'+name);
 }}}};
 globalThis.__commerce={read:async()=>({snapshot:structuredClone(f.snapshot),context:{shopDomain:p.SHOP,apiVersion:p.API_VERSION,shopCurrency:'ILS',scopes:f.context.scopes,capturedAt:time,catalogCapturedAt:time,locations:[],locationsComplete:false,shopify:f.context.shopify}}),send:async()=>assert.fail('initial plan must not send')};
 return {f,loaded,calls,db};
}
async function enabled(fn){const oldEnv=process.env.VERCEL_ENV,oldMode=process.env.SHOPIFY_GALLERY_PUBLISH_MODE,oldNow=Date.now;process.env.VERCEL_ENV='production';process.env.SHOPIFY_GALLERY_PUBLISH_MODE='publish_verified_v1';Date.now=()=>Date.parse(time);
 try{return await fn()}finally{Date.now=oldNow;if(oldEnv===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=oldEnv;if(oldMode===undefined)delete process.env.SHOPIFY_GALLERY_PUBLISH_MODE;else process.env.SHOPIFY_GALLERY_PUBLISH_MODE=oldMode;}}
test('concrete runtime reserves one immutable plan under both owned source leases before any Shopify write',()=>enabled(async()=>{
 const s=setup();const result=await m.runPersistedCommerce(s.db,s.f.intent.galleryItemId);
 assert.deepEqual(result,{status:'pending',mutationAttempted:false,continuationNeeded:true});
 const reserved=s.calls.find(x=>x.name==='reserve_gallery_commercial_finalization');assert.equal(reserved.args.p_plan.intent.commercial.tracked,false);
 assert.deepEqual(reserved.args.p_plan.steps.map(x=>x.kind),['commerce','activate_product','publish_product']);assert.equal(s.calls.at(-1).name,'release_gallery_shopify_draft');
}));
test('merchant route schema refuses client identity/proof/stock/actor fields',()=>{
 const edit={itemId:id(2),expectedRevision:null,requestId:id(3),values:{price:'1545',compareAtPrice:null,barcode:null,taxable:true,requiresShipping:true,publishWhenReady:true}};
 assert.equal(m.commerceEditSchema.safeParse(edit).success,true);
 for(const extra of [{productGid:'gid://shopify/Product/1'},{actorId:id(4)},{sourceFingerprint:'a'.repeat(64)},{stock:[]}])assert.equal(m.commerceEditSchema.safeParse({...edit,...extra}).success,false);
 assert.equal(m.commerceEditSchema.safeParse({...edit,values:{...edit.values,tracked:true}}).success,false);
});
test('server verified session actor is retained and nullable commerce remains explicit',()=>enabled(async()=>{
 const s=setup();s.loaded.intent=null;
 const saved=await m.saveCommerceEdit(s.db,{itemId:id(2),expectedRevision:null,requestId:id(5),values:{price:'1545',compareAtPrice:null,barcode:null,taxable:false,requiresShipping:true,publishWhenReady:true}},Date.now()+9000,id(99));
 assert.equal(saved.provenance.actorId,id(99));assert.equal(saved.commercial.price,'1545.00');assert.equal(saved.commercial.compareAtPrice,null);assert.deepEqual(saved.stock,[]);assert.equal(saved.commercial.tracked,false);
}));
test('default off performs no service or Shopify call',async()=>{
 const old=process.env.SHOPIFY_GALLERY_PUBLISH_MODE;delete process.env.SHOPIFY_GALLERY_PUBLISH_MODE;try{const s=setup();assert.equal((await m.runPersistedCommerce(s.db,id(2))).status,'disabled');assert.equal(s.calls.length,0)}finally{if(old!==undefined)process.env.SHOPIFY_GALLERY_PUBLISH_MODE=old;}
});
test('uncertain plan reservation never schedules continuation or sends, and releases owned lease',()=>enabled(async()=>{
 const s=setup(),base=s.db.rpc;s.db.rpc=(name,args)=>name==='reserve_gallery_commercial_finalization'?{abortSignal:async()=>{throw Error('lost accepted SQL reply')}}:base(name,args);
 const result=await m.runPersistedCommerce(s.db,id(2));assert.equal(result.continuationNeeded,false);assert.equal(result.mutationAttempted,false);assert.equal(s.calls.at(-1).name,'release_gallery_shopify_draft');
}));
