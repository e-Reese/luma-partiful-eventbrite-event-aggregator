import { describe, it, expect } from 'vitest';
import { COVERAGE_FLOORS, evaluateRun, VOLUME_DROP_THRESHOLD } from '../src/oracle.js';
import type { FetchResult } from '../src/types.js';

function result(over: Partial<FetchResult> = {}): FetchResult {
  return {
    source: 'luma',
    records: Array.from({ length: 779 }, (_, i) => ({
      source: 'luma' as const, sourceEventId: `e${i}`, payload: {},
    })),
    termination: { kind: 'exhausted' },
    expectedCount: null,
    pages: 17,
    driftSignals: {},
    ...over,
  };
}

describe('evaluateRun', () => {
  it('marks a cleanly exhausted run ok', () => {
    expect(evaluateRun(result()).status).toBe('ok');
  });

  it('marks a stuck cursor degraded even though rows were returned', () => {
    const report = evaluateRun(result({ termination: { kind: 'cursor_stuck' } }));
    expect(report.status).toBe('degraded');
    expect(report.terminationKind).toBe('cursor_stuck');
  });

  it('marks a page_cap termination degraded', () => {
    expect(evaluateRun(result({ termination: { kind: 'page_cap' } })).status).toBe('degraded');
  });

  it('marks an error termination failed', () => {
    const report = evaluateRun(result({
      termination: { kind: 'error', error: 'network down' }, records: [],
    }));
    expect(report.status).toBe('failed');
    expect(report.error).toBe('network down');
  });

  it('treats zero records as an error, never as an empty city', () => {
    expect(evaluateRun(result({ records: [] })).status).toBe('degraded');
  });

  it('computes coverage against a source-reported expected count', () => {
    const report = evaluateRun(result({
      source: 'partiful',
      records: Array.from({ length: 52 }, (_, i) => ({
        source: 'partiful' as const, sourceEventId: `p${i}`, payload: {},
      })),
      expectedCount: 67,
    }));
    expect(report.coveragePct).toBeCloseTo(0.7761, 3);
    expect(report.status).toBe('ok');
  });

  it('accepts Partiful real-world coverage — 41 of 65 measured live is healthy, not degraded', () => {
    const report = evaluateRun(result({
      source: 'partiful',
      records: Array.from({ length: 41 }, (_, i) => ({
        source: 'partiful' as const, sourceEventId: `p${i}`, payload: {},
      })),
      expectedCount: 65,
    }));
    expect(report.coveragePct).toBeCloseTo(0.6308, 3);
    expect(report.status).toBe('ok');
  });

  it('degrades when a Partiful pool disappears — losing feedItems lands near 0.43', () => {
    const report = evaluateRun(result({
      source: 'partiful',
      records: Array.from({ length: 28 }, (_, i) => ({
        source: 'partiful' as const, sourceEventId: `p${i}`, payload: {},
      })),
      expectedCount: 65,
    }));
    expect(report.status).toBe('degraded');
  });

  it('degrades when coverage falls below the source floor', () => {
    const report = evaluateRun(result({
      source: 'partiful',
      records: Array.from({ length: 10 }, (_, i) => ({
        source: 'partiful' as const, sourceEventId: `p${i}`, payload: {},
      })),
      expectedCount: 67,
    }));
    expect(report.status).toBe('degraded');
  });

  it('degrades on a large volume drop against the trailing median', () => {
    const report = evaluateRun(
      result({ records: [{ source: 'luma', sourceEventId: 'e1', payload: {} }] }),
      { trailingMedian: 779 },
    );
    expect(report.status).toBe('degraded');
  });

  it('accepts an Eventbrite full drain — 996 of a reported 1000 is complete, not degraded', () => {
    const report = evaluateRun(result({
      source: 'eventbrite',
      records: Array.from({ length: 996 }, (_, i) => ({
        source: 'eventbrite' as const, sourceEventId: `e${i}`, payload: {},
      })),
      expectedCount: 1000,
    }));
    expect(report.coveragePct).toBeCloseTo(0.996, 3);
    expect(report.status).toBe('ok');
  });

  it('degrades an Eventbrite run that stops well short of the reported total', () => {
    const report = evaluateRun(result({
      source: 'eventbrite',
      records: Array.from({ length: 500 }, (_, i) => ({
        source: 'eventbrite' as const, sourceEventId: `e${i}`, payload: {},
      })),
      expectedCount: 1000,
    }));
    expect(report.status).toBe('degraded');
  });

  it('exposes the configured floors', () => {
    expect(COVERAGE_FLOORS.partiful).toBe(0.5);
    expect(COVERAGE_FLOORS.luma).toBe(1);
    expect(COVERAGE_FLOORS.eventbrite).toBe(0.95);
    expect(VOLUME_DROP_THRESHOLD).toBe(0.4);
  });
});
