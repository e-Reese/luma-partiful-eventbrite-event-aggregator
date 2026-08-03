import Link from 'next/link';
import type { EventRow } from '@/lib/queries';

const SOURCE_CLASS: Record<string, string> = {
  luma: 'text-luma border-luma/40 bg-luma/10',
  partiful: 'text-partiful border-partiful/40 bg-partiful/10',
  eventbrite: 'text-eventbrite border-eventbrite/40 bg-eventbrite/10',
};

export function SourceBadge({ source }: { source: string }) {
  return (
    <span
      className={`rounded border px-1.5 py-px font-mono text-[10px] uppercase tracking-wide ${
        SOURCE_CLASS[source] ?? 'text-muted border-line'
      }`}
    >
      {source}
    </span>
  );
}

/**
 * Formats in the venue's own city timezone rather than the viewer's. An event
 * listed for 7pm in SF should read 7pm regardless of where the page is opened.
 */
function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

function attendance(e: EventRow): string | null {
  const n = e.interested ?? e.going ?? e.guests;
  if (n === null || n === undefined) return null;
  return `${n.toLocaleString()} ${e.interested !== null ? 'interested' : e.going !== null ? 'going' : 'guests'}`;
}

export function EventCard({ event }: { event: EventRow }) {
  const count = attendance(event);
  const place = event.venue_name ?? event.address ?? event.city;

  return (
    <li className="border-b border-line last:border-0">
      <Link
        href={`/e/${event.id}`}
        className="group block px-1 py-3.5 transition-colors hover:bg-surface"
      >
        <div className="flex items-baseline gap-2">
          <time className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
            {when(event.starts_at)}
          </time>
          <div className="flex gap-1">
            {event.sources?.map((s) => <SourceBadge key={s} source={s} />)}
          </div>
        </div>

        <h2 className="mt-1 text-[15px] font-medium leading-snug group-hover:text-accent">
          {event.title}
        </h2>

        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted">
          {place && <span className="truncate">{place}</span>}
          {place && count && <span aria-hidden>·</span>}
          {count && <span className="tabular-nums">{count}</span>}
          {event.host_names?.length > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{event.host_names.slice(0, 2).join(', ')}</span>
            </>
          )}
        </div>
      </Link>
    </li>
  );
}
