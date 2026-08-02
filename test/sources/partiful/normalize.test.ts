import { describe, it, expect } from 'vitest';
import { normalizePartiful } from '../../../src/sources/partiful/normalize.js';
import type { RawRecord } from '../../../src/types.js';

const record: RawRecord = {
  source: 'partiful',
  sourceEventId: 'muz6tv150fmIFm9wcdte',
  payload: {
    id: 'item-1',
    tags: [{ id: 'COMMUNITY', label: 'Community' }],
    event: {
      id: 'muz6tv150fmIFm9wcdte',
      title: 'Run for Mutts',
      description: 'Join us for a community run/walk',
      startDate: '2026-09-05T16:00:00.000Z',
      endDate: null,
      timezone: 'America/Los_Angeles',
      ownerIds: ['KARWuleKo9czrJaphLHFV5RBTCf2'],
      interestedGuestCount: 163,
      goingGuestCount: 65,
      approvedGuestCount: 0,
      maybeGuestCount: 25,
      waitlistGuestCount: 0,
      isPublic: true,
      status: 'PUBLISHED',
      locationInfo: {
        type: 'structured',
        mapsInfo: { name: 'Crosstown Trail', addressLines: ['San Francisco, CA'] },
      },
    },
  },
};

describe('normalizePartiful', () => {
  it('maps an explore item to a CanonicalEvent', () => {
    const [event] = normalizePartiful([record]);
    expect(event!.title).toBe('Run for Mutts');
    expect(event!.description).toBe('Join us for a community run/walk');
    expect(event!.startsAt).toBe('2026-09-05T16:00:00.000Z');
    expect(event!.endsAt).toBeNull();
    expect(event!.venueName).toBe('Crosstown Trail');
    expect(event!.address).toBe('San Francisco, CA');
    expect(event!.sourceUrl).toBe('https://partiful.com/e/muz6tv150fmIFm9wcdte');
  });

  it('maps all five guest counters', () => {
    const [event] = normalizePartiful([record]);
    expect(event!.counts.interested).toBe(163);
    expect(event!.counts.going).toBe(65);
    expect(event!.counts.approved).toBe(0);
    expect(event!.counts.maybe).toBe(25);
    expect(event!.counts.waitlist).toBe(0);
  });

  it('maps ownerIds to hosts', () => {
    const [event] = normalizePartiful([record]);
    expect(event!.hosts).toEqual([
      { sourceHostId: 'KARWuleKo9czrJaphLHFV5RBTCf2', displayName: null, profileUrl: null },
    ]);
  });

  it('skips events that are not PUBLISHED', () => {
    const draft = structuredClone(record) as RawRecord;
    (draft.payload as any).event.status = 'DRAFT';
    expect(normalizePartiful([draft])).toEqual([]);
  });
});
