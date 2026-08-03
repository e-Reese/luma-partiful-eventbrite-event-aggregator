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

/**
 * A plain GET form. Every piece of state lives in the URL, so results are
 * shareable and the back button works, and the page needs no client JS at all.
 */
export function Filters({ q, sources, city, from, to, sort, cities }: Props) {
  const allSelected = sources.length === 0 || sources.length === SOURCES.length;

  return (
    <form method="get" className="space-y-3">
      <div className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search titles and descriptions…"
          aria-label="Search events"
          className="w-full rounded-md border px-3 py-2 text-[14px] outline-none placeholder:text-muted focus:border-accent"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
        >
          Search
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">Sources</legend>
          {SOURCES.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-1 text-muted">
              <input
                type="checkbox"
                name="source"
                value={s}
                defaultChecked={allSelected || sources.includes(s)}
                className="accent-accent"
              />
              {s}
            </label>
          ))}
        </fieldset>

        <label className="flex items-center gap-1.5 text-muted">
          city
          <select
            name="city"
            defaultValue={city}
            className="rounded border px-1.5 py-1 text-[12px] outline-none focus:border-accent"
          >
            <option value="">all</option>
            {cities.map((c) => (
              <option key={c.city} value={c.city}>
                {c.city} ({c.n})
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-muted">
          from
          <input
            type="date"
            name="from"
            defaultValue={from}
            className="rounded border px-1.5 py-1 font-mono text-[12px] outline-none focus:border-accent"
          />
        </label>

        <label className="flex items-center gap-1.5 text-muted">
          to
          <input
            type="date"
            name="to"
            defaultValue={to}
            className="rounded border px-1.5 py-1 font-mono text-[12px] outline-none focus:border-accent"
          />
        </label>

        <label className="flex items-center gap-1.5 text-muted">
          sort
          <select
            name="sort"
            defaultValue={sort}
            className="rounded border px-1.5 py-1 text-[12px] outline-none focus:border-accent"
          >
            <option value="soonest">soonest</option>
            <option value="popular">most interest</option>
            <option value="newest">recently added</option>
          </select>
        </label>
      </div>
    </form>
  );
}
