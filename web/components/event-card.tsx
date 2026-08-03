import Link from 'next/link';
import { timeOfDay } from '@/lib/dates';
import type { EventRow } from '@/lib/queries';

const SOURCE_TEXT: Record<string, string> = {
  luma: 'text-luma',
  partiful: 'text-partiful',
  eventbrite: 'text-eventbrite',
};

export function SourceMark({ sources }: { sources: string[] }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1" title={sources.join(', ')}>
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

function attendance(e: EventRow): number | null {
  return e.interested || e.going || e.guests || null;
}

export function EventCard({ event }: { event: EventRow }) {
  const count = attendance(event);
  // One line of context, not three. The venue answers "where"; the host lives on
  // the detail page. Showing time, title, dot, venue, host, count and a count
  // label turned every row into a paragraph.
  const context = event.venue_name ?? event.address ?? event.city;

  return (
    <li className="border-b border-rule last:border-0">
      <Link href={`/e/${event.id}`} className="flex items-baseline gap-3 py-3">
        <time className="tnum w-[3.25rem] shrink-0 text-[12px] text-faint">
          {timeOfDay(event.starts_at)}
        </time>

        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-medium leading-snug hover:text-accent">
            {event.title}
          </h3>
          {context && (
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-[13px] text-quiet">
              <SourceMark sources={event.sources ?? []} />
              {context}
            </p>
          )}
        </div>

        {count !== null && (
          <span
            className="tnum shrink-0 text-[13px] text-faint"
            title="going or interested"
          >
            {count.toLocaleString()}
          </span>
        )}
      </Link>
    </li>
  );
}
