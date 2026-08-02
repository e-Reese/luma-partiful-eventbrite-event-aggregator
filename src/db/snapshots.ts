import type { CanonicalEvent } from '../types.js';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Append-only. One row per event per cycle; never updated. */
export async function insertSnapshot(
  db: Queryable,
  eventId: string,
  event: CanonicalEvent,
): Promise<void> {
  const c = event.counts;
  await db.query(
    `insert into snapshots
       (event_id, source, interested_count, going_count, approved_count,
        maybe_count, waitlist_count, guest_count, ticket_count,
        registration_availability, sales_status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      eventId, event.source, c.interested, c.going, c.approved,
      c.maybe, c.waitlist, c.guestCount, c.ticketCount,
      c.registrationAvailability, c.salesStatus,
    ],
  );
}
