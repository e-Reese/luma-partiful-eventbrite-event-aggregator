import { evaluateRun } from './oracle.js';
import { dedupeWithinSource } from './dedupe/within-source.js';
import type { CanonicalEvent, FetchResult, RawRecord, RunReport, SourceName } from './types.js';

export interface Collector {
  source: SourceName;
  fetch(): Promise<FetchResult>;
  normalize(records: RawRecord[]): CanonicalEvent[];
}

export interface CycleDeps {
  db: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };
  collectors: Collector[];
  /**
   * Writes a source's events. Batched internally with a per-row fallback, so a
   * single malformed row still cannot abort the cycle. Returns counts rather
   * than throwing — a persistence problem shows up as a `persisted` shortfall
   * against `fetchedCount` in the run report, not as a lost cycle.
   */
  persistEvents(
    db: CycleDeps['db'], events: CanonicalEvent[],
  ): Promise<{ persisted: number; failed: number; batchFallbacks: number }>;
  insertRun(db: CycleDeps['db'], report: RunReport): Promise<void>;
  medianRecentCount(
    db: CycleDeps['db'], source: SourceName, days: number,
  ): Promise<number | null>;
}

/**
 * Runs one full collection cycle. Sources are independent: one failing must
 * never prevent the others from collecting or from writing their run reports.
 */
export async function runCycle(deps: CycleDeps): Promise<RunReport[]> {
  const reports: RunReport[] = [];

  for (const collector of deps.collectors) {
    const startedAt = new Date().toISOString();
    let result: FetchResult;

    try {
      result = await collector.fetch();
    } catch (err) {
      result = {
        source: collector.source,
        records: [],
        termination: { kind: 'error', error: err instanceof Error ? err.message : String(err) },
        expectedCount: null,
        pages: 0,
        driftSignals: {},
      };
    }

    const events = dedupeWithinSource(collector.normalize(result.records));

    const write = await deps.persistEvents(deps.db, events);

    const trailingMedian = await deps.medianRecentCount(deps.db, collector.source, 7);
    const report = evaluateRun(result, {
      startedAt,
      finishedAt: new Date().toISOString(),
      trailingMedian,
    });

    // Persistence problems are recorded, never swallowed: a batch that fell back
    // row-by-row, or rows that failed outright, are visible in the run report.
    if (write.failed > 0 || write.batchFallbacks > 0) {
      report.driftSignals = {
        ...report.driftSignals,
        persistFailed: write.failed,
        persistBatchFallbacks: write.batchFallbacks,
      };
      if (write.failed > 0) report.status = 'degraded';
    }

    await deps.insertRun(deps.db, report);
    reports.push(report);
  }

  return reports;
}
