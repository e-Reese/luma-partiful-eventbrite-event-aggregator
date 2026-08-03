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

      <p className="py-2.5 text-[13px] text-faint">
        <span className="tnum">{total.toLocaleString()}</span>{' '}
        {total === 1 ? 'event' : 'events'}
        {q && <> for “{q}”</>}
        {filtered && (
          <>
            {' · '}
            <Link href="/" className="text-accent hover:underline">
              clear
            </Link>
          </>
        )}
      </p>

      {rows.length === 0 ? (
        <p className="py-24 text-center text-[15px] text-quiet">
          Nothing matches that.
          {q && (
            <span className="mt-1.5 block text-[13px] text-faint">
              Every word has to appear — try fewer of them.
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
                  <h2 className="day-sticky pb-1.5 pt-5 text-[14px] font-semibold">
                    {label.lead ? (
                      <>
                        {label.lead}
                        <span className="ml-2 font-normal text-faint">{label.date}</span>
                      </>
                    ) : (
                      label.date
                    )}
                  </h2>
                )}
                <ul className="border-t border-ink/25">
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
        <nav className="mt-8 flex items-baseline justify-between border-t border-rule pt-4 text-[13px]">
          {page > 1 ? (
            <Link href={pageHref(sp, page - 1)} className="text-accent hover:underline">
              ← Earlier
            </Link>
          ) : (
            <span className="text-faint">← Earlier</span>
          )}
          <span className="tnum text-quiet">
            {page} / {pages.toLocaleString()}
          </span>
          {page < pages ? (
            <Link href={pageHref(sp, page + 1)} className="text-accent hover:underline">
              Later →
            </Link>
          ) : (
            <span className="text-faint">Later →</span>
          )}
        </nav>
      )}
    </>
  );
}
