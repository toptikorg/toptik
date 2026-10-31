import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source = stripTypeScriptTypes(readFileSync('src/lib/shopify/publication-sync.ts','utf8')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const worker = stripTypeScriptTypes(readFileSync('src/lib/shopify/sync-worker.ts','utf8')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const {make} = await import('data:text/javascript;base64,'+Buffer.from(`export function make(fetchProductSnapshot,fetchAllOnboardingVariantIdentities=async()=>[]) {
 const configuredShopifyDomain=()=> 'toptik.myshopify.com';
 const isSafeShopifyProductHandle=x=>/^[a-z0-9-]+$/.test(x);
 const normalizeSyncSku=x=>typeof x==='string'?x.replace(/[^a-z0-9]/gi,'').toUpperCase()||null:null;
 const configuredShopifySyncMode=()=> 'verified_catalog';
 const FZT73_PRODUCT_GID='gid://shopify/Product/7524873044218';
 ${source}
 ${worker}
 return {refreshProductPublication,enqueuePublicationRecovery,reconcileInboxEvent};
}`).toString('base64'));
const gid='gid://shopify/Product/123', variant='gid://shopify/ProductVariant/456';
const product={id:gid,handle:'bag',status:'ACTIVE',publishedOnPublication:true,updatedAt:'2026-10-12T10:00:00Z',variants:[{id:variant,sku:'BAG'}]};
for (const [name,value,published] of [ ['draft',{...product,status:'DRAFT'},false],['archived',{...product,status:'ARCHIVED'},false],
 ['unpublished',{...product,publishedOnPublication:false},false],['confirmed missing',null,false],['active',product,true]]) {
 test(`publication snapshot: ${name}`,async()=>{
  let args; const api=make(async()=>value);
  await api.refreshProductPublication({rpc:async(name,input)=>{assert.equal(name,'refresh_shopify_gallery_publication');args=input;return {error:null};}},gid,'owner');
  assert.equal(args.p_is_published,published);assert.equal(args.p_owner,'owner');
  assert.deepEqual(args.p_visible_variant_gids,published?[variant]:[]);
 });
}
test('failed Shopify fetch cannot be interpreted as deletion',async()=>{
 let writes=0;await assert.rejects(make(async()=>{throw Error('network');}).refreshProductPublication({rpc:async()=>{writes++;}},gid,'owner'),/network/);
 assert.equal(writes,0);
});
for (const value of [{...product,id:'wrong'},{...product,status:'UNKNOWN'},{...product,updatedAt:'bad'}, {...product,publishedOnPublication:null},
 {...product,variants:[{id:'wrong'}]}, {...product,variants:[{id:variant},{id:variant}]}]) test('reject invalid snapshot '+JSON.stringify(value),async()=>{
 await assert.rejects(make(async()=>value).refreshProductPublication({rpc:()=>assert.fail('no writes')},gid,'owner'),/SYNC_PUBLICATION/);
});
test('publication failure does not finalize the inbox event',async()=>{
 const api=make(async()=>({...product,status:'DRAFT'}));
 await assert.rejects(api.reconcileInboxEvent({rpc:async()=>({error:{}}),from:()=>assert.fail('not finalized')},{id:'e',payload:{}},gid,'owner'),/WRITE_FAILED/);
});
for(const topic of ['products/update','products/delete'])test(`withdrawal ${topic} completes before copy eligibility`,async()=>{
 const calls=[];const db={rpc:async()=>{calls.push('publication');return{error:null};},from:()=>({update:patch=>({eq:async()=>{calls.push(patch.status);return{error:null};}})})};
 assert.equal(await make(async()=>({...product,status:'DRAFT'})).reconcileInboxEvent(db,{id:'e',topic,payload:{}},gid,'owner'),'processed');
 assert.deepEqual(calls,['publication','processed']);
});
test('daily recovery rereads current publication without calling content or media code',async()=>{
 let patch;const db={rpc:async()=>({error:null}),from:()=>({update:p=>({eq:async()=>{patch=p;return{error:null};}})})};
 await make(async()=>product).reconcileInboxEvent(db,{id:'e',payload:{publication_recovery:true}},gid,'owner');
 assert.equal(patch.status,'processed');
});
test('recovery paginates, repairs missing Shopify variants and preserves historical events',async()=>{
 const events=new Map();let pages=0;
 const db={from:table=> table==='shopify_gallery_bindings'?{select:()=>({order:()=>({range:async offset=>{
  pages++;return{data:offset===0?Array.from({length:500},()=>({catalog_key:'BOUND',product_gid:gid,variant_gid:variant})):[{catalog_key:'SECOND',product_gid:'gid://shopify/Product/789',variant_gid:'gid://shopify/ProductVariant/790'}],error:null};
 }})})}:table==='carousel_items'?{select:()=>({order:()=>({range:async()=>({data:[{catalog_number:'LEGACY-1'}],error:null})})})}:{upsert:async(rows,options)=>{assert.deepEqual(options,{onConflict:'delivery_id',ignoreDuplicates:true});for(const row of rows)if(!events.has(row.delivery_id))events.set(row.delivery_id,row);return{error:null};}}};
 const variants=async()=>[{id:variant,sku:'BAG',product:{id:gid}},
  {id:'gid://shopify/ProductVariant/997',sku:'LEGACY 1',product:{id:'gid://shopify/Product/996'}},
  {id:'gid://shopify/ProductVariant/999',sku:'NEW',product:{id:'gid://shopify/Product/998'}}];
 const api=make(async()=>product,variants);await api.enqueuePublicationRecovery(db,'2026-10-12');await api.enqueuePublicationRecovery(db,'2026-10-12');
 assert.equal(pages,4);assert.equal(events.size,4);assert.equal([...events.values()].filter(e=>e.payload.catalog_coverage_recovery).length,1);
 assert.ok([...events.values()].filter(e=>e.payload.publication_recovery).length===3);
 assert.ok([...events.values()].some(e=>e.payload.id==='7524873044218'));
 assert.ok([...events.values()].some(e=>e.delivery_id==='catalog-coverage:2026-10-12:gid://shopify/Product/998'));
 assert.ok(![...events.values()].some(e=>e.delivery_id.includes('gid://shopify/Product/996')));
});
