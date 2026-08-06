# Deploying the web app to Vercel

The frontend lives in `web/`. The pipeline does **not** run on Vercel — it stays on a
local cron, because it drives a real browser to obtain Eventbrite cookies.

## The project

One project, **`event-scraper`**, connected to this repo on `main` with **Root
Directory** set to `web`. Pushing to `main` deploys it; there is nothing to run by
hand. Production is <https://event-scraper-liard.vercel.app>.

Check what the CLI is pointing at before deploying from a terminal — `web/.vercel`
is local, gitignored, and easy to leave aimed at some other project:

```
vercel project inspect --cwd web
```

## One-time setup

1. Import the repo at <https://vercel.com/new>.
2. Set **Root Directory** to `web`. This is the only non-default setting; without it
   Vercel builds the pipeline instead of the app.
3. Add one environment variable, for Production, Preview and Development:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase **transaction pooler** URI, port **6543** |

   Use a pooler, not `db.<ref>.supabase.co` — the direct host is IPv6-only and
   Vercel's build and function network is IPv4.

4. Deploy.

## Why the pooler matters, and which one

Every page is server-rendered and queries Postgres directly; nothing reaches the
browser but HTML. Serverless functions are short-lived and can be many, so the pooled
connection string is what keeps Supabase's connection limit from being exhausted. The
app caps its own pool at 5 as well.

Take the **transaction** pooler on port 6543, not the session pooler on 5432. Session
mode holds one Postgres connection per client for the life of that client, and it
allows 15 of them in total — which sounds ample until you count what a serverless app
really opens. Every instance keeps a pool of up to 5, Vercel runs as many instances as
traffic asks for, a `next dev` on someone's laptop takes its own, and one visit to the
front page makes Next prefetch every event link on it, so a single reader can trigger
thirty server renders. Past 15 the whole site returns 500 with:

```
(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15
```

Transaction mode hands a connection back at the end of each statement, so the same
traffic needs a fraction of them. The app only sends parameterised `SELECT`s, which is
all transaction mode supports — no session state, no named prepared statements.

The pipeline is the exception: leave its `DATABASE_URL` (repo root `.env`) on the
session pooler. Migrations want a connection that holds still.

## Reads only

The web app never writes. It has no service-role key and no Supabase client — just a
`DATABASE_URL` and `SELECT`s. If you would rather it could not write even in
principle, create a read-only role:

```sql
create role web_reader login password '<pick-one>';
grant connect on database postgres to web_reader;
grant usage on schema public to web_reader;
grant select on all tables in schema public to web_reader;
alter default privileges in schema public grant select on tables to web_reader;
```

then point Vercel's `DATABASE_URL` at `web_reader` instead of `postgres`.

## Analytics

Vercel Web Analytics is on, mounted in `web/components/analytics.tsx`. Pageviews
only: `track()` custom events need a Pro plan, and this project is on Hobby
(50,000 events a month included).

Enabling it in the dashboard is not enough on its own — the script is wired into
a deployment at build time, so anything deployed before you switch it on serves
the script as a 404. Redeploy, then confirm:

```
curl -o /dev/null -w '%{http_code}\n' https://event-scraper-liard.vercel.app/_vercel/insights/script.js
```

Three things that make a working install look broken:

- **The console stays empty in production.** The debug script only loads under
  `next dev`. In production, watch the network tab for `POST …/view` instead.
- **That request is not called what you expect.** Vercel serves analytics from a
  randomised path per project to get past ad blockers, so filtering the network
  tab for "insights" or "vercel" finds nothing.
- **Automated browsers send nothing.** The script checks `navigator.webdriver`
  and stays quiet, so headless QA never shows up in the numbers.

## After deploying

- The site shows whatever the last cron cycle wrote; it has no cache of its own
  (`dynamic = 'force-dynamic'`), so a fresh cycle is visible immediately.
- If the cron machine is off, the site keeps serving the last collected data and the
  "updated" timestamp in the header goes stale. That timestamp is the health signal.
