import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const url = s => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const workerSource = stripTypeScriptTypes(readFileSync('src/lib/shopify/sync-worker.ts', 'utf8'))
  .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const policySource = stripTypeScriptTypes(readFileSync('src/lib/shopify/sync-policy.ts', 'utf8'))
  .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const { make } = await import(url(`import { randomUUID } from 'node:crypto'; export function make(deps) {
  const { FZT73_VARIANTS, MD20_VARIANTS, FZT73_PRODUCT_GID, configuredShopifySyncMode, reconcileFzt73Variants } = deps;
  ${policySource}\n${workerSource}\nreturn { processOneOutboxRow, processQueue }; }`));
const item = { catalog_key: 'P10FZT73001', carousel_item_id: '341df0c7-7a31-4e77-87c0-a683082c3cd7',
  id: 'outbox-edit', attempts: 1, payload: { title: 'Older change' } };

test('FZT73 outbox cannot report synced merely because Shopify source was replayed', async () => {
  let sourceReplays = 0;
  const db = { rpc: async () => ({ data: true, error: null }), from: () => assert.fail('must not finalize this edit') };
  const worker = make({ FZT73_VARIANTS: [{ sku: item.catalog_key, itemId: item.carousel_item_id }], MD20_VARIANTS: [],
    FZT73_PRODUCT_GID: 'product', configuredShopifySyncMode: () => 'verified_catalog',
    reconcileFzt73Variants: async () => { sourceReplays++; } });
  await assert.rejects(worker.processOneOutboxRow(db, item, null, Date.now() + 45000), /SYNC_FZT73_BASELINE_REQUIRED/);
  assert.equal(sourceReplays, 0);
});

test('actual FZT73 outbox processing records review with no Shopify calls or false synced status', async () => {
  const patches = [], rpcCalls = [];
  let sourceReplays = 0;
  const db = {
    rpc: async name => { rpcCalls.push(name); return { data: [item], error: null }; },
    from: table => ({ update: patch => ({ eq: async (column, id) => {
      patches.push({ table, patch, column, id }); return { error: null };
    } }) }),
  };
  const worker = make({ FZT73_VARIANTS: [{ sku: item.catalog_key, itemId: item.carousel_item_id }], MD20_VARIANTS: [],
    FZT73_PRODUCT_GID: 'product', configuredShopifySyncMode: () => 'verified_catalog',
    reconcileFzt73Variants: async () => { sourceReplays++; } });
  const result = await worker.processQueue(db, 'claim_shopify_gallery_outbox',
    row => worker.processOneOutboxRow(db, row, null, Date.now() + 45000), Date.now() + 45000);
  assert.deepEqual(rpcCalls, ['claim_shopify_gallery_outbox']);
  assert.equal(sourceReplays, 0);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].table, 'shopify_gallery_content_outbox');
  assert.equal(patches[0].id, item.id);
  assert.equal(patches[0].patch.status, 'review');
  assert.equal(patches[0].patch.last_error, 'SYNC_FZT73_BASELINE_REQUIRED');
  assert.equal(result.reviewed, 1);
  assert.equal(result.processed, 0);
});
