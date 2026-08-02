import type { FetchResult, RawRecord, Termination } from '../../types.js';
import { sleep } from '../../http.js';

const SEARCH_URL = 'https://www.eventbrite.com/api/v3/destination/search/';

/**
 * 50 is the server-side maximum. Verified 2026-08-02: requesting 100 or 200
 * silently returns 50, with `pagination.page_size` echoing 50 — no error, so a
 * larger value would just mean the loop quietly needs more pages than expected.
 */
const PAGE_SIZE = 50;

/**
 * SF reports `object_count` 4413, so a full drain is ~89 pages at 50 per page.
 * The cap sits well above that: reaching it means the corpus grew a lot or
 * pagination broke, and either way `page_cap` is the honest answer rather than
 * silently returning a truncated set as success.
 */
const MAX_PAGES = 250;

/** Matches the Luma fetcher's inter-page delay. */
const DELAY_MS = 300;

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
  pageSize?: number;
  delayMs?: number;
}

export async function fetchEventbrite(opts: FetchEventbriteOptions): Promise<FetchResult> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const delayMs = opts.delayMs ?? DELAY_MS;
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
        page_size: pageSize,
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

    if (delayMs > 0) await sleep(delayMs);
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
