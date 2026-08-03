import type { FetchResult, RawRecord, Termination } from '../../types.js';
import { sleep } from '../../http.js';
import type { HttpPostJson } from './fetch.js';

const SEARCH_URL = 'https://www.eventbrite.com/api/v3/destination/search/';
const PAGE_SIZE = 50;

/**
 * Results reachable inside one query.
 *
 * Measured 2026-08-02: the API reports the true `object_count` (4382 for SF) but
 * caps `page_count` at 19 when `page_size` is 50 — so only ~950 rows of any
 * result set are actually retrievable. Splitting a date range is the only way
 * past it. 900 leaves margin for the count moving between the probe and the
 * drain.
 */
const WINDOW_LIMIT = 900;

/** How far ahead to partition. Observed SF events run ~10 months out. */
const HORIZON_DAYS = 730;

/** Stop splitting here; a single day over the limit is accepted as truncated. */
const MIN_WINDOW_DAYS = 1;

const DELAY_MS = 300;

interface SearchResponse {
  events?: {
    results?: Array<{ id?: string }>;
    pagination?: { object_count?: number; page_count?: number };
  };
}

export interface DateWindow {
  from: string; // YYYY-MM-DD inclusive
  to: string;   // YYYY-MM-DD inclusive
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysBetween(w: DateWindow): number {
  return Math.round((Date.parse(w.to) - Date.parse(w.from)) / DAY_MS) + 1;
}

/** Split a window into two roughly equal halves that do not overlap. */
export function splitWindow(w: DateWindow): [DateWindow, DateWindow] {
  const from = Date.parse(w.from);
  const to = Date.parse(w.to);
  const midMs = from + Math.floor((to - from) / 2);
  const mid = new Date(midMs);
  const nextDay = new Date(midMs + DAY_MS);
  return [
    { from: w.from, to: isoDay(mid) },
    { from: isoDay(nextDay), to: w.to },
  ];
}

function searchBody(placeId: string, page: number, window?: DateWindow) {
  return {
    browse_surface: 'search',
    event_search: {
      places: [placeId],
      dedup: true,
      page,
      page_size: PAGE_SIZE,
      ...(window
        ? { date_range: { from: window.from, to: window.to } }
        : { dates: ['current_future'] }),
    },
    'expand.destination_event': [
      'primary_venue', 'image', 'ticket_availability',
      'event_sales_status', 'primary_organizer',
    ],
  };
}

export interface PartitionedOptions {
  placeId: string;
  csrfToken: string;
  post: HttpPostJson;
  horizonDays?: number;
  windowLimit?: number;
  delayMs?: number;
  /** Injectable for tests; defaults to today. */
  today?: Date;
  onWindow?: (w: DateWindow, objectCount: number, action: 'split' | 'drain') => void;
}

/**
 * Fetches Eventbrite by adaptively partitioning the date range.
 *
 * A single query can only surface ~950 of a result set however large it really
 * is, so any window whose reported `object_count` exceeds the limit is split in
 * half and re-probed. Dense weeks end up as narrow windows, sparse months stay
 * wide, and no window is drained until it fits.
 *
 * `expectedCount` is null: no reliable denominator exists. The unbounded
 * `object_count` is itself capped, and per-window counts double-count events
 * spanning a boundary. Completeness is proven the way Luma proves it — every
 * window drained to its own page count.
 */
export async function fetchEventbritePartitioned(
  opts: PartitionedOptions,
): Promise<FetchResult> {
  const limit = opts.windowLimit ?? WINDOW_LIMIT;
  const delayMs = opts.delayMs ?? DELAY_MS;
  const start = opts.today ?? new Date();
  const horizon = new Date(start.getTime() + (opts.horizonDays ?? HORIZON_DAYS) * DAY_MS);

  const headers = {
    'X-CSRFToken': opts.csrfToken,
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    Referer: 'https://www.eventbrite.com/',
  };

  const byId = new Map<string, RawRecord>();
  const driftSignals: Record<string, unknown> = {};
  let pages = 0;
  let truncatedWindows = 0;
  let drainedWindows = 0;

  const ask = async (page: number, window?: DateWindow): Promise<SearchResponse> => {
    pages += 1;
    const res = (await opts.post(SEARCH_URL, searchBody(opts.placeId, page, window), headers)) as SearchResponse;
    if (delayMs > 0) await sleep(delayMs);
    return res;
  };

  const absorb = (res: SearchResponse): number => {
    const results = res.events?.results ?? [];
    for (const r of results) {
      if (!r?.id) continue;
      byId.set(r.id, { source: 'eventbrite', sourceEventId: r.id, payload: r });
    }
    return results.length;
  };

  let unboundedCount: number | null = null;
  let windowCountSum = 0;

  try {
    const probe = await ask(1);
    unboundedCount = probe.events?.pagination?.object_count ?? null;
    absorb(probe);

    const queue: DateWindow[] = [{ from: isoDay(start), to: isoDay(horizon) }];

    while (queue.length > 0) {
      const window = queue.shift()!;
      const first = await ask(1, window);
      const count = first.events?.pagination?.object_count ?? 0;

      if (count > limit && daysBetween(window) > MIN_WINDOW_DAYS) {
        opts.onWindow?.(window, count, 'split');
        queue.push(...splitWindow(window));
        continue;
      }

      opts.onWindow?.(window, count, 'drain');
      drainedWindows += 1;
      windowCountSum += count;
      absorb(first);

      // A window still over the limit at one-day granularity cannot be drained
      // fully. Record it rather than pretending the result set is complete.
      if (count > limit) truncatedWindows += 1;

      const pageCount = first.events?.pagination?.page_count ?? 1;
      for (let page = 2; page <= pageCount; page++) {
        const res = await ask(page, window);
        if (absorb(res) === 0) break;
      }
    }
  } catch (err) {
    return {
      source: 'eventbrite',
      records: [...byId.values()],
      termination: { kind: 'error', error: err instanceof Error ? err.message : String(err) },
      expectedCount: null,
      pages,
      driftSignals: {
        ...driftSignals, partitioned: true, drainedWindows, truncatedWindows,
        unboundedCount, windowCountSum, uniqueFetched: byId.size,
      },
    };
  }

  const termination: Termination =
    truncatedWindows > 0 ? { kind: 'page_cap' } : { kind: 'exhausted' };

  return {
    source: 'eventbrite',
    records: [...byId.values()],
    termination,
    // Deliberately null. Neither available number is a valid denominator:
    // the unbounded `object_count` is itself capped (it reported 4382 while
    // partitioning surfaced 12013), and summing per-window counts double-counts
    // events that span a window boundary. Like Luma, this source proves
    // completeness by exhausting its windows, not by a ratio. Both figures are
    // kept as drift signals so a regression is still visible.
    expectedCount: null,
    pages,
    driftSignals: {
      ...driftSignals,
      partitioned: true,
      drainedWindows,
      truncatedWindows,
      unboundedCount,
      windowCountSum,
      uniqueFetched: byId.size,
    },
  };
}
