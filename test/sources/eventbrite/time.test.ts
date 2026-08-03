import { describe, it, expect } from 'vitest';
import { zonedToUtcIso } from '../../../src/sources/eventbrite/time.js';

describe('zonedToUtcIso', () => {
  it('treats the clock time as local to the given zone, not as UTC', () => {
    // 2pm in Los Angeles during PDT (UTC-7) is 21:00 UTC.
    expect(zonedToUtcIso('2026-10-18', '14:00', 'America/Los_Angeles'))
      .toBe('2026-10-18T21:00:00.000Z');
  });

  it('regression: a 9am event must not land at 2am', () => {
    // The bug stamped wall time with Z, so 09:00 became 09:00Z and rendered as
    // 02:00 PDT — which is how the listing filled with 2am workshops.
    const iso = zonedToUtcIso('2026-08-03', '09:00', 'America/Los_Angeles')!;
    const shown = new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: true,
    });
    expect(shown).toBe('9 AM');
  });

  it('handles standard time, where the offset is an hour larger', () => {
    // January is PST (UTC-8).
    expect(zonedToUtcIso('2027-01-15', '14:00', 'America/Los_Angeles'))
      .toBe('2027-01-15T22:00:00.000Z');
  });

  it('resolves a time inside the spring-forward transition', () => {
    // 2027-03-14 02:30 PT does not exist; the refinement pass must still
    // produce a valid instant rather than NaN.
    const iso = zonedToUtcIso('2027-03-14', '02:30', 'America/Los_Angeles');
    expect(iso).not.toBeNull();
    expect(Number.isNaN(Date.parse(iso!))).toBe(false);
  });

  it('honours a non-Pacific zone', () => {
    expect(zonedToUtcIso('2026-10-18', '14:00', 'America/New_York'))
      .toBe('2026-10-18T18:00:00.000Z');
  });

  it('defaults a missing time to local midnight', () => {
    expect(zonedToUtcIso('2026-10-18', null, 'America/Los_Angeles'))
      .toBe('2026-10-18T07:00:00.000Z');
  });

  it('falls back to UTC when no zone is supplied', () => {
    expect(zonedToUtcIso('2026-10-18', '14:00', null))
      .toBe('2026-10-18T14:00:00.000Z');
  });

  it('returns null for an unusable date rather than a broken timestamp', () => {
    expect(zonedToUtcIso(null, '14:00', 'America/Los_Angeles')).toBeNull();
    expect(zonedToUtcIso('not-a-date', '14:00', 'America/Los_Angeles')).toBeNull();
    expect(zonedToUtcIso('2026-10-18', '99:99', 'America/Los_Angeles')).toBeNull();
  });

  it('survives an unknown zone identifier', () => {
    expect(zonedToUtcIso('2026-10-18', '14:00', 'Mars/Olympus_Mons'))
      .toBe('2026-10-18T14:00:00.000Z');
  });
});
