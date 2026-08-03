import { SOURCES } from '@/lib/queries';

interface Props {
  q: string;
  sources: string[];
  city: string;
  from: string;
  to: string;
  sort: string;
  cities: Array<{ city: string; n: number }>;
}

const SORTS: Array<{ value: string; label: string }> = [
  { value: 'soonest', label: 'Soonest' },
  { value: 'popular', label: 'Most anticipated' },
  { value: 'newest', label: 'Newly listed' },
];

/**
 * Presented as a masthead rule rather than a control panel.
 *
 * Still a plain GET form — all state lives in the URL, so results are shareable,
 * the back button works, and the page ships no client JavaScript.
 */
export function Filters({ q, sources, city, from, to, sort, cities }: Props) {
  const allSelected = sources.length === 0 || sources.length === SOURCES.length;

  return (
    <form method="get" className="border-b border-rule py-4">
      <div className="flex items-baseline gap-3 border-b border-rule pb-3">
        <label htmlFor="q" className="sr-only">
          Search events
        </label>
        <input
          id="q"
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by name, description, anything…"
          className="w-full border-0 bg-transparent font-display text-[19px] outline-none placeholder:text-faint"
        />
        <button
          type="submit"
          className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-accent hover:underline"
        >
          Search
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-quiet">
        <fieldset className="flex items-center gap-3">
          <legend className="sr-only">Sources</legend>
          {SOURCES.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-1.5 hover:text-ink">
              <input
                type="checkbox"
                name="source"
                value={s}
                defaultChecked={allSelected || sources.includes(s)}
                className="h-3 w-3 accent-accent"
              />
              {s}
            </label>
          ))}
        </fieldset>

        <span className="text-faint" aria-hidden>
          |
        </span>

        <label className="flex items-center gap-1.5">
          <span className="sr-only">City</span>
          <select
            name="city"
            defaultValue={city}
            className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[10.5px] uppercase tracking-[0.1em] outline-none hover:text-ink"
          >
            <option value="">all cities</option>
            {cities.map((c) => (
              <option key={c.city} value={c.city}>
                {c.city.toLowerCase()} ({c.n})
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5">
          from
          <input
            type="date"
            name="from"
            defaultValue={from}
            className="tnum border-0 bg-transparent p-0 font-mono text-[10.5px] outline-none"
          />
        </label>

        <label className="flex items-center gap-1.5">
          to
          <input
            type="date"
            name="to"
            defaultValue={to}
            className="tnum border-0 bg-transparent p-0 font-mono text-[10.5px] outline-none"
          />
        </label>

        <label className="ml-auto flex items-center gap-1.5">
          <span className="sr-only">Sort</span>
          <select
            name="sort"
            defaultValue={sort}
            className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[10.5px] uppercase tracking-[0.1em] outline-none hover:text-ink"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
    </form>
  );
}
