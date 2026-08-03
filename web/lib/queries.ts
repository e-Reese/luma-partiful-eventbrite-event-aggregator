import { query } from './db';

export const SOURCES = ['luma', 'partiful', 'eventbrite'] as const;
export type Source = (typeof SOURCES)[number];

export type SortKey = 'soonest' | 'popular' | 'newest';

export interface SearchParams {
  q?: string;
  sources?: Source[];
  city?: string;
  from?: string;
  to?: string;
  sort?: SortKey;
  page?: number;
}

export interface EventRow {
  id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  venue_name: string | null;
  address: string | null;
  city: string | null;
  canonical_url: string | null;
  sources: Source[];
  source_urls: string[];
  interested: number | null;
  going: number | null;
  guests: number | null;
  host_names: string[];
}

export const PAGE_SIZE = 30;

/**
 * Builds the shared WHERE clause for search and count.
 *
 * Kept in one place so the result count can never disagree with the result
 * list — a pagination bug that is invisible until someone reaches the last
 * page and finds it empty.
 */
function buildFilter(p: SearchParams): { where: string; params: unknown[] } {
  const clauses: string[] = ['e.starts_at is not null'];
  const params: unknown[] = [];

  if (p.q?.trim()) {
    params.push(p.q.trim());
    clauses.push(`e.search_tsv @@ websearch_to_tsquery('english', $${params.length})`);
  }
  if (p.sources?.length && p.sources.length < SOURCES.length) {
    params.push(p.sources);
    clauses.push(`exists (select 1 from event_sources s
                            where s.event_id = e.id
                              and s.source = any($${params.length}::source_name[]))`);
  }
  if (p.city) {
    params.push(p.city);
    clauses.push(`e.city = $${params.length}`);
  }
  if (p.from) {
    params.push(p.from);
    clauses.push(`e.starts_at >= $${params.length}::timestamptz`);
  } else {
    // Default to upcoming. Without this the "soonest" sort leads with expired
    // events, which is never what a browse view should show. An explicit `from`
    // overrides it, so past events remain reachable.
    clauses.push(`e.starts_at >= now()`);
  }
  if (p.to) {
    params.push(p.to);
    clauses.push(`e.starts_at < ($${params.length}::timestamptz + interval '1 day')`);
  }

  return { where: clauses.join(' and '), params };
}

function orderBy(sort: SortKey | undefined, hasQuery: boolean): string {
  if (sort === 'popular') {
    return 'coalesce(latest.interested_count, latest.going_count, latest.guest_count, 0) desc nulls last, e.starts_at asc';
  }
  if (sort === 'newest') return 'e.first_seen_at desc';
  // With a text query and no explicit sort, relevance is more useful than time.
  if (hasQuery && !sort) return 'rank desc, e.starts_at asc';
  return 'e.starts_at asc';
}

export async function searchEvents(
  p: SearchParams,
): Promise<{ rows: EventRow[]; total: number }> {
  const { where, params } = buildFilter(p);
  const page = Math.max(1, p.page ?? 1);
  const hasQuery = Boolean(p.q?.trim());

  const rankExpr = hasQuery
    ? `ts_rank(e.search_tsv, websearch_to_tsquery('english', $1))`
    : `0`;

  const listParams = [...params, PAGE_SIZE, (page - 1) * PAGE_SIZE];

  const rows = await query<EventRow>(
    `select e.id, e.title, e.description, e.starts_at, e.ends_at,
            e.venue_name, e.address, e.city, e.canonical_url,
            ${rankExpr} as rank,
            array_agg(distinct es.source::text) as sources,
            array_agg(distinct es.source_url) filter (where es.source_url is not null) as source_urls,
            latest.interested_count as interested,
            latest.going_count as going,
            latest.guest_count as guests,
            coalesce(array_agg(distinct h.display_name)
                     filter (where h.display_name is not null), '{}') as host_names
       from events e
       join event_sources es on es.event_id = e.id
       left join lateral (
         select s.interested_count, s.going_count, s.guest_count
           from snapshots s where s.event_id = e.id
          order by s.captured_at desc limit 1
       ) latest on true
       left join event_hosts eh on eh.event_id = e.id
       left join hosts h on h.id = eh.host_id
      where ${where}
      group by e.id, latest.interested_count, latest.going_count, latest.guest_count
      order by ${orderBy(p.sort, hasQuery)}
      limit $${listParams.length - 1} offset $${listParams.length}`,
    listParams,
  );

  const [{ n }] = await query<{ n: number }>(
    `select count(*)::int n from events e where ${where}`,
    params,
  );

  return { rows, total: n };
}

export async function getEvent(id: string): Promise<EventRow | null> {
  const rows = await query<EventRow>(
    `select e.id, e.title, e.description, e.starts_at, e.ends_at,
            e.venue_name, e.address, e.city, e.canonical_url,
            array_agg(distinct es.source::text) as sources,
            array_agg(distinct es.source_url) filter (where es.source_url is not null) as source_urls,
            latest.interested_count as interested,
            latest.going_count as going,
            latest.guest_count as guests,
            coalesce(array_agg(distinct h.display_name)
                     filter (where h.display_name is not null), '{}') as host_names
       from events e
       join event_sources es on es.event_id = e.id
       left join lateral (
         select s.interested_count, s.going_count, s.guest_count
           from snapshots s where s.event_id = e.id
          order by s.captured_at desc limit 1
       ) latest on true
       left join event_hosts eh on eh.event_id = e.id
       left join hosts h on h.id = eh.host_id
      where e.id = $1
      group by e.id, latest.interested_count, latest.going_count, latest.guest_count`,
    [id],
  );
  return rows[0] ?? null;
}

export interface Sample {
  captured_at: string;
  interested_count: number | null;
  going_count: number | null;
  guest_count: number | null;
}

/** Every recorded sample for an event. Rows exist only where counts changed. */
export async function getSamples(id: string): Promise<Sample[]> {
  return query<Sample>(
    `select captured_at, interested_count, going_count, guest_count
       from snapshots where event_id = $1 order by captured_at asc`,
    [id],
  );
}

export async function getCities(limit = 40): Promise<Array<{ city: string; n: number }>> {
  return query(
    `select city, count(*)::int n from events
      where city is not null and starts_at > now()
      group by city order by n desc limit $1`,
    [limit],
  );
}

export async function getStats(): Promise<{
  events: number; upcoming: number; samples: number; hosts: number;
  bySource: Array<{ source: string; n: number }>;
  lastRun: string | null;
}> {
  const [{ n: events }] = await query<{ n: number }>('select count(*)::int n from events');
  const [{ n: upcoming }] = await query<{ n: number }>(
    'select count(*)::int n from events where starts_at > now()',
  );
  const [{ n: samples }] = await query<{ n: number }>('select count(*)::int n from snapshots');
  const [{ n: hosts }] = await query<{ n: number }>('select count(*)::int n from hosts');
  const bySource = await query<{ source: string; n: number }>(
    'select source::text as source, count(*)::int n from event_sources group by source order by n desc',
  );
  const last = await query<{ finished_at: string }>(
    'select finished_at from runs order by id desc limit 1',
  );
  return { events, upcoming, samples, hosts, bySource, lastRun: last[0]?.finished_at ?? null };
}
