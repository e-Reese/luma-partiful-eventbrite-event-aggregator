import { describe, it, expect } from 'vitest';
import { dedupeWithinSource } from '../../src/dedupe/within-source.js';
import { EMPTY_COUNTS, type CanonicalEvent } from '../../src/types.js';

function ev(id: string, title = 'Party'): CanonicalEvent {
  return {
    source: 'partiful', sourceEventId: id, sourceUrl: `https://partiful.com/e/${id}`,
    title, description: null, startsAt: '2026-09-05T16:00:00.000Z', endsAt: null,
    timezone: null, venueName: null, address: null, city: null, lat: null, lng: null,
    isPublic: true, hosts: [], counts: EMPTY_COUNTS, raw: {},
  };
}

describe('dedupeWithinSource', () => {
  it('keeps one row per sourceEventId', () => {
    const result = dedupeWithinSource([ev('a'), ev('b'), ev('a')]);
    expect(result.map((e) => e.sourceEventId)).toEqual(['a', 'b']);
  });

  it('keeps the last occurrence, which carries the freshest counts', () => {
    const stale = ev('a', 'Old title');
    const fresh = ev('a', 'New title');
    expect(dedupeWithinSource([stale, fresh])[0]!.title).toBe('New title');
  });

  it('returns an empty array unchanged', () => {
    expect(dedupeWithinSource([])).toEqual([]);
  });
});
