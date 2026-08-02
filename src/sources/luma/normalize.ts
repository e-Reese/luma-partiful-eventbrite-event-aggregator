import { type CanonicalEvent, EMPTY_COUNTS, type HostRef, type RawRecord } from '../../types.js';

interface LumaEntry {
  api_id?: string;
  guest_count?: number | null;
  ticket_count?: number | null;
  registration_availability?: string | null;
  hosts?: Array<{ api_id?: string; name?: string | null; url?: string | null }>;
  event?: {
    name?: string | null;
    start_at?: string | null;
    end_at?: string | null;
    timezone?: string | null;
    url?: string | null;
    geo_address_info?: {
      city?: string | null; region?: string | null; address?: string | null;
    } | null;
    coordinate?: { latitude?: number | null; longitude?: number | null } | null;
  } | null;
}

function toHosts(entry: LumaEntry): HostRef[] {
  return (entry.hosts ?? [])
    .filter((h): h is { api_id: string; name?: string | null; url?: string | null } =>
      typeof h?.api_id === 'string')
    .map((h) => ({
      sourceHostId: h.api_id,
      displayName: h.name ?? null,
      profileUrl: h.url ? `https://lu.ma/user/${h.url}` : null,
    }));
}

export function normalizeLuma(records: RawRecord[]): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];

  for (const record of records) {
    const entry = record.payload as LumaEntry;
    const ev = entry?.event;
    if (!ev?.name || !ev.start_at) continue;

    const geo = ev.geo_address_info ?? null;
    out.push({
      source: 'luma',
      sourceEventId: record.sourceEventId,
      sourceUrl: ev.url ? `https://lu.ma/${ev.url}` : `https://lu.ma/${record.sourceEventId}`,
      title: ev.name,
      description: null, // not present in the discovery payload; see spec §9
      startsAt: new Date(ev.start_at).toISOString(),
      endsAt: ev.end_at ? new Date(ev.end_at).toISOString() : null,
      timezone: ev.timezone ?? null,
      venueName: geo?.address ?? null,
      address: geo?.address ?? null,
      city: geo?.city ?? null,
      lat: ev.coordinate?.latitude ?? null,
      lng: ev.coordinate?.longitude ?? null,
      isPublic: true,
      hosts: toHosts(entry),
      counts: {
        ...EMPTY_COUNTS,
        guestCount: entry.guest_count ?? null,
        ticketCount: entry.ticket_count ?? null,
        registrationAvailability: entry.registration_availability ?? null,
      },
      raw: record.payload,
    });
  }

  return out;
}
