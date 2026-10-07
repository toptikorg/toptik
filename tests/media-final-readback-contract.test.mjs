import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const sql = readFileSync(new URL('../supabase/migrations/20261007_media_final_readback.sql', import.meta.url), 'utf8');

test('final readback is lease scoped, service only and preserves immutable evidence', () => {
  assert.match(sql, /security definer set search_path=pg_catalog,pg_temp/);
  assert.match(sql, /assert_access\(p_product_gid,p_lease_owner\)/);
  assert.match(sql, /assert_pair\(p_observed,i\)/);
  assert.match(sql, /revoke all on function public\.accept_toptik_media_final_readback.*from public,anon,authenticated/);
  assert.match(sql, /grant execute.*to service_role/);
  assert.match(sql, /e\.event_kind<>'transport_final_readback' or e\.request_hash<>h/);
  assert.match(sql, /'historicGuard',c\.current_guard,'freshGuard',p_guard,'observed',p_observed/);
  assert.doesNotMatch(sql, /update\s+toptik_media_private\.(state|provenance|transport_chains|transport_attempts|transport_artifacts)/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
});

test('no repeat transport is authorized, only verified chain and started exact step', () => {
  assert.match(sql, /o\.status not in \('running','uncertain'\) or o\.next_step<>p_step_index/);
  assert.match(sql, /s\.status not in \('started','uncertain'\)/);
  assert.match(sql, /c\.status<>'verified'/);
  assert.match(sql, /s\.body->>'kind'='reorder' and source is null/);
  assert.match(sql, /target is null or source is null/);
  assert.match(sql, /p_guard->>'sourceFingerprint' is distinct from toptik_media_private\.fingerprint\(p_observed->source\)/);
  assert.match(sql, /p_observed#>>'\{shopify,revision\}' is distinct from toptik_media_private\.ready_transport_fingerprint\(p_guard->'target'\)/);
  assert.match(sql, /p\.product_gid=p_product_gid and p\.side='shopify'/);
  assert.match(sql, /jsonb_agg\(p\.proof->>'platformRef' order by n\)/);
  assert.match(sql, /m->>'status' is distinct from 'READY' or m->>'fileStatus' is distinct from 'READY'/);
});

test('timestamp exception removes only top level product timestamp and its derived revision', () => {
  assert.match(sql, /unchanged_media:=\(\(c\.current_guard->'target'\)-'updatedAt'-'revision'\)=\(\(p_guard->'target'\)-'updatedAt'-'revision'\)/);
  assert.match(sql, /unchanged_media:=c\.current_guard->'target'=p_guard->'target'/);
  const condition = sql.slice(sql.indexOf('if unchanged_media then'), sql.indexOf('else\n  -- The transport'));
  assert.match(condition, /toptik_media_private\.accept_toptik_media_readback\(/);
  assert.doesNotMatch(condition, /public\.accept_toptik_media_readback\(/);
});

test('genuine media drift persists conflict and only previously verified absent detach receipt', () => {
  assert.match(sql, /detached:=s\.body->>'kind'='detach_reference'/);
  for (const side of ['gallery', 'shopify']) assert.ok(sql.includes(`asset(p_observed->'${side}',s.body->>'key') is null`));
  assert.match(sql, /set status='conflict',readback_pair=p_observed,detach_verified=detached/);
  assert.match(sql, /operations set status='conflict',observed_pair=p_observed,version=version\+1/);
  assert.match(sql, /'MEDIA_FINAL_READBACK_CONCURRENT_CHANGE'/);
  assert.doesNotMatch(sql, /set\s+.*next_step\s*=/i);
});

// Executable examples of the exact JSON equality predicate pinned above.
// SQL runtime acceptance still requires separate deployed RPC verification.
const raw = () => ({ side: 'shopify', identity: { productId: 'p1', variantId: 'v1', exactGallerySku: 'YELLOW', exactShopifySku: 'YELLOW' },
  complete: true, updatedAt: '2026-10-07T01:00:00Z', revision: 'before', variantMediaIds: ['m1'], variantImage: { id: 'i1', url: 'yellow.jpg' },
  media: [{ mediaId: 'm1', status: 'READY', fileStatus: 'READY', alt: 'yellow', updatedAt: '2026-10-06T01:00:00Z', image: { id: 'i1', url: 'yellow.jpg', width: 800, height: 800 } },
    { mediaId: 'm2', status: 'READY', fileStatus: 'READY', alt: 'yellow back', updatedAt: '2026-10-06T01:00:00Z', image: { id: 'i2', url: 'yellow-back.jpg', width: 800, height: 800 } }] });
const omitProductTime = value => { const result = structuredClone(value); delete result.updatedAt; delete result.revision; return result; };
test('copy-only product timestamp matches full media predicate', () => {
  const before = raw(), after = raw(); after.updatedAt = '2026-10-07T02:00:00Z'; after.revision = 'after';
  assert.deepEqual(omitProductTime(before), omitProductTime(after));
});
for (const [name, change] of [
  ['wrong color URL', x => { x.media[0].image.url = 'black.jpg'; }],
  ['sibling SKU', x => { x.identity.exactShopifySku = 'BLACK'; }],
  ['other variant', x => { x.identity.variantId = 'v2'; }],
  ['variant reassignment', x => { x.variantMediaIds = ['m2']; }],
  ['cover changed', x => { x.variantImage.url = 'black.jpg'; }],
  ['image byte revision', x => { x.media[0].updatedAt = '2026-10-07T03:00:00Z'; }],
  ['alt changed', x => { x.media[0].alt = 'black'; }],
  ['image ID changed', x => { x.media[0].image.id = 'i3'; }],
  ['dimensions changed', x => { x.media[0].image.width++; }],
  ['not ready', x => { x.media[0].fileStatus = 'PROCESSING'; }],
  ['order changed', x => { x.media.reverse(); }],
  ['image removed', x => { x.media.pop(); }],
  ['new unknown fact', x => { x.unrecognizedField = 'must not be ignored'; }],
]) test(`${name} cannot use timestamp exception`, () => {
  const before = raw(), after = raw(); after.updatedAt = '2026-10-07T02:00:00Z'; after.revision = 'after'; change(after);
  assert.notDeepEqual(omitProductTime(before), omitProductTime(after));
});
