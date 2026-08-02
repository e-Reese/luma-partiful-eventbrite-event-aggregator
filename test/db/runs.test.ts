import { describe, it, expect, vi } from 'vitest';
import { insertRun, medianRecentCount } from '../../src/db/runs.js';
import type { RunReport } from '../../src/types.js';

const report: RunReport = {
  source: 'luma',
  startedAt: '2026-08-02T00:00:00.000Z',
  finishedAt: '2026-08-02T00:01:00.000Z',
  status: 'ok',
  fetchedCount: 779,
  expectedCount: null,
  coveragePct: null,
  terminationKind: 'exhausted',
  error: null,
  driftSignals: { buildId: 'abc' },
};

describe('insertRun', () => {
  it('writes every field of the report', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    await insertRun({ query } as any, report);

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain('insert into runs');
    expect(params).toEqual([
      'luma', report.startedAt, report.finishedAt, 'ok',
      779, null, null, 'exhausted', null, JSON.stringify({ buildId: 'abc' }),
    ]);
  });
});

describe('medianRecentCount', () => {
  it('returns the median fetched_count for the source', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ median: '779' }] });
    await expect(medianRecentCount({ query } as any, 'luma', 7)).resolves.toBe(779);
  });

  it('returns null when there is no history yet', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ median: null }] });
    await expect(medianRecentCount({ query } as any, 'luma', 7)).resolves.toBeNull();
  });
});
