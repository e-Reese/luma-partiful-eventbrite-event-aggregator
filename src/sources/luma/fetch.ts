import type { FetchResult, RawRecord, Termination } from '../../types.js';
import { type HttpGet, sleep } from '../../http.js';

const BASE = 'https://api2.luma.com/discover/get-paginated-events';
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 60;
const DELAY_MS = 300;

export const LUMA_HEADERS = {
  Accept: 'application/json',
  Referer: 'https://luma.com/',
};

interface LumaPage {
  entries?: Array<{ api_id?: string }>;
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface FetchLumaOptions {
  latitude: number;
  longitude: number;
  pageSize?: number;
  maxPages?: number;
  delayMs?: number;
  get: HttpGet;
}

/**
 * Drains Luma's discovery feed.
 *
 * Two non-obvious rules, both verified against the live API on 2026-08-02:
 *  - The cursor parameter is `pagination_cursor`. Passing `cursor` is accepted
 *    and ignored: same page, same cursor, has_more true forever (45 vs 779 events).
 *  - `slug` (category) is omitted deliberately. An unrecognised slug such as
 *    `all` returns an empty entries array with no error.
 */
export async function fetchLuma(opts: FetchLumaOptions): Promise<FetchResult> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const delayMs = opts.delayMs ?? DELAY_MS;

  const byId = new Map<string, RawRecord>();
  let cursor: string | null = null;
  let previousCursor: string | null = null;
  let pages = 0;
  let termination: Termination = { kind: 'page_cap' };

  while (pages < maxPages) {
    const params = new URLSearchParams({
      latitude: String(opts.latitude),
      longitude: String(opts.longitude),
      pagination_limit: String(pageSize),
    });
    if (cursor) params.set('pagination_cursor', cursor);

    let body: LumaPage;
    try {
      body = (await opts.get(`${BASE}?${params.toString()}`, LUMA_HEADERS)) as LumaPage;
    } catch (err) {
      termination = { kind: 'error', error: err instanceof Error ? err.message : String(err) };
      break;
    }

    pages += 1;

    for (const entry of body.entries ?? []) {
      if (!entry?.api_id) continue;
      byId.set(entry.api_id, {
        source: 'luma',
        sourceEventId: entry.api_id,
        payload: entry,
      });
    }

    if (!body.has_more) {
      termination = { kind: 'exhausted' };
      break;
    }

    const next = body.next_cursor ?? null;
    if (!next || next === previousCursor) {
      termination = { kind: 'cursor_stuck' };
      break;
    }

    previousCursor = next;
    cursor = next;
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    source: 'luma',
    records: [...byId.values()],
    termination,
    expectedCount: null, // Luma reports no total; exhaustion is its proof
    pages,
    driftSignals: {},
  };
}
