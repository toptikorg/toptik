import { resolveImageLimits } from './helpers/existing-media-limits.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { descriptionModuleUrl } from "./helpers/description-module.mjs";

const moduleUrl=source=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(resolveImageLimits(source))).toString("base64")}`;
const vendorUrl=moduleUrl(readFileSync("src/lib/catalog-source/vendor-detect.ts","utf8"));
const rulesUrl=moduleUrl(readFileSync("src/lib/shopify/sync-rules.ts","utf8").replace('"@/lib/catalog-source/vendor-detect"',JSON.stringify(vendorUrl)));
const policyUrl=moduleUrl(readFileSync("src/lib/shopify/onboarding-policy.ts","utf8")
  .replace('"./description-document"',JSON.stringify(descriptionModuleUrl)).replace('"./sync-rules"',JSON.stringify(rulesUrl)));
const policy=await import(policyUrl);
const guardsUrl=moduleUrl(readFileSync("src/lib/catalog-source/source-allowlist.ts","utf8"));
const workerSource=stripTypeScriptTypes(resolveImageLimits(readFileSync("src/lib/shopify/onboarding-worker.ts","utf8"))).replace(/^import[\s\S]*?;\r?\n/gm,"").replace(/^export /gm,"");
const {makeWorker}=await import(moduleUrl(`
  import {createHash} from 'node:crypto';
  import sharp from '${import.meta.resolve("sharp")}';
  import {isPrivateAddress} from '${guardsUrl}';
  import {normalizeSyncSku} from '${rulesUrl}';
  import {approvedShopifyImageUrl,assertOnboardingShopifyUniqueness,MAX_ONBOARDING_IMAGE_BYTES,ONBOARDING_SHOP_DOMAIN,
    onboardingSnapshotFingerprint,PUBLIC_ONBOARDING_POLICY,publicOnboardingCandidate} from '${policyUrl}';
  export function makeWorker(deps){
    const {configuredShopifyDomain,fetchAllOnboardingVariantIdentities,fetchPublicOnboardingProductSnapshot,lookup,fetch,process}=deps;
    ${workerSource}
    return {ensurePublicShopifyOnboarding,verifyOnboardingImage};
  }
