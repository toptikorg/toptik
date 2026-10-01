import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {descriptionModuleUrl} from "./helpers/description-module.mjs";
const url=s=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString("base64")}`;
const read=p=>readFileSync(p,"utf8");
const vendor=url(read("src/lib/catalog-source/vendor-detect.ts"));
const rules=url(read("src/lib/shopify/sync-rules.ts").replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendor)));
const onboarding=url(read("src/lib/shopify/onboarding-policy.ts").replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rules)));
const policyUrl=url(read("src/lib/shopify/osv04-admission-policy.ts").replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./onboarding-policy"',JSON.stringify(onboarding)));
const {OSV04_ADMISSION:id,validateOsv04AdmissionSource:validate}=await import(policyUrl);
const source=stripTypeScriptTypes(read("src/lib/shopify/osv04-admission.ts")).replace(/^import[\s\S]*?;\r?\n/gm,"").replace(/^export /gm,"");
const {make}=await import(url(`import {OSV04_ADMISSION,validateOsv04AdmissionSource} from '${policyUrl}';import {onboardingSnapshotFingerprint} from '${onboarding}';export function make(process){${source};return admitExistingOsv04;}`));
function product(){return {id:id.productId,handle:id.handle,title:"Official product",descriptionHtml:"<p>Current <strong>rich</strong> copy.</p>",seoTitle:null,seoDescription:null,status:"ACTIVE",updatedAt:new Date().toISOString(),publishedOnPublication:true,vendor:"mandarinaduck",productType:"suitcase",variants:[{id:id.variantId,sku:id.shopifySku}],media:[{id:"gid://shopify/MediaImage/123",mediaContentType:"IMAGE",status:"READY",alt:null,image:{url:"https://cdn.shopify.com/s/files/1/official.png?v=1",width:40,height:60,altText:null}}]};}
function commerce(){return {shop:{myshopifyDomain:"toptikcoil.myshopify.com",currencyCode:"ILS"},product:{id:id.productId,variants:{nodes:[{id:id.variantId,sku:id.shopifySku,price:"1545.00",inventoryItem:{tracked:false}}],pageInfo:{hasNextPage:false}}}};}
const variants=p=>[{...p.variants[0],product:{id:p.id}}];
function fixture(options={}){const p=product(),c=commerce(),calls=[];let count=0,commercialReads=0;const now=Date.now();
 const run=make({env:{VERCEL_ENV:options.env??"production"}});
 const deps={now:()=>now,client:{rpc(name,args){calls.push({name,args});return {async abortSignal(){return {data:name==='read_existing_osv04_admission'?(options.initial??{admitted:false,galleryRevision:'a'.repeat(64)}):(options.result??{admitted:true,replayed:false,enabled:true,itemId:id.itemId}),error:null};}};}},
 transport:()=>({async acquire(){calls.push({acquire:true});return {owner:'lease-owner',expiresAt:now+300000};},async release(){calls.push({release:true});}}),
 product:async()=>{count++;const fresh=structuredClone(p);if(count===2)options.late?.(fresh);return fresh;},variants:async()=>variants(p),
 commerce:async()=>{commercialReads++;const fresh=structuredClone(c);if(commercialReads===2)options.commerceLate?.(fresh);return fresh;},
 image:async m=>({mediaGid:m.id,url:m.image.url,width:40,height:60,mime:'image/png',byteLength:1000,sha256:'b'.repeat(64)})};
 return {p,c,calls,deps,run:()=>run(now+45000,deps)};}
test('exact approved tuple preserves raw Shopify rich copy and independent Gallery CAS evidence',async()=>{const f=fixture(),r=await f.run();assert.equal(r.admitted,true);assert.deepEqual(f.calls.map(x=>x.name??Object.keys(x)[0]),['acquire','read_existing_osv04_admission','admit_existing_osv04','release']);const e=f.calls[2].args.p_evidence;assert.equal(e.gallerySku,id.gallerySku);assert.equal(e.shopifySku,id.shopifySku);assert.equal(e.copy.descriptionHtml,f.p.descriptionHtml);assert.equal(e.copy.description,'Current rich copy.');assert.equal(e.media[0].sha256,'b'.repeat(64));assert.equal(e.galleryRevision,'a'.repeat(64));});
for(const field of ['id','handle','vendor','status'])test(`reject unapproved product ${field}`,()=>{const p=product();p[field]='different';assert.throws(()=>validate(p,variants(p),commerce()),/IDENTITY/);});
for(const mutate of [p=>p.variants[0].sku=id.gallerySku,p=>p.variants[0].id='gid://shopify/ProductVariant/1',p=>p.variants.push({...p.variants[0]}),p=>p.publishedOnPublication=false])test('exact variant, SKU, single-variant and publication required',()=>{const p=product();mutate(p);assert.throws(()=>validate(p,variants(p),commerce()),/IDENTITY/);});
for(const mutate of [c=>c.shop.currencyCode='USD',c=>c.product.variants.nodes[0].price='1544.00',c=>c.product.variants.nodes[0].inventoryItem.tracked=true,c=>c.product.variants.pageInfo.hasNextPage=true])test('merchant approved price/currency/untracked scope cannot drift',()=>{const c=commerce(),p=product();mutate(c);assert.throws(()=>validate(p,variants(p),c),/IDENTITY/);});
test('inactive/exact and normalized Shopify SKU collisions block admission',()=>{const p=product();assert.throws(()=>validate(p,[...variants(p),{id:'gid://shopify/ProductVariant/2',sku:id.gallerySku,product:{id:'gid://shopify/Product/2'}}],commerce()),/COLLISION/);});
for(const mutate of [p=>p.media.push(structuredClone(p.media[0])),p=>p.media[0].image.url='https://evil.example/a.png',p=>p.media[0].image.width=0,p=>p.media[0].status='PROCESSING',p=>p.descriptionHtml='<script>alert(1)</script>',p=>p.title='x'.repeat(121)])test('invalid media and active HTML never reach evidence',()=>{const p=product();mutate(p);assert.throws(()=>validate(p,variants(p),commerce()),/INVALID|UNSAFE/);});
for(const late of [p=>p.title='changed',p=>p.variants[0].sku='CHANGED',p=>p.media[0].image.url+='2'])test('final Shopify re-read drift releases lease without admission',async()=>{const f=fixture({late});await assert.rejects(f.run(),/SOURCE_CHANGED/);assert.ok(!f.calls.some(x=>x.name==='admit_existing_osv04'));assert.equal(f.calls.at(-1).release,true);});
test('late commerce edit blocks admission',async()=>{const f=fixture({commerceLate:c=>c.product.variants.nodes[0].price='1546.00'});await assert.rejects(f.run(),/SOURCE_CHANGED/);assert.ok(!f.calls.some(x=>x.name==='admit_existing_osv04'));});
test('disabled replay neither rereads Shopify nor re-enables/resets association',async()=>{const f=fixture({initial:{admitted:true,enabled:false,itemId:id.itemId}});f.deps.product=async()=>assert.fail('no Shopify read');const r=await f.run();assert.equal(r.enabled,false);assert.equal(r.replayed,true);assert.equal(f.calls.filter(x=>x.name).length,1);});
test('nonproduction performs no I/O',async()=>{const f=fixture({env:'preview'});await assert.rejects(f.run(),/PRODUCTION_REQUIRED/);assert.equal(f.calls.length,0);});
test('malformed successful RPC result is not reported as admission',async()=>{const f=fixture({result:{admitted:true,itemId:'wrong'}});await assert.rejects(f.run(),/CONTEXT_INVALID/);});
