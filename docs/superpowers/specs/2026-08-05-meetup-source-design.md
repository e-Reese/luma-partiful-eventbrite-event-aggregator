# Meetup Source — Design

**Date:** 2026-08-05
**Status:** Draft for review
**Goal:** Add meetup.com as a fourth collection source, same city (SF), same cadence,
same completeness discipline as the existing three.

---

## 1. Scope

| Decision | Value |
|---|---|
| Surface | `POST https://www.meetup.com/gql2` — the GraphQL endpoint the find page calls |
| Coverage | Same lat/lng as Luma (SF is a radius, not a boundary; city kept per event) |
| Auth | None — no cookies, no browser, no API key |
| Non-goals | Official Meetup API (Pro-gated), per-group crawling, attendee identity data |

## 2. Source surface

Verified live on 2026-08-05. This section is the load-bearing research.

### 2.1 Access — no browser, no auth

The official Meetup API is gated behind a Meetup Pro subscription and OAuth, so it
fails the project's constraint the same way the other three sources' official APIs do.
But the web app's own GraphQL endpoint accepts **arbitrary, non-persisted queries with
no authentication**:

```
POST https://www.meetup.com/gql2
Content-Type: application/json
Headers: browser UA, Referer: https://www.meetup.com/find/

{ "operationName": "...", "variables": { ... }, "query": "query ... " }
```

It even returns schema validation errors naming unknown fields, which is how the field
selection below was derived. No persisted-query hash is required (unlike many GraphQL
frontends). A plain Node POST works.

### 2.2 The query

```graphql
query recEvents($lat: Float!, $lon: Float!, $first: Int, $after: String) {
  recommendedEvents(filter: { lat: $lat, lon: $lon }, first: $first, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { node {
      id title description dateTime endTime eventType eventUrl
      rsvpState maxTickets
      venue { name address city state postalCode lat lon }
      group { id name urlname timezone city }
      going { totalCount }
      socialProofInsights { totalInterestedUsers }
      feeSettings { amount currency }
    } }
  }
}
```

Verified full drain, SF (lat 37.7749 / lng -122.4194), 2026-08-05: **532 unique events
over 12 pages at `first: 50`, terminated cleanly on `hasNextPage === false`.** The final
page's `endCursor` switches from an offset to an event id — treat the cursor as opaque.

### 2.3 Traps, all verified live

1. **`totalCount` is the page's edge count, not a corpus total.** Page 1 at
   `first: 50` reports `totalCount: 40` with `hasNextPage: true`; page 4 reports 50.
   It must **not** be used as `expectedCount` — like Luma, exhaustion is the proof,
   and `expectedCount` stays `null`.
2. **Pages overlap.** This is a ranked recommendation feed, and adjacent pages
   re-rank: a 12-page drain returned 567 edges but 532 unique ids (~6% overlap).
   Records must be collected into a by-id map, as Luma already does. Raw edge counts
   overstate coverage.
3. **A page returns fewer edges than requested even mid-drain** (40–50 per page at
   `first: 50`). Short pages are normal and must not be treated as a termination
   signal; only `hasNextPage` is.
4. **The feed is a recommendation surface, not a search index.** The risk is that
   ranking quietly drops events a plain search would return. Mitigation in §6.

### 2.4 Date-range filtering (verified, held in reserve)

`filter` accepts `startDateRange` / `endDateRange` in ZonedDateTime format
(`"2026-09-01T00:00:00-07:00[US/Pacific]"`), verified to bound results correctly.
Not needed for v1 — 532 events drain cleanly with no result-window cap — but it is
the Eventbrite-style partition fallback if a cap ever appears, and it powers the
completeness cross-check in §6.

### 2.5 Fallback surface

`GET https://www.meetup.com/find/?location=us--ca--san%20francisco&source=EVENTS`
returns SSR HTML with an `__APOLLO_STATE__` embed containing the first feed page
(~9 events) and the exact filter shape the site itself uses. Useful for recon and
drift diagnosis, not viable as a primary surface (one page only, buildId churn).

## 3. Approaches considered

- **Official GraphQL API** — rejected: requires Meetup Pro + OAuth; not a public
  discovery surface.
