import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SourceBadge } from '@/components/event-card';
import { getEvent, getSamples } from '@/lib/queries';

export const dynamic = 'force-dynamic';

function fullWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
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
  const counts = samples
    .map((s) => s.interested_count ?? s.going_count ?? s.guest_count)
    .filter((n): n is number => n !== null);
  const movement = counts.length > 1 ? counts[counts.length - 1]! - counts[0]! : null;

  return (
    <article className="space-y-6">
      <Link href="/" className="font-mono text-[12px] text-accent hover:underline">
        ← all events
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {event.sources?.map((s) => <SourceBadge key={s} source={s} />)}
          <time className="font-mono text-[12px] text-muted">
            {fullWhen(event.starts_at)}
          </time>
        </div>
        <h1 className="text-2xl font-semibold leading-tight tracking-tight">{event.title}</h1>
        {(event.venue_name || event.address) && (
          <p className="text-[14px] text-muted">
            {[event.venue_name, event.address].filter(Boolean).join(' · ')}
          </p>
        )}
        {event.host_names?.length > 0 && (
          <p className="text-[13px] text-muted">
            Hosted by {event.host_names.join(', ')}
          </p>
        )}
      </header>

      <div className="flex flex-wrap gap-2">
        {event.source_urls?.map((url) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-line px-3 py-1.5 text-[13px] transition-colors hover:border-accent hover:text-accent"
          >
            View original ↗
          </a>
        ))}
      </div>

      {event.description && (
        <section>
          <h2 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-muted">
            Description
          </h2>
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed">
            {event.description}
          </p>
        </section>
      )}

      <section>
        <h2 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-muted">
          Attendance
        </h2>
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-[14px]">
          {event.interested !== null && (
            <div>
              <dt className="text-[11px] text-muted">interested</dt>
              <dd className="font-mono tabular-nums">{event.interested.toLocaleString()}</dd>
            </div>
          )}
          {event.going !== null && (
            <div>
              <dt className="text-[11px] text-muted">going</dt>
              <dd className="font-mono tabular-nums">{event.going.toLocaleString()}</dd>
            </div>
          )}
          {event.guests !== null && (
            <div>
              <dt className="text-[11px] text-muted">guests</dt>
              <dd className="font-mono tabular-nums">{event.guests.toLocaleString()}</dd>
            </div>
          )}
          {movement !== null && movement !== 0 && (
            <div>
              <dt className="text-[11px] text-muted">since first seen</dt>
              <dd className="font-mono tabular-nums">
                {movement > 0 ? `+${movement}` : movement}
              </dd>
            </div>
          )}
        </dl>

        {samples.length > 1 ? (
          <div className="mt-3">
            <p className="mb-1 font-mono text-[11px] text-muted">
              {samples.length} recorded changes
            </p>
            <ol className="space-y-0.5 font-mono text-[12px] tabular-nums">
              {samples.map((s, i) => (
                <li key={i} className="flex gap-3 text-muted">
                  <span className="w-32 shrink-0">
                    {new Date(s.captured_at).toLocaleString('en-US', {
                      timeZone: 'America/Los_Angeles',
                      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                    })}
                  </span>
                  <span className="text-ink">
                    {s.interested_count ?? s.going_count ?? s.guest_count ?? '—'}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="mt-2 font-mono text-[11px] text-muted">
            No change recorded since first seen. Counts are sampled every three hours and
            stored only when they move.
          </p>
        )}
      </section>
    </article>
  );
}