`));
const bytes=await sharp({create:{width:40,height:60,channels:3,background:"#ffcc00"}}).png().toBuffer();
const productId="gid://shopify/Product/999",variantId="gid://shopify/ProductVariant/888";
const input={eventId:"00000000-0000-4000-8000-000000000001",productGid:productId,leaseOwner:"00000000-0000-4000-8000-000000000002"};
function snapshot(){return {id:productId,handle:"new-product",title:"New verified product",descriptionHtml:'<p>A <strong>bag</strong>.</p><table><tr><td>Size</td><td>55</td></tr></table>',seoTitle:"SEO",seoDescription:"Description",status:"ACTIVE",updatedAt:"2026-09-30T12:00:00Z",publishedOnPublication:true,
  vendor:"Samsonite",productType:"carry-on luggage",variants:[{id:variantId,sku:"NEW-001"}],media:[{id:"gid://shopify/MediaImage/77",mediaContentType:"IMAGE",status:"READY",alt:null,image:{url:"https://cdn.shopify.com/s/files/1/verified.png?v=1",width:40,height:60,altText:null}}]};}
test("explicit bag, wallet and accessory types retain their exact gallery categories",()=>{
  for(const [productType,category] of [["תיק צד","fashion-bags"],["תיק כתף","fashion-bags"],["תיק גב","backpacks"],["תיק מחשב","laptop-bags"],["תיק נסיעות","travel-bags"],["ארנק עור","wallets"],["תיק רחצה","pouches"],["unknown",null]]){
    assert.equal(policy.publicOnboardingCandidate({...snapshot(),productType}).category,category);
  }
});
function fixture(options={}){
  const product=options.product??snapshot(),rpcCalls=[],reads=[];let snapshots=0,variantReads=0;
  const rows=options.gallery??[];
  const db={from(table){let start=0,end=999;const query={table};reads.push(query);const builder={
    select(fields){query.fields=fields;return builder;},order(){return builder;},range(a,b){start=a;end=b;return builder;},
    eq(){return builder;},async maybeSingle(){return {data:options.receipt??null,error:null};},
    async abortSignal(){return {data:rows.slice(start,end+1),error:null};}};return builder;},
    async rpc(name,args){rpcCalls.push({name,args});return {data:{changed:true,itemId:"new-item",catalogKey:"NEW001",approvalId:"new-approval"},error:null};}};
  const worker=makeWorker({process:{env:{SHOPIFY_SYNC_AUTOCREATE:options.enabled===false?undefined:"published_shopify"}},configuredShopifyDomain:()=>"toptikcoil.myshopify.com",
    fetchPublicOnboardingProductSnapshot:async()=>{snapshots++;const result=structuredClone(product);if(snapshots>1)options.late?.(result);return result;},
    fetchAllOnboardingVariantIdentities:async()=>{variantReads++;return options.variants??[{id:variantId,sku:product.variants[0].sku,product:{id:productId}}];},
    lookup:async()=>options.addresses??[{address:"8.8.8.8"}],
    fetch:async(url,init)=>{assert.equal(url,product.media[0].image.url);assert.equal(init.redirect,"error");return options.response?.()??new Response(bytes,{headers:{"content-type":"image/png"}});}});
  return {worker,db,product,rpcCalls,reads,counts:()=>({snapshots,variantReads}),run:extra=>worker.ensurePublicShopifyOnboarding(db,{...input,...extra})};
}

test("published product creates exact raw pair and decoded-image evidence through one RPC only",async()=>{
  const f=fixture();assert.equal(await f.run(),true);assert.equal(f.rpcCalls.length,1);
  assert.equal(f.rpcCalls[0].name,"onboard_public_shopify_product");assert.equal(f.rpcCalls[0].args.p_lease_owner,input.leaseOwner);
  const e=f.rpcCalls[0].args.p_evidence;
  assert.equal(e.exactSku,"NEW-001");assert.equal(e.catalogKey,"NEW001");assert.equal(e.copy.descriptionHtml,f.product.descriptionHtml);
  assert.ok(e.copy.description.includes("Size\t55"));assert.equal(e.brandLabel,"Samsonite");assert.equal(e.category,"carryon");
  assert.equal(e.status,"ACTIVE");assert.equal(e.publishedOnPublication,true);assert.equal(e.variantCount,1);assert.equal(e.shopDomain,"toptikcoil.myshopify.com");
  assert.deepEqual(e.media,[{mediaGid:"gid://shopify/MediaImage/77",url:f.product.media[0].image.url,width:40,height:60,mime:"image/png",byteLength:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")}]);
  assert.deepEqual(f.counts(),{snapshots:2,variantReads:2});
  assert.ok(!("price" in e)&&!("sourceUrl" in e));
});

test("draft/unpublished/other-brand and both held SKUs never create or fetch media",async()=>{
  for(const change of [p=>{p.status="DRAFT";},p=>{p.status="ARCHIVED";},p=>{p.publishedOnPublication=false;},p=>{p.vendor="American Tourister";},
    p=>{p.variants[0].sku="P10OSV04-05J-TU";},p=>{p.variants[0].sku="P10ZJT0624U";}]){
    const product=snapshot();change(product);const f=fixture({product});assert.equal(await f.run(),false);assert.equal(f.rpcCalls.length,0);assert.equal(f.counts().variantReads,0);
  }
});

test("missing activation, identity, rich HTML and schema limits fail closed without truncation",async()=>{
  await assert.rejects(fixture({enabled:false}).run(),/NOT_ENABLED/);
  for(const [change,error] of [[p=>{p.variants.push({id:"gid://shopify/ProductVariant/2",sku:"OTHER"});},/MULTIPLE_VARIANTS/],
    [p=>{p.variants[0].sku=" NEW-001 ";},/IDENTITY_INVALID/],[p=>{p.title="x".repeat(121);},/COPY_LIMIT/],
    [p=>{p.descriptionHtml='<script>alert(1)</script>';},/HTML_UNSAFE/],[p=>{p.media=[];},/MEDIA_NOT_READY/],
    [p=>{p.media[0].status="PROCESSING";},/MEDIA_NOT_READY/]]){
    const product=snapshot();change(product);const f=fixture({product});await assert.rejects(f.run(),error);assert.equal(f.rpcCalls.length,0);
  }
});

test("normalized duplicate draft SKUs and inactive Gallery collisions block; no implicit attachment",async()=>{
  const f=fixture({variants:[{id:variantId,sku:"NEW-001",product:{id:productId}},{id:"gid://shopify/ProductVariant/2",sku:"new001",product:{id:"gid://shopify/Product/2"}}]});
  await assert.rejects(f.run(),/SHOPIFY_SKU_COLLISION/);assert.equal(f.rpcCalls.length,0);
  const gallery=Array.from({length:1001},(_,i)=>({id:String(i),catalog_number:i===1000?"new001":`OTHER${i}`,is_active:false}));
  const g=fixture({gallery});await assert.rejects(g.run(),/GALLERY_SKU_COLLISION/);assert.equal(g.rpcCalls.length,0);
  assert.equal(g.reads.filter(r=>r.table==="carousel_items").length,2);
});

test("only matching onboarding receipt permits exact idempotent RPC replay",async()=>{
  const gallery=[{id:"item",catalog_number:"NEW-001",is_active:true}];
  const receipt={product_gid:productId,variant_gid:variantId,catalog_key:"NEW001",carousel_item_id:"item",exact_sku:"NEW-001"};
  assert.equal(await fixture({gallery,receipt}).run(),true);
  await assert.rejects(fixture({gallery,receipt:{...receipt,exact_sku:"NEW001"}}).run(),/GALLERY_SKU_COLLISION/);
});

test("changed version, SKU, image association or publication after decoding prevents commit",async()=>{
  for(const late of [p=>{p.updatedAt="2026-09-30T13:00:00Z";},p=>{p.variants[0].sku="CHANGED";},p=>{p.media[0].id="gid://shopify/MediaImage/999";},p=>{p.publishedOnPublication=false;}]){
    const f=fixture({late});await assert.rejects(f.run(),/SOURCE_CHANGED/);assert.equal(f.rpcCalls.length,0);
  }
});

test("CDN URL/public DNS/decoded bytes and exact dimensions are required",async()=>{
  for(const url of ["https://cdn.shopify.com.evil/s/files/x","http://cdn.shopify.com/s/files/x","https://u@cdn.shopify.com/s/files/x","https://cdn.shopify.com:444/s/files/x","https://cdn.shopify.com:443/s/files/x","https://cdn.shopify.com/s/files/x#x","https://cdn.shopify.com/s/files/a\\b","https://cdn.shopify.com/s/files/a b"])
    assert.equal(policy.approvedShopifyImageUrl(url),null);
  await assert.rejects(fixture({addresses:[{address:"127.0.0.1"}]}).run(),/IMAGE_HOST_UNSAFE/);
  await assert.rejects(fixture({response:()=>new Response("not an image")}).run(),/IMAGE_DECODE_FAILED/);
  await assert.rejects(fixture({response:()=>new Response(bytes,{headers:{"content-length":String(8*1024*1024+1)}})}).run(),/IMAGE_TOO_LARGE/);
  const product=snapshot();product.media[0].image.width=41;await assert.rejects(fixture({product}).run(),/IMAGE_DIMENSIONS_CHANGED/);
});
test('shared existing-image verifier decodes25MP, while new-product admission remains16MP',async()=>{
 const original=await sharp({create:{width:5000,height:5000,channels:3,background:'#fedcba'}}).png().toBuffer();
 const product=snapshot();product.media[0].image.width=5000;product.media[0].image.height=5000;
 const f=fixture({product,response:()=>new Response(original)});
 const decoded=await f.worker.verifyOnboardingImage(product.media[0],Date.now()+15000);
 assert.equal(decoded.width,5000);assert.equal(decoded.height,5000);assert.equal(decoded.sha256,createHash('sha256').update(original).digest('hex'));
 await assert.rejects(f.run(),/SYNC_ONBOARDING_MEDIA_IDENTITY_INVALID/);assert.equal(f.rpcCalls.length,0);
});

test("ambiguous product types remain all-only and shared deadline prevents late mutation",async()=>{
  const product=snapshot();product.productType="Suitcase";assert.equal(policy.publicOnboardingCandidate(product).category,null);
  const f=fixture();await assert.rejects(f.run({deadline:Date.now()+10}),/TIME_BUDGET/);assert.equal(f.rpcCalls.length,0);
});

test("onboarding GraphQL readers scan all statuses, page identities, and use no mutation",async()=>{
  const source=readFileSync("src/lib/shopify/admin-api.ts","utf8");
  const part=source.slice(source.indexOf("export type ShopifyOnboardingSnapshot"),source.indexOf("/** Bounded read for the reviewed seed"));
  const {makeReader}=await import(moduleUrl(`export function makeReader(graphql,getConfig){${part.replace(/^export /gm,"")}return {fetchPublicOnboardingProductSnapshot,fetchAllOnboardingVariantIdentities};}`));
  const queries=[];let page=0;
  const reader=makeReader(async(query,variables,timeout)=>{queries.push({query,variables,timeout});return {productVariants:{nodes:[{id:String(++page),sku:page===1?"ONE":"TWO",product:{id:String(page)}}],pageInfo:{hasNextPage:page===1,endCursor:page===1?"cursor":null}}};},()=>({publicationId:"gid://shopify/Publication/1"}));
  assert.equal((await reader.fetchAllOnboardingVariantIdentities(Date.now()+40000)).length,2);
  assert.equal(queries[1].variables.after,"cursor");assert.ok(queries.every(q=>!q.query.includes("mutation")&&!q.query.includes("status:")&&!q.query.includes("query:")));
  assert.ok(queries.every(q=>q.timeout<=6000));
  await assert.rejects(reader.fetchPublicOnboardingProductSnapshot(productId,Date.now()+40000),/PUBLICATION_MISMATCH/);
  assert.equal(queries.length,2,"wrong publication cannot perform any product fetch");
});
