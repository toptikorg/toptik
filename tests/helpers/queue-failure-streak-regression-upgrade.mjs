// Optional second pass of the historical SQL suites against the real forward migration.
// Test-only. No network or hosted database; never imported by production.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const repo = new URL('../../', import.meta.url);
const migration = name => readFile(new URL('supabase/migrations/' + name, repo), 'utf8');
const pick = (s,re) => { const m=s.match(re);assert.ok(m,'missing queue SQL anchor');return m[0]; };
export const queueUpgradeRegression = process.env.TOPTIK_TEST_QUEUE_UPGRADE === '1';
export async function upgradeQueueRegressionFixture(db) {
 if(!queueUpgradeRegression)return;
 const planning=await migration('20261001_media_planning_runtime.sql');
 for(const [sig,re] of [
  ['public.claim_toptik_media_work(uuid)',/create function public\.claim_toptik_media_work\([\s\S]*?end \$\$;/],
  ['public.finish_toptik_media_work(text,uuid,bigint,text,text)',/create function public\.finish_toptik_media_work\([\s\S]*?end \$\$;/],
  ['public.recover_toptik_media_work()',/create function public\.recover_toptik_media_work\([\s\S]*?end \$\$;/],
 ])if(!(await db.query('select to_regprocedure($1) present',[sig])).rows[0].present)await db.exec(pick(planning,re));
 const column=(await db.query("select exists(select 1 from pg_attribute where attrelid='toptik_media_private.work_queue'::regclass and attname='inflight_keeps') present")).rows[0].present;
 if(!column)await db.exec(await migration('20261007_media_queue_inflight.sql'));
 for(const [sig,name] of [
  ['toptik_media_private.validate_queue_exclusions(text[])','20261007_media_queue_distinct.sql'],
  ['public.defer_toptik_media_work(text,uuid,bigint)','20261007_media_queue_defer.sql'],
 ])if(!(await db.query('select to_regprocedure($1) present',[sig])).rows[0].present)await db.exec(await migration(name));
 if(!(await db.query("select to_regprocedure('toptik_media_private.enqueue_routine(text)') present")).rows[0].present)await db.exec(await migration('20261008_media_queue_priority.sql'));
 await db.exec(await migration('20261008_media_queue_failed_backoff.sql'));
 if(!(await db.query("select to_regprocedure('public.read_toptik_media_liveness(integer)') present")).rows[0].present)await db.exec(await migration('20261111121000_media_liveness_read.sql'));
 await db.exec(await migration('20261112055049_media_queue_failure_streak.sql'));
}
