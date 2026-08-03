import Link from 'next/link';
import { EventCard } from '@/components/event-card';
import { Filters } from '@/components/filters';
import { dayLabel, groupByDay } from '@/lib/dates';
import {
  PAGE_SIZE, SOURCES, getCities, getStats, searchEvents,
  type Source, type SortKey,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const many = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v : v ? [v] : [];

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
  // Day headings only make sense in chronological order.
  const chronological = !sort || sort === 'soonest';
  const days = chronological ? groupByDay(rows) : [{ key: '', rows }];

  return (
    <>
      <Filters
        q={q} sources={selected} city={city} from={from} to={to}
        sort={sort ?? 'soonest'} cities={cities}
      />

      <div className="flex items-baseline justify-between gap-4 py-3 font-mono text-[10.5px] uppercase tracking-[0.12em] text-quiet">
        <p>
          <span className="tnum text-ink">{total.toLocaleString()}</span>{' '}
          {total === 1 ? 'event' : 'events'}
          {q && <span className="normal-case tracking-normal"> for “{q}”</span>}
          {filtered && (
            <>
              {' · '}
              <Link href="/" className="text-accent hover:underline">
                clear
              </Link>
            </>
          )}
        </p>
        {stats.lastRun && (
          <p className="text-faint">
            updated{' '}
            {new Date(stats.lastRun).toLocaleString('en-US', {
              timeZone: 'America/Los_Angeles',
              month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })}
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="py-24 text-center font-display text-[20px] italic text-quiet">
          Nothing on the calendar matches that.
          {q && (
            <span className="mt-2 block font-sans text-[13px] not-italic text-faint">
              Search needs every word to appear — try fewer of them.
            </span>
          )}
        </p>
      ) : (
        <div className="space-y-1">
          {days.map(({ key, rows: dayRows }) => {
            const label = key ? dayLabel(key) : null;
            return (
              <section key={key || 'all'}>
                {label && (
                  <div className="day-sticky flex items-baseline gap-2 pb-1.5 pt-4">
                    {label.lead && (
                      <h2 className="font-display text-[20px] leading-none tracking-[-0.01em]">
                        {label.lead}
                      </h2>
                    )}
                    <span
                      className={`font-mono text-[10.5px] uppercase tracking-[0.12em] ${
                        label.lead ? 'text-faint' : 'text-quiet'
                      }`}
                    >
                      {label.date}
                    </span>
                    <span className="ml-auto font-mono text-[10.5px] tabular-nums text-faint">
                      {dayRows.length}
                    </span>
                  </div>
                )}
                <ul className="border-t border-ink/70">
                  {dayRows.map((e) => (
                    <EventCard key={e.id} event={e} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {pages > 1 && (
        <nav className="mt-10 flex items-baseline justify-between border-t border-rule pt-4 font-mono text-[10.5px] uppercase tracking-[0.12em]">
          {page > 1 ? (
            <Link href={pageHref(sp, page - 1)} className="text-accent hover:underline">
              ← earlier
            </Link>
          ) : (
            <span className="text-faint">← earlier</span>
          )}
          <span className="tnum text-quiet">
            page {page} of {pages.toLocaleString()}
          </span>
          {page < pages ? (
            <Link href={pageHref(sp, page + 1)} className="text-accent hover:underline">
              later →
            </Link>
          ) : (
            <span className="text-faint">later →</span>
          )}
        </nav>
      )}
    </>
  );
}
