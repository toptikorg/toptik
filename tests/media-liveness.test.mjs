// Pure detector: fake clock only, no network, no database. Every rule, boundary and the six review corrections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const dataUrl = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64');
const lib = await import(dataUrl(stripTypeScriptTypes(read('src/lib/shopify/media-liveness.ts'))));
const T = lib.LIVENESS_THRESHOLDS;
const NOW = Date.parse('2026-11-11T09:00:00Z'), iso = ms => new Date(ms).toISOString(), min = n => n * 60 * 1000;
const OP = '11111111-1111-4111-8111-111111111111', OP2 = '33333333-3333-4333-8333-333333333333', CLAIM = '44444444-4444-4444-8444-444444444444';
const row = (o = {}) => ({ productGid: 'gid://shopify/Product/1', sku: 'SKU-1', status: 'pending', code: null, updatedAt: iso(NOW - min(1)), attempts: 3, generation: 7,
  claimId: null, claimedAt: null, claimStaleAfter: null, inflightKeeps: 0, routine: false, retryDueAt: null, episode: null, episodeProgress: null, lastCompleted: null,
  lastObservedAt: iso(NOW - min(1)), ...o });
const source = at => ({ kind: 'transport_readback', requestId: '22222222-2222-4222-8222-222222222222', stepIndex: 0, phaseIndex: 2, at: iso(at) });
const episode = (createdAt, extra = {}) => ({ id: OP, status: 'running', nextStep: 0, stateVersion: 5, createdAt: iso(createdAt), updatedAt: iso(createdAt), ...extra });
const progress = (verifiedAt, extra = {}) => ({ lastVerifiedAt: verifiedAt === null ? null : iso(verifiedAt), lastVerifiedSource: verifiedAt === null ? null : source(verifiedAt),
  verifiedPhases: verifiedAt === null ? 0 : 3, verifiedSteps: 0, lastActivityAt: iso(NOW - min(1)), latestAttempt: null, ...extra });
const withEpisode = (createdAgo, verifiedAgo, o = {}) => row({ episode: episode(NOW - min(createdAgo)), episodeProgress: progress(verifiedAgo === null ? null : NOW - min(verifiedAgo)), ...o });
const a = (r, now = NOW) => lib.assessLiveness(r, now);
const pick = v => [v.state, v.rule];

test('an open operation that just started, or just verified a phase, is in progress; the anchor names what it rests on', () => {
  const fresh = a(withEpisode(4, null));
  assert.deepEqual(pick(fresh), ['healthy', 'IN_PROGRESS']); assert.equal(fresh.anchorKind, 'operation_start'); assert.equal(fresh.ageMs, min(4)); assert.equal(fresh.candidateKey, null);
  const verified = a(withEpisode(40, 5));
  assert.deepEqual(pick(verified), ['healthy', 'IN_PROGRESS']); assert.equal(verified.anchorKind, 'verified_progress'); assert.equal(verified.evidence.verifiedSource.phaseIndex, 2);
});

test('slow then stuck follow the verified-progress clock exactly at the thresholds', () => {
  const at = ms => a(withEpisode(60, null, { episode: episode(NOW - ms) }));
  assert.deepEqual(pick(at(T.progressWaitMs)), ['healthy', 'IN_PROGRESS']);
  assert.deepEqual(pick(at(T.progressWaitMs + 1)), ['waiting', 'SLOW_PROGRESS']);
  assert.deepEqual(pick(at(T.stuckMs)), ['waiting', 'SLOW_PROGRESS']);
  const stuck = at(T.stuckMs + 1);
  assert.deepEqual(pick(stuck), ['stuck', 'NO_VERIFIED_PROGRESS']);
  assert.equal(stuck.candidateKey, `media:gid://shopify/Product/1:op:${OP}:NO_VERIFIED_PROGRESS`);
  assert.equal(stuck.anchorKind, 'operation_start');
});

