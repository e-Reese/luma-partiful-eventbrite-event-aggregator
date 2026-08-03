import { type CanonicalEvent, EMPTY_COUNTS, type RawRecord } from '../../types.js';

interface PartifulPayload {
  event?: {
    id?: string;
    title?: string | null;
    description?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    timezone?: string | null;
    ownerIds?: string[];
    interestedGuestCount?: number | null;
    goingGuestCount?: number | null;
    approvedGuestCount?: number | null;
    maybeGuestCount?: number | null;
    waitlistGuestCount?: number | null;
    isPublic?: boolean;
    status?: string | null;
    locationInfo?: {
      mapsInfo?: { name?: string | null; addressLines?: string[] } | null;
    } | null;
  } | null;
}

export function normalizePartiful(records: RawRecord[]): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];

  for (const record of records) {
    const ev = (record.payload as PartifulPayload)?.event;
    if (!ev?.title || !ev.startDate) continue;
    if (ev.status && ev.status !== 'PUBLISHED') continue;

    const maps = ev.locationInfo?.mapsInfo ?? null;
    const address = maps?.addressLines?.join(', ') ?? null;

    out.push({
      source: 'partiful',
      sourceEventId: record.sourceEventId,
      sourceUrl: `https://partiful.com/e/${record.sourceEventId}`,
      title: ev.title,
      description: ev.description ?? null,
      startsAt: new Date(ev.startDate).toISOString(),
      endsAt: ev.endDate ? new Date(ev.endDate).toISOString() : null,
      timezone: ev.timezone ?? null,
      venueName: maps?.name ?? null,
      address,
      city: null, // Partiful gives a free-text address, not a city field
      lat: null,
      lng: null,
      isPublic: ev.isPublic ?? true,
      hosts: (ev.ownerIds ?? []).map((id) => ({
        sourceHostId: id, displayName: null, profileUrl: null,
      })),
      counts: {
        ...EMPTY_COUNTS,
        interested: ev.interestedGuestCount ?? null,
        going: ev.goingGuestCount ?? null,
        approved: ev.approvedGuestCount ?? null,
        maybe: ev.maybeGuestCount ?? null,
        waitlist: ev.waitlistGuestCount ?? null,
      },
      raw: record.payload,
    });
  }

  return out;
}
