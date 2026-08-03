import { describe, it, expect, vi } from 'vitest';
import { runCycle } from '../src/cycle.js';
import { EMPTY_COUNTS, type CanonicalEvent, type FetchResult } from '../src/types.js';

function event(id: string): CanonicalEvent {
  return {
    source: 'luma', sourceEventId: id, sourceUrl: `https://lu.ma/${id}`,
    title: `Event ${id}`, description: null, startsAt: '2026-08-10T19:00:00.000Z',
    endsAt: null, timezone: null, venueName: null, address: null, city: 'San Francisco',
    lat: null, lng: null, isPublic: true, hosts: [], counts: EMPTY_COUNTS, raw: {},
  };
}

const good: FetchResult = {
  source: 'luma', records: [{ source: 'luma', sourceEventId: 'a', payload: {} }],
  termination: { kind: 'exhausted' }, expectedCount: null, pages: 1, driftSignals: {},
};

describe('runCycle', () => {
  it('persists events, snapshots, and a run report per source', async () => {
    const deps = {
      db: { query: vi.fn().mockResolvedValue({ rows: [{ id: 'uuid-1' }] }) } as any,
      collectors: [
        { source: 'luma' as const, fetch: async () => good, normalize: () => [event('a')] },
      ],
      persistEvents: vi.fn().mockResolvedValue({ persisted: 1, failed: 0, batchFallbacks: 0 }),
      insertRun: vi.fn().mockResolvedValue(undefined),
      medianRecentCount: vi.fn().mockResolvedValue(null),
    };

    const reports = await runCycle(deps as any);

    expect(deps.persistEvents).toHaveBeenCalledTimes(1);
    expect(deps.persistEvents.mock.calls[0]![1]).toHaveLength(1);
    expect(deps.insertRun).toHaveBeenCalledTimes(1);
    expect(reports[0]!.status).toBe('ok');
  });

  it('keeps going when one source throws, and marks only that source failed', async () => {
    const deps = {
      db: { query: vi.fn().mockResolvedValue({ rows: [{ id: 'uuid-1' }] }) } as any,
      collectors: [
        {
          source: 'luma' as const,
          fetch: async () => { throw new Error('luma down'); },
          normalize: () => [],
        },
        { source: 'partiful' as const, fetch: async () => good, normalize: () => [event('a')] },
      ],
      persistEvents: vi.fn().mockResolvedValue({ persisted: 1, failed: 0, batchFallbacks: 0 }),
      insertRun: vi.fn().mockResolvedValue(undefined),
      medianRecentCount: vi.fn().mockResolvedValue(null),
    };

    const reports = await runCycle(deps as any);

    expect(reports).toHaveLength(2);
    expect(reports[0]!.status).toBe('failed');
    expect(reports[0]!.error).toBe('luma down');
    expect(reports[1]!.status).toBe('ok');
  });
});

describe('runCycle persistence reporting', () => {
  function deps(persist: any) {
    return {
      db: { query: vi.fn().mockResolvedValue({ rows: [] }) } as any,
      collectors: [
        { source: 'luma' as const, fetch: async () => good, normalize: () => [event('a')] },
      ],
      persistEvents: vi.fn().mockResolvedValue(persist),
      insertRun: vi.fn().mockResolvedValue(undefined),
      medianRecentCount: vi.fn().mockResolvedValue(null),
    };
  }

  it('degrades the run when rows failed to persist', async () => {
    const d = deps({ persisted: 0, failed: 1, batchFallbacks: 1 });
    const [report] = await runCycle(d as any);
    expect(report!.status).toBe('degraded');
    expect(report!.driftSignals.persistFailed).toBe(1);
  });

  it('records a batch fallback without degrading when every row still landed', async () => {
    const d = deps({ persisted: 1, failed: 0, batchFallbacks: 1 });
    const [report] = await runCycle(d as any);
    expect(report!.status).toBe('ok');
    expect(report!.driftSignals.persistBatchFallbacks).toBe(1);
  });

  it('leaves driftSignals untouched on a clean write', async () => {
    const d = deps({ persisted: 1, failed: 0, batchFallbacks: 0 });
    const [report] = await runCycle(d as any);
    expect(report!.status).toBe('ok');
    expect(report!.driftSignals.persistFailed).toBeUndefined();
  });
});
