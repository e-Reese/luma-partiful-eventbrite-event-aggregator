# event_scraper

A dataset of public San Francisco events, collected from **Luma**, **Partiful** and
**Eventbrite** every three hours, plus a web frontend to search it.

Roughly **13,000 events** per cycle. None of the three sources has a usable public
discovery API, so all three are reverse-engineered from surfaces the sites serve to
their own browsers.

```
pipeline (local cron, every 3h) ──► Supabase / Postgres ──► web (Vercel)
```

## What makes this different from a normal scraper

It is built to **prove** completeness rather than assume it, because the failure mode
that matters is silent. Every source returns HTTP 200 with well-formed, plausible data
right up until it quietly stops returning everything.

The pipeline records *why* a pagination loop stopped, and only one answer counts:

```ts
type Termination =
  | { kind: 'exhausted' }     // the only success
  | { kind: 'cursor_stuck' }
  | { kind: 'page_cap' }
  | { kind: 'error'; error: string }
```

This is not theoretical. Luma's pagination parameter is `pagination_cursor`; passing
`cursor` is **accepted and silently ignored**, returning the same first page forever
with `has_more: true`. Measured on SF: 45 events instead of 779. A published
open-source scraper has exactly this bug, hidden behind a page cap. Nothing short of
an exhaustion proof distinguishes the two outcomes.

Every run writes a row to `runs` with its termination reason, coverage against the
source's own reported total where one exists, and drift signals. Zero results is
always an error, never an empty city.

## Sources

| Source | Access | Browser | Per cycle |
|---|---|---|---|
| Luma | `api2.luma.com/discover/get-paginated-events` | no | ~780 |
| Partiful | `/_next/data/<buildId>/explore/sf.json` | no | ~42 |
| Eventbrite | `POST /api/v3/destination/search/` | cookies only | ~12,000 |

Notes worth knowing before touching any of them:

- **Luma** — omit `slug` entirely; an unrecognised value like `all` returns an empty
  array with no error. Discovery is lat/lng based, so "San Francisco" is a radius, not
  a boundary — roughly two thirds of results are in SF proper.
- **Partiful** — `buildId` rotates on every deploy, so it is re-scraped each cycle and a
  404 triggers one retry. The four event pools overlap by about a quarter; measure the
  deduped union, never the raw sum.
- **Eventbrite** — a single query surfaces only ~950 rows however large the result set,
  so the date range is recursively split until each window fits. Contrary to widely
  repeated recon notes, the API is *not* WAF-blocked server-side: a plain Node POST
  replaying the browser's cookie jar works fine.

## Layout

```
migrations/     schema + search indexes
src/
  sources/      one directory per source: fetch + normalize together
  db/           batched persistence with per-row fallback
  oracle.ts     termination + coverage evaluation
  cycle.ts      orchestration; sources are independent
web/            Next.js frontend
docs/superpowers/   design spec and implementation plan
```

Files are split by **source**, not by layer, so when a platform changes shape exactly
one directory changes.

## Running the pipeline

```bash
npm install
cp .env.example .env          # set DATABASE_URL
npm run migrate
npm run cycle
```

Scheduled via cron:

```
0 */3 * * * ~/workspaces/event_scraper/scripts/cycle.sh
```

The runner refuses to start without `DATABASE_URL` rather than collecting ~13,000
events and discarding them.

## Running the web app

```bash
cd web
npm install
cp ../.env .env.local          # needs DATABASE_URL
npm run dev
```

## Tests

```bash
npm test           # 98 unit tests, no network
npm run test:contract   # live schema contracts against all three sources
```

The contract tests are the drift alarm and are deliberately excluded from `npm test`
so a network blip never blocks a commit. If one fails, a source changed shape — do not
loosen the threshold to make it green.

## Performance notes

Both of these were found by measuring, not guessing:

- Writing one row at a time took **14m07s at 1% CPU** — essentially all round-trip
  latency. Batched at 500 rows it is ~2 seconds. A failing batch falls back to
  per-row writes so one malformed row drops only itself.
- Snapshots are written **only when counts change**. Guest counts are a step function,
  so an unchanged sample stores nothing. That is 408 rows per cycle instead of 13,277
  — a 97% reduction, and the difference between 1.2M and 37M rows a year.

## Data

`events` is canonical; `event_sources` holds one row per platform per event with the
untouched `raw` payload, so a schema change can be backfilled from history rather than
re-crawled. `snapshots` is an append-only time series of guest counts — the asset that
cannot be recovered later, because it only exists if you were recording when it moved.

All content links back to the original listing.
