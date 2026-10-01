import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const url=s=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(s)).toString('base64')}`;
let answer=null,calls=[];
globalThis.__galleryCreationTest={domain:'toptikcoil.myshopify.com',request:async(query,variables,timeout)=>{calls.push({query,variables,timeout});return typeof answer==='function'?answer(query,variables):structuredClone(answer);}};
const transport=url('export const configuredShopifyDomain=()=>globalThis.__galleryCreationTest.domain; export const shopifyAdminGraphql=(...args)=>globalThis.__galleryCreationTest.request(...args);');
// Only payload parsing is mocked here; policy's exact payload has separate executable tests.
const policy=url('export const CREATION_SHOP="toptikcoil.myshopify.com"; export const buildGalleryDraftCreateVariables=ready=>ready.variables;');
const source=readFileSync('src/lib/shopify/creation-admin-api.ts','utf8');
const api=await import(url(source.replace('import "server-only";','').replace('"./admin-api"',JSON.stringify(transport)).replace('"./creation-policy"',JSON.stringify(policy))));
const namespace='app--12345--toptik_gallery';
const ready={customId:{namespace,key:'source_item_id',value:'exactUUID'},variables:{product:{title:'שם',status:'DRAFT'},media:[]}};
function product(){return {id:'gid://shopify/Product/999',title:'שם',descriptionHtml:'<p>תיאור</p>',seo:{title:null,description:null},vendor:"Bric's",status:'DRAFT',updatedAt:'2026-09-30T19:00:00Z',
 resourcePublicationsCount:{count:0},sourceId:{value:'exactUUID'},sourceHash:{value:'a'.repeat(64)},
 variants:{nodes:[{id:'gid://shopify/ProductVariant/888',sku:null,price:'0.00',compareAtPrice:null,barcode:null,taxable:false,inventoryItem:{requiresShipping:true}}],pageInfo:{hasNextPage:false}},media:{nodes:[],pageInfo:{hasNextPage:false}}};}
const deadline=()=>Date.now()+40000;

test('configuration resolves actual app namespace and existing unique definition without mutations',async()=>{
 calls=[];answer=query=>query.includes('GalleryDraftShopConfig')?{shop:{currencyCode:'ILS'},currentAppInstallation:{app:{id:'gid://shopify/App/12345'}}}:
  {metafieldDefinitions:{nodes:[{namespace,key:'source_item_id',ownerType:'PRODUCT',type:{name:'id'},capabilities:{uniqueValues:{enabled:true}}}],pageInfo:{hasNextPage:false}}};
 const config=await api.readCreationShopConfiguration(deadline());assert.equal(config.namespace,namespace);assert.equal(config.definition.uniqueValuesEnabled,true);
 assert.equal(calls.length,2);assert.ok(calls.every(call=>!call.query.includes('mutation')));
 answer={shop:{currencyCode:'ILS'},currentAppInstallation:{app:{id:'bad'}}};await assert.rejects(api.readCreationShopConfiguration(deadline()),/APP_IDENTITY_INVALID/);
});
test('custom-ID recovery returns initial exact commercial fields and refuses truncated identity',async()=>{
 calls=[];answer={productByIdentifier:product()};const value=await api.lookupCreatedGalleryDraft(ready,deadline());
 assert.deepEqual(value.snapshot.commercial,{price:'0.00',compareAtPrice:null,barcode:null,taxable:false,requiresShipping:true});
 assert.deepEqual(calls[0].variables.identifier,{customId:ready.customId});assert.equal(value.snapshot.sku,'');
 answer.productByIdentifier.variants.pageInfo.hasNextPage=true;await assert.rejects(api.lookupCreatedGalleryDraft(ready,deadline()),/REMOTE_IDENTITY_INVALID/);
});
test('mutations refuse Preview/off mode before transport; create returns original response snapshot',async()=>{
 const oldEnv=process.env.VERCEL_ENV,oldMode=process.env.SHOPIFY_GALLERY_CREATE_MODE;
 try{
  process.env.VERCEL_ENV='preview';process.env.SHOPIFY_GALLERY_CREATE_MODE='draft_only';calls=[];
  await assert.rejects(api.createGalleryShopifyDraft(ready,deadline()),/NOT_ENABLED/);assert.equal(calls.length,0);
  process.env.VERCEL_ENV='production';answer={productCreate:{product:product(),userErrors:[]}};
  const value=await api.createGalleryShopifyDraft(ready,deadline());assert.equal(value.productGid,'gid://shopify/Product/999');assert.equal(value.commercial.price,'0.00');
  assert.equal(calls[0].variables.product.status,'DRAFT');assert.match(calls[0].query,/productCreate\(product:/);
  answer.productCreate.userErrors=[{field:['media'],message:'private provider detail'}];await assert.rejects(api.createGalleryShopifyDraft(ready,deadline()),/^Error: SYNC_CREATION_PRODUCT_CREATE_REJECTED$/);
 }finally{if(oldEnv===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=oldEnv;if(oldMode===undefined)delete process.env.SHOPIFY_GALLERY_CREATE_MODE;else process.env.SHOPIFY_GALLERY_CREATE_MODE=oldMode;}
});
test('all-status SKU scan follows bounded pagination and carries status, never a publication filter',async()=>{
 calls=[];answer=(_q,variables)=>({productVariants:{nodes:[{id:`gid://shopify/ProductVariant/${variables.after?'2':'1'}`,sku:variables.after?'B':'A',product:{id:'gid://shopify/Product/9',status:variables.after?'ARCHIVED':'DRAFT'}}],pageInfo:{hasNextPage:!variables.after,endCursor:variables.after?null:'cursor'}}});
 const rows=await api.fetchCreationVariantIdentities(deadline());assert.deepEqual(rows.map(row=>row.status),['DRAFT','ARCHIVED']);
 assert.equal(calls.length,2);assert.ok(calls.every(call=>!call.query.includes('status:active')));
});