test('correction 1: queue touches, activity, observation refreshes and generation churn never keep a stalled episode healthy', () => {
  const base = withEpisode(40, 35);
  assert.deepEqual(pick(a(base)), ['stuck', 'NO_VERIFIED_PROGRESS']);
  const touched = { ...base, updatedAt: iso(NOW - 1000), lastObservedAt: iso(NOW - 1000), generation: 99, attempts: 150,
    episodeProgress: { ...base.episodeProgress, lastActivityAt: iso(NOW - 1000), latestAttempt: { phase: 'detach_old', status: 'started', createdAt: iso(NOW - 1000) } } };
  const v = a(touched);
  assert.deepEqual(pick(v), ['stuck', 'NO_VERIFIED_PROGRESS']);
  assert.equal(v.candidateKey, a(base).candidateKey, 'generation and attempts are evidence, not identity');
  assert.equal(v.ageMs, min(35));
});

test('correction 1: historical verified activity of another operation never anchors the current episode', () => {
  const v = a(withEpisode(40, null, { lastCompleted: { id: OP2, updatedAt: iso(NOW - min(2)) } }));
  assert.deepEqual(pick(v), ['stuck', 'NO_VERIFIED_PROGRESS']); assert.equal(v.anchorKind, 'operation_start');
  // a verified timestamp older than the episode start is not this episode's progress either
  const older = a(withEpisode(20, 25));
  assert.equal(older.anchorKind, 'operation_start'); assert.deepEqual(pick(older), ['waiting', 'SLOW_PROGRESS']);
});

test('correction 2: without a reliable start for the current work the verdict is unknown, never an alarm', () => {
  const old = a(row({ lastCompleted: { id: OP2, updatedAt: iso(NOW - min(60 * 48)) } }));
  assert.deepEqual(pick(old), ['unknown', 'MISSING_CLOCK']); assert.equal(old.ageMs, null); assert.equal(old.candidateKey, null);
  assert.deepEqual(pick(a(row())), ['unknown', 'MISSING_CLOCK']);
  const recent = a(row({ lastCompleted: { id: OP2, updatedAt: iso(NOW - min(3)) } }));
  assert.deepEqual(pick(recent), ['healthy', 'IN_PROGRESS']); assert.equal(recent.anchorKind, 'last_completed');
  assert.deepEqual(pick(a(row({ status: 'processing', claimedAt: null, claimStaleAfter: null }))), ['unknown', 'MISSING_CLOCK']);
  assert.deepEqual(pick(a(row({ status: 'failed', code: 'MEDIA_PLANNING_TIME_BUDGET', retryDueAt: null }))), ['unknown', 'MISSING_CLOCK']);
});

test('an old pending FIFO timestamp is not evidence of scheduler inactivity', () => {
  const idle = row({ updatedAt: iso(NOW - T.idleMs - 1) });
  const v = a(idle);
  assert.deepEqual(pick(v), ['unknown', 'MISSING_CLOCK']); assert.equal(v.candidateKey, null);
  assert.deepEqual(pick(a(row({ updatedAt: iso(NOW - T.idleMs) }))), ['unknown', 'MISSING_CLOCK']);
  assert.equal(a(idle, NOW + min(30)).candidateKey, null);
});

test('fresh claims and preserved FIFO timestamps never override the current episode clock', () => {
  const stalled = withEpisode(60, null, { status: 'processing', claimId: CLAIM, claimedAt: iso(NOW), claimStaleAfter: iso(NOW + min(5)) });
  const result = a(stalled);
  assert.deepEqual(pick(result), ['stuck', 'NO_VERIFIED_PROGRESS']);
  assert.equal(result.anchorKind, 'operation_start'); assert.equal(result.ageMs, min(60)); assert.equal(result.evidence.claimId, CLAIM);
  const fresh = withEpisode(60, 1, { updatedAt: iso(NOW - min(60)), inflightKeeps: 3 });
  assert.deepEqual(pick(a(fresh)), ['healthy', 'IN_FLIGHT_CONTINUES']);
  assert.equal(a(fresh).anchorKind, 'verified_progress');
  assert.deepEqual(pick(a({ ...fresh, status: 'processing', claimId: CLAIM, claimedAt: iso(NOW), claimStaleAfter: iso(NOW + min(5)) })), ['healthy', 'IN_PROGRESS']);
});

