'use client';

import { computeRoute, type BeforeSendEvent } from '@vercel/analytics';
import { Analytics as VercelAnalytics } from '@vercel/analytics/react';
import { useParams, usePathname } from 'next/navigation';
import { SOURCES } from '@/lib/sources';

/** Query keys the register itself uses. Everything else is somebody's campaign. */
const OWN_KEYS = new Set(['q', 'source', 'city', 'from', 'to', 'sort', 'page']);

/** What `<Filters>` sends when the reader has changed nothing. */
const DEFAULT_SORT = 'soonest';

/** Long enough for a real search, short enough to stay a readable row. */
const MAX_QUERY = 80;

/**
 * Folds a listing URL down to the view it actually represents.
 *
 * The filter panel is a plain GET form with no client JavaScript, so every
 * submit carries every field — the blank ones included, and all three source
 * checkboxes whether or not the reader touched them:
 *
 *     /?q=&city=&from=&to=&sort=soonest&source=luma&source=partiful&source=eventbrite
 *
 * That is the front page. So is `/`. Left alone, the Pages panel fills up with
 * dozens of spellings of the same handful of views and the one thing worth
 * reading — what people search for — is spread too thin to see.
 *
 * Anything unrecognised (`utm_*`, `ref`) survives untouched, after the
 * register's own keys, so campaign links still attribute.
 */
function canonicalUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // Never lose a pageview to a URL we failed to parse.
  }

  const sent = url.searchParams;
  const kept = new URLSearchParams();

  // Search is case-insensitive in Postgres, so "Jazz" and "jazz" are one query
  // and should be one row.
  const q = (sent.get('q') ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_QUERY);
  if (q) kept.set('q', q);

  // All three ticked is the same result set as none ticked. Only a genuine
  // narrowing is worth recording.
  const sources = [...new Set(sent.getAll('source'))]
    .filter((s) => (SOURCES as readonly string[]).includes(s))
    .sort();
  if (sources.length > 0 && sources.length < SOURCES.length) {
    for (const source of sources) kept.append('source', source);
  }

  for (const key of ['city', 'from', 'to'] as const) {
    const value = (sent.get(key) ?? '').trim();
    if (value) kept.set(key, value);
  }

  const sort = (sent.get('sort') ?? '').trim();
  if (sort && sort !== DEFAULT_SORT) kept.set('sort', sort);

  const page = Number(sent.get('page'));
  if (Number.isFinite(page) && page > 1) kept.set('page', String(Math.floor(page)));

  for (const key of [...new Set(sent.keys())].sort()) {
    if (OWN_KEYS.has(key)) continue;
    for (const value of sent.getAll(key)) kept.append(key, value);
  }

  url.search = kept.toString();
  return url.toString();
}

/**
 * Module scope, not an inline arrow: the SDK re-registers the hook whenever the
 * prop identity changes, and a new function every render would do that forever.
 */
function beforeSend(event: BeforeSendEvent): BeforeSendEvent {
  return { ...event, url: canonicalUrl(event.url) };
}

/** `useParams()` can hand back undefined values; `computeRoute` cannot take them. */
function definedParams(
  params: ReturnType<typeof useParams>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Vercel Web Analytics.
 *
 * A client component rather than `<VercelAnalytics beforeSend={…} />` straight
 * in the layout: `beforeSend` is a function, and functions cannot cross the
 * server/client boundary as props. The whole thing still renders `null` and
 * ships one deferred script — the pages themselves stay server-rendered HTML.
 *
 * The route is computed here, from `useParams()` alone, instead of using
 * `@vercel/analytics/next`. That entry point falls back to the *query* string
 * on any page without dynamic segments, and then rewrites the path with
 * whichever key it finds a value for. The filter form submits `city=` empty, so
 * the empty string matched the whole of "/" and the front page was filed under
 * the route `/[city]`. Verified before the change and after: it now reports `/`.
 */
export function Analytics() {
  const pathname = usePathname();
  const params = useParams();

  return (
    <VercelAnalytics
      route={computeRoute(pathname, definedParams(params))}
      path={pathname}
      framework="next"
      beforeSend={beforeSend}
      // Passed through by hand, since we no longer use the Next entry point
      // that reads them. Vercel sets these when the app is served under an
      // observability base path; they are undefined everywhere else.
      basePath={process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_BASEPATH}
      configString={process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_CLIENT_CONFIG}
    />
  );
}