- **SSR `__NEXT_DATA__` scraping (Partiful pattern)** — rejected: only the first
  ~9 events are embedded; pagination happens client-side against gql2 anyway.
- **Direct gql2 queries (chosen)** — the surface the browser itself uses, verified
  drainable to exhaustion with plain HTTP. Structurally this is the Luma pattern:
  cursor loop, by-id map, no reported total.

## 4. Field mapping

| Canonical | Meetup | Note |
|---|---|---|
| `sourceEventId` | `id` | numeric string |
| `sourceUrl` | `eventUrl` | canonical listing link |
| `title` / `description` | `title` / `description` | descriptions ARE in the feed (unlike Luma) |
| `startsAt` / `endsAt` | `dateTime` / `endTime` | carry UTC offset (`-07:00`); plain `new Date().toISOString()` is correct — the Eventbrite venue-timezone bug cannot recur here |
| `timezone` | `group.timezone` | IANA, e.g. `America/Los_Angeles`; `timezone` does not exist on `Event` |
| `venueName`/`address`/`city`/`lat`/`lng` | `venue.*` | `venue` is null for `eventType: ONLINE`; venue field is `lon`, not `lng` |
| `isPublic` | `true` | feed only surfaces public events |
| `hosts` | `group` | one HostRef: id, name, `https://www.meetup.com/<urlname>/` |
| `counts.going` | `going.totalCount` | |
| `counts.interested` | `socialProofInsights.totalInterestedUsers` | nullable object |
| `counts.ticketCount` | `maxTickets` | 0 means uncapped — normalize 0 → null |
| `counts.registrationAvailability` | `rsvpState` | e.g. `JOIN_OPEN` |

## 5. Architecture

New directory `src/sources/meetup/` (`fetch.ts`, `normalize.ts`, `index.ts`), Luma
pattern exactly: cursor loop with by-id map, `cursor_stuck` guard on a repeated
`endCursor`, `page_cap` default high enough for ~6× the observed corpus
(maxPages 60 × 50), 300ms inter-page delay, `expectedCount: null`.

Touch points, in dependency order:

1. `migrations/003_meetup.sql` — `alter type source_name add value 'meetup';`
2. `src/types.ts` — add `'meetup'` to `SOURCE_NAMES`
3. `src/oracle.ts` — `COVERAGE_FLOORS.meetup = 1` (no reported total → no ratio is
   ever computed; the entry exists to satisfy `Record<SourceName, number>`, same
   position as Luma). Volume-drop vs trailing median guards the rest.
4. `src/sources/meetup/` — fetch + normalize
5. `bin/run-cycle.ts` — register the collector
6. Web: `web/lib/sources.ts` (add `'meetup'`), `web/app/globals.css` (`--color-meetup`
   light + dark), `web/components/event-card.tsx` (`SOURCE_TEXT.meetup`)
7. Tests: `test/sources/meetup/` unit (fixture-driven fetch loop + normalize),
   `test/contract/meetup.contract.test.ts` live drift alarm

Everything else — dedupe (within and cross-source), batching, snapshots, run
reports, cycle orchestration — is source-agnostic and picks the new source up
automatically. Snapshots capture `going`/`interested` as the time series.

## 6. Completeness verification

Because the feed is a recommendation surface (§2.3 trap 4), exhaustion alone proves
we drained *the feed*, not that the feed shows *everything*. One-time check during
implementation: drain date-partitioned windows (§2.4) over the next ~8 weeks and
compare the union against the unpartitioned drain. If the partitioned union
exceeds the unpartitioned drain by more than 5%, the collector switches to
partitioned drains (Eventbrite pattern) before shipping. Either way the measured corpus size sets the contract
test floor (observed 532 → floor ~250, mirroring Luma's 779 → 300 convention).

## 7. Risks

- **Unofficial surface drift** — same posture as the other three: contract tests
  are the alarm; `raw` payload retention allows backfill after schema changes.
- **gql2 may start requiring persisted queries or bot checks** — fallback is the
  find-page SSR embed (§2.5) plus date-partitioned drains; worst case, cookie
  replay as with Eventbrite.
- **Feed incompleteness** — measured, not assumed (§6).
