import type { CanonicalEvent } from '../types.js';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

async function linkHosts(db: Queryable, eventId: string, event: CanonicalEvent) {
  for (const host of event.hosts) {
    const { rows } = await db.query(
      `insert into hosts (source, source_host_id, display_name, profile_url)
       values ($1, $2, $3, $4)
       on conflict (source, source_host_id) do update
         set display_name = coalesce(excluded.display_name, hosts.display_name)
       returning id`,
      [event.source, host.sourceHostId, host.displayName, host.profileUrl],
    );
    const hostId = rows[0]?.id;
    if (!hostId) continue;
    await db.query(
      `insert into event_hosts (event_id, host_id) values ($1, $2)
       on conflict do nothing`,
      [eventId, hostId],
    );
  }
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
