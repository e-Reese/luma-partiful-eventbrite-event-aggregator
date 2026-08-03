import Link from 'next/link';
import { timeOfDay } from '@/lib/dates';
import type { EventRow } from '@/lib/queries';

const SOURCE_TEXT: Record<string, string> = {
  luma: 'text-luma',
  partiful: 'text-partiful',
  eventbrite: 'text-eventbrite',
};

/**
 * A dot rather than a filled badge.
 *
 * Source is the least important thing on the row — it matters when scanning for
 * provenance and never otherwise. A badge competes with the title for attention; a
 * 5px dot carries the same information at a fraction of the visual weight.
 */
export function SourceMark({ sources }: { sources: string[] }) {
  return (
    <span className="inline-flex items-center gap-1" title={sources.join(', ')}>
      {sources.map((s) => (
        <span
          key={s}
          aria-label={s}
          className={`h-[5px] w-[5px] rounded-full bg-current ${SOURCE_TEXT[s] ?? 'text-faint'}`}
        />
      ))}
    </span>
  );
}

/**
 * Zero is suppressed in the list but kept on the detail page.
 *
 * A "0 guests" figure is truthful, but in a scan it pulls the eye toward the
 * least interesting row on the page — the opposite of what the attendance
 * column is for. Detail pages have no competing rows, so the exact figure is
 * shown there.
 */
function attendance(e: EventRow): { n: number; label: string } | null {
  if (e.interested) return { n: e.interested, label: 'interested' };
  if (e.going) return { n: e.going, label: 'going' };
  if (e.guests) return { n: e.guests, label: 'guests' };
  return null;
}

/**
 * Visual weight tracks signal.
 *
 * In a list where everything looks identical the eye has nowhere to land. Giving
 * the few genuinely large events a larger title creates a scan path down the
 * page without adding any new element to read.
 */
function titleSize(count: number | null): string {
  if (count === null) return 'text-[17px]';
  if (count >= 500) return 'text-[22px] leading-[1.15]';
  if (count >= 120) return 'text-[19px] leading-[1.2]';
  return 'text-[17px]';
}

export function EventCard({ event }: { event: EventRow }) {
  const att = attendance(event);
  const place = event.venue_name ?? event.address ?? event.city;
  const hosts = event.host_names?.filter(Boolean) ?? [];

  return (
    <li className="group border-b border-rule last:border-0">
      <Link href={`/e/${event.id}`} className="flex gap-4 py-4">
        <time className="tnum w-[3.75rem] shrink-0 pt-[3px] font-mono text-[11px] text-quiet">
          {timeOfDay(event.starts_at)}
        </time>

        <div className="min-w-0 flex-1">
          <h3
            className={`font-display ${titleSize(att?.n ?? null)} leading-snug tracking-[-0.01em] group-hover:text-accent`}
          >
            {event.title}
          </h3>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-quiet">
            <SourceMark sources={event.sources ?? []} />
            {place && <span className="truncate">{place}</span>}
            {hosts.length > 0 && (
              <span className="truncate italic text-faint">
                {hosts.slice(0, 2).join(', ')}
              </span>
            )}
          </div>
        </div>

        {att && (
          <div className="w-[4.5rem] shrink-0 pt-[2px] text-right">
            <div className="tnum font-display text-[17px] leading-none">
              {att.n.toLocaleString()}
            </div>
            <div className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-faint">
              {att.label}
            </div>
          </div>
        )}
      </Link>
    </li>
  );
}
