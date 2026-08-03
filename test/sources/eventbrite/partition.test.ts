import { describe, it, expect, vi } from 'vitest';
import {
  daysBetween, fetchEventbritePartitioned, isoDay, splitWindow,
} from '../../../src/sources/eventbrite/partition.js';

describe('splitWindow', () => {
  it('halves a range without overlapping or dropping a day', () => {
    const [a, b] = splitWindow({ from: '2026-08-01', to: '2026-08-10' });
    expect(a).toEqual({ from: '2026-08-01', to: '2026-08-05' });
    expect(b).toEqual({ from: '2026-08-06', to: '2026-08-10' });
    expect(daysBetween(a) + daysBetween(b)).toBe(10);
  });

  it('splits a two-day window into two single days', () => {
    const [a, b] = splitWindow({ from: '2026-08-01', to: '2026-08-02' });
    expect(a).toEqual({ from: '2026-08-01', to: '2026-08-01' });
    expect(b).toEqual({ from: '2026-08-02', to: '2026-08-02' });
  });
});

describe('daysBetween', () => {
  it('counts inclusively', () => {
    expect(daysBetween({ from: '2026-08-01', to: '2026-08-01' })).toBe(1);
    expect(daysBetween({ from: '2026-08-01', to: '2026-08-07' })).toBe(7);
  });
});

/**
 * Builds a mock API whose event density varies by date, so the partitioner has
 * to actually adapt rather than split a uniform range.
 */
function mockApi(densityPerDay: (day: string) => number) {
  return vi.fn().mockImplementation(async (_url: string, body: any) => {
    const search = body.event_search;
    const range = search.date_range;
    const pageSize = search.page_size;

    let count: number;
    if (!range) {
      count = 4382; // unbounded probe: the true total
    } else {
      count = 0;
      const from = Date.parse(range.from);
      const to = Date.parse(range.to);
      for (let t = from; t <= to; t += 86_400_000) {
        count += densityPerDay(new Date(t).toISOString().slice(0, 10));
      }
    }

    const accessible = Math.min(count, 950);
    const pageCount = Math.max(1, Math.ceil(accessible / pageSize));
    const page = search.page;
    const start = (page - 1) * pageSize;
    const n = Math.max(0, Math.min(pageSize, accessible - start));
    const key = range ? `${range.from}` : 'all';

    return {
      events: {
        results: Array.from({ length: n }, (_, i) => ({ id: `${key}-${start + i}` })),
        pagination: { object_count: count, page_count: pageCount },
      },
    };
  });
}

describe('fetchEventbritePartitioned', () => {
  const today = new Date('2026-08-01T00:00:00.000Z');

  it('drains without splitting when the whole horizon fits under the limit', async () => {
    const post = mockApi(() => 1); // ~30 events over a 30-day horizon
    const seen: string[] = [];

    const result = await fetchEventbritePartitioned({
      placeId: '859', csrfToken: 't', post, today, horizonDays: 29, delayMs: 0,
      onWindow: (w, _c, action) => seen.push(`${action} ${w.from}..${w.to}`),
    });

    expect(seen).toEqual(['drain 2026-08-01..2026-08-30']);
    expect(result.termination).toEqual({ kind: 'exhausted' });
    expect(result.driftSignals.drainedWindows).toBe(1);
  });

  it('splits a dense range until every window fits', async () => {
    const post = mockApi(() => 100); // 100/day: a 30-day horizon holds 3000
    const actions: string[] = [];

    const result = await fetchEventbritePartitioned({
      placeId: '859', csrfToken: 't', post, today, horizonDays: 29, delayMs: 0,
      onWindow: (w, c, action) => actions.push(`${action}:${daysBetween(w)}d:${c}`),
    });

    expect(actions.filter((a) => a.startsWith('split')).length).toBeGreaterThan(0);
    // Every drained window must be under the limit.
    for (const a of actions.filter((x) => x.startsWith('drain'))) {
      expect(Number(a.split(':')[2])).toBeLessThanOrEqual(900);
    }
    expect(result.termination).toEqual({ kind: 'exhausted' });
  });

  it('reports no expectedCount, because neither available total is a valid denominator', async () => {
    const post = mockApi(() => 5);
    const result = await fetchEventbritePartitioned({
      placeId: '859', csrfToken: 't', post, today, horizonDays: 29, delayMs: 0,
    });
    // Live: the unbounded probe said 4382 while partitioning surfaced 12013, so
    // a ratio against it would read 274%. Exhaustion is the proof instead.
    expect(result.expectedCount).toBeNull();
    expect(result.driftSignals.unboundedCount).toBe(4382);
    expect(result.driftSignals.windowCountSum).toBeGreaterThan(0);
    expect(result.driftSignals.uniqueFetched).toBe(result.records.length);
  });

  it('adapts window width to density rather than splitting uniformly', async () => {
    // August is dense, later months are empty.
    const post = mockApi((day) => (day.startsWith('2026-08') ? 200 : 0));
    const drained: number[] = [];

    await fetchEventbritePartitioned({
      placeId: '859', csrfToken: 't', post, today, horizonDays: 89, delayMs: 0,
      onWindow: (w, _c, action) => { if (action === 'drain') drained.push(daysBetween(w)); },
    });

    // The sparse tail should be drained in wider windows than the dense head.
    expect(Math.max(...drained)).toBeGreaterThan(Math.min(...drained));
  });

  it('marks page_cap when a single day still exceeds the limit', async () => {
    // One day holds 5000 events; it cannot be split any further.
    const post = mockApi((day) => (day === '2026-08-01' ? 5000 : 0));

    const result = await fetchEventbritePartitioned({
      placeId: '859', csrfToken: 't', post, today, horizonDays: 1, delayMs: 0,
    });

    expect(result.termination).toEqual({ kind: 'page_cap' });
    expect(result.driftSignals.truncatedWindows).toBeGreaterThan(0);
  });

  it('returns an error termination but keeps what it already collected', async () => {
    // Call 1 is the unbounded probe and succeeds; the first window request throws.
    let calls = 0;
    const post = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls > 1) throw new Error('HTTP 429');
      return {
        events: {
          results: [{ id: `e${calls}` }],
          pagination: { object_count: 10, page_count: 1 },
        },
      };
    });

    const result = await fetchEventbritePartitioned({
      placeId: '859', csrfToken: 't', post, today, horizonDays: 10, delayMs: 0,
    });

    expect(result.termination).toEqual({ kind: 'error', error: 'HTTP 429' });
    expect(result.records.length).toBeGreaterThan(0);
  });

  it('deduplicates events appearing in more than one window', async () => {
    const post = vi.fn().mockImplementation(async () => ({
      events: {
        results: [{ id: 'same-event' }],
        pagination: { object_count: 1, page_count: 1 },
      },
    }));

    const result = await fetchEventbritePartitioned({
      placeId: '859', csrfToken: 't', post, today, horizonDays: 5, delayMs: 0,
    });

    expect(result.records).toHaveLength(1);
  });
});

describe('isoDay', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(isoDay(new Date('2026-08-02T23:59:59.000Z'))).toBe('2026-08-02');
  });
});
