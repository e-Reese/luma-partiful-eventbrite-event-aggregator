import { describe, it, expect, vi } from 'vitest';
import { BATCH_SIZE, persistEvents } from '../../src/db/batch.js';
import { EMPTY_COUNTS, type CanonicalEvent } from '../../src/types.js';

function ev(id: string, over: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    source: 'partiful', sourceEventId: id, sourceUrl: `https://partiful.com/e/${id}`,
    title: `Event ${id}`, description: null, startsAt: '2026-09-05T16:00:00.000Z',
    endsAt: null, timezone: null, venueName: null, address: null, city: null,
    lat: null, lng: null, isPublic: true,
    hosts: [{ sourceHostId: `owner-${id}`, displayName: null, profileUrl: null }],
    counts: { ...EMPTY_COUNTS, interested: 5 }, raw: { id }, ...over,
  };
}

/** Mock that answers the existing-ids lookup and accepts every write. */
function okDb() {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('from event_sources')) return { rows: [] };
    return { rows: [] };
  });
  return { query };
}

describe('persistEvents', () => {
  it('writes a batch in a handful of round trips, not one per row', async () => {
    const db = okDb();
    const events = Array.from({ length: 50 }, (_, i) => ev(`e${i}`));

    const outcome = await persistEvents(db as any, events);

    expect(outcome).toEqual({ persisted: 50, failed: 0, batchFallbacks: 0, snapshotsWritten: 0 });
    // lookup + insert events + upsert sources + hosts + snapshots = 5.
    // The point of the batch path is that this does not scale with row count.
    expect(db.query.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('returns an empty outcome for no events without touching the db', async () => {
    const db = okDb();
    expect(await persistEvents(db as any, [])).toEqual({
      persisted: 0, failed: 0, batchFallbacks: 0, snapshotsWritten: 0,
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('splits into batches of BATCH_SIZE', async () => {
    const db = okDb();
    const events = Array.from({ length: BATCH_SIZE + 10 }, (_, i) => ev(`e${i}`));

    const outcome = await persistEvents(db as any, events);

    expect(outcome.persisted).toBe(BATCH_SIZE + 10);
    // Two batches, each a small fixed number of queries.
    expect(db.query.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('reuses the event id of an already-known source row', async () => {
    const db = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('from event_sources')) {
          return { rows: [{ source_event_id: 'a', event_id: 'existing-uuid' }] };
        }
        return { rows: [] };
      }),
    };

    await persistEvents(db as any, [ev('a')]);

    const sqls = db.query.mock.calls.map((c) => c[0] as string);
    // Nothing new to create, so no insert into events — only the last_seen_at touch.
    expect(sqls.some((s) => s.includes('insert into events'))).toBe(false);
    expect(sqls.some((s) => s.includes('set last_seen_at = now()'))).toBe(true);
  });

  it('falls back to per-row writes when a batch fails, dropping only the bad row', async () => {
    const db = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('from event_sources')) return { rows: [] };
        if (sql.includes('insert into events')) throw new Error('batch exploded');
        return { rows: [] };
      }),
    };
    const single = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('bad row'))
      .mockResolvedValueOnce(undefined);

    const outcome = await persistEvents(db as any, [ev('a'), ev('b'), ev('c')], single);

    expect(outcome.batchFallbacks).toBe(1);
    expect(outcome.persisted).toBe(2);
    expect(outcome.failed).toBe(1);
    expect(single).toHaveBeenCalledTimes(3);
  });

  it('counts the whole batch failed when no fallback writer is supplied', async () => {
    const db = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('from event_sources')) return { rows: [] };
        if (sql.includes('insert into events')) throw new Error('boom');
        return { rows: [] };
      }),
    };

    const outcome = await persistEvents(db as any, [ev('a'), ev('b')]);

    expect(outcome).toEqual({ persisted: 0, failed: 2, batchFallbacks: 1, snapshotsWritten: 0 });
  });

  it('deduplicates hosts so one organiser across several events is upserted once', async () => {
    const db = okDb();
    const shared = { sourceHostId: 'org-1', displayName: 'Org', profileUrl: null };
    await persistEvents(db as any, [
      ev('a', { hosts: [shared] }),
      ev('b', { hosts: [shared] }),
      ev('c', { hosts: [shared] }),
    ]);

    const hostCall = db.query.mock.calls.find((c) =>
      (c[0] as string).includes('insert into hosts'))!;
    const params = hostCall[1] as unknown[];
    // Postgres rejects on-conflict-do-update touching the same row twice in one
    // statement, so the host id array must carry one entry, not three.
    expect(params[1]).toEqual(['org-1']);
    // ...while the link arrays still carry all three event/host pairs.
    expect((params[5] as string[]).length).toBe(3);
  });
});

describe('change-only snapshots', () => {
  it('reports how many snapshot rows the database actually accepted', async () => {
    // The insert filters unchanged rows server-side, so `returning id` yields
    // fewer rows than events submitted.
    const db = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('from event_sources')) return { rows: [] };
        if (sql.includes('insert into snapshots')) return { rows: [{ id: 1 }, { id: 2 }] };
        return { rows: [] };
      }),
    };

    const outcome = await persistEvents(
      db as any,
      Array.from({ length: 10 }, (_, i) => ev(`e${i}`)),
    );

    expect(outcome.persisted).toBe(10);
    expect(outcome.snapshotsWritten).toBe(2);
  });

  it('compares against the latest prior sample, not the whole history', async () => {
    const db = okDb();
    await persistEvents(db as any, [ev('a')]);

    const snap = db.query.mock.calls.find((c) =>
      (c[0] as string).includes('insert into snapshots'))![0] as string;
    expect(snap).toContain('distinct on (s.event_id)');
    expect(snap).toContain('order by s.event_id, s.captured_at desc');
    // NULL-safe comparison: null -> null is not a change, null -> 0 is.
    expect(snap).toContain('is distinct from');
  });
});
