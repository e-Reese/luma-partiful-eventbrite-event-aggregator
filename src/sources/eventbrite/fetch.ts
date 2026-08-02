import type { FetchResult, RawRecord, Termination } from '../../types.js';

const SEARCH_URL = 'https://www.eventbrite.com/api/v3/destination/search/';
const PAGE_SIZE = 20;
const MAX_PAGES = 100;

export interface HttpPostJson {
  (url: string, body: unknown, headers: Record<string, string>): Promise<unknown>;
}

interface SearchResponse {
  events?: {
    results?: Array<{ id?: string }>;
    pagination?: { object_count?: number; page_number?: number; page_size?: number };
  };
}

export interface FetchEventbriteOptions {
  placeId: string;
  csrfToken: string;
  post: HttpPostJson;
  maxPages?: number;
}

export async function fetchEventbrite(opts: FetchEventbriteOptions): Promise<FetchResult> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const byId = new Map<string, RawRecord>();
  let termination: Termination = { kind: 'page_cap' };
  let expectedCount: number | null = null;
  let pages = 0;

  const headers = {
    'X-CSRFToken': opts.csrfToken,
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    Referer: 'https://www.eventbrite.com/',
  };

  for (let page = 1; page <= maxPages; page++) {
    const body = {
      browse_surface: 'search',
      event_search: {
        places: [opts.placeId],
        dates: ['current_future'],
        dedup: true,
        page,
        page_size: PAGE_SIZE,
      },
      'expand.destination_event': [
        'primary_venue', 'image', 'ticket_availability',
        'event_sales_status', 'primary_organizer',
      ],
    };

    let response: SearchResponse;
    try {
      response = (await opts.post(SEARCH_URL, body, headers)) as SearchResponse;
    } catch (err) {
      termination = { kind: 'error', error: err instanceof Error ? err.message : String(err) };
      break;
    }

    pages += 1;
    const results = response.events?.results ?? [];
    for (const result of results) {
      if (!result?.id) continue;
      byId.set(result.id, {
        source: 'eventbrite', sourceEventId: result.id, payload: result,
      });
    }

    expectedCount = response.events?.pagination?.object_count ?? expectedCount;

    if (results.length === 0 || (expectedCount !== null && byId.size >= expectedCount)) {
      termination = { kind: 'exhausted' };
      break;
    }
  }

  return {
    source: 'eventbrite',
    records: [...byId.values()],
    termination,
    expectedCount,
    pages,
    driftSignals: {},
  };
}
