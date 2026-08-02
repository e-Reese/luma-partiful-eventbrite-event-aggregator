import type { RunReport, SourceName } from '../types.js';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export async function insertRun(db: Queryable, report: RunReport): Promise<void> {
  await db.query(
    `insert into runs
       (source, started_at, finished_at, status, fetched_count,
        expected_count, coverage_pct, termination_kind, error, drift_signals)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      report.source,
      report.startedAt,
      report.finishedAt,
      report.status,
      report.fetchedCount,
      report.expectedCount,
      report.coveragePct,
      report.terminationKind,
      report.error,
      JSON.stringify(report.driftSignals),
    ],
  );
}

/** Median fetched_count for a source over the trailing N days, or null. */
export async function medianRecentCount(
  db: Queryable,
  source: SourceName,
  days: number,
): Promise<number | null> {
  const { rows } = await db.query(
    `select percentile_cont(0.5) within group (order by fetched_count) as median
       from runs
      where source = $1
        and status = 'ok'
        and started_at > now() - ($2 || ' days')::interval`,
    [source, String(days)],
  );
  const median = rows[0]?.median;
  return median == null ? null : Number(median);
}