test('correction 5: a future retry due time is a wait, not a failure; the scheduler is called out only after its grace', () => {
  const failed = (dueAgo, code = 'MEDIA_PLANNING_TIME_BUDGET') => a(row({ status: 'failed', code, attempts: 55, updatedAt: iso(NOW - min(60)), retryDueAt: iso(NOW - dueAgo) }));
  const cooling = failed(-min(20));
  assert.deepEqual(pick(cooling), ['waiting', 'FAILED_COOLDOWN']); assert.equal(cooling.dueAt, iso(NOW + min(20))); assert.equal(cooling.candidateKey, null);
  assert.deepEqual(pick(failed(T.schedulerGraceMs)), ['waiting', 'FAILED_COOLDOWN']);
  const late = failed(T.schedulerGraceMs + 1);
  assert.deepEqual(pick(late), ['stuck', 'FAILED_NOT_RECLAIMED']); assert.equal(late.anchorKind, 'retry_due'); assert.match(late.candidateKey, /:failed-due:/);
  for (const code of ['MEDIA_TRANSPORT_LEASE_BUSY', 'MEDIA_STATUS_RPC_FAILED', 'MEDIA_SOURCE_READ_FAILED', null]) assert.equal(failed(-min(1), code).state, 'waiting', String(code));
  const human = failed(-min(20), 'MEDIA_REVIEW_REJECTED');
  assert.deepEqual(pick(human), ['blocked', 'FAILED_REQUIRES_HUMAN']); assert.match(human.candidateKey, /:failed:MEDIA_REVIEW_REJECTED:/);
});

test('correction 5: a claim older than its stale bound is a signal first, a stuck verdict only after the recovery tick', () => {
  const proc = claimedAgo => a(row({ status: 'processing', claimId: CLAIM, claimedAt: iso(NOW - claimedAgo), claimStaleAfter: iso(NOW - claimedAgo + min(5)) }));
  assert.deepEqual(pick(proc(min(2))), ['healthy', 'IN_PROGRESS']);
  assert.deepEqual(pick(proc(min(5))), ['healthy', 'IN_PROGRESS']);
  assert.deepEqual(pick(proc(min(5) + 1)), ['waiting', 'CLAIM_STALE_RECOVERY_PENDING']);
  assert.deepEqual(pick(proc(min(10))), ['waiting', 'CLAIM_STALE_RECOVERY_PENDING']);
  const stuck = proc(min(10) + 1);
  assert.deepEqual(pick(stuck), ['stuck', 'CLAIM_STALE_NOT_RECOVERED']); assert.equal(stuck.candidateKey, `media:gid://shopify/Product/1:claim:${CLAIM}`); assert.equal(stuck.anchorKind, 'claim');
});

test('review rows are blocked on a person; provider waits and in-flight continuations are waits, not failures', () => {
  const review = a(row({ status: 'review', code: 'MEDIA_REVIEW_REQUIRED' }));
  assert.deepEqual(pick(review), ['blocked', 'REVIEW_REQUIRES_HUMAN']); assert.match(review.candidateKey, /:review:MEDIA_REVIEW_REQUIRED:/);
  assert.deepEqual(pick(a(withEpisode(20, null, { code: 'MEDIA_STORAGE_OBJECT_PRESENT_UNREADABLE' }))), ['waiting', 'PROVIDER_WAIT']);
  assert.deepEqual(pick(a(withEpisode(40, null, { code: 'MEDIA_STORAGE_OBJECT_PRESENT_UNREADABLE' }))), ['stuck', 'NO_VERIFIED_PROGRESS'], 'a provider wait does not suspend the stuck clock');
  assert.deepEqual(pick(a(row({ code: 'MEDIA_STORAGE_OBJECT_NOT_READABLE_AFTER_UPLOAD' }))), ['waiting', 'PROVIDER_WAIT']);
  assert.deepEqual(pick(a(withEpisode(10, 3, { code: 'MEDIA_QUEUE_IN_FLIGHT_CONTINUES', inflightKeeps: 2 }))), ['healthy', 'IN_FLIGHT_CONTINUES']);
  assert.deepEqual(pick(a(withEpisode(20, 16, { inflightKeeps: 2 }))), ['waiting', 'SLOW_PROGRESS']);
});

