import type { CanonicalEvent } from '../types.js';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Append-only, and only when something changed.
 *
 * Rows are never updated or deleted — the table is a time series. But an
 * unchanged sample carries no information, so it is skipped: the value at any
 * timestamp is still the most recent row at or before it. This mirrors the
 * batch path in `db/batch.ts`; both must agree, or a batch failing over to
 * per-row writes would quietly start emitting the duplicates the batch path
 * suppresses.
 *
 * The first sample for an event always writes, giving every event a baseline.
 */
export async function insertSnapshot(
  db: Queryable,
  eventId: string,
  event: CanonicalEvent,
): Promise<void> {
  const c = event.counts;
  await db.query(
    `with latest as (
       select interested_count, going_count, approved_count, maybe_count,
              waitlist_count, guest_count, ticket_count,
              registration_availability, sales_status
         from snapshots
        where event_id = $1 and source = $2::source_name
        order by captured_at desc
        limit 1
     )
     insert into snapshots
       (event_id, source, interested_count, going_count, approved_count,
        maybe_count, waitlist_count, guest_count, ticket_count,
        registration_availability, sales_status)
     select $1, $2::source_name, $3, $4, $5, $6, $7, $8, $9, $10, $11
      where not exists (select 1 from latest)
         or (select (interested_count, going_count, approved_count, maybe_count,
                     waitlist_count, guest_count, ticket_count,
                     registration_availability, sales_status) from latest)
            is distinct from ($3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      eventId, event.source, c.interested, c.going, c.approved,
      c.maybe, c.waitlist, c.guestCount, c.ticketCount,
      c.registrationAvailability, c.salesStatus,
    ],
  );
}
