import { randomUUID } from 'node:crypto';
import type { CanonicalEvent } from '../types.js';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Rows per batch. Chosen for round trips, not memory: at ~70ms of pooler
 * latency per query, a 1821-event cycle written one row at a time measured
 * 14m07s at 1% CPU — almost pure waiting. Batching at 500 turns ~12,700 round
 * trips into ~25.
 *
 * Kept well under Postgres' 65535 bind-parameter ceiling. Parameters here are
 * arrays rather than one placeholder per value, so the real limit is far away,
 * but a moderate batch also keeps the per-row fallback cheap when one fires.
 */
export const BATCH_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Look up which of these source ids already have canonical events. */
async function existingIds(
  db: Queryable,
  source: string,
  sourceEventIds: string[],
): Promise<Map<string, string>> {
  const { rows } = await db.query(
    `select source_event_id, event_id from event_sources
      where source = $1::source_name and source_event_id = any($2::text[])`,
    [source, sourceEventIds],
  );
  return new Map(rows.map((r) => [r.source_event_id as string, r.event_id as string]));
}

async function insertNewEvents(
  db: Queryable,
  fresh: CanonicalEvent[],
  ids: Map<string, string>,
): Promise<void> {
  if (fresh.length === 0) return;
  await db.query(
    `insert into events
       (id, title, description, starts_at, ends_at, timezone,
        venue_name, address, city, lat, lng, is_public, canonical_url)
     select * from unnest(
       $1::uuid[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[],
       $6::text[], $7::text[], $8::text[], $9::text[], $10::float8[], $11::float8[],
       $12::boolean[], $13::text[])`,
    [
      fresh.map((e) => ids.get(e.sourceEventId)),
      fresh.map((e) => e.title),
      fresh.map((e) => e.description),
      fresh.map((e) => e.startsAt),
      fresh.map((e) => e.endsAt),
      fresh.map((e) => e.timezone),
      fresh.map((e) => e.venueName),
      fresh.map((e) => e.address),
      fresh.map((e) => e.city),
      fresh.map((e) => e.lat),
      fresh.map((e) => e.lng),
      fresh.map((e) => e.isPublic),
      fresh.map((e) => e.sourceUrl),
    ],
  );
}

async function upsertEventSources(
  db: Queryable,
  events: CanonicalEvent[],
  ids: Map<string, string>,
  source: string,
): Promise<void> {
  await db.query(
    `insert into event_sources (event_id, source, source_event_id, source_url, raw)
     select u.event_id, $1::source_name, u.sid, u.url, u.raw
       from unnest($2::uuid[], $3::text[], $4::text[], $5::jsonb[])
            as u(event_id, sid, url, raw)
     on conflict (source, source_event_id) do update
       set raw = excluded.raw, last_seen_at = now()`,
    [
      source,
      events.map((e) => ids.get(e.sourceEventId)),
      events.map((e) => e.sourceEventId),
      events.map((e) => e.sourceUrl),
      events.map((e) => JSON.stringify(e.raw)),
    ],
  );
}

/**
 * Upserts every host in the batch and links them to their events.
 *
 * Hosts are deduplicated by `source_host_id` before the insert. Postgres
 * rejects `on conflict do update` that touches the same row twice in one
 * statement ("cannot affect row a second time"), and one organiser hosting
 * several events in a batch would do exactly that.
 */
async function linkHostsBatch(
  db: Queryable,
  events: CanonicalEvent[],
  ids: Map<string, string>,
  source: string,
): Promise<void> {
  const uniqueHosts = new Map<string, { name: string | null; url: string | null }>();
  const links: Array<{ eventId: string; hostSrcId: string }> = [];

  for (const event of events) {
    const eventId = ids.get(event.sourceEventId);
    if (!eventId) continue;
    for (const host of event.hosts) {
      if (!host.sourceHostId) continue;
      const prior = uniqueHosts.get(host.sourceHostId);
      uniqueHosts.set(host.sourceHostId, {
        name: host.displayName ?? prior?.name ?? null,
        url: host.profileUrl ?? prior?.url ?? null,
      });
      links.push({ eventId, hostSrcId: host.sourceHostId });
    }
  }

  if (uniqueHosts.size === 0) return;
  const hostIds = [...uniqueHosts.keys()];

  await db.query(
    `with upserted as (
       insert into hosts (source, source_host_id, display_name, profile_url)
       select $1::source_name, u.hid, u.name, u.url
         from unnest($2::text[], $3::text[], $4::text[]) as u(hid, name, url)
       on conflict (source, source_host_id) do update
         set display_name = coalesce(excluded.display_name, hosts.display_name)
       returning id, source_host_id
     )
     insert into event_hosts (event_id, host_id)
     select m.event_id, up.id
       from unnest($5::uuid[], $6::text[]) as m(event_id, hid)
       join upserted up on up.source_host_id = m.hid
     on conflict do nothing`,
    [
      source,
      hostIds,
      hostIds.map((h) => uniqueHosts.get(h)!.name),
      hostIds.map((h) => uniqueHosts.get(h)!.url),
      links.map((l) => l.eventId),
      links.map((l) => l.hostSrcId),
    ],
  );
}

