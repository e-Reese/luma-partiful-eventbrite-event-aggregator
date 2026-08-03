import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SourceMark } from '@/components/event-card';
import { fullWhen } from '@/lib/dates';
import { getEvent, getSamples } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * A bare inline sparkline.
 *
 * Deliberately unlabelled and tiny: the exact figures are already in the table
 * below it, so this only has to answer "is it climbing, flat, or falling" at a
 * glance. Rendered as SVG with no client JS.
 */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 160;
  const h = 28;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - lo) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="overflow-visible text-accent"
      role="img"
      aria-label={`Attendance from ${values[0]} to ${values[values.length - 1]}`}
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();

  const samples = await getSamples(id);
  const values = samples
    .map((s) => s.interested_count ?? s.going_count ?? s.guest_count)
    .filter((n): n is number => n !== null);
  const movement = values.length > 1 ? values[values.length - 1]! - values[0]! : null;
  const hosts = event.host_names?.filter(Boolean) ?? [];

  return (
    <article className="pb-4">
      <Link
        href="/"
        className="mt-5 inline-block font-mono text-[10.5px] uppercase tracking-[0.14em] text-quiet hover:text-accent"
      >
        ← the register
      </Link>

      <header className="mt-6 border-b border-ink pb-5">
        <p className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-quiet">
          <SourceMark sources={event.sources ?? []} />
          {event.sources?.join(' · ')}
        </p>
        <h1 className="mt-2 font-display text-[2.4rem] leading-[1.05] tracking-[-0.02em]">
          {event.title}
        </h1>
        <p className="mt-3 font-display text-[17px] italic text-quiet">
          {fullWhen(event.starts_at)}
        </p>
        {(event.venue_name || event.address) && (
          <p className="mt-1 text-[14px] text-quiet">
            {[event.venue_name, event.address].filter(Boolean).join(' · ')}
          </p>
        )}
        {hosts.length > 0 && (
          <p className="mt-1 text-[14px] text-faint">
            Presented by <span className="italic">{hosts.join(', ')}</span>
          </p>
        )}
      </header>

      {event.description && (
        <div className="mt-6 whitespace-pre-wrap font-display text-[17px] leading-[1.6]">
          {event.description}
        </div>
      )}

      <section className="mt-8 border-t border-rule pt-4">
        <h2 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-quiet">
          Attendance
        </h2>

        <div className="mt-3 flex flex-wrap items-end gap-x-10 gap-y-4">
          {(
            [
              ['interested', event.interested],
              ['going', event.going],
              ['guests', event.guests],
            ] as const
          )
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([label, v]) => (
              <div key={label}>
                <div className="tnum font-display text-[2rem] leading-none">
                  {v!.toLocaleString()}
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
                  {label}
                </div>
              </div>
            ))}

          {values.length > 1 && (
            <div className="ml-auto">
              <Spark values={values} />
              <div className="mt-1 text-right font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
                {movement !== null && movement !== 0
                  ? `${movement > 0 ? '+' : ''}${movement} since first seen`
                  : 'no net change'}
              </div>
            </div>
          )}
        </div>

        {samples.length > 1 ? (
          <ol className="mt-5 space-y-1 border-t border-rule pt-3">
            {samples.map((s, i) => {
              const v = s.interested_count ?? s.going_count ?? s.guest_count;
              const prev =
                i > 0
                  ? samples[i - 1]!.interested_count ??
                    samples[i - 1]!.going_count ??
                    samples[i - 1]!.guest_count
                  : null;
              const delta = v !== null && prev !== null ? v - prev : null;
              return (
                <li key={i} className="flex items-baseline gap-3 font-mono text-[11.5px]">
                  <span className="tnum w-36 shrink-0 text-faint">
                    {new Date(s.captured_at).toLocaleString('en-US', {
                      timeZone: 'America/Los_Angeles',
                      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                    })}
                  </span>
                  <span className="tnum text-ink">{v ?? '—'}</span>
                  {delta !== null && delta !== 0 && (
                    <span className="tnum text-accent">
                      {delta > 0 ? `+${delta}` : delta}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="mt-3 font-display text-[15px] italic text-faint">
            Unchanged since we first saw it. Figures are checked every three hours and
            recorded only when they move.
          </p>
        )}
      </section>

      <div className="mt-8 flex flex-wrap gap-3 border-t border-rule pt-5">
        {event.source_urls?.map((url) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-accent hover:underline"
          >
            Read the original ↗
          </a>
        ))}
      </div>
    </article>
  );
}
