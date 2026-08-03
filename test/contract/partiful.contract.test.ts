import { describe, it, expect } from 'vitest';
import { fetchPartiful } from '../../src/sources/partiful/fetch.js';
import { normalizePartiful } from '../../src/sources/partiful/normalize.js';
import { httpGetJson, httpGetText } from '../../src/http.js';

describe('Partiful live contract', () => {
  it('resolves a buildId and returns the SF region payload', async () => {
    const result = await fetchPartiful({
      region: 'sf', getText: httpGetText, getJson: httpGetJson,
    });

    expect(result.termination).toEqual({ kind: 'exhausted' });
    expect(typeof result.driftSignals.buildId).toBe('string');

    // regionEventCounts is the coverage oracle; losing it blinds the pipeline.
    expect(result.expectedCount).toBeGreaterThan(0);
    expect(result.records.length).toBeGreaterThan(20);
  }, 60_000);

  it('still exposes the fields the normalizer depends on', async () => {
    const result = await fetchPartiful({
      region: 'sf', getText: httpGetText, getJson: httpGetJson,
    });
    const events = normalizePartiful(result.records);

    expect(events.length).toBeGreaterThan(0);
    const event = events[0]!;
    expect(typeof event.title).toBe('string');
    expect(Number.isNaN(Date.parse(event.startsAt))).toBe(false);
    expect(event.sourceUrl).toMatch(/^https:\/\/partiful\.com\/e\//);
  }, 60_000);
});
