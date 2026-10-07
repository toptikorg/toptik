const LANE_STATES = {
  copy_inbox: { complete: ['processed'], pending: ['pending', 'processing'], review: ['review', 'failed'] },
  copy_outbox: { complete: ['synced'], pending: ['pending', 'processing'], review: ['review', 'failed'] },
  media: { complete: ['done'], pending: ['pending', 'processing'], review: ['review', 'failed'] },
  specifications: { complete: ['complete'], pending: ['pending', 'processing'], review: ['review', 'failed'] },
  commerce: { complete: ['confirmed'], pending: ['pending'], review: ['review'] },
  media_operations: { complete: ['verified'], pending: ['reserved', 'running', 'uncertain'], review: ['conflict'] },
} as const;
type Runtime = { copy: boolean; media: boolean; specifications: boolean };
type StatusData = { observedAt: string; queues: { lane: keyof typeof LANE_STATES; status: string; count: number }[];
  coverage: { approvedProducts: number; missingCopyBaseline: number; missingMediaBaseline: number; missingMediaQueue: number; missingSpecBaseline: number; missingSpecQueue: number } };
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

/** Queue completion is not a live catalog/image verification. Fail closed when
 * either lane is unavailable, malformed, unbootstrapped, open, or held. */
export function evaluateCombinedSyncStatus(input: unknown, runtime: Runtime) {
  const data = object(input), coverage = object(data?.coverage), seen = new Set<string>();
  const unknown = () => ({ status: 'unknown' as const, queuesClear: false, liveVerified: false, scope: 'approved_catalog_queues' as const });
  if (!data || typeof data.observedAt !== 'string' || !Number.isFinite(Date.parse(data.observedAt)) || !Array.isArray(data.queues) || !coverage ||
      !['approvedProducts', 'missingCopyBaseline', 'missingMediaBaseline', 'missingMediaQueue', 'missingSpecBaseline', 'missingSpecQueue'].every(k => count(coverage[k]))) return unknown();
  let pending = false, review = false;
  for (const value of data.queues) {
    const row = object(value);
    if (!row || typeof row.lane !== 'string' || !Object.hasOwn(LANE_STATES, row.lane) || typeof row.status !== 'string' || !count(row.count)) return unknown();
    const lane = LANE_STATES[row.lane as keyof typeof LANE_STATES];
    if (![...lane.complete, ...lane.pending, ...lane.review].some(s => s === row.status) || seen.has(`${row.lane}:${row.status}`)) return unknown();
    seen.add(`${row.lane}:${row.status}`);
    if (row.count && lane.pending.some(s => s === row.status)) pending = true;
    if (row.count && lane.review.some(s => s === row.status)) review = true;
  }
  const state = data as unknown as StatusData;
  const incomplete = !state.coverage.approvedProducts || state.coverage.missingCopyBaseline > 0 ||
    state.coverage.missingMediaBaseline > 0 || state.coverage.missingMediaQueue > 0 ||
    state.coverage.missingSpecBaseline > 0 || state.coverage.missingSpecQueue > 0;
  const status = !runtime.copy || !runtime.media || !runtime.specifications ? 'disabled' : review ? 'review' : incomplete ? 'incomplete' : pending ? 'pending' : 'queues_clear';
  return { status, queuesClear: status === 'queues_clear', liveVerified: false, scope: 'approved_catalog_queues' as const,
    observedAt: state.observedAt, runtimeEnabled: runtime, coverage: state.coverage, queues: state.queues };
}
