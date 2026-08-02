import { describe, it, expect } from 'vitest';
import { classifyPair, normalizeTitle, titleSimilarity } from '../../src/dedupe/cross-source.js';
import { EMPTY_COUNTS, type CanonicalEvent, type SourceName } from '../../src/types.js';

function ev(over: Partial<CanonicalEvent> & { source: SourceName }): CanonicalEvent {
  return {
    sourceEventId: 'x', sourceUrl: 'https://example.com',
    title: 'Rooftop Sunset Party', description: null,
    startsAt: '2026-08-10T19:00:00.000Z', endsAt: null, timezone: null,
    venueName: null, address: null, city: 'San Francisco',
    lat: 37.7749, lng: -122.4194, isPublic: true, hosts: [],
    counts: EMPTY_COUNTS, raw: {}, ...over,
  };
}

describe('normalizeTitle', () => {
  it('lowercases, strips emoji and punctuation, and collapses whitespace', () => {
    expect(normalizeTitle('  ✰ Rooftop  SUNSET Party! ✰ ')).toBe('rooftop sunset party');
  });
});

describe('titleSimilarity', () => {
  it('scores identical titles as 1', () => {
    expect(titleSimilarity('Rooftop Party', 'rooftop party')).toBe(1);
  });

  it('scores unrelated titles low', () => {
    expect(titleSimilarity('Rooftop Party', 'Chess Tournament')).toBeLessThan(0.4);
  });
});

describe('classifyPair', () => {
  it('matches identical title and start time within the window', () => {
    const a = ev({ source: 'luma' });
    const b = ev({ source: 'partiful', startsAt: '2026-08-10T19:20:00.000Z' });
    expect(classifyPair(a, b)).toBe('same');
  });

  it('matches on high title similarity plus time and geo proximity', () => {
    const a = ev({ source: 'luma', title: 'Rooftop Sunset Party' });
    const b = ev({ source: 'partiful', title: 'Rooftop Sunset Party 2026', lat: 37.7752, lng: -122.4190 });
    expect(classifyPair(a, b)).toBe('same');
  });

  it('rejects the same title on a different day', () => {
    const a = ev({ source: 'luma' });
    const b = ev({ source: 'partiful', startsAt: '2026-08-14T19:00:00.000Z' });
    expect(classifyPair(a, b)).toBe('different');
  });

  it('flags matching time and geo with unrelated titles as ambiguous, never same', () => {
    const a = ev({ source: 'luma', title: 'Rooftop Sunset Party' });
    const b = ev({ source: 'partiful', title: 'Chess Tournament Night' });
    expect(classifyPair(a, b)).toBe('ambiguous');
  });

  it('never merges two events from the same source', () => {
    const a = ev({ source: 'luma', sourceEventId: 'a' });
    const b = ev({ source: 'luma', sourceEventId: 'b' });
    expect(classifyPair(a, b)).toBe('different');
  });
});
