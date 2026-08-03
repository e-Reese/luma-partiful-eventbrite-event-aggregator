import { describe, it, expect, vi } from 'vitest';
import { fetchEventbrite } from '../../../src/sources/eventbrite/fetch.js';
import { normalizeEventbrite } from '../../../src/sources/eventbrite/normalize.js';
import type { RawRecord } from '../../../src/types.js';

function searchPage(ids: string[], total: number) {
  return {
    events: {
      results: ids.map((id) => ({
        id, name: `Event ${id}`, url: `https://www.eventbrite.com/e/${id}`,
        start_date: '2026-08-10', start_time: '19:00',
        primary_venue: { name: 'The Venue', address: { localized_address_display: 'SF, CA' } },
      })),
      pagination: { object_count: total, page_number: 1, page_size: 2 },
    },
  };
}

describe('fetchEventbrite', () => {
  it('pages until the reported total is reached and reports exhausted', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce(searchPage(['a', 'b'], 3))
      .mockResolvedValueOnce(searchPage(['c'], 3));

    const result = await fetchEventbrite({ placeId: '859', csrfToken: 'tok', post });

    expect(result.records.map((r) => r.sourceEventId)).toEqual(['a', 'b', 'c']);
    expect(result.expectedCount).toBe(3);
    expect(result.termination).toEqual({ kind: 'exhausted' });
  });

  it('sends the CSRF header Eventbrite requires', async () => {
    const post = vi.fn().mockResolvedValue(searchPage(['a'], 1));
    await fetchEventbrite({ placeId: '859', csrfToken: 'tok123', post });

    const headers = post.mock.calls[0]![2] as Record<string, string>;
    expect(headers['X-CSRFToken']).toBe('tok123');
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
  });

  it('records an error termination when the WAF rejects the call', async () => {
    const post = vi.fn().mockRejectedValue(new Error('HTTP 403'));
    const result = await fetchEventbrite({ placeId: '859', csrfToken: 'tok', post });
    expect(result.termination).toEqual({ kind: 'error', error: 'HTTP 403' });
  });
});

describe('normalizeEventbrite', () => {
  it('maps a search result to a CanonicalEvent', () => {
    const record: RawRecord = {
      source: 'eventbrite', sourceEventId: 'a',
      payload: searchPage(['a'], 1).events.results[0],
    };
    const [event] = normalizeEventbrite([record]);
    expect(event!.title).toBe('Event a');
    expect(event!.venueName).toBe('The Venue');
    expect(event!.address).toBe('SF, CA');
    expect(event!.startsAt).toBe('2026-08-10T19:00:00.000Z');
  });
});
