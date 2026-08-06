# Deploying the web app to Vercel

The frontend lives in `web/`. The pipeline does **not** run on Vercel — it stays on a
local cron, because it drives a real browser to obtain Eventbrite cookies.

## One-time setup

1. Import the repo at <https://vercel.com/new>.
2. Set **Root Directory** to `web`. This is the only non-default setting; without it
   Vercel builds the pipeline instead of the app.
3. Add one environment variable, for Production, Preview and Development:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase **session pooler** URI |

   Use the pooler, not `db.<ref>.supabase.co` — the direct host is IPv6-only and
   Vercel's build and function network is IPv4.

4. Deploy.

## Why the pooler matters

Every page is server-rendered and queries Postgres directly; nothing reaches the
browser but HTML. Serverless functions are short-lived and can be many, so the pooled
connection string is what keeps Supabase's connection limit from being exhausted. The
app caps its own pool at 5 as well.

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
`/_vercel/insights/script.js` as a 404. Redeploy, then confirm:

```
curl -o /dev/null -w '%{http_code}\n' https://sf-register.vercel.app/_vercel/insights/script.js
```

Note that no beacon is sent from an automated browser: the script checks
`navigator.webdriver` and stays quiet. Headless QA runs will never show up.

## After deploying

- The site shows whatever the last cron cycle wrote; it has no cache of its own
  (`dynamic = 'force-dynamic'`), so a fresh cycle is visible immediately.
- If the cron machine is off, the site keeps serving the last collected data and the
  "updated" timestamp in the header goes stale. That timestamp is the health signal.
