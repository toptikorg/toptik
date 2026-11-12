// Regression tests execute the actual failure-streak migration on real queue SQL
// in an offline in-memory PGlite database. No worker, network or live database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createVerifiedImportDatabase } from './helpers/verified-native-import-sql-fixture.mjs';

const repo = new URL('../', import.meta.url);
const migration = name => readFile(new URL('supabase/migrations/' + name, repo), 'utf8');
const pick = (text, re) => { const m = text.match(re); assert.ok(m, 'anchor missing: ' + re); return m[0]; };

const QUEUE_MIGRATIONS = ['20261007_media_queue_inflight.sql', '20261007_media_queue_distinct.sql', '20261007_media_queue_repair_backoff.sql',
  '20261007_media_queue_defer.sql', '20261008_media_queue_priority.sql', '20261008_media_queue_failed_backoff.sql', '20261111121000_media_liveness_read.sql'];

async function baseDatabase() {
  const { db } = await createVerifiedImportDatabase();
  const planning = await migration('20261001_media_planning_runtime.sql');
  for (const re of [/create table toptik_media_private\.work_queue\([\s\S]*?\);/, /create function public\.claim_toptik_media_work\([\s\S]*?end \$\$;/,
    /create function public\.finish_toptik_media_work\([\s\S]*?end \$\$;/, /create function public\.recover_toptik_media_work\([\s\S]*?end \$\$;/]) await db.exec(pick(planning, re));
  for (const name of QUEUE_MIGRATIONS) await db.exec(await migration(name));
  // Include the real planning ACL and RLS statements, not just its function bodies.
  await db.exec(pick(planning, /alter table toptik_media_private\.work_queue enable row level security;[\s\S]*?revoke all on toptik_media_private\.work_queue from public,anon,authenticated,service_role;/));
  await db.exec(pick(planning, /do \$\$ declare f record;[\s\S]*?end \$\$;/));
  // The enqueue paths call the copy-identity assertion; the queue, not identity, is under test here (in-memory stub only).
  await db.exec('create or replace function public.assert_shopify_verified_copy_identity(p_item uuid,p_key text,p_gsku text,p_product text,p_variant text,p_ssku text) returns void language plpgsql as $$begin end$$;');
  return db;
}

// Execute the actual forward migration, not a test-local substitute.
async function applyMigration(db) {
  await db.exec(await migration('20261112055049_media_queue_failure_streak.sql'));
}

async function harness({ migrated = true } = {}) {
  const db = await baseDatabase();
  let n = 9500;
  const product = async () => {
    const gid = `gid://shopify/Product/${n++}`, sku = 'S' + n;
    await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)', [gid, sku, randomUUID(), `gid://shopify/ProductVariant/${n}`, sku, sku, 'h-' + sku]);
    await db.query('insert into toptik_media_private.products(product_gid,identity,approval_id,approval_evidence,enabled) values($1,$2,$3,$4,true)', [gid, JSON.stringify({ sku }), randomUUID(), '{}']);
    return gid;
  };
  const rpc = async (name, args) => (await db.query(`select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) r`, args)).rows[0].r;
  const h = {
    db, product,
    claim: () => rpc('public.claim_toptik_media_work_excluding', [randomUUID()]),
    finish: (gid, c, status, error = null) => rpc('public.finish_toptik_media_work', [gid, c.claimId, c.generation, status, error]),
    enqueue: gid => db.query("select toptik_media_private.enqueue($1,'{}'::jsonb)", [gid]),
    routine: gid => db.query('select toptik_media_private.enqueue_routine($1)', [gid]),
    row: async gid => (await db.query('select status,attempts,routine,last_error,generation,failure_streak from toptik_media_private.work_queue where product_gid=$1', [gid])).rows[0],
    age: (gid, minutes) => db.query('update toptik_media_private.work_queue set updated_at=clock_timestamp()-make_interval(mins=>$2) where product_gid=$1', [gid, minutes]),
    liveness: async gid => (await db.query('select public.read_toptik_media_liveness(100) r')).rows[0].r.items.find(i => i.product_gid === gid),
    set: (gid, sql, ...args) => db.query(`update toptik_media_private.work_queue set ${sql} where product_gid=$1`, [gid, ...args]),
  };
  h.fail = async gid => { const c = await h.claim(); assert.equal(c?.productId, gid, 'claim for failure'); await h.finish(gid, c, 'failed', 'MEDIA_SOURCE_READ_FAILED'); };
  h.successfulRun = async gid => {
    for (let i = 0; i < 39; i++) { const c = await h.claim(); assert.equal(c?.productId, gid); await h.finish(gid, c, 'pending'); }
    const last = await h.claim(); assert.equal(last?.productId, gid); await h.finish(gid, last, 'done');
  };
  // reclaimable exactly when `due` minutes have passed since the last update (checked one minute either side)
  h.assertDue = async (gid, due, label) => {
    await h.age(gid, due - 1); assert.equal(await h.claim(), null, `${label}: not reclaimable at ${due - 1} min`);
    await h.age(gid, due + 1); const c = await h.claim(); assert.equal(c?.productId, gid, `${label}: reclaimable at ${due + 1} min`); return c;
  };
  h.dueMinutes = live => Math.round((Date.parse(live.retry_due_at) - Date.parse(live.updated_at)) / 60000);
  if (migrated) await applyMigration(db);
  return h;
}

test('migration applies to the real queue definitions and initializes new rows', async t => {
  const h = await harness(); t.after(() => h.db.close()); const gid = await h.product();
  await h.enqueue(gid); assert.equal((await h.row(gid)).failure_streak, 0);
});

test('contract 1: the first failure after 40 successful claims retries after 10 minutes, and the monitor says so', async t => {
  const h = await harness(); t.after(() => h.db.close()); const gid = await h.product();
  await h.enqueue(gid); await h.successfulRun(gid); await h.enqueue(gid);
  await h.fail(gid);
  const r = await h.row(gid); assert.equal(r.status, 'failed'); assert.equal(r.failure_streak, 1); assert.equal(r.attempts, 41, 'attempts keeps counting every claim');
  assert.equal(h.dueMinutes(await h.liveness(gid)), 10);
  await h.assertDue(gid, 10, 'first failure');
});

test('contract 2: a chronic failure keeps backing off 10,20,30... capped at 360 minutes (no storm, no shortcut)', async t => {
  const h = await harness(); t.after(() => h.db.close()); const gid = await h.product(); await h.enqueue(gid);
  for (let k = 1; k <= 40; k++) {
    await h.fail(gid);                                  // the k-th consecutive failure
    assert.equal((await h.row(gid)).failure_streak, Math.min(k, 36));
    const due = Math.min(k, 36) * 10;
    assert.equal(h.dueMinutes(await h.liveness(gid)), due, `monitor after failure ${k}`);
    if ([1, 2, 5, 36, 37].includes(k)) { await h.age(gid, due - 1); assert.equal(await h.claim(), null, `failure ${k}: held until ${due} min`); }
    await h.age(gid, due + 1);                          // let it become due for the next loop iteration
  }
});

test('contract 3: pending (progress) does not reset the streak; done does', async t => {
  const h = await harness(); t.after(() => h.db.close()); const gid = await h.product(); await h.enqueue(gid);
  await h.fail(gid); await h.age(gid, 11); await h.fail(gid);                 // streak 2
  assert.equal((await h.row(gid)).failure_streak, 2);
  await h.age(gid, 21); let c = await h.claim(); await h.finish(gid, c, 'pending');
  assert.equal((await h.row(gid)).failure_streak, 2, 'a pending finish keeps the chronic-failure protection');
  c = await h.claim(); await h.finish(gid, c, 'failed', 'MEDIA_SOURCE_READ_FAILED');
  assert.equal((await h.row(gid)).failure_streak, 3); assert.equal(h.dueMinutes(await h.liveness(gid)), 30);
  await h.age(gid, 31); c = await h.claim(); await h.finish(gid, c, 'done');
  assert.equal((await h.row(gid)).failure_streak, 0, 'done resets');
  await h.enqueue(gid); await h.fail(gid); assert.equal((await h.row(gid)).failure_streak, 1);
  assert.equal(h.dueMinutes(await h.liveness(gid)), 10);
});

test('contract 4: monitor and queue agree for streaks 1, 3 and 36 (retry_due_at is the real claim time)', async t => {
  const h = await harness(); t.after(() => h.db.close());
  for (const streak of [1, 3, 36]) {
    const gid = await h.product(); await h.enqueue(gid); await h.fail(gid);
    await h.set(gid, 'failure_streak=$2', streak);
    const due = Math.min(streak, 36) * 10;
    assert.equal(h.dueMinutes(await h.liveness(gid)), due, 'monitor, streak ' + streak);
    await h.assertDue(gid, due, 'queue, streak ' + streak);
  }
});

test('contract 5: a real enqueue makes the row claimable now but does NOT erase the streak; the next failure continues the count', async t => {
  const h = await harness(); t.after(() => h.db.close()); const gid = await h.product(); await h.enqueue(gid);
  await h.fail(gid); await h.age(gid, 11); await h.fail(gid); assert.equal((await h.row(gid)).failure_streak, 2);
  await h.enqueue(gid); const r = await h.row(gid); assert.equal(r.status, 'pending'); assert.equal(r.failure_streak, 2); assert.equal(r.last_error, null);
  await h.fail(gid); assert.equal((await h.row(gid)).failure_streak, 3);
});

test('contract 6: the daily routine sweep leaves failed rows alone, and a done row does not inherit a streak', async t => {
  const h = await harness(); t.after(() => h.db.close()); const gid = await h.product(); await h.enqueue(gid);
  await h.fail(gid); const before = await h.row(gid);
  await h.routine(gid); const after = await h.row(gid);
  assert.equal(after.status, 'failed'); assert.equal(after.failure_streak, before.failure_streak); assert.equal(after.routine, false);
  await h.age(gid, 11); const c = await h.claim(); await h.finish(gid, c, 'done');
  await h.routine(gid); const swept = await h.row(gid); assert.equal(swept.status, 'pending'); assert.equal(swept.routine, true); assert.equal(swept.failure_streak, 0);
});

test('contract 7: a stale claim is re-claimed without counting a failure; the dead claim cannot change the streak', async t => {
  const h = await harness(); t.after(() => h.db.close()); const gid = await h.product(); await h.enqueue(gid);
  await h.fail(gid); await h.age(gid, 11);
  const first = await h.claim(); assert.equal(first?.productId, gid);
  await h.set(gid, "claimed_at=clock_timestamp()-interval '6 minutes'");
  const second = await h.claim(); assert.equal(second?.productId, gid); assert.notEqual(second.claimId, first.claimId);
  assert.equal((await h.row(gid)).failure_streak, 1, 're-claiming a stale claim is not a failure');
  await assert.rejects(h.finish(gid, first, 'failed', 'MEDIA_SOURCE_READ_FAILED'), /MEDIA_QUEUE_CLAIM_CHANGED/);
  assert.equal((await h.row(gid)).failure_streak, 1);
  await h.finish(gid, second, 'failed', 'MEDIA_SOURCE_READ_FAILED'); assert.equal((await h.row(gid)).failure_streak, 2);
});

test('contract 8: a finish from an older generation neither counts a failure nor resets the streak', async t => {
  const h = await harness(); t.after(() => h.db.close()); const gid = await h.product(); await h.enqueue(gid);
  await h.fail(gid); await h.age(gid, 11);
  let c = await h.claim(); await h.enqueue(gid);              // the generation moves while the claim is processing
  await h.finish(gid, c, 'failed', 'MEDIA_SOURCE_READ_FAILED');
  let r = await h.row(gid); assert.equal(r.status, 'pending', 'the newer generation wins'); assert.equal(r.failure_streak, 1, 'a stale-generation failure is not counted');
  c = await h.claim(); await h.enqueue(gid); await h.finish(gid, c, 'done');
  r = await h.row(gid); assert.equal(r.status, 'pending'); assert.equal(r.failure_streak, 1, 'a stale-generation done does not reset');
});

test('contract 9: backfill keeps chronic failures where they are; pending and done rows start at zero', async t => {
  const h = await harness({ migrated: false }); t.after(() => h.db.close()); const chronic = await h.product(), pend = await h.product(), done = await h.product();
  for (const g of [chronic, pend, done]) await h.enqueue(g);
  await h.set(chronic, "status='failed',attempts=55,last_error='MEDIA_PLANNING_TIME_BUDGET',updated_at=clock_timestamp()");
  await h.set(done, "status='done',attempts=40");
  await applyMigration(h.db);
  assert.equal((await h.row(chronic)).failure_streak, 36); assert.equal(h.dueMinutes(await h.liveness(chronic)), 360, 'a backfilled chronic failure keeps its 6 hours');
  assert.equal((await h.row(pend)).failure_streak, 0); assert.equal((await h.row(done)).failure_streak, 0);
});

test('contract 10: attempts is diagnostic only and still increments on every claim', async t => {
  const h = await harness(); t.after(() => h.db.close()); const gid = await h.product(); await h.enqueue(gid);
  for (let i = 1; i <= 5; i++) { const c = await h.claim(); assert.equal(c?.productId, gid); await h.finish(gid, c, 'pending'); assert.equal((await h.row(gid)).attempts, i); }
});


// Capture the ACL and implementation contracts of the existing queue before replacing functions.
const signatures = [
 'public.finish_toptik_media_work(text,uuid,bigint,text,text)',
 'public.claim_toptik_media_work_excluding(uuid,text[])',
 'public.read_toptik_media_liveness(integer)',
];
async function securitySnapshot(db) {
 const functions = (await db.query(`select p.oid::regprocedure::text as signature,p.proacl::text as acl,p.proowner,p.prosecdef,p.proconfig::text as config,p.proargtypes::text as argument_types,p.prorettype::text as return_type
 from pg_proc p where p.oid=any($1::regprocedure[]) order by p.oid`, [signatures])).rows;
 const table = (await db.query("select relacl::text,relrowsecurity,relforcerowsecurity from pg_class where oid='toptik_media_private.work_queue'::regclass")).rows;
 const grants = [];
 for (const role of ['anon','authenticated','service_role']) {
  for (const signature of signatures) grants.push([role,signature,(await db.query('select has_function_privilege($1,$2,\'EXECUTE\') ok',[role,signature])).rows[0].ok]);
  grants.push([role,'table',(await db.query("select has_table_privilege($1,'toptik_media_private.work_queue','SELECT,INSERT,UPDATE,DELETE') ok",[role])).rows[0].ok]);
 }
 return { functions,table,grants };
}

test('migration preserves ACLs, owners, RLS, hardened search_path and service-only execution; rollback does too', async t => {
 const h=await harness({migrated:false});t.after(()=>h.db.close());
 const before=await securitySnapshot(h.db);
 const constraints=async()=> (await h.db.query("select conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid='toptik_media_private.work_queue'::regclass order by conname")).rows;
 const originalConstraints=await constraints();
 assert.ok(before.table[0].relrowsecurity);
 for(const [role,signature,allowed] of before.grants) assert.equal(allowed,role==='service_role'&&signature!=='table',`${role}: ${signature}`);
 await applyMigration(h.db);assert.deepEqual(await securitySnapshot(h.db),before);
 const upgradedConstraints=await constraints();
 assert.deepEqual(upgradedConstraints.filter(r=>!['media_queue_failure_streak_range','work_queue_failure_streak_not_null'].includes(r.conname)),originalConstraints);
 assert.equal(upgradedConstraints.filter(r=>r.conname==='media_queue_failure_streak_range').length,1);
 assert.equal((await h.db.query("select attnotnull from pg_attribute where attrelid='toptik_media_private.work_queue'::regclass and attname='failure_streak'")).rows[0].attnotnull,true);
 for(const role of ['anon','authenticated']) {
  await h.db.exec(`set role ${role}`);
  try { await assert.rejects(h.db.query('select public.read_toptik_media_liveness(1)'),/permission denied/); }
  finally {await h.db.exec('reset role');}
 }
 await h.db.exec(await readFile(new URL('docs/media-queue-failure-streak-rollback.sql',repo),'utf8'));
 assert.deepEqual(await securitySnapshot(h.db),before);
});

test('backfill preserves every existing queue field and conservatively carries history for ALL unfinished states', async t => {
 const h=await harness({migrated:false});t.after(()=>h.db.close());
 const gids=[];
 for(const status of ['pending','processing','failed','review','done']) {
  const gid=await h.product();gids.push(gid);await h.enqueue(gid);
  await h.set(gid,"status=$2,attempts=55,last_error='MEDIA_TIME_BUDGET',generation=7,evidence='{\"marker\":true}'::jsonb",status);
 }
 const before=(await h.db.query('select * from toptik_media_private.work_queue order by product_gid')).rows;
 await applyMigration(h.db);
 const after=(await h.db.query('select * from toptik_media_private.work_queue order by product_gid')).rows;
 assert.deepEqual(after.map(row=>{const previousFields={...row};delete previousFields.failure_streak;return previousFields;}),before);
 for(const r of after)assert.equal(r.failure_streak,r.status==='done'?0:36);
 const active=gids[1];await h.set(active,"claim_id=$2,claimed_generation=7,claimed_at=clock_timestamp()",randomUUID());
 const a=(await h.db.query('select claim_id from toptik_media_private.work_queue where product_gid=$1',[active])).rows[0];
 await h.finish(active,{claimId:a.claim_id,generation:7},'failed','MEDIA_TIME_BUDGET');
 assert.equal((await h.row(active)).failure_streak,36);assert.equal(h.dueMinutes(await h.liveness(active)),360);
});

test('unchanged defer, keep and recover preserve failure history and their queue-position semantics',async t=>{
 const h=await harness();t.after(()=>h.db.close());const gid=await h.product();await h.enqueue(gid);
 await h.fail(gid);await h.age(gid,11);await h.fail(gid);await h.age(gid,21);
 let c=await h.claim();
 const timestamp=async()=> (await h.db.query('select updated_at from toptik_media_private.work_queue where product_gid=$1',[gid])).rows[0].updated_at;
 let at=await timestamp();
 await h.db.query('select public.defer_toptik_media_work($1,$2,$3)',[gid,c.claimId,c.generation]);
 assert.equal((await h.row(gid)).failure_streak,2);assert.deepEqual(await timestamp(),at);
 c=await h.claim();at=await timestamp();
 await h.db.query('select public.keep_toptik_media_work_in_flight($1,$2,$3)',[gid,c.claimId,c.generation]);
 assert.equal((await h.row(gid)).failure_streak,2);assert.deepEqual(await timestamp(),at);
 c=await h.claim();await h.finish(gid,c,'failed','MEDIA_TIME_BUDGET');
 const before=await h.row(gid);await h.db.query('select public.recover_toptik_media_work()');assert.deepEqual(await h.row(gid),before);
 await h.age(gid,31);c=await h.claim();await h.finish(gid,c,'done');await h.db.query('select public.recover_toptik_media_work()');
 assert.equal((await h.row(gid)).routine,true);assert.equal((await h.row(gid)).failure_streak,0);
});

test('actual migration leaves the claim selection, locking, exclusions, identity guards and monitor fields unchanged',async t=>{
 const h=await harness({migrated:false});t.after(()=>h.db.close());
 const definitions=async()=> (await h.db.query(`select p.proname,pg_get_functiondef(p.oid) body from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','toptik_media_private') order by n.nspname,p.proname,p.oid`)).rows;
 const before=await definitions();await applyMigration(h.db);const after=await definitions();
 const changed=[];
 for(let i=0;i<before.length;i++)if(before[i].body!==after[i].body)changed.push(before[i].proname);
 assert.deepEqual(changed.sort(),['claim_toptik_media_work_excluding','finish_toptik_media_work','read_toptik_media_liveness']);
 const oldClaim=before.find(r=>r.proname==='claim_toptik_media_work_excluding').body;
 const newClaim=after.find(r=>r.proname==='claim_toptik_media_work_excluding').body;
 assert.equal(newClaim.replaceAll('failure_streak','attempts'),oldClaim);
 const oldLive=before.find(r=>r.proname==='read_toptik_media_liveness').body;
 const newLive=after.find(r=>r.proname==='read_toptik_media_liveness').body;
 assert.equal(newLive.replaceAll('failure_streak','attempts'),oldLive);
});

test('chronic failed work does not starve healthy work; exclusions, disabled identities and active claims still apply',async t=>{
 const h=await harness();t.after(()=>h.db.close());const bad=await h.product(),good=await h.product();
 await h.enqueue(bad);await h.fail(bad);await h.set(bad,'failure_streak=36');await h.enqueue(good);
 const c=await h.claim();assert.equal(c.productId,good);assert.equal(await h.claim(),null,'active claim cannot be claimed again');
 await h.finish(good,c,'done');await h.enqueue(good);
 assert.equal((await h.db.query('select public.claim_toptik_media_work_excluding($1,$2) r',[randomUUID(),[good]])).rows[0].r,null);
 await h.db.query('update public.shopify_gallery_copy_eligibility set enabled=false where product_gid=$1',[good]);
 assert.equal(await h.claim(),null);
});

test('counter rejects invalid values, caps failures and failed zero-attempt rows never become immediate retries on upgrade',async t=>{
 const h=await harness({migrated:false});t.after(()=>h.db.close());const gid=await h.product();await h.enqueue(gid);await h.set(gid,"status='failed',attempts=0");
 await applyMigration(h.db);assert.equal((await h.row(gid)).failure_streak,1);assert.equal(h.dueMinutes(await h.liveness(gid)),10);
 for(const value of [-1,37])await assert.rejects(h.set(gid,'failure_streak=$2',value),/media_queue_failure_streak_range/);
 await assert.rejects(h.set(gid,'failure_streak=null'),/not-null constraint/);
});

test('rollback restores original scheduling definitions without rewriting or deleting any queue row or lifetime diagnostic',async t=>{
 const h=await harness({migrated:false});t.after(()=>h.db.close());
 const def=async()=> (await h.db.query('select pg_get_functiondef(x::regprocedure) body from unnest($1::text[]) x',[signatures])).rows;
 const original=await def();await applyMigration(h.db);const gid=await h.product();await h.enqueue(gid);await h.successfulRun(gid);await h.enqueue(gid);await h.fail(gid);
 assert.equal(h.dueMinutes(await h.liveness(gid)),10);
 const before=(await h.db.query('select * from toptik_media_private.work_queue')).rows;
 await h.db.exec(await readFile(new URL('docs/media-queue-failure-streak-rollback.sql',repo),'utf8'));
 assert.deepEqual(await def(),original);assert.equal(h.dueMinutes(await h.liveness(gid)),360);assert.deepEqual((await h.db.query('select * from toptik_media_private.work_queue')).rows,before);
});
