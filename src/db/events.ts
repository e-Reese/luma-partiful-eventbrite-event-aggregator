import type { CanonicalEvent } from '../types.js';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Upserts every host for an event and links them, in a single round trip.
 *
 * Was two queries per host. Cycle time is almost entirely round-trip latency
 * against a pooled connection — a 1821-event run measured 14m07s at 1% CPU —
 * so collapsing per-host chatter matters more than any local work.
 *
 * `unnest` over parallel arrays keeps this one statement regardless of host
 * count, and the CTE feeds the generated ids straight into `event_hosts`
 * without a second trip. Semantics are unchanged: same conflict handling,
 * same `coalesce` on `display_name`, hosts with no id still skipped.
 */
async function linkHosts(db: Queryable, eventId: string, event: CanonicalEvent) {
  const hosts = event.hosts.filter((h) => h.sourceHostId);
  if (hosts.length === 0) return;

  await db.query(
    `with upserted as (
       insert into hosts (source, source_host_id, display_name, profile_url)
       select $2, h.id, h.name, h.url
         from unnest($3::text[], $4::text[], $5::text[]) as h(id, name, url)
       on conflict (source, source_host_id) do update
         set display_name = coalesce(excluded.display_name, hosts.display_name)
       returning id
     )
     insert into event_hosts (event_id, host_id)
     select $1, id from upserted
     on conflict do nothing`,
    [
      eventId,
      event.source,
      hosts.map((h) => h.sourceHostId),
      hosts.map((h) => h.displayName),
      hosts.map((h) => h.profileUrl),
    ],
  );
}

/**
 * Inserts or refreshes one event. Returns the canonical event id.
 * The raw payload is always stored so a future schema change can be backfilled
 * from history rather than re-crawled.
 */
export async function upsertEvent(db: Queryable, event: CanonicalEvent): Promise<string> {
  const existing = await db.query(
    `select event_id from event_sources where source = $1 and source_event_id = $2`,
    [event.source, event.sourceEventId],
  );

  let eventId: string | undefined = existing.rows[0]?.event_id;

  if (eventId) {
    await db.query(`update events set last_seen_at = now() where id = $1`, [eventId]);
  } else {
    const inserted = await db.query(
      `insert into events
         (title, description, starts_at, ends_at, timezone,
          venue_name, address, city, lat, lng, is_public, canonical_url)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning id`,
      [
        event.title, event.description, event.startsAt, event.endsAt, event.timezone,
        event.venueName, event.address, event.city, event.lat, event.lng,
        event.isPublic, event.sourceUrl,
      ],
    );
    eventId = inserted.rows[0]?.id as string;
  }

  await db.query(
    `insert into event_sources (event_id, source, source_event_id, source_url, raw)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (source, source_event_id) do update
       set raw = excluded.raw, last_seen_at = now()`,
    [eventId, event.source, event.sourceEventId, event.sourceUrl, JSON.stringify(event.raw)],
  );

  await linkHosts(db, eventId!, event);
  return eventId!;
}