async function insertSnapshotsBatch(
  db: Queryable,
  events: CanonicalEvent[],
  ids: Map<string, string>,
  source: string,
): Promise<void> {
  const rows = events.filter((e) => ids.has(e.sourceEventId));
  if (rows.length === 0) return;
  await db.query(
    `insert into snapshots
       (event_id, source, interested_count, going_count, approved_count,
        maybe_count, waitlist_count, guest_count, ticket_count,
        registration_availability, sales_status)
     select u.event_id, $1::source_name, u.interested, u.going, u.approved,
            u.maybe, u.waitlist, u.guests, u.tickets, u.avail, u.sales
       from unnest($2::uuid[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[],
                   $8::int[], $9::int[], $10::text[], $11::text[])
            as u(event_id, interested, going, approved, maybe, waitlist,
                 guests, tickets, avail, sales)`,
    [
      source,
      rows.map((e) => ids.get(e.sourceEventId)),
      rows.map((e) => e.counts.interested),
      rows.map((e) => e.counts.going),
      rows.map((e) => e.counts.approved),
      rows.map((e) => e.counts.maybe),
      rows.map((e) => e.counts.waitlist),
      rows.map((e) => e.counts.guestCount),
      rows.map((e) => e.counts.ticketCount),
      rows.map((e) => e.counts.registrationAvailability),
      rows.map((e) => e.counts.salesStatus),
    ],
  );
}

/** Writes one batch. Throws on any failure so the caller can fall back per row. */
async function writeBatch(db: Queryable, events: CanonicalEvent[]): Promise<number> {
  const source = events[0]!.source;
  const known = await existingIds(db, source, events.map((e) => e.sourceEventId));

  const ids = new Map(known);
  const fresh = events.filter((e) => !ids.has(e.sourceEventId));
  for (const event of fresh) ids.set(event.sourceEventId, randomUUID());

  await insertNewEvents(db, fresh, ids);
  if (known.size > 0) {
    await db.query(`update events set last_seen_at = now() where id = any($1::uuid[])`, [
      [...known.values()],
    ]);
  }
  await upsertEventSources(db, events, ids, source);
  await linkHostsBatch(db, events, ids, source);
  await insertSnapshotsBatch(db, events, ids, source);

  return events.length;
}

export interface PersistOutcome {
  persisted: number;
  failed: number;
  batchFallbacks: number;
}

/**
 * Persists a source's events, batched, with a per-row fallback.
 *
 * The fallback is what makes batching safe here. A malformed row would
 * otherwise take its whole batch down with it, losing up to 499 good events;
 * instead the batch is retried row by row so only the genuinely bad row is
 * dropped. That preserves the original one-bad-row-cannot-abort-the-cycle
 * guarantee while keeping the fast path fast.
 */
export async function persistEvents(
  db: Queryable,
  events: CanonicalEvent[],
  singleRowWriter?: (db: Queryable, event: CanonicalEvent) => Promise<void>,
): Promise<PersistOutcome> {
  const outcome: PersistOutcome = { persisted: 0, failed: 0, batchFallbacks: 0 };
  if (events.length === 0) return outcome;

  for (const group of chunk(events, BATCH_SIZE)) {
    try {
      outcome.persisted += await writeBatch(db, group);
    } catch {
      outcome.batchFallbacks += 1;
      if (!singleRowWriter) {
        outcome.failed += group.length;
        continue;
      }
      for (const event of group) {
        try {
          await singleRowWriter(db, event);
          outcome.persisted += 1;
        } catch {
          outcome.failed += 1;
        }
      }
    }
  }

  return outcome;
}
