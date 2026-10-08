// Queue priority: real work and recovery are claimed before the daily safety sweep,
// the sweep never demotes or resets waiting rows, and routine rows cannot starve.
// Real queue migrations on an offline PGlite engine (required); no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = name => readFileSync(path.join(repo, 'supabase/migrations', name), 'utf8');
const sql = migration('20261008_media_queue_priority.sql');
const pick = (text, re) => { const m = text.match(re); assert.ok(m, String(re)); return m[0]; };

test('priority migration keeps grants, adds no grant to the sweep helper, and changes no data', () => {
  assert.doesNotMatch(sql, /\bgrant\b/i);
  assert.match(sql, /revoke all on function toptik_media_private\.enqueue_routine\(text\) from public,anon,authenticated,service_role;/);
  assert.doesNotMatch(sql, /\bdelete from\b|\btruncate\b|\bdrop\b/i);
  assert.match(sql, /where work_queue\.status in \('done','review'\);/);
  assert.match(sql, /set local lock_timeout='3s';/);
});

const engine = process.env.TOPTIK_PGLITE_DIR ?? path.resolve(repo, '../sync-sql-validation-20260930/package');
// Same convention as the other real-SQL suites: database tests skip (with a reason) where the
// offline engine is not installed, e.g. CI; the static checks above always run.
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
    // The whole planning migration needs the full catalog schema; take its exact queue objects verbatim.
    for (const re of [/create table toptik_media_private\.work_queue\([\s\S]*?\);/, /create function public\.claim_toptik_media_work\([\s\S]*?end \$\$;/,
      /create function public\.finish_toptik_media_work\([\s\S]*?end \$\$;/, /create function public\.recover_toptik_media_work\([\s\S]*?end \$\$;/]) await db.exec(pick(planning, re));
    for (const name of ['20261007_media_queue_inflight.sql', '20261007_media_queue_distinct.sql', '20261007_media_queue_repair_backoff.sql',
      '20261007_media_queue_defer.sql', '20261008_media_queue_priority.sql']) await db.exec(migration(name));
    return db;
  })();
  return ready;
}
let serial = 900;
async function product(db) {
  const n = serial++, p = `gid://shopify/Product/${n}`;
  await db.query('insert into public.shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)', [p, 'SKU' + n, randomUUID(), `gid://shopify/ProductVariant/${n}`, 'G' + n, 'S' + n, 'h' + n]);
  return p;
}
const one = async (db, q, a = []) => (await db.query(q, a)).rows[0];
const row = (db, p) => one(db, 'select status,routine,last_error,updated_at,generation from toptik_media_private.work_queue where product_gid=$1', [p]);
const set = (db, p, cols) => db.query(`update toptik_media_private.work_queue set ${Object.keys(cols).map((k, i) => `${k}=$${i + 2}`).join(',')} where product_gid=$1`, [p, ...Object.values(cols)]);
const claim = async db => (await one(db, 'select public.claim_toptik_media_work($1) r', [randomUUID()])).r?.productId ?? null;
async function reset(db) { await db.query("update toptik_media_private.work_queue set status='done',routine=false,last_error=null"); await db.query('update public.shopify_gallery_copy_eligibility set enabled=false'); }

