import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {moduleUrl} from './helpers/typed-spec-modules.mjs';
const source=readFileSync('src/app/api/admin/shopify/specs/fields/route.ts','utf8');
const body=source.slice(source.indexOf('const productId')).replace(/^export /gm,'');
const {createHandlers}=await import(moduleUrl(`export function createHandlers(deps){
 const {z,requireGalleryAdmin,typedSpecSyncEnabled,typedSpecClearsEnabled,createSupabaseServiceRoleClient,withTypedSpecLease,readTypedState,freshTypedShopify,editTypedSpecs,typedSpecDefinitions,scheduleTypedSpecSync}=deps;
 const NextResponse={json:(value,init)=>Response.json(value,init)};
 ${body}
 return {GET,PATCH};
}`));
const productId='gid://shopify/Product/123',variantId='gid://shopify/ProductVariant/456',itemId='11111111-1111-4111-8111-111111111111';
const input={productId,variantId,itemId,exactGallerySku:'P10SZV24-05J-TU',exactShopifySku:'P10SZV2405J',productHandle:'logoduck-i-טרולי',requestId:'22222222-2222-4222-8222-222222222222',changes:{material:'100% PC'},versions:{material:1}};
function fixture(options={}){
 const calls=[];let scheduled=0;
 const handlers=createHandlers({z,requireGalleryAdmin:()=>options.denied?Response.json({error:'Unauthorized'},{status:401}):null,typedSpecSyncEnabled:()=>!options.disabled,typedSpecClearsEnabled:()=>false,
  createSupabaseServiceRoleClient:()=>{calls.push('db');return 'service';},
  withTypedSpecLease:async(db,gid,fn)=>{calls.push(['lease',db,gid]);return fn('owner');},
  readTypedState:async(db,gid,owner)=>{calls.push(['read',db,gid,owner]);if(options.error)throw Error(options.error);return {identity:{productGid:productId},fields:Array.from({length:19},(_,i)=>({key:String(i),galleryVersion:1}))};},
  freshTypedShopify:async()=>{calls.push('shopRead');return {document:{fields:{material:{cell:{state:'absent'},revision:null}}},updatedAt:'2026-09-30T18:00:00Z'};},
  editTypedSpecs:async(...args)=>{calls.push(['edit',...args]);if(options.error)throw Error(options.error);return [{key:'material',galleryVersion:2}];},
  typedSpecDefinitions:()=>[{key:'material'}],scheduleTypedSpecSync:()=>scheduled++,
 });
 return {calls,get scheduled(){return scheduled;},async send(method='PATCH',data=input){const request=new Request(`https://landing.toptik.co.il/api/admin/shopify/specs/fields${method==='GET'?`?productId=${encodeURIComponent(data)}`:''}`,{method,...(method==='PATCH'?{body:typeof data==='string'?data:JSON.stringify(data)}:{})});request.nextUrl=new URL(request.url);const response=await handlers[method](request);return {status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};}};
}
test('token field patch passes complete exact alias identity and field CAS; only schedules after acceptance',async()=>{
 const f=fixture(),result=await f.send();assert.equal(result.status,202);assert.equal(result.cache,'no-store');assert.equal(result.body.queued,true);
 const call=f.calls.find(x=>Array.isArray(x)&&x[0]==='edit');assert.deepEqual(call.slice(1),['service',productId,input.requestId,input.changes,input.versions,{itemId,variantGid:variantId,gallerySku:input.exactGallerySku,exactSku:input.exactShopifySku,productHandle:input.productHandle}]);assert.equal(f.scheduled,1);
 assert.doesNotMatch(source,/saveCarouselPayload|carousel_item_angles|carousel_settings|writeTypedSpecFields/);
});
test('private GET observes complete state plus fresh Shopify without scheduling, editing or baseline writes',async()=>{
 const f=fixture(),result=await f.send('GET',productId);assert.equal(result.status,200);assert.equal(result.cache,'no-store');assert.equal(result.body.initialized,true);assert.equal(result.body.fields.length,19);assert.ok(result.body.shopify.fields.material);assert.equal(f.scheduled,0);assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='edit').length,0);
});
test('auth runs before config/DB, default off returns404, malformed/commerce/missing identity requests do not queue',async()=>{
 for(const [options,data,status] of [[{denied:true},input,401],[{disabled:true},input,404],[{},'malformed',400],[{},{...input,price:'1'},400],[{},{...input,exactShopifySku:undefined},400],[{},{...input,versions:{material:0}},400]]){
  const f=fixture(options),result=await f.send('PATCH',data);assert.equal(result.status,status);assert.equal(f.calls.length,0);assert.equal(f.scheduled,0);
 }
 for(const options of [{denied:true},{disabled:true}]){const f=fixture(options);assert.equal((await f.send('GET',productId)).status,options.denied?401:404);assert.equal(f.calls.length,0);}
});
test('stale versions/changed identity hold the edit without scheduling; errors never expose provider messages',async()=>{
 for(const error of ['SPEC_EDITOR_STALE','SPEC_IDENTITY_CHANGED','private provider message with value']){const f=fixture({error}),result=await f.send();assert.equal(result.status,409);assert.equal(result.body.error,error.startsWith('SPEC_')?error:'SPEC_REQUEST_FAILED');assert.equal(f.scheduled,0);}
 const badGet=fixture();assert.equal((await badGet.send('GET','not-a-product')).status,400);assert.equal(badGet.calls.length,0);
 const tooLarge=fixture();assert.equal((await tooLarge.send('PATCH',' '.repeat(500001))).status,413);assert.equal(tooLarge.calls.length,0);
});
