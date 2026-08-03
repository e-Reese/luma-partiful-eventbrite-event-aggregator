import Link from 'next/link';
import { EventCard } from '@/components/event-card';
import { Filters } from '@/components/filters';
import {
  PAGE_SIZE, SOURCES, getCities, getStats, searchEvents,
  type Source, type SortKey,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

function many(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  return v ? [v] : [];
}

function pageHref(params: Search, page: number): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === 'page' || v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) qs.append(k, item);
  }
  if (page > 1) qs.set('page', String(page));
  const s = qs.toString();
  return s ? `/?${s}` : '/';
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const q = one(sp.q);
  const city = one(sp.city);
  const from = one(sp.from);
  const to = one(sp.to);
  const sort = (one(sp.sort) || undefined) as SortKey | undefined;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const selected = many(sp.source).filter((s): s is Source =>
    (SOURCES as readonly string[]).includes(s),
  );

  const [{ rows, total }, cities, stats] = await Promise.all([
    searchEvents({ q, sources: selected, city, from, to, sort, page }),
    getCities(),
    getStats(),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(q || city || from || to || selected.length);

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
        <span>
          <strong className="text-ink">{stats.upcoming.toLocaleString()}</strong> upcoming
        </span>
        <span>
          <strong className="text-ink">{stats.events.toLocaleString()}</strong> total
        </span>
        {stats.bySource.map((s) => (
          <span key={s.source}>
            {s.source} <strong className="text-ink">{s.n.toLocaleString()}</strong>
          </span>
        ))}
        {stats.lastRun && (
          <span className="ml-auto">
            updated{' '}
            {new Date(stats.lastRun).toLocaleString('en-US', {
              timeZone: 'America/Los_Angeles',
              month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })}
          </span>
        )}
      </section>

      <Filters
        q={q} sources={selected} city={city} from={from} to={to}
        sort={sort ?? 'soonest'} cities={cities}
      />

      <section>
        <p className="mb-1 font-mono text-[11px] text-muted">
          {total.toLocaleString()} {total === 1 ? 'event' : 'events'}
          {q && <> matching &ldquo;{q}&rdquo;</>}
          {filtered && (
            <>
              {' · '}
              <Link href="/" className="underline hover:text-accent">
                clear
              </Link>
            </>
          )}
        </p>

        {rows.length === 0 ? (
          <p className="py-16 text-center text-[14px] text-muted">
            Nothing matches those filters.
            {q && (
              <>
                {' '}
                Search requires every word to appear — try fewer terms.
              </>
            )}
          </p>
        ) : (
          <ul>
            {rows.map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </ul>
        )}
      </section>

      {pages > 1 && (
        <nav className="flex items-center justify-between font-mono text-[12px]">
          {page > 1 ? (
            <Link href={pageHref(sp, page - 1)} className="text-accent hover:underline">
              ← previous
            </Link>
          ) : (
            <span className="text-muted/50">← previous</span>
          )}
          <span className="text-muted">
            {page} / {pages.toLocaleString()}
          </span>
          {page < pages ? (
            <Link href={pageHref(sp, page + 1)} className="text-accent hover:underline">
              next →
            </Link>
          ) : (
            <span className="text-muted/50">next →</span>
          )}
        </nav>
      )}
    </div>
  );
}
