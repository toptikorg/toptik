import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const url=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const worker=stripTypeScriptTypes(readFileSync('src/lib/shopify/sync-worker.ts','utf8')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const policy=stripTypeScriptTypes(readFileSync('src/lib/shopify/sync-policy.ts','utf8')).replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const {make}=await import(url(`import {randomUUID} from 'node:crypto'; export function make(deps){const {FZT73_VARIANTS,MD20_VARIANTS,FZT73_PRODUCT_GID,configuredShopifySyncMode,reconcileFzt73Variants}=deps;${policy}\n${worker}\nreturn {processOneOutboxRow,processQueue};}`));
const item={catalog_key:'P10FZT73001',carousel_item_id:'341df0c7-7a31-4e77-87c0-a683082c3cd7',id:'outbox-edit',attempts:1,payload:{title:'Older change'}};
test('FZT73 outbox edit is held for review instead of falsely acknowledged after source replay',async()=>{
 let calls=0;const db={rpc:async()=>({data:true,error:null}),from:()=>assert.fail('must not falsely finalize this edit')};
 const worker=make({FZT73_VARIANTS:[{sku:item.catalog_key,itemId:item.carousel_item_id}],MD20_VARIANTS:[],FZT73_PRODUCT_GID:'product',configuredShopifySyncMode:()=> 'verified_catalog',reconcileFzt73Variants:async()=>{calls++;}});
 await assert.rejects(worker.processOneOutboxRow(db,item,null,Date.now()+45000),/SYNC_FZT73_BASELINE_REQUIRED/);
 assert.equal(calls,0,'source replay does not prove a gallery-to-Shopify edit was applied');
});
test('FZT73 outbox baseline failure is recorded as review',async()=>{
 let patch;const worker=make({FZT73_VARIANTS:[],MD20_VARIANTS:[],FZT73_PRODUCT_GID:'product',configuredShopifySyncMode:()=> 'verified_catalog',reconcileFzt73Variants:async()=>{}});
 const db={rpc:async()=>({data:[item],error:null}),from:()=>({update:p=>({eq:async()=>{patch=p;return{error:null};}})})};
 const result=await worker.processQueue(db,'claim_shopify_gallery_outbox',async()=>{throw Error('SYNC_FZT73_BASELINE_REQUIRED');},Date.now()+45000);
 assert.equal(patch.status,'review');assert.equal(patch.last_error,'SYNC_FZT73_BASELINE_REQUIRED');assert.equal(result.reviewed,1);
});
