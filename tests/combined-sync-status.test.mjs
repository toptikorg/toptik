import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const text = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const code = stripTypeScriptTypes(text('../src/lib/shopify/combined-sync-status.ts'));
const { evaluateCombinedSyncStatus: evaluate } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const runtime = { copy: true, media: true, specifications: true };
const base = () => ({ observedAt: '2026-10-07T09:00:00Z', coverage: { approvedProducts: 400, missingCopyBaseline: 0, missingMediaBaseline: 0, missingMediaQueue: 0, missingSpecBaseline: 0, missingSpecQueue: 0 },
  queues: [{ lane: 'copy_inbox', status: 'processed', count: 100 }, { lane: 'media', status: 'done', count: 400 }] });

test('clear queues explicitly do not assert live catalog verification', () => {
  const result = evaluate(base(), runtime);
  assert.equal(result.status, 'queues_clear'); assert.equal(result.queuesClear, true); assert.equal(result.liveVerified, false);
  assert.equal(result.scope, 'approved_catalog_queues');
});
for (const [lane, statuses] of Object.entries({ copy_inbox: ['pending', 'processing'], copy_outbox: ['pending', 'processing'],
  media: ['pending', 'processing'], specifications: ['pending', 'processing'], commerce: ['pending'], media_operations: ['reserved', 'running', 'uncertain'] })) {
  for (const status of statuses) test(`${lane} ${status} prevents an overall clear result`, () => {
    const data = base(); data.queues.push({ lane, status, count: 1 });
    const result = evaluate(data, runtime); assert.equal(result.status, 'pending'); assert.equal(result.queuesClear, false);
  });
}
for (const [lane, statuses] of Object.entries({ copy_inbox: ['review', 'failed'], copy_outbox: ['review', 'failed'],
  media: ['review', 'failed'], specifications: ['review', 'failed'], commerce: ['review'], media_operations: ['conflict'] })) {
  for (const status of statuses) test(`${lane} ${status} remains review even with completed copy and media`, () => {
    const data = base(); data.queues.push({ lane, status, count: 1 });
    assert.equal(evaluate(data, runtime).status, 'review');
  });
}
for (const key of ['copy', 'media', 'specifications']) test(`${key} runtime disabled cannot be healthy`, () => {
  const result = evaluate(base(), { ...runtime, [key]: false }); assert.equal(result.status, 'disabled'); assert.equal(result.queuesClear, false);
});
for (const key of ['missingCopyBaseline', 'missingMediaBaseline', 'missingMediaQueue', 'missingSpecBaseline', 'missingSpecQueue']) test(`${key} is incomplete even when all present queue rows are done`, () => {
  const data = base(); data.coverage[key] = 1;
  assert.equal(evaluate(data, runtime).status, 'incomplete');
});
test('empty, missing, duplicate, unknown, negative or malformed status evidence fails closed', () => {
  const empty = base(); empty.coverage.approvedProducts = 0; empty.queues = [];
  assert.equal(evaluate(empty, runtime).status, 'incomplete');
  for (const row of [{ lane: 'media', status: 'done', count: 1 }, { lane: 'unexpected', status: 'done', count: 1 },
    { lane: 'media', status: 'new_unknown_status', count: 1 }, { lane: 'media', status: 'pending', count: -1 }]) {
    const data = base(); data.queues.push(row); assert.equal(evaluate(data, runtime).status, 'unknown');
  }
  for (const data of [null, {}, { ...base(), coverage: null }, { ...base(), observedAt: 'invalid' }, { ...base(), queues: null }]) {
    assert.equal(evaluate(data, runtime).status, 'unknown');
  }
});
test('SQL is private read-only and counts both directions plus media work and current operations', () => {
  const sql = text('../supabase/migrations/20261007_combined_sync_status.sql');
  assert.match(sql, /stable security definer set search_path=pg_catalog,pg_temp/);
  assert.match(sql, /revoke all on function public.read_toptik_combined_sync_status\(text\) from public,anon,authenticated/);
  assert.match(sql, /grant execute.*to service_role/);
  assert.doesNotMatch(sql, /\b(insert into|update\s+\w|delete from)\b/i);
  for (const table of ['shopify_webhook_events', 'shopify_gallery_content_outbox', 'work_queue', 'shopify_gallery_commerce_commands', 'operations']) assert.ok(sql.includes(table));
  assert.match(sql, /o\.state_version=s\.version/);
  for (const field of ['last_synced_payload', 'gallery_baseline_payload', 'shopify_baseline_payload']) assert.ok(sql.includes(`c.${field} is null`));
  assert.match(sql, /sp\.product_gid is null or not sp\.enabled/);
  assert.match(sql, /unnest\(toptik_spec_private\.keys\(\)\)/);
  assert.match(sql, /fs\.product_gid=e\.product_gid and fs\.field_key=k/);
  assert.match(sql, /'missingSpecQueue',count\(\*\) filter\(where sq\.product_gid is null\)/);
  const route = text('../src/app/api/admin/shopify/sync/status/route.ts');
  assert.ok(route.indexOf('await requireGalleryAdmin(req)') < route.indexOf(".rpc('read_toptik_combined_sync_status'"));
  assert.match(route, /Cache-Control.*no-store/);
  assert.match(route, /queuesClear: false, liveVerified: false/);
});
