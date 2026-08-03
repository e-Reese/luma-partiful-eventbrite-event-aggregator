import { describe, it, expect } from 'vitest';
import { normalizeLuma } from '../../../src/sources/luma/normalize.js';
import type { RawRecord } from '../../../src/types.js';

const record: RawRecord = {
  source: 'luma',
  sourceEventId: 'evt-6J4GrvPZ2jtGWHD',
  payload: {
    api_id: 'evt-6J4GrvPZ2jtGWHD',
    guest_count: 42,
    ticket_count: 10,
    registration_availability: 'available',
    hosts: [{ api_id: 'usr-1', name: 'Ada', url: 'ada' }],
    event: {
      name: 'AI Innovation Studio',
      start_at: '2026-08-02T01:30:00.000Z',
      end_at: '2026-08-02T04:30:00.000Z',
      timezone: 'America/Los_Angeles',
      url: '5g7a63ns',
      geo_address_info: {
        city: 'Milpitas', region: 'California',
        address: 'California Science And Technology University',
      },
      coordinate: { latitude: 37.43, longitude: -121.9 },
    },
  },
};

describe('normalizeLuma', () => {
  it('maps a discovery entry to a CanonicalEvent', () => {
    const [event] = normalizeLuma([record]);
    expect(event).toBeDefined();
    expect(event!.source).toBe('luma');
    expect(event!.title).toBe('AI Innovation Studio');
    expect(event!.startsAt).toBe('2026-08-02T01:30:00.000Z');
    expect(event!.endsAt).toBe('2026-08-02T04:30:00.000Z');
    expect(event!.city).toBe('Milpitas');
    expect(event!.sourceUrl).toBe('https://lu.ma/5g7a63ns');
    expect(event!.counts.guestCount).toBe(42);
    expect(event!.hosts).toEqual([
      { sourceHostId: 'usr-1', displayName: 'Ada', profileUrl: 'https://lu.ma/user/ada' },
    ]);
  });

  it('leaves description null — the discovery payload has no description field', () => {
    const [event] = normalizeLuma([record]);
    expect(event!.description).toBeNull();
  });

  it('skips records missing a title or start time rather than emitting a broken row', () => {
    const broken: RawRecord = {
      source: 'luma', sourceEventId: 'x', payload: { event: { name: null } },
    };
    expect(normalizeLuma([broken])).toEqual([]);
  });
});
