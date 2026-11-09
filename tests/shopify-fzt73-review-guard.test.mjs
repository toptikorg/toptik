import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { variantPolicySource } from './helpers/variant-source-module.mjs';

const source = stripTypeScriptTypes(readFileSync('src/lib/shopify/sync-worker.ts','utf8'))
  .replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const encoded = Buffer.from(`export function make(deps) {
  ${variantPolicySource}
  const { refreshProductPublication, reconcileFzt73Variants } = deps;
  const configuredShopifySyncMode = () => 'verified_catalog';
  ${source}
  return {reconcileInboxEvent,processOneOutboxRow};
}`).toString('base64');
const { make } = await import(`data:text/javascript;base64,${encoded}`);

test('FZT73 refreshes publication and moves divergent copy to review without overwriting', async () => {
  const calls=[];
  const worker=make({refreshProductPublication:async (...args)=>{calls.push(['publication',...args]);return {published:true}},
    reconcileFzt73Variants:async (...args)=>{assert.equal(args[2],true);calls.push(['inspect']);throw Error('SYNC_FZT73_BASELINE_REQUIRED')}});
  const db={from(){throw Error('unexpected write')}};
  const product='gid://shopify/Product/7524873044218';
  await assert.rejects(worker.reconcileInboxEvent(db,{id:'e1',topic:'products/update',payload:{}},product,'lease',9999),
    /SYNC_FZT73_BASELINE_REQUIRED/);
  assert.deepEqual(calls.map(x=>x[0]),['publication','inspect']);
});

for (const published of [true,false]) test(`FZT73 ${published ? 'matching copy' : 'withdrawal'} is acknowledged without a copy write`, async () => {
  const calls=[];
  const worker=make({refreshProductPublication:async()=>({published}),
    reconcileFzt73Variants:async (_db,_deadline,inspectOnly)=>{assert.equal(inspectOnly,true);calls.push('inspect')}});
  const db={from(table){assert.equal(table,'shopify_webhook_events');return {update(patch){calls.push(patch);return {async eq(){return {error:null}}}}}}};
  const status=await worker.reconcileInboxEvent(db,{id:'e',topic:'products/update',payload:{}},'gid://shopify/Product/7524873044218','lease',9999);
  assert.equal(status,'processed');
  assert.equal(calls.filter(x=>x==='inspect').length,published?1:0);
  assert.equal(calls.at(-1).status,'processed');
});

test('FZT73 gallery edit remains reviewable without overwriting product copy', async () => {
  const calls=[];
  const worker=make({refreshProductPublication:async()=>{throw Error('unexpected')},
    reconcileFzt73Variants:async()=>{calls.push('unsafe-write')}});
  const db={from(){throw Error('unexpected write')},rpc(){throw Error('unexpected rpc')}};
  await assert.rejects(worker.processOneOutboxRow(db,{id:'o1',catalog_key:'P10FZT73001',
    carousel_item_id:'341df0c7-7a31-4e77-87c0-a683082c3cd7'},null,9999),/SYNC_FZT73_BASELINE_REQUIRED/);
  assert.deepEqual(calls,[]);
});
