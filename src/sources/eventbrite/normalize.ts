import { type CanonicalEvent, EMPTY_COUNTS, type RawRecord } from '../../types.js';
import { zonedToUtcIso } from './time.js';

interface EventbriteResult {
  id?: string;
  name?: string | null;
  summary?: string | null;
  url?: string | null;
  start_date?: string | null;
  start_time?: string | null;
  end_date?: string | null;
  end_time?: string | null;
  timezone?: string | null;
  event_sales_status?: { sales_status?: string | null } | null;
  primary_organizer?: { id?: string; name?: string | null; url?: string | null } | null;
  primary_venue?: {
    name?: string | null;
    address?: {
      localized_address_display?: string | null;
      city?: string | null;
      latitude?: string | null;
      longitude?: string | null;
    } | null;
  } | null;
}

export function normalizeEventbrite(records: RawRecord[]): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];

  for (const record of records) {
    const r = record.payload as EventbriteResult;
    const startsAt = zonedToUtcIso(r?.start_date, r?.start_time, r?.timezone);
    if (!r?.name || !startsAt) continue;

    const address = r.primary_venue?.address ?? null;
    const organizer = r.primary_organizer ?? null;

    out.push({
      source: 'eventbrite',
      sourceEventId: record.sourceEventId,
      sourceUrl: r.url ?? `https://www.eventbrite.com/e/${record.sourceEventId}`,
      title: r.name,
      description: r.summary ?? null,
      startsAt,
      endsAt: zonedToUtcIso(r.end_date, r.end_time, r.timezone),
      timezone: r.timezone ?? null,
      venueName: r.primary_venue?.name ?? null,
      address: address?.localized_address_display ?? null,
      city: address?.city ?? null,
      lat: address?.latitude ? Number(address.latitude) : null,
      lng: address?.longitude ? Number(address.longitude) : null,
      isPublic: true,
      hosts: organizer?.id
        ? [{
            sourceHostId: organizer.id,
            displayName: organizer.name ?? null,
            profileUrl: organizer.url ?? null,
          }]
        : [],
      counts: {
        ...EMPTY_COUNTS,
        salesStatus: r.event_sales_status?.sales_status ?? null,
      },
      raw: record.payload,
    });
  }

  return out;
}
