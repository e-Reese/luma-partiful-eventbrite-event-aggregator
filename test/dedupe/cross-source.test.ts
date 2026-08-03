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
    // 'Rooftop Sunset Party SF' scores 0.875 against the base title.
    const a = ev({ source: 'luma', title: 'Rooftop Sunset Party' });
    const b = ev({ source: 'partiful', title: 'Rooftop Sunset Party SF', lat: 37.7752, lng: -122.4190 });
    expect(classifyPair(a, b)).toBe('same');
  });

  // Trigram Jaccard is length-sensitive: the same ' 2026' suffix scores 0.808 on a
  // 20-char title but 0.891 on a 40-char one. Short titles therefore need a near-exact
  // match to merge. That is the intended conservative behaviour, and this test pins it
  // so the threshold is not quietly lowered later to make a short-title pair merge.
  it('leaves a short title with a year suffix ambiguous rather than merging it', () => {
    const a = ev({ source: 'luma', title: 'Rooftop Sunset Party' });
    const b = ev({ source: 'partiful', title: 'Rooftop Sunset Party 2026', lat: 37.7752, lng: -122.4190 });
    expect(titleSimilarity(a.title, b.title)).toBeCloseTo(0.8077, 3);
    expect(classifyPair(a, b)).toBe('ambiguous');
  });

  it('merges the same suffix on a long title, where similarity survives', () => {
    const long = 'Annual Chinatown Night Market Photo Walk';
    const a = ev({ source: 'luma', title: long });
    const b = ev({ source: 'partiful', title: `${long} 2026`, lat: 37.7752, lng: -122.4190 });
    expect(titleSimilarity(a.title, b.title)).toBeGreaterThanOrEqual(0.85);
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
