import { describe, it, expect, vi } from 'vitest';
import { upsertEvent } from '../../src/db/events.js';
import { EMPTY_COUNTS, type CanonicalEvent } from '../../src/types.js';

const event: CanonicalEvent = {
  source: 'partiful', sourceEventId: 'abc',
  sourceUrl: 'https://partiful.com/e/abc',
  title: 'Run for Mutts', description: 'A run',
  startsAt: '2026-09-05T16:00:00.000Z', endsAt: null,
  timezone: 'America/Los_Angeles', venueName: 'Crosstown Trail',
  address: 'San Francisco, CA', city: null, lat: null, lng: null,
  isPublic: true,
  hosts: [{ sourceHostId: 'owner1', displayName: null, profileUrl: null }],
  counts: { ...EMPTY_COUNTS, interested: 163, going: 65 },
  raw: { hello: 'world' },
};

function mockDb(eventId = 'uuid-1') {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('from event_sources')) return { rows: [] };
    if (sql.includes('insert into events')) return { rows: [{ id: eventId }] };
    if (sql.includes('insert into hosts')) return { rows: [{ id: 'host-uuid' }] };
    return { rows: [] };
  });
  return { query };
}

describe('upsertEvent', () => {
  it('creates the event and links the source row', async () => {
    const db = mockDb();
    const id = await upsertEvent(db as any, event);

    expect(id).toBe('uuid-1');
    const sqls = db.query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('insert into events'))).toBe(true);
    expect(sqls.some((s) => s.includes('insert into event_sources'))).toBe(true);
  });

  it('always persists the raw payload for later backfill', async () => {
    const db = mockDb();
    await upsertEvent(db as any, event);

    const call = db.query.mock.calls.find((c) =>
      (c[0] as string).includes('insert into event_sources'))!;
    expect(call[1]).toContain(JSON.stringify({ hello: 'world' }));
  });

  it('reuses the existing event when the source row is already known', async () => {
    const db = { query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('from event_sources')) return { rows: [{ event_id: 'existing' }] };
      return { rows: [] };
    }) };

    const id = await upsertEvent(db as any, event);

    expect(id).toBe('existing');
    const sqls = db.query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('insert into events'))).toBe(false);
  });
});
