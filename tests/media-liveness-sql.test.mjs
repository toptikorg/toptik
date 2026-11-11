// Real read_toptik_media_liveness against an offline PGlite database with the real journal, transport and queue migrations.
// No network, no live database. Verifies the evidence the RPC returns, its scoping to the current episode, backoff mirrors, limits and grants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { createVerifiedImportDatabase } from './helpers/verified-native-import-sql-fixture.mjs';

const repo = new URL('../', import.meta.url);
const migration = name => readFile(new URL('supabase/migrations/' + name, repo), 'utf8');
const pick = (text, re) => { const m = text.match(re); assert.ok(m, String(re)); return m[0]; };
const ago = minutes => minutes == null ? null : `${minutes} minutes`;

async function database() {
  const { db } = await createVerifiedImportDatabase();
  // Same offline recipe as the queue suites: the planning migration's queue objects verbatim (the whole file needs the full
  // catalog schema), then every queue migration in order, then the migration under test. Nothing is skipped silently.
  const planning = await migration('20261001_media_planning_runtime.sql');
  for (const re of [/create table toptik_media_private\.work_queue\([\s\S]*?\);/, /create function public\.claim_toptik_media_work\([\s\S]*?end \$\$;/,
    /create function public\.finish_toptik_media_work\([\s\S]*?end \$\$;/, /create function public\.recover_toptik_media_work\([\s\S]*?end \$\$;/]) await db.exec(pick(planning, re));
  for (const name of ['20261007_media_queue_inflight.sql', '20261007_media_queue_distinct.sql', '20261007_media_queue_repair_backoff.sql',
    '20261007_media_queue_defer.sql', '20261008_media_queue_priority.sql', '20261008_media_queue_failed_backoff.sql',
    '20261111121000_media_liveness_read.sql']) await db.exec(await migration(name));
  const liveness = async (limit = 50) => (await db.query('select public.read_toptik_media_liveness($1) result', [limit])).rows[0].result;
  let n = 7100;
  const product = async (sku, queue) => {
    const gid = `gid://shopify/Product/${n++}`;
    await db.query('insert into shopify_gallery_copy_eligibility values($1,$2,$3,$4,$5,$6,$7,true)', [gid, sku, randomUUID(), `gid://shopify/ProductVariant/${n}`, sku, sku, 'h-' + sku]);
    await db.query('insert into toptik_media_private.products(product_gid,identity,approval_id,approval_evidence,enabled) values($1,$2,$3,$4,true)', [gid, JSON.stringify({ sku }), randomUUID(), '{}']);
    await db.query(`insert into toptik_media_private.work_queue(product_gid,status,last_error,attempts,generation,claim_id,claimed_at,updated_at)
      values($1,$2,$3,$4,$5,$6,clock_timestamp()-$7::interval,clock_timestamp()-$8::interval)`,
      [gid, queue.status, queue.lastError ?? null, queue.attempts ?? 0, queue.generation ?? 1, queue.claimId ?? null, ago(queue.claimedAgoMin), ago(queue.updatedAgoMin ?? 1)]);
    return gid;
  };
  const operation = async (gid, status, createdAgoMin, updatedAgoMin = createdAgoMin) => {
    const id = randomUUID();
    await db.query(`insert into toptik_media_private.operations(id,product_gid,state_version,plan,initial_pair,request_hash,observed_pair,status,next_step,created_at,updated_at)
      values($1,$2,1,'{}','{}','h','{}',$3,0,clock_timestamp()-$4::interval,clock_timestamp()-$5::interval)`, [id, gid, status, ago(createdAgoMin), ago(updatedAgoMin)]);
    return id;
  };
  const event = (gid, op, kind, result, agoMin, evidence = { stepIndex: 0, phaseIndex: 1 }) =>
    db.query(`insert into toptik_media_private.events(request_id,product_gid,operation_id,event_kind,request_hash,evidence,result,created_at)
      values($1,$2,$3,$4,$5,$6,$7,clock_timestamp()-$8::interval)`, [randomUUID(), gid, op, kind, 'h' + randomUUID(), JSON.stringify(evidence), JSON.stringify(result), ago(agoMin)]);
  const step = (op, index, status, verifiedAgoMin) => db.query(`insert into toptik_media_private.steps(operation_id,step_index,body,status,verified_at)
      values($1,$2,'{}',$3,clock_timestamp()-$4::interval)`, [op, index, status, ago(verifiedAgoMin)]);
  return { db, liveness, product, operation, event, step };
}
const minutesAgo = (iso, now = Date.now()) => (now - Date.parse(iso)) / 60000;
const near = (iso, expectedMin, tolerance = 0.2) => Math.abs(minutesAgo(iso) - expectedMin) <= tolerance;

test('the current episode is the open operation; only its verified readbacks and steps advance progress, bookkeeping and history do not', async () => {
  const h = await database();
  try {
    const gid = await h.product('LIVE-1', { status: 'pending', attempts: 4, generation: 9, updatedAgoMin: 1 });
    const historical = await h.operation(gid, 'verified', 120, 2);          // an older operation verified two minutes ago: history, not this episode
    const open = await h.operation(gid, 'running', 40);
    await h.event(gid, open, 'transport_readback', { status: 'verified', mayExecute: false, nextPhase: 2 }, 35, { stepIndex: 0, phaseIndex: 1 });
    await h.event(gid, open, 'transport_readback', { status: 'conflict', mayExecute: false, nextPhase: 2 }, 10, { stepIndex: 0, phaseIndex: 2 });
    await h.event(gid, open, 'transport_guard_refreshed', { refreshed: true }, 3);
    await h.event(gid, open, 'transport_started', { mayExecute: true }, 2);
    await h.event(gid, historical, 'transport_readback', { status: 'verified' }, 1, { stepIndex: 0, phaseIndex: 0 }); // verified, but on the historical operation
    // a transport attempt that started a minute ago is activity, not verification: it is reported as latest_attempt and moves nothing else
    await h.step(open, 0, 'started', null);
    await h.db.query(`insert into toptik_media_private.transport_chains(operation_id,step_index,phases,initial_guard,current_guard,status) values($1,0,'[]','{}','{}','running')`, [open]);
    await h.db.query(`insert into toptik_media_private.transport_attempts(operation_id,step_index,phase_index,attempt_id,phase,request_hash,request,before_guard,status,created_at)
      values($1,0,2,$2,'associate','h','{}','{}','started',clock_timestamp()-interval '1 minute')`, [open, randomUUID()]);
    const r = await h.liveness();
    assert.equal(r.scope, 'open_work_queue_rows_only'); assert.equal(r.openTotal, 1); assert.equal(r.limit, 50);
    const [row] = r.items;
    assert.equal(row.product_gid, gid); assert.equal(row.sku, 'LIVE-1'); assert.equal(row.status, 'pending'); assert.equal(row.generation, 9); assert.equal(row.attempts, 4);
    assert.equal(row.episode.id, open); assert.equal(row.episode.status, 'running'); assert.ok(near(row.episode.created_at, 40));
    assert.ok(near(row.episode_progress.last_verified_at, 35), 'the verified readback, not the conflict, the guard refresh, the started attempt or the historical operation');
    assert.deepEqual([row.episode_progress.last_verified_source.kind, row.episode_progress.last_verified_source.step_index, row.episode_progress.last_verified_source.phase_index], ['transport_readback', 0, 1]);
    assert.equal(row.episode_progress.verified_phases, 1); assert.equal(row.episode_progress.verified_steps, 0);
    assert.ok(near(row.episode_progress.last_activity_at, 2), 'activity is reported separately from progress');
    assert.deepEqual([row.episode_progress.latest_attempt.phase, row.episode_progress.latest_attempt.status], ['associate', 'started']);
    assert.ok(near(row.episode_progress.latest_attempt.created_at, 1), 'the attempt start is reported as an attempt, never as verified progress');
    assert.equal(row.last_completed.id, historical); assert.ok(near(row.last_completed.updated_at, 2));
    assert.ok(minutesAgo(row.last_observed_at) <= 1.2);
    assert.equal(row.retry_due_at, null); assert.equal(row.claim_stale_after, null); assert.equal(row.claimed_at, null);
  } finally { await h.db.close(); }
});

test('a verified step anchors progress when it is newer than any verified readback; a row without an open operation reports no episode', async () => {
  const h = await database();
  try {
    const gid = await h.product('LIVE-2', { status: 'pending' });
    const open = await h.operation(gid, 'uncertain', 30);
    await h.event(gid, open, 'transport_final_readback', { status: 'verified' }, 20, { stepIndex: 0 });
    await h.step(open, 0, 'verified', 5);
    await h.step(open, 1, 'ready', null);
    const idle = await h.product('LIVE-3', { status: 'pending', updatedAgoMin: 20 });
    await h.operation(idle, 'verified', 300, 200);
    const r = await h.liveness();
    const a = r.items.find(i => i.product_gid === gid), b = r.items.find(i => i.product_gid === idle);
    assert.ok(near(a.episode_progress.last_verified_at, 5)); assert.deepEqual([a.episode_progress.last_verified_source.kind, a.episode_progress.last_verified_source.step_index], ['step', 0]);
    assert.equal(a.episode_progress.verified_phases, 1); assert.equal(a.episode_progress.verified_steps, 1);
    assert.equal(b.episode, null); assert.equal(b.episode_progress, null); assert.ok(near(b.last_completed.updated_at, 200)); assert.ok(near(b.updated_at, 20));
  } finally { await h.db.close(); }
});

test('failed rows carry the same retry due time the claim function applies (capped at 36 steps); processing rows carry the stale-claim bound', async () => {
  const h = await database();
  try {
    const capped = await h.product('LIVE-4', { status: 'failed', lastError: 'MEDIA_PLANNING_TIME_BUDGET', attempts: 55, updatedAgoMin: 60 });
    const small = await h.product('LIVE-5', { status: 'failed', lastError: 'MEDIA_PLANNING_TIME_BUDGET', attempts: 3, updatedAgoMin: 60 });
    const claim = randomUUID();
    const proc = await h.product('LIVE-6', { status: 'processing', claimId: claim, claimedAgoMin: 2, updatedAgoMin: 2 });
    const r = await h.liveness();
    const by = Object.fromEntries(r.items.map(i => [i.product_gid, i]));
    assert.ok(near(by[capped].retry_due_at, 60 - 360), '36 * 10 minutes after the failure');
    assert.ok(near(by[small].retry_due_at, 60 - 30), '3 * 10 minutes after the failure');
    assert.equal(by[proc].claim_id, claim); assert.ok(near(by[proc].claimed_at, 2)); assert.ok(near(by[proc].claim_stale_after, 2 - 5));
    assert.equal(by[proc].retry_due_at, null); assert.equal(by[capped].claim_stale_after, null);
    // The mirrored formulas are the ones the existing claim function enforces; if that function changes, this read must change with it.
    const claimSql = (await h.db.query("select pg_get_functiondef('public.claim_toptik_media_work_excluding(uuid,text[])'::regprocedure) d")).rows[0].d;
    assert.match(claimSql, /least\(\s*q\.attempts\s*,\s*36\s*\)\s*\*\s*interval\s*'10 minutes'/i);
    assert.match(claimSql, /q\.claimed_at\s*<\s*clock_timestamp\(\)\s*-\s*interval\s*'5 minutes'/i);
  } finally { await h.db.close(); }
});

test('provider text never leaves the database, done rows are out of scope, the limit bounds the rows while openTotal counts them all', async () => {
  const h = await database();
  try {
    const review = await h.product('LIVE-7', { status: 'review', lastError: 'connection refused at 10.0.0.1 key=secret', updatedAgoMin: 5 });
    await h.product('LIVE-8', { status: 'done', updatedAgoMin: 4 });
    const p1 = await h.product('LIVE-9', { status: 'pending', updatedAgoMin: 3 });
    const p2 = await h.product('LIVE-10', { status: 'pending', updatedAgoMin: 2 });
    const r = await h.liveness(2);
    assert.equal(r.limit, 2); assert.equal(r.items.length, 2); assert.equal(r.openTotal, 3);
    assert.deepEqual(r.items.map(i => i.product_gid), [review, p1], 'oldest first, the done row excluded');
    assert.equal(r.items[0].last_error, 'MEDIA_ERROR_UNRECOGNIZED'); assert.ok(!JSON.stringify(r).includes('secret'));
    assert.ok((await h.liveness(50)).items.some(i => i.product_gid === p2));
    for (const limit of [0, 101]) await assert.rejects(h.liveness(limit), /MEDIA_MONITOR_INPUT_INVALID/);
  } finally { await h.db.close(); }
});

test('the read is service-role only and declared stable; it never writes', async () => {
  const h = await database();
  try {
    const priv = async role => (await h.db.query(`select has_function_privilege($1::name,'public.read_toptik_media_liveness(int)'::text,'execute') ok`, [role])).rows[0].ok;
    assert.equal(await priv('service_role'), true);
    for (const role of ['anon', 'authenticated']) assert.equal(await priv(role), false, role);
    const vol = (await h.db.query("select provolatile v, prosecdef s from pg_proc where proname='read_toptik_media_liveness'")).rows[0];
    assert.deepEqual([vol.v, vol.s], ['s', true]);
    const gid = await h.product('LIVE-11', { status: 'pending' });
    const before = (await h.db.query('select to_jsonb(q) row from toptik_media_private.work_queue q where product_gid=$1', [gid])).rows[0].row;
    await h.liveness(); await h.liveness(1);
    assert.deepEqual((await h.db.query('select to_jsonb(q) row from toptik_media_private.work_queue q where product_gid=$1', [gid])).rows[0].row, before);
  } finally { await h.db.close(); }
});

test('real claim, keep and defer preserve FIFO time while current operation progress selects the verdict', async () => {
  const code = await readFile(new URL('src/lib/shopify/media-liveness.ts', repo), 'utf8');
  const detector = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(code)).toString('base64'));
  const h = await database();
  try {
    const gid = await h.product('LIVE-FIFO', { status: 'pending', generation: 1, updatedAgoMin: 60 });
    const op = await h.operation(gid, 'running', 60);
    const firstClaim = randomUUID();
    const claimed = (await h.db.query('select public.claim_toptik_media_work_excluding($1,$2) result', [firstClaim, []])).rows[0].result;
    assert.equal(claimed.productId, gid);
    const assess = async () => { const result = await h.liveness(); const reading = detector.livenessRows(result); assert.ok(reading); return {raw: result.items[0], verdict: detector.assessLiveness(reading.rows[0], Date.parse(result.observedAt))}; };
    let r = await assess();
    assert.ok(near(r.raw.updated_at, 60));
    assert.deepEqual([r.verdict.state, r.verdict.rule, r.verdict.anchorKind], ['stuck', 'NO_VERIFIED_PROGRESS', 'operation_start']);
    await h.event(gid, op, 'transport_readback', { status: 'verified' }, 1);
    r = await assess(); assert.deepEqual([r.verdict.state, r.verdict.anchorKind], ['healthy', 'verified_progress']);
    assert.equal((await h.db.query('select public.keep_toptik_media_work_in_flight($1,$2,$3) ok', [gid, firstClaim, claimed.generation])).rows[0].ok, true);
    r = await assess(); assert.ok(near(r.raw.updated_at, 60)); assert.equal(r.raw.status, 'pending');
    assert.deepEqual([r.verdict.state, r.verdict.rule, r.verdict.anchorKind], ['healthy', 'IN_FLIGHT_CONTINUES', 'verified_progress']);
    const secondClaim = randomUUID();
    const again = (await h.db.query('select public.claim_toptik_media_work_excluding($1,$2) result', [secondClaim, []])).rows[0].result;
    assert.equal(again.productId, gid); assert.ok(near((await assess()).raw.updated_at, 60));
    assert.equal((await h.db.query('select public.defer_toptik_media_work($1,$2,$3) ok', [gid, secondClaim, again.generation])).rows[0].ok, true);
    r = await assess(); assert.ok(near(r.raw.updated_at, 60)); assert.equal(r.raw.status, 'pending');
    assert.deepEqual([r.verdict.state, r.verdict.anchorKind], ['healthy', 'verified_progress']);
  } finally { await h.db.close(); }
});
