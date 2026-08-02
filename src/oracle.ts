import type { FetchResult, RunReport, RunStatus, SourceName } from './types.js';

/**
 * Minimum acceptable fetched/expected ratio, per source.
 *
 * Luma is held to 1.0 — it reports no total, so `expectedCount` is null and no
 * coverage ratio is computed at all; exhaustion of its cursor is its proof.
 *
 * Eventbrite is held to 0.95. Measured live 2026-08-02: a clean full drain
 * returns 996 unique events against a reported `object_count` of 1000 — the
 * gap is server-side `dedup: true` plus our own id dedup, so 0.996 is what a
 * healthy complete run looks like. A 1.0 floor marks every successful drain
 * degraded. Note also that `object_count` is soft: the same query reports 4413
 * at page_size 5 or 20 and 1000 at page_size 50, because the endpoint caps the
 * accessible result window at ~1000. It is a sanity check, not an exact total.
 *
 * Partiful is held to 0.50. Measured live on 2026-08-02, one page load yields 41
 * unique events against a self-reported 65 — coverage 0.63, and that is the
 * ceiling, not a shortfall, because the four pools overlap and a single load
 * cannot see the whole region. A floor at or above 0.63 would mark every healthy
 * run degraded and train the operator to ignore the alert. A much lower floor
 * would miss the failure that matters: losing a pool. Dropping `feedItems` lands
 * near 0.43 and dropping `sections[]` near 0.38, so 0.50 separates those from
 * normal feed rotation.
 */
export const COVERAGE_FLOORS: Record<SourceName, number> = {
  luma: 1,
  partiful: 0.5,
  eventbrite: 0.95,
};

/** A run losing more than this fraction vs the trailing median is degraded. */
export const VOLUME_DROP_THRESHOLD = 0.4;

export interface EvaluateOptions {
  startedAt?: string;
  finishedAt?: string;
  /** Median unique-event count for this source over the trailing window. */
  trailingMedian?: number | null;
}

export function evaluateRun(result: FetchResult, opts: EvaluateOptions = {}): RunReport {
  const now = new Date().toISOString();
  const fetchedCount = result.records.length;

  const coveragePct =
    result.expectedCount && result.expectedCount > 0
      ? fetchedCount / result.expectedCount
      : null;

  let status: RunStatus = 'ok';
  let error: string | null = null;

  if (result.termination.kind === 'error') {
    status = 'failed';
    error = result.termination.error;
  } else if (result.termination.kind !== 'exhausted') {
    // A truncated loop that returned rows is still a truncated loop.
    status = 'degraded';
  } else if (fetchedCount === 0) {
    // Zero results is always an error, never an empty city.
    status = 'degraded';
  } else if (coveragePct !== null && coveragePct < COVERAGE_FLOORS[result.source]) {
    status = 'degraded';
  } else if (
    opts.trailingMedian != null &&
    opts.trailingMedian > 0 &&
    fetchedCount < opts.trailingMedian * (1 - VOLUME_DROP_THRESHOLD)
  ) {
    status = 'degraded';
  }

  return {
    source: result.source,
    startedAt: opts.startedAt ?? now,
    finishedAt: opts.finishedAt ?? now,
    status,
    fetchedCount,
    expectedCount: result.expectedCount,
    coveragePct,
    terminationKind: result.termination.kind,
    error,
    driftSignals: result.driftSignals,
  };
}
