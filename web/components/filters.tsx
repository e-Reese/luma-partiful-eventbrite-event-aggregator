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
 * Search and sort are always visible; everything else hides behind a native
 * `<details>`.
 *
 * Eight controls competing at once made the top of the page look like a
 * database admin panel. Most visits are "what's on" — one field. `<details>` is
 * progressive disclosure with no client JavaScript, and it opens automatically
 * when a hidden filter is actually in use so active state is never invisible.
 */
export function Filters({ q, sources, city, from, to, sort, cities }: Props) {
  const allSelected = sources.length === 0 || sources.length === SOURCES.length;
  const advancedInUse = Boolean(city || from || to || !allSelected);

  return (
    <form method="get" className="border-b border-rule pb-4 pt-5">
      <div className="flex items-center gap-3">
        <label htmlFor="q" className="sr-only">
          Search events
        </label>
        <input
          id="q"
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search events…"
          className="w-full border-b border-rule bg-transparent pb-1.5 text-[16px] outline-none placeholder:text-faint focus:border-accent"
        />
        <select
          name="sort"
          defaultValue={sort}
          aria-label="Sort order"
          className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[13px] text-quiet outline-none hover:text-ink"
        >
          <option value="soonest">Soonest</option>
          <option value="popular">Most interest</option>
          <option value="newest">Newly listed</option>
        </select>
        <button
          type="submit"
          className="shrink-0 text-[13px] font-medium text-accent hover:underline"
        >
          Search
        </button>
      </div>

      <details open={advancedInUse} className="mt-2.5">
        <summary className="inline-block text-[13px] text-faint hover:text-quiet">
          Filters{advancedInUse ? ' ·' : ' +'}
        </summary>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-quiet">
          <fieldset className="flex items-center gap-3">
            <legend className="sr-only">Sources</legend>
            {SOURCES.map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-1.5 hover:text-ink">
                <input
                  type="checkbox"
                  name="source"
                  value={s}
                  defaultChecked={allSelected || sources.includes(s)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                {s}
              </label>
            ))}
          </fieldset>

          <label className="flex items-center gap-1.5">
            <span className="text-faint">in</span>
            <select
              name="city"
              defaultValue={city}
              className="cursor-pointer border-0 bg-transparent p-0 text-[13px] outline-none hover:text-ink"
            >
              <option value="">all cities</option>
              {cities.map((c) => (
                <option key={c.city} value={c.city}>
                  {c.city}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5">
            <span className="text-faint">from</span>
            <input
              type="date"
              name="from"
              defaultValue={from}
              className="tnum border-0 bg-transparent p-0 text-[13px] outline-none"
            />
          </label>

          <label className="flex items-center gap-1.5">
            <span className="text-faint">to</span>
            <input
              type="date"
              name="to"
              defaultValue={to}
              className="tnum border-0 bg-transparent p-0 text-[13px] outline-none"
            />
          </label>
        </div>
      </details>
    </form>
  );
}
