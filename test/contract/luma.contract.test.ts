import { describe, it, expect } from 'vitest';
import { fetchLuma } from '../../src/sources/luma/fetch.js';
import { normalizeLuma } from '../../src/sources/luma/normalize.js';
import { httpGetJson } from '../../src/http.js';

describe('Luma live contract', () => {
  it('drains SF cleanly and returns a realistic corpus', async () => {
    const result = await fetchLuma({
      latitude: 37.7749, longitude: -122.4194, get: httpGetJson,
    });

    // Exhaustion is the only acceptable termination.
    expect(result.termination).toEqual({ kind: 'exhausted' });

    // Observed 779 on 2026-08-02. A collapse toward ~45 means the pagination
    // parameter regressed from pagination_cursor back to cursor.
    expect(result.records.length).toBeGreaterThan(300);
    expect(result.pages).toBeGreaterThan(5);
  }, 300_000);

  it('still exposes every field the normalizer depends on', async () => {
    const result = await fetchLuma({
      latitude: 37.7749, longitude: -122.4194, maxPages: 1, get: httpGetJson,
    });
    const events = normalizeLuma(result.records);

    expect(events.length).toBeGreaterThan(0);
    const event = events[0]!;
    expect(typeof event.title).toBe('string');
    expect(Number.isNaN(Date.parse(event.startsAt))).toBe(false);
    expect(event.sourceUrl).toMatch(/^https:\/\/lu\.ma\//);
  }, 60_000);
});