test('the sweep wakes finished rows as routine and never touches waiting or processing rows', { skip }, async () => {
  const db = await database(); await reset(db);
  const [done, review, waiting, repair, busy] = [await product(db), await product(db), await product(db), await product(db), await product(db)];
  for (const p of [done, review, waiting, repair, busy]) await one(db, "select toptik_media_private.enqueue($1,'{}'::jsonb)", [p]);
  await set(db, done, { status: 'done' }); await set(db, review, { status: 'review', last_error: 'MEDIA_REVIEW_REQUIRED' });
  await set(db, repair, { last_error: 'MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED' }); await set(db, busy, { status: 'processing' });
  const before = { waiting: await row(db, waiting), repair: await row(db, repair), busy: await row(db, busy) };
  await one(db, 'select public.recover_toptik_media_work()');
  for (const p of [done, review]) { const r = await row(db, p); assert.equal(r.status, 'pending'); assert.equal(r.routine, true); assert.equal(r.last_error, null); }
  assert.deepEqual(await row(db, waiting), before.waiting, 'real pending work is not demoted or re-timestamped');
  assert.deepEqual(await row(db, repair), before.repair, 'a storage-repair backoff is not reset by the sweep');
  assert.deepEqual(await row(db, busy), before.busy, 'a processing claim is untouched');
});
test('real work and recovery are claimed before newer and older routine sweep rows', { skip }, async () => {
  const db = await database(); await reset(db);
  const sweepA = await product(db), sweepB = await product(db), real = await product(db);
  for (const p of [sweepA, sweepB]) { await one(db, "select toptik_media_private.enqueue($1,'{}'::jsonb)", [p]); await set(db, p, { status: 'done' }); }
  await one(db, 'select public.recover_toptik_media_work()');
  await one(db, `select toptik_media_private.enqueue($1,'{"shopify":{"kind":"signed_shopify_event"}}'::jsonb)`, [real]);
  // Make the sweep rows older than the real row but still within the 3-hour window.
  await db.query("update toptik_media_private.work_queue set updated_at=clock_timestamp()-interval '1 hour' where routine");
  assert.equal(await claim(db), real);
  const claimedSweep = await claim(db); assert.ok([sweepA, sweepB].includes(claimedSweep));
  assert.equal((await row(db, claimedSweep)).routine, false, 'a claim clears routine');
});
test('a real enqueue promotes a routine row', { skip }, async () => {
  const db = await database(); await reset(db);
  const p = await product(db); await one(db, "select toptik_media_private.enqueue($1,'{}'::jsonb)", [p]); await set(db, p, { status: 'done' });
  await one(db, 'select public.recover_toptik_media_work()'); assert.equal((await row(db, p)).routine, true);
  await one(db, `select toptik_media_private.enqueue($1,'{"storageAttemptRetired":"x"}'::jsonb)`, [p]);
  assert.equal((await row(db, p)).routine, false);
});
test('routine rows carry a fixed 6-hour handicap: older than that they go first, so the sweep cannot starve', { skip }, async () => {
  const db = await database(); await reset(db);
  const old = await product(db), real = await product(db);
  await one(db, "select toptik_media_private.enqueue($1,'{}'::jsonb)", [old]); await set(db, old, { status: 'done' });
  await one(db, 'select public.recover_toptik_media_work()');
  await db.query("update toptik_media_private.work_queue set updated_at=clock_timestamp()-interval '7 hours' where product_gid=$1", [old]);
  await one(db, "select toptik_media_private.enqueue($1,'{}'::jsonb)", [real]);
  assert.equal(await claim(db), old);
});
test('the base claim shares the order and honours the storage-repair backoff', { skip }, async () => {
  const db = await database(); await reset(db);
  const repair = await product(db), other = await product(db);
  for (const p of [repair, other]) await one(db, "select toptik_media_private.enqueue($1,'{}'::jsonb)", [p]);
  await db.query("update toptik_media_private.work_queue set last_error='MEDIA_STORAGE_OBJECT_NOT_READABLE_REPAIR_NEEDED',updated_at=clock_timestamp()-interval '1 hour' where product_gid=$1", [repair]);
  assert.equal(await claim(db), other);
  assert.equal(await claim(db), repair, 'still claimed when nothing else is claimable');
});
test('application roles keep exactly their previous queue grants', { skip }, async () => {
  const db = await database();
  const can = async (role, fn) => (await one(db, 'select has_function_privilege($1,$2,$3) v', [role, fn, 'execute'])).v;
  assert.equal(await can('service_role', 'public.claim_toptik_media_work_excluding(uuid,text[])'), true);
  assert.equal(await can('service_role', 'toptik_media_private.enqueue_routine(text)'), false);
  assert.equal(await can('authenticated', 'public.claim_toptik_media_work_excluding(uuid,text[])'), false);
});
test('the sweep leaves failed rows (already claimable, possibly real work) untouched', { skip }, async () => {
  const db = await database(); await reset(db);
  const p = await product(db); await one(db, `select toptik_media_private.enqueue($1,'{"gallery":{"actorType":"supabase_user"}}'::jsonb)`, [p]);
  await set(db, p, { status: 'failed', last_error: 'MEDIA_WORK_FAILED' });
  const before = await row(db, p); await one(db, 'select public.recover_toptik_media_work()');
  assert.deepEqual(await row(db, p), before);
});
test('a 3-hour-old routine row still waits behind real work enqueued after it (no cliff)', { skip }, async () => {
  const db = await database(); await reset(db);
  const old = await product(db), real = await product(db);
  await one(db, "select toptik_media_private.enqueue($1,'{}'::jsonb)", [old]); await set(db, old, { status: 'done' });
  await one(db, 'select public.recover_toptik_media_work()');
  await db.query("update toptik_media_private.work_queue set updated_at=clock_timestamp()-interval '3 hours 30 minutes' where product_gid=$1", [old]);
  await one(db, "select toptik_media_private.enqueue($1,'{}'::jsonb)", [real]);
  assert.equal(await claim(db), real);
});
