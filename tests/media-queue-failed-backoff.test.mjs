// A chronically failing queue row backs off (least(attempts, 36) * 10 minutes since its last
// attempt) instead of burning a claim and a full image observation every batch; a real enqueue
// resets it immediately. Real queue migrations on the offline PGlite engine; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = name => readFileSync(path.join(repo, 'supabase/migrations', name), 'utf8');
const sql = migration('20261008_media_queue_failed_backoff.sql');
const pick = (text, re) => { const m = text.match(re); assert.ok(m, String(re)); return m[0]; };

test('backoff migration replaces only the claim WHERE: no grants, no data change, order kept', () => {
  assert.doesNotMatch(sql, /\bgrant\b/i);
  assert.doesNotMatch(sql, /\bdelete from\b|\btruncate\b|\bdrop\b|\balter table\b/i);
  assert.equal([...sql.matchAll(/create or replace function/g)].length, 1);
  assert.match(sql, /q\.status='failed' and q\.updated_at<=clock_timestamp\(\)-least\(q\.attempts,36\)\*interval '10 minutes'/);
  // The repair-backoff ordering and the routine handicap are carried over verbatim.
  assert.match(sql, /MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED/);
  assert.match(sql, /case when q\.routine then q\.updated_at\+interval '6 hours' else q\.updated_at end/);
  assert.match(sql, /skip locked/);
});

const engine = process.env.TOPTIK_PGLITE_DIR ?? path.resolve(repo, '../sync-sql-validation-20260930/package');
const skip = existsSync(path.join(engine, 'dist/index.js')) ? false : `PGlite engine not found at ${engine}`;
let ready;
function database() {
  ready ??= (async () => {
    const { PGlite } = await import(pathToFileURL(path.join(engine, 'dist/index.js')).href);
    const db = new PGlite();
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create table public.shopify_gallery_copy_eligibility(product_gid text primary key,catalog_key text,carousel_item_id uuid,variant_gid text,exact_gallery_sku text,exact_shopify_sku text,approved_product_handle text,enabled boolean);
create table public.shopify_gallery_reconciliation_leases(product_gid text primary key,owner uuid,expires_at timestamptz);
create table public.shopify_webhook_events(id uuid,topic text,shop_domain text,payload jsonb,delivery_id text);
create function public.assert_shopify_verified_copy_identity(p_item uuid,p_key text,p_gsku text,p_product text,p_variant text,p_ssku text) returns void language plpgsql as $$begin end$$;`);
    await db.exec(migration('20260930_media_sync_journal.sql'));
    const planning = migration('20261001_media_planning_runtime.sql');
    for (const re of [/create table toptik_media_private\.work_queue\([\s\S]*?\);/, /create function public\.claim_toptik_media_work\([\s\S]*?end \$\$;/,
      /create function public\.finish_toptik_media_work\([\s\S]*?end \$\$;/, /create function public\.recover_toptik_media_work\([\s\S]*?end \$\$;/]) await db.exec(pick(planning, re));
    for (const name of ['20261007_media_queue_inflight.sql', '20261007_media_queue_distinct.sql', '20261007_media_queue_repair_backoff.sql',
      '20261007_media_queue_defer.sql', '20261008_media_queue_priority.sql', '20261008_media_queue_failed_backoff.sql']) await db.exec(migration(name));
    return db;
  })();
  return ready;
}
let serial = 300;
async function product(db) {
  const n = serial++, gid = `gid://shopify/Product/${n}`;
  await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)', [gid, 'K' + n, randomUUID(), `gid://shopify/ProductVariant/${n}`, 'G-' + n, 'S' + n, 'h-' + n]);
  return gid;
}
const rpc = async (db, name, args) => (await db.query(`select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) r`, args.map(a => a && typeof a === 'object' ? JSON.stringify(a) : a))).rows[0].r;
const enqueue = (db, gid) => db.query("select toptik_media_private.enqueue($1,'{}'::jsonb)", [gid]);
const claim = async db => rpc(db, 'public.claim_toptik_media_work_excluding', [randomUUID()]);
const fail = async (db, gid) => {
  const c = await claim(db); assert.ok(c && c.productId === gid, 'expected to claim ' + gid + ', got ' + JSON.stringify(c));
  await rpc(db, 'public.finish_toptik_media_work', [gid, c.claimId, c.generation, 'failed', 'MEDIA_SOURCE_READ_FAILED']);
};
const age = (db, gid, minutes) => db.query(`update toptik_media_private.work_queue set updated_at=clock_timestamp()-make_interval(mins=>$2) where product_gid=$1`, [gid, minutes]);

test('a failed row is not reclaimed inside its backoff window and returns after it', { skip }, async () => {
  const db = await database(); const gid = await product(db);
  await enqueue(db, gid); await fail(db, gid);
  assert.equal(await claim(db), null, 'attempt 1 must wait 10 minutes');
  await age(db, gid, 11);
  const again = await claim(db); assert.equal(again.productId, gid);
  await rpc(db, 'public.finish_toptik_media_work', [gid, again.claimId, again.generation, 'failed', 'MEDIA_SOURCE_READ_FAILED']);
  await age(db, gid, 19); assert.equal(await claim(db), null, 'attempt 2 waits 20 minutes');
  await age(db, gid, 21); assert.equal((await claim(db)).productId, gid);
});
test('a chronic failure settles at the 6-hour horizon and never exceeds it', { skip }, async () => {
  const db = await database(); const gid = await product(db);
  await enqueue(db, gid); await fail(db, gid);
  await db.query('update toptik_media_private.work_queue set attempts=282 where product_gid=$1', [gid]);
  await age(db, gid, 5 * 60); assert.equal(await claim(db), null, 'held inside 6 hours');
  await age(db, gid, 6 * 60 + 1);
  const c = await claim(db); assert.equal(c.productId, gid);
});
test('a real enqueue clears the backoff immediately; healthy work is never delayed behind it', { skip }, async () => {
  const db = await database(); const gid = await product(db), other = await product(db);
  await enqueue(db, gid); await fail(db, gid);
  assert.equal(await claim(db), null);
  await enqueue(db, gid);   // the webhook/editor path: pending, error cleared, fresh updated_at
  const c = await claim(db); assert.equal(c.productId, gid);
  await rpc(db, 'public.finish_toptik_media_work', [gid, c.claimId, c.generation, 'failed', 'MEDIA_SOURCE_READ_FAILED']);
  await enqueue(db, other);
  const healthy = await claim(db); assert.equal(healthy.productId, other, 'the failed row must not block the healthy one');
  await rpc(db, 'public.finish_toptik_media_work', [other, healthy.claimId, healthy.generation, 'done', null]);
});
test('stale processing rows and repair-needed ordering are unchanged', { skip }, async () => {
  const db = await database(); const gid = await product(db);
  await enqueue(db, gid);
  const c = await claim(db); assert.equal(c.productId, gid);
  await db.query("update toptik_media_private.work_queue set claimed_at=clock_timestamp()-interval '6 minutes' where product_gid=$1", [gid]);
  const stale = await claim(db); assert.equal(stale.productId, gid, 'a stale processing row stays reclaimable');
  await rpc(db, 'public.finish_toptik_media_work', [gid, stale.claimId, stale.generation, 'pending', 'MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED']);
  const rn = await claim(db); assert.equal(rn.productId, gid, 'a repair-needed row is deprioritized but still claimable when alone');
});
