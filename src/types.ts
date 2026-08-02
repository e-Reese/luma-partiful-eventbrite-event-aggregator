export const SOURCE_NAMES = ['luma', 'partiful', 'eventbrite'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export function isSourceName(value: string): value is SourceName {
  return (SOURCE_NAMES as readonly string[]).includes(value);
}

/** Why a pagination loop stopped. Only `exhausted` is success. */
export type Termination =
  | { kind: 'exhausted' }
  | { kind: 'cursor_stuck' }
  | { kind: 'page_cap' }
  | { kind: 'error'; error: string };

export interface RawRecord {
  source: SourceName;
  sourceEventId: string;
  payload: unknown;
}

export interface FetchResult {
  source: SourceName;
  records: RawRecord[];
  termination: Termination;
  /** Source-reported ground truth, or null when the source cannot report one. */
  expectedCount: number | null;
  pages: number;
  driftSignals: Record<string, unknown>;
}

export interface HostRef {
  sourceHostId: string;
  displayName: string | null;
  profileUrl: string | null;
}

export interface GuestCounts {
  interested: number | null;
  going: number | null;
  approved: number | null;
  maybe: number | null;
  waitlist: number | null;
  guestCount: number | null;
  ticketCount: number | null;
  registrationAvailability: string | null;
  salesStatus: string | null;
}

export const EMPTY_COUNTS: GuestCounts = {
  interested: null, going: null, approved: null, maybe: null, waitlist: null,
  guestCount: null, ticketCount: null, registrationAvailability: null, salesStatus: null,
};

export interface CanonicalEvent {
  source: SourceName;
  sourceEventId: string;
  sourceUrl: string;
  title: string;
  description: string | null;
  startsAt: string;          // ISO 8601 UTC
  endsAt: string | null;
  timezone: string | null;
  venueName: string | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  isPublic: boolean;
  hosts: HostRef[];
  counts: GuestCounts;
  raw: unknown;
}

export type RunStatus = 'ok' | 'degraded' | 'failed';

export interface RunReport {
  source: SourceName;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  fetchedCount: number;
  expectedCount: number | null;
  coveragePct: number | null;
  terminationKind: Termination['kind'];
  error: string | null;
  driftSignals: Record<string, unknown>;
}