test('correction 5: timestamps from the future are unknown, never age zero', () => {
  assert.deepEqual(pick(a(withEpisode(-5, null))), ['unknown', 'CLOCK_SKEW']);
  assert.deepEqual(pick(a(row({ updatedAt: iso(NOW + min(3)) }))), ['unknown', 'CLOCK_SKEW']);
  assert.deepEqual(pick(a(withEpisode(1, null))), ['healthy', 'IN_PROGRESS'], 'small skew inside the tolerance is clamped, not flagged');
  assert.equal(a(withEpisode(-1, null)).ageMs, 0);
});

test('malformed rows are unknown; the validator rejects every missing or inconsistent field', () => {
  assert.deepEqual(pick(a({ productGid: 'x' })), ['unknown', 'INVALID_ROW']);
  const ok = withEpisode(5, 2); assert.ok(lib.validLivenessRow(ok));
  const bad = [
    { productGid: 'gid://shopify/Order/1' }, { sku: 'bad sku <x>' }, { status: 'done' }, { code: 'not a code' }, { updatedAt: 'yesterday' }, { attempts: -1 }, { generation: 1.5 },
    { routine: 'yes' }, { claimId: 'bad id with spaces' }, { episode: null }, { episodeProgress: null }, { episodeProgress: { ...ok.episodeProgress, lastVerifiedSource: null } },
    { episodeProgress: { ...ok.episodeProgress, lastVerifiedAt: null } }, { episode: { ...ok.episode, status: 'done' } }, { episode: { ...ok.episode, status: 'verified' } }, { lastCompleted: { id: OP2 } }, { lastObservedAt: 5 },
  ];
  for (const patch of bad) assert.equal(lib.validLivenessRow({ ...ok, ...patch }), false, JSON.stringify(patch));
});

test('correction 6: a stale, future or partial reading never claims a healthy whole; counts add up; scope is explicit', () => {
  const rows = [withEpisode(4, null), withEpisode(40, 35, {productGid: 'gid://shopify/Product/2'}), row({ status: 'review', productGid: 'gid://shopify/Product/3' })];
  const fresh = lib.assessReading({ openTotal: 3, limit: 50, rows }, iso(NOW - min(1)), NOW);
  assert.deepEqual(fresh.counts, { healthy: 1, waiting: 0, stuck: 1, blocked: 1, unknown: 0 }); assert.equal(fresh.complete, true); assert.equal(fresh.hasMore, false); assert.equal(fresh.scope, 'open_work_queue_rows_only');
  const partial = lib.assessReading({ openTotal: 80, limit: 50, rows }, iso(NOW - min(1)), NOW);
  assert.equal(partial.hasMore, true); assert.equal(partial.complete, false); assert.equal(partial.returned, 3); assert.equal(partial.openTotal, 80);
  const stale = lib.assessReading({ openTotal: 3, limit: 50, rows }, iso(NOW - T.readingStaleMs - 1), NOW);
  assert.equal(stale.stale, true); assert.equal(stale.complete, false); assert.deepEqual(stale.counts, { healthy: 0, waiting: 0, stuck: 0, blocked: 0, unknown: 3 });
  assert.ok(stale.rows.every(r => r.rule === 'READING_STALE' && r.candidateKey === null));
  assert.equal(lib.assessReading({ openTotal: 3, limit: 50, rows }, iso(NOW + min(5)), NOW).stale, true);
  assert.equal(lib.assessReading({ openTotal: 3, limit: 50, rows }, 'not a time', NOW).stale, true);
  const exact = lib.assessReading({ openTotal: 3, limit: 50, rows }, iso(NOW - T.readingStaleMs), NOW); assert.equal(exact.stale, false);
});

