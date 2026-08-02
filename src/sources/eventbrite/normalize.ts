import { type CanonicalEvent, EMPTY_COUNTS, type RawRecord } from '../../types.js';

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

function toIso(date?: string | null, time?: string | null): string | null {
  if (!date) return null;
  const parsed = new Date(`${date}T${time ?? '00:00'}:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeEventbrite(records: RawRecord[]): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];

  for (const record of records) {
    const r = record.payload as EventbriteResult;
    const startsAt = toIso(r?.start_date, r?.start_time);
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
      endsAt: toIso(r.end_date, r.end_time),
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
