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
  upsertEvent(db: CycleDeps['db'], event: CanonicalEvent): Promise<string>;
  insertSnapshot(db: CycleDeps['db'], eventId: string, event: CanonicalEvent): Promise<void>;
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

    for (const event of events) {
      try {
        const eventId = await deps.upsertEvent(deps.db, event);
        await deps.insertSnapshot(deps.db, eventId, event);
      } catch {
        // A single bad row must not abort the cycle; coverage reporting will
        // surface a systemic problem via fetched vs persisted divergence.
      }
    }

    const trailingMedian = await deps.medianRecentCount(deps.db, collector.source, 7);
    const report = evaluateRun(result, {
      startedAt,
      finishedAt: new Date().toISOString(),
      trailingMedian,
    });

    await deps.insertRun(deps.db, report);
    reports.push(report);
  }

  return reports;
}