test('correction 3 and 4: keys are stable across repeated reads of the same stuck operation and comparisons are only candidates', () => {
  const first = lib.assessReading({ openTotal: 1, limit: 50, rows: [withEpisode(40, 35)] }, iso(NOW), NOW);
  const second = lib.assessReading({ openTotal: 1, limit: 50, rows: [withEpisode(50, 45, { generation: 12, updatedAt: iso(NOW + min(9)) })] }, iso(NOW + min(10)), NOW + min(10));
  const keys = r => r.rows.map(x => x.candidateKey);
  assert.deepEqual(keys(first), keys(second));
  assert.deepEqual(lib.compareReadings(keys(first), second.rows), { opened: [], ongoing: keys(first), closedCandidates: [] });
  assert.deepEqual(lib.compareReadings([], second.rows), { opened: keys(first), ongoing: [], closedCandidates: [] });
  const gone = lib.assessReading({ openTotal: 0, limit: 50, rows: [] }, iso(NOW + min(20)), NOW + min(20));
  assert.deepEqual(lib.compareReadings(keys(first), gone.rows), { opened: [], ongoing: [], closedCandidates: keys(first) });
  assert.ok(!('recovered' in lib.compareReadings(keys(first), gone.rows)), 'no recovery claim exists without persisted state');
});

test('sanitizing the raw RPC result: snake_case in, validated camelCase out; any doubt blanks the whole section', () => {
  const raw = (items, extra = {}) => ({ observedAt: iso(NOW), limit: 50, openTotal: items.length, items, scope: 'open_work_queue_rows_only', ...extra });
  const item = (o = {}) => ({ product_gid: 'gid://shopify/Product/9', sku: 'ABC-9', status: 'pending', last_error: null, updated_at: iso(NOW - min(1)), attempts: 2, generation: 3,
    claim_id: null, claimed_at: null, claim_stale_after: null, inflight_keeps: 0, routine: false, retry_due_at: null,
    episode: { id: OP, status: 'running', next_step: 0, state_version: 2, created_at: iso(NOW - min(3)), updated_at: iso(NOW - min(3)) },
    episode_progress: { last_verified_at: iso(NOW - min(2)), last_verified_source: { kind: 'transport_readback', request_id: '22222222-2222-4222-8222-222222222222', step_index: 0, phase_index: 1, at: iso(NOW - min(2)) },
      verified_phases: 1, verified_steps: 0, last_activity_at: iso(NOW - min(2)), latest_attempt: { phase: 'associate', status: 'verified', created_at: iso(NOW - min(2)) } },
    last_completed: null, last_observed_at: iso(NOW - min(1)), ...o });
  const s = lib.livenessRows(raw([item(), item({ product_gid: 'gid://shopify/Product/10', sku: 'bad <sku>', last_error: 'connection refused key=secret' })]));
  assert.equal(s.rows.length, 2); assert.equal(s.rows[0].episodeProgress.lastVerifiedSource.phaseIndex, 1); assert.equal(s.rows[0].episode.stateVersion, 2);
  assert.deepEqual([s.rows[1].sku, s.rows[1].code], [null, 'MEDIA_ERROR_UNRECOGNIZED']); assert.ok(!JSON.stringify(s).includes('secret'));
  assert.ok(lib.livenessRows(raw([item()], { limit: 1, openTotal: 5 })), 'exactly the limit is fine');
  assert.equal(lib.livenessRows(raw([item(), item({ product_gid: 'gid://shopify/Product/10' })], { limit: 1 })), null, 'more items than the limit');
  assert.equal(lib.livenessRows(raw([item()], { scope: 'everything' })), null, 'an unexpected scope is not trusted');
  assert.equal(lib.livenessRows(raw([item({ episode_progress: null })])), null, 'an episode without its progress block');
  assert.equal(lib.livenessRows(raw([item({ episode_progress: { last_verified_at: iso(NOW), last_verified_source: null, verified_phases: 1, verified_steps: 0, last_activity_at: null, latest_attempt: null } })])), null, 'a verified time without its source');
  assert.equal(lib.livenessRows(raw([{}])), null); assert.equal(lib.livenessRows(null), null); assert.equal(lib.livenessRows(raw([item({ attempts: 'many' })])), null);
  assert.ok(lib.livenessRows(raw([item({ sku: null, episode: null, episode_progress: null })])));
  assert.equal(lib.livenessRows(raw([item()], {openTotal: 0})), null, 'count cannot be smaller than returned');
  for (const limit of [0, 101, -1, 1.5, '50']) assert.equal(lib.livenessRows(raw([], {limit})), null, `invalid limit ${limit}`);
  assert.equal(lib.livenessRows(raw([item(), item()])), null, 'duplicate product identity');
  for (const patch of [{episode: 'corrupted', episode_progress: 'corrupted'}, {last_completed: 'corrupted'},
    {episode_progress: {...item().episode_progress, latest_attempt: 'corrupted'}},
    {episode_progress: {...item().episode_progress, last_verified_source: 'corrupted'}},
    {episode_progress: {...item().episode_progress, last_verified_source: {...item().episode_progress.last_verified_source, step_index: -1}}},
    {episode_progress: {...item().episode_progress, last_verified_source: {...item().episode_progress.last_verified_source, at: iso(NOW - min(3))}}}]) {
    assert.equal(lib.livenessRows(raw([item(patch)])), null, JSON.stringify(patch));
  }
});

test('invalid direct readings cannot report complete or healthy', () => {
  const good = withEpisode(4, null);
  for (const section of [{openTotal: 0, limit: 50, rows: [good]}, {openTotal: 1, limit: 0, rows: [good]},
    {openTotal: 1, limit: 101, rows: [good]}, {openTotal: 2, limit: 50, rows: [good, good]},
    {openTotal: 1, limit: 50, rows: [{...good, episode: 'corrupted'}]}]) {
    const r = lib.assessReading(section, iso(NOW), NOW);
    assert.equal(r.complete, false); assert.equal(r.counts.healthy, 0); assert.equal(r.stale, true);
  }
});

test('every rule has a plain Hebrew explanation that never promises an automatic retry for human-only states', () => {
  for (const rule of ['IN_PROGRESS', 'SLOW_PROGRESS', 'NO_VERIFIED_PROGRESS', 'NOT_CLAIMED', 'PROVIDER_WAIT', 'IN_FLIGHT_CONTINUES', 'CLAIM_STALE_RECOVERY_PENDING', 'CLAIM_STALE_NOT_RECOVERED',
    'FAILED_COOLDOWN', 'FAILED_NOT_RECLAIMED', 'FAILED_REQUIRES_HUMAN', 'REVIEW_REQUIRES_HUMAN', 'MISSING_CLOCK', 'CLOCK_SKEW', 'INVALID_ROW', 'READING_STALE']) {
    const e = lib.explainLivenessRule(rule); assert.ok(e.title.length > 2 && e.detail.length > 10, rule);
  }
  assert.doesNotMatch(lib.explainLivenessRule('REVIEW_REQUIRES_HUMAN').detail, /אוטומטי/);
  assert.doesNotMatch(lib.explainLivenessRule('FAILED_REQUIRES_HUMAN').detail, /תנסה שוב/);
  assert.match(lib.explainLivenessRule('MISSING_CLOCK').detail, /לא נקבע שהמוצר תקוע/);
  assert.deepEqual(Object.keys(lib.LIVENESS_STATE_TEXT).sort(), ['blocked', 'healthy', 'stuck', 'unknown', 'waiting']);
});
