# Event Scraper — Design

**Date:** 2026-08-02
**Status:** Draft for review
**Goal:** A queryable dataset of public events in San Francisco from Partiful, Luma, and Eventbrite. Optimized for completeness and reliability of the data gathered, not for speed of collection.

---

## 1. Scope

| Decision | Value |
|---|---|
| Purpose | Queryable event dataset (history + trends), not a personal feed |
| Coverage | One city — San Francisco — all events, unfiltered by topic |
| Storage | Supabase / Postgres |
| Orchestration | NanoClaw as **supervisor only**; pipeline runs independently |
| Language | TypeScript (matches `~/workspaces/news_agg`: `pg`, `vitest`, eslint) |

Non-goals for v1: other cities, lead-gen export, public-facing feed, attendee identity data.

---

## 2. Source surfaces

All three surfaces were verified live on 2026-08-02. This section is the load-bearing research; everything downstream depends on it.

### 2.1 Luma — no browser, no auth

```
GET https://api2.luma.com/discover/get-paginated-events
      ?latitude=37.7749&longitude=-122.4194
      &pagination_limit=50&pagination_cursor=<cursor>
Headers: Referer: https://luma.com/ , Accept: application/json, browser UA
```

Verified response shape:

```
{ entries: [ { api_id, event: { name, start_at, geo_address_info{city,region,address},
                                url, cover_url }, hosts, guest_count, ticket_count,
                ticket_info, registration_availability, featured_guests, calendar } ],
  has_more: true, next_cursor: "<base64 of {sv: start-time, fb: event-id}>" }
```

**Two traps, both found by testing and both silent.** These are the most important operational facts in this document:

1. **The pagination parameter is `pagination_cursor`, not `cursor`.** Passing `cursor` is *accepted and ignored* — the API returns HTTP 200, the same first page, and the same `next_cursor`, with `has_more: true` forever. A loop written against `cursor` never terminates and never advances. Measured on SF: `cursor` yields **45** events; `pagination_cursor` yields **779**. A 17× completeness loss with no error at any layer. The published `anhgemus/luma-scraper` uses `cursor` and caps out via a `MAX_PER_CATEGORY=100` guard, which masks the bug rather than revealing it.
2. **The `slug` (category) parameter is optional, and `slug=all` is invalid.** Omit `slug` entirely for the unfiltered feed. Passing an unrecognised slug such as `all` or `social` returns `entries: []` with no error — an empty result that looks exactly like a quiet city.

Verified full drain, SF (lat 37.7749 / lng -122.4194), 2026-08-02: **779 unique events over 17 pages, terminated cleanly on `has_more === false`.** 500 in San Francisco proper; remainder across Oakland (46), Mountain View (31), Palo Alto (27), Berkeley (25), Menlo Park (21) and other Bay Area cities. Date range 2026-08-02 → 2027-06-13.

Because discovery is lat/lng-based rather than city-bounded, **"San Francisco" is a radius, not a boundary.** The `geo_address_info.city` field must be retained per event so the boundary is a query-time decision rather than a collection-time one.

Other notes:
- A second path exists (`luma.com/<city-slug>` → `__NEXT_DATA__`), useful as a fallback. Its city is chosen by slug rather than caller IP, unlike `api.lu.ma/discover` which geolocates. Slugs are irregular (`sf`, `nyc`, `la`, `dc`).
- Event **descriptions are not in the discovery payload**. Per-event pages are rate-limited (429) when fetched in a tight loop. Descriptions are therefore a deliberate v1 gap for Luma — see §9.

### 2.2 Partiful — no browser, no auth

```
GET https://partiful.com/explore/sf                        # scrape buildId
GET https://partiful.com/_next/data/<buildId>/explore/sf.json   # 200, ~148KB JSON
```

`props.pageProps` contains four pools, all carrying the same event object:

| Pool | Count (SF) |
|---|---|
| `trendingSection.items` | 8 |
| `sections[].items` (3 curated carousels) | 26 |
| `feedItems` | 20 |
| Raw sum | 54 |
| **Union, deduped by `event.id`** | **41** (13 discarded as overlap) |

The pools overlap heavily — roughly a quarter of the raw items are repeats. Measure the
deduped union, never the raw sum. An earlier draft of this document reported ~52 by summing
the pools without deduplicating, which overstated achievable coverage and would have set the
alert floor above what the source can actually deliver.

Event object fields:
`id, title, description, locationInfo{type,hasPostCode,mapsInfo{name,addressLines}}, startDate, endDate, timezone, ownerIds[], interestedGuestCount, goingGuestCount, approvedGuestCount, maybeGuestCount, waitlistGuestCount, showGuestCount, isPublic, status, image, displaySettings`

Notes:
- `pageProps.regionEventCounts` is our completeness oracle (see §4). Point-in-time readings on 2026-08-02: **SF 67 → 65 → 64** across a few hours, alongside NYC 102, LA 107, CHI 38, DC 27, BOS 25, ATX 24, MIA 9, LON 1. It drifts continuously, so treat it as a live ratio denominator, never a fixed constant.
- `pageProps.tags` has only three categories: `DISCOVER_HOME` ("All"), `COMMUNITY`, `ARTS`. The `?tag=` query param returns byte-identical payloads, so category filtering is client-side. One request retrieves the whole city regardless.
- **`buildId` rotates on every Partiful deploy.** Current value at time of writing: `lQ8EngFIXMTxMGIl_INAM`. It must be re-scraped, never hardcoded. This is the single most likely cause of a silent break.
- Events are marked `isPublic: true` and the surface is labelled by Partiful as "Public events you can crash." Page robots meta is `noimageindex` only, not `noindex`.

### 2.3 Eventbrite — browser for cookies only

```
# Browser session, once per cycle: yields placeId (SF = 85922583) + cookie jar
GET  https://www.eventbrite.com/d/ca--san-francisco/events/   # __SERVER_DATA__ → placeId

# Then plain Node POSTs, replaying those cookies
POST https://www.eventbrite.com/api/v3/destination/search/
  Headers: X-CSRFToken: <csrftoken from cookie jar>, X-Requested-With: XMLHttpRequest,
           Cookie: <full document.cookie>, Origin: https://www.eventbrite.com, browser UA
  Body: { browse_surface: "search",
          event_search: { places: ["<placeId>"], dates: ["current_future"],
                          dedup: true, page: N, page_size: 50 },
          "expand.destination_event": [ "primary_venue", "image", "ticket_availability",
                                        "event_sales_status", "primary_organizer" ] }
```

Notes:
- **Server-side calls are NOT WAF-blocked.** Third-party recon notes claim they are, and an earlier draft of this document repeated that. Verified false on 2026-08-02: a plain Node POST carrying the browser session's cookie jar, the `csrftoken` header and an `Origin` header returns HTTP 200 with full results. The browser is needed only to *obtain* cookies and the `placeId` — never to issue requests.
- The in-page alternative does not work anyway: the gstack `browse` binary's `js` command returns empty output for any expression containing `fetch`, because it does not await network promises. Multi-line and async expressions are otherwise fine.
- **`page_size` caps at 50.** Requesting 100 or 200 silently returns 50 with `pagination.page_size` echoing 50 — no error.
- **Date-range partitioning lifts the per-query cap.** `date_range: {from, to}` works and reports honest per-window counts, so any window whose `object_count` exceeds the ~950 accessible limit is split in half and re-probed until it fits. Measured 2026-08-02: 24 adaptive windows (3-day spans in dense August, 6-month spans in sparse 2027) surfaced **12,029 unique events against 996 unpartitioned** — a 12x gain, terminating `exhausted` with zero truncated windows, in ~8 minutes over 317 requests.
- **Partitioned mode reports `expectedCount: null`.** Neither candidate denominator is valid: the unbounded `object_count` is itself capped (it read 4382 while partitioning surfaced 12,029, which would show 274% coverage), and summing per-window counts double-counts events spanning a boundary (15,017 summed vs 12,029 unique). Completeness is proven the way Luma proves it — every window drained to its own `page_count` — with both figures kept as drift signals.
- **The unpartitioned single-query path is retained** in `fetch.ts` for a fast shallow sweep; `partition.ts` is what the collector uses.
- Historical note — **the endpoint exposes only ~1000 results per query.** A full SF drain returns 996 unique events over 21 pages. `object_count` is soft and varies with page size — 4413 at page_size 5 or 20, 1000 at page_size 50 — because the accessible window is capped. So SF genuinely holds ~4413 Eventbrite events but this query surfaces roughly a quarter of them. Reaching the rest requires partitioning the search (by date range or category) into windows that each fall under the cap. Deliberately not attempted in v1; recorded as the largest known coverage gap.
- Coverage floor is 0.95, not 1.0: server-side `dedup: true` plus our own id dedup means a healthy complete drain lands at 0.996, and a 1.0 floor would mark every successful run degraded.
- Searches take internal place ids, never place names. Resolve `placeId` once from the browse page and cache it. Verified live 2026-08-02: SF resolves to `85922583`.
- Request shapes were captured from live traffic on 2026-07-30 against `web_app discover v10.14.65`. **The live version is already `10.14.68`** as of 2026-08-02 — recorded as a drift signal, with no coverage impact observed. This is what the drift channel is for; a version move only becomes actionable when paired with a coverage drop.
- **The SSR page does NOT embed a first page of results.** An earlier draft of this document claimed `search_data.events` was present on the browse page, taken from third-party recon notes without verification. The live payload has 50 top-level keys and no `search_data` key at all — the event-shaped ones are `things_to_do_shelf`, `point_of_interest_shelf`, and `search_id`. Results come from the POST search API only; there is no free first page and no SSR fallback.
- Parsing `window.__SERVER_DATA__` requires brace-counting to the matching close, not a regex anchored on `</script>`. The live page assigns several globals in one script block, so a lazy match runs past the object boundary. A regex version passed against a single-assignment fixture and returned null on every real page.

### 2.4 What was rejected

- **The official APIs.** Eventbrite killed its public Event Search API on 2020-02-20 (only by-id / by-venue / by-organization survive). Luma's official API requires Luma Plus (~$59/mo) and is scoped to your own calendar, so it cannot discover. Partiful has no public API.
- **The authenticated Partiful path.** Firebase Cloud Functions at `api.partiful.com/<fn>` with a phone/SMS-OTP Bearer token exist, but every documented endpoint is user-scoped (`getMyRsvps`, `getEvent`, `getGuestsCsv`). It cannot see a city, and it would bias the dataset to the operator's own network.
- **Apify actors.** Would work, but rent the hardest part forever and surrender control of extraction quality and field coverage.
- **Crawlee.** Genuinely good, and reconsidered if Eventbrite blocking escalates. But two of three sources are cursor loops over JSON APIs at a scale of hundreds of records. Adding a crawler framework with fingerprint rotation and autoscaling for that is unjustified weight.

---

## 3. Architecture

```
                    ┌─────────────────────────────────┐
   plain scheduler  │  fetch cycle (deterministic TS) │
   (cron / systemd) │                                 │
                    │  luma.ts       fetch + cursor   │  no browser
                    │  partiful.ts   buildId → JSON   │  no browser
                    │  eventbrite.ts browse session   │  browser (WAF + CSRF)
                    └──────────────┬──────────────────┘
                                   │ raw payloads
                                   ▼
                        normalize → CanonicalEvent
                                   │
                                   ▼
                        dedupe (deterministic rules)
                                   │
                          ┌────────┴────────┐
                          │                 │ ambiguous tail only
                          ▼                 ▼
                     Supabase        NanoClaw (container)
              events · event_sources   ├ resolve tail
              hosts · snapshots · runs ├ repair drift
                                       ├ tag / categorize
                                       └ alert on coverage drop
```

**The pipeline has no LLM in it.** Extraction, normalization, and the bulk of deduplication are deterministic TypeScript. This is deliberate: nondeterminism in the data path defeats both stated goals, because a varying output cannot be diffed to detect drift, and a hallucinated field is indistinguishable from a real one.

**The claw sits above the pipeline, never inside it.** If NanoClaw is down, collection continues and the dataset stays correct; only drift repair, tail resolution, and alerting pause. NanoClaw is chosen over Hermes for two reasons specific to this shape: scheduled jobs support **script gates** (run deterministic code, gate the agent on its output), and per-session container isolation matters because event descriptions are attacker-authored text entering a model context. Hermes's advantage is long-term memory, which here is Supabase's job.

---

## 4. The completeness oracle

This is the mechanism that makes "as close to all events as possible" measurable rather than hopeful. Each source exposes its own ground truth:

| Source | Oracle | Check | Observed 2026-08-02 |
|---|---|---|---|
| Partiful | `regionEventCounts.SF` | `fetched / reported` ≥ floor | 41 / 65 = 0.63 |
| Luma | `has_more` / `next_cursor` | terminated because `has_more === false`, not from an error, a stuck cursor, or a page cap | 779 over 17 pages, clean |
| Eventbrite | `pagination.object_count` (soft) | `fetched / reported` >= 0.95 | 996 / 1000 = 0.996 over 21 pages |

The Luma cursor trap in §2.1 is the canonical example of what this section exists to catch. Both the broken and the correct implementation return HTTP 200 with well-formed JSON and plausible-looking events. Nothing short of comparing against an exhaustion proof distinguishes 45 from 779. A monitoring approach based on "did the job error?" reports success in both cases.

Consequently the loop-termination reason is recorded explicitly, not inferred:

```ts
type Termination =
  | { kind: 'exhausted' }              // has_more === false — the only success
  | { kind: 'cursor_stuck' }           // next_cursor repeated
  | { kind: 'page_cap' }               // hit MAX_PAGES guard
  | { kind: 'error'; error: string }
```

Every cycle writes a row to `runs`:

```
run_id, source, started_at, finished_at, status,
fetched_count, expected_count, coverage_pct,
pagination_terminated_cleanly, error, drift_signals jsonb
```

Rules:
- `coverage_pct` below a per-source floor → the run is marked degraded and the claw is notified. Floor is **0.50 for Partiful** and 1.0 for the two sources that can prove exhaustion.

  The Partiful floor deserves its reasoning recorded, because getting it wrong makes the
  oracle useless in either direction. Observed coverage is 0.63, and that is the *ceiling*,
  not a shortfall to fix — a single page load simply cannot see all 65 events. A floor set
  at or above 0.63 marks every healthy run degraded, and an oracle that fires every cycle
  trains you to ignore it. A floor much below 0.50 misses the failure that actually matters:
  losing a pool. Dropping `feedItems` takes coverage to roughly 0.43 and dropping
  `sections[]` to roughly 0.38, so 0.50 catches either while tolerating normal feed rotation.
- A cursor loop that exits for any reason other than `has_more === false` is a failure, never a success with fewer rows.
- **Zero results is always an error, never an empty city.** This single rule catches most silent breaks.

Without this, a broken selector and a quiet weekend look identical in the database. With it, they are distinguishable on the first run.

---

## 5. Data model

```sql
sources        -- 'partiful' | 'luma' | 'eventbrite'

events         -- canonical, one row per real-world event
  id uuid pk, title, description, starts_at timestamptz, ends_at, timezone,
  venue_name, address, city, lat, lng,
  first_seen_at, last_seen_at, is_public, canonical_url

event_sources  -- one row per (event, source); an event cross-posted to two platforms has two
  event_id fk, source, source_event_id, source_url,
  raw jsonb,           -- full untouched payload, always
  first_seen_at, last_seen_at
  unique (source, source_event_id)

hosts
  id, source, source_host_id, display_name, profile_url
event_hosts    -- join; Partiful ownerIds[], Luma hosts[], Eventbrite primary_organizer

snapshots      -- the time series; append-only, never updated
  event_id, source, captured_at,
  interested_count, going_count, approved_count, maybe_count, waitlist_count,
  guest_count, ticket_count, registration_availability, sales_status

runs           -- see §4
```

Two deliberate choices:

**`raw jsonb` is always retained.** Reprocessing history beats re-crawling it, and when a source changes shape the raw column is the only way to backfill the new field onto old rows.

**`snapshots` is append-only, and written only on change.** Partiful exposes five guest counters and Luma exposes `guest_count` / `ticket_info` / `registration_availability`. Sampling them each cycle turns a list of events into a time series of event momentum: what fills up, how fast, which hosts reliably sell out. No API sells this — it exists only if you were recording. For a dataset whose purpose is trends, this is the asset that cannot be recovered later.

Rows are never updated or deleted, but an unchanged sample is not written at all. Guest counts are a step function, so the value at any timestamp is still the most recent row at or before it — nothing is lost. Measured 2026-08-02 at 13,277 events per cycle: **408 rows written instead of 13,277, a 97% reduction** (Eventbrite 388/11,997, Luma 13/777, Partiful 7/41). Unfiltered this would have been ~103k rows/day and ~37M/year, exhausting a Supabase free tier within weeks; filtered it is ~3.3k/day. The batch and single-row paths must agree on this rule, or a batch falling back per-row would silently reintroduce duplicates.

---

## 6. Deduplication and entity resolution

Two distinct problems, handled differently.

**Within a source** — trivial. Partiful's four pools overlap heavily; dedupe by `source_event_id` when merging `trendingSection` + `sections[].items` + `feedItems`.

**Across sources** — the same party posted to both Luma and Partiful. Deterministic first:

1. Exact match on normalized `(title, starts_at)` within a ±30 min window → same event.
2. Trigram similarity on title ≥ 0.85 **and** `starts_at` within ±30 min **and** venue/geo within ~500m → same event.
3. Anything that matches on time and geo but not title, or vice versa → **ambiguous**, queued for the claw.

Only tier 3 reaches a model. It is expected to be a small fraction, and every LLM decision is written back with its reasoning so it can be audited and reversed. A wrong merge is worse than a missed merge, so the agent's instruction is to default to "not the same event" under uncertainty.

**Measured 2026-08-02: cross-posting is rare to the point of absence.** Across a full live corpus of 1,821 events (783 Luma + 42 Partiful + 996 Eventbrite), **zero** cross-source pairs overlapped in time with even 0.30 title similarity. The three platforms serve largely disjoint communities — Luma skews tech and professional, Partiful social and invite-driven, Eventbrite ticketed and commercial. Two consequences:

- The tier thresholds are currently unexercised by production data. They are set conservatively rather than empirically, and the 0.85 title cut in particular has never fired on a real pair.
- Cross-source merging is **not** on the critical path for this dataset, and the deferred merge-writer (§ follow-on work) is lower priority than it appeared at design time. Re-measure before investing in it.

One property of the metric is worth recording because it looks like a bug and is not: trigram Jaccard is length-sensitive. Appending ` 2026` scores 0.808 against a 20-character title but 0.891 against a 40-character one, so short titles must match near-exactly to merge while longer ones tolerate suffixes.

---

## 7. Drift detection

Ranked by likelihood of firing:

| Signal | Detection | Response |
|---|---|---|
| Partiful `buildId` rotated | `_next/data` 404 | Re-scrape `/explore/sf`, retry once. Routine, not an alert |
| Partiful `pageProps` restructured | fixture contract test fails | Alert + claw inspects new shape, proposes patch |
| Luma response shape changed | fixture contract test fails | Alert + claw |
| Eventbrite app version bump | version string differs from recorded `v10.14.65` | Log as drift signal; alert only if paired with a coverage drop |
| Eventbrite WAF / CSRF failure | non-200 or empty results | Refresh browser session, retry; escalate after 3 consecutive failed cycles |
| Luma param silently ignored | termination reason ≠ `exhausted`, or unique count collapses vs. trailing median | Alert — see §2.1 |
| Any source | `coverage_pct` below floor, or zero results | Alert |

A run-over-run volume check backs up the per-source oracles: a drop of more than 40% in unique events against the trailing 7-day median is an alert regardless of what the oracle says. This is the net that catches a source inventing a *new* silent-truncation mode that no existing check anticipates.

Fixtures are frozen sample responses committed to the repo. `vitest` asserts that a live response still satisfies the expected schema. This is what converts a silent break into a loud one.

---

## 8. Politeness and error handling

- Sequential fetches with a delay between requests (~300ms, matching what is known to work against Luma). No parallel hammering.
- Exponential backoff on 429 and 5xx; a source that keeps failing degrades that source's run only, never the whole cycle.
- One source failing must not block the other two. Per-source run rows make partial cycles first-class.
- Only public, unauthenticated surfaces are read. No login, no bypassing access controls, no attendee personal data beyond aggregate counts.
- Cadence: every 3 hours. Frequent enough to catch Partiful's rotating feed and to give `snapshots` useful resolution; light enough to stay well within polite request volumes. **Assumption — adjustable.**

---

## 9. Known gaps and risks

| Gap | Impact | Mitigation |
|---|---|---|
| Partiful 41/65 on a single load | ~37% of SF events unseen per cycle | The feed rotates; accumulating across 3-hourly cycles should close most of it. Measure via `coverage_pct` before building anything more elaborate |
| Luma is radius-based, not city-bounded | 779 SF-query events span the whole Bay Area (500 actually in SF) | Retain `geo_address_info.city` per event; treat the city boundary as a query-time filter, never a collection-time one |
| Source volumes are wildly unequal | Luma 779 vs Partiful 67 — naive "events per city" analysis would read as a Luma-dominated world | Always segment trend queries by source; never aggregate raw counts across platforms without normalising |
| Luma descriptions absent from discovery | Weaker text for tagging/search | Accepted for v1. Per-event fetch is 429-prone; if needed later, do it slowly for a subset |
| Eventbrite is the only browser dependency | Its failure mode differs from the others | Isolated behind one module; if blocking escalates, this is where Crawlee + Patchright would be introduced |
| `buildId` rotation | Partiful breaks on every deploy | Never hardcoded; re-scrape and retry is routine |
| Cross-posted events inflate counts | Trend analysis skewed | Handled by §6; `event_sources` preserves the fact that an event appeared on two platforms, which is itself a signal |

**Answered 2026-08-02.** Two cycles roughly an hour apart fetched 42 and then 41 Partiful
events and accumulated **47 distinct** — so the feed does rotate and accumulation does close
the gap. Single-cycle coverage 0.63 became 0.72 accumulated after two runs. Eventbrite behaved
the same way: 996 + 996 fetched, 1014 accumulated. Host-graph snowballing and search-engine
backfill are therefore **not** needed to reach usable Partiful coverage; time does the work.
Re-measure after a week before considering either.

Original framing, kept for the record: the 41/65 gap had been observed on single fetches only, never over time. Whether 3-hourly accumulation closes it is the first empirical question the pipeline should answer, and it should be answered with data before any host-graph crawling or search-engine backfill is built.

The measurement history is itself a caution. The first pass at this number summed the four pools and reported 52; deduplicating gives 41. Every coverage figure in this document is a deduped unique count, and any future number quoted here should state which it is.

---

## 9a. Write performance

The first live cycle wrote 1821 events in **14m07s at 1% CPU** — roughly 12,700 sequential
round trips against the Supabase session pooler, essentially all latency. Batched writes
(`src/db/batch.ts`, 500 rows per batch) brought a full cycle to **47s**, of which ~45s is
network collection; the write phase is about two seconds.

The batch path deliberately keeps a per-row fallback. A failing batch is retried row by row
through the original single-row writer, so one malformed row drops only itself instead of
taking up to 499 good events with it. Fallback counts and outright failures land in the run
report's `driftSignals`, and any failure degrades the run — persistence problems are visible,
not silent.

Two Postgres details worth remembering:
- Event UUIDs are generated client-side. `insert ... returning` cannot map generated ids back
  to input rows, and client-side ids remove the need to read anything back.
- Hosts are deduplicated per batch. `on conflict do update` cannot touch the same row twice in
  one statement, which one organiser hosting several events in a batch would otherwise trigger.

---

## 10. Testing

- **Contract tests (`vitest`)** — live response satisfies the committed fixture schema, per source. These are the drift alarm.
- **Normalizer unit tests** — fixture in, `CanonicalEvent` out. Pure functions, no network.
- **Dedupe unit tests** — hand-built near-miss pairs: same title different day, same time different venue, cross-posted duplicate. Tier 3 must classify as ambiguous, not guess.
- **Oracle tests** — a truncated pagination response must produce a degraded run, not a successful one with fewer rows.

---

## 11. Build order

1. Schema + migrations.
2. `partiful.ts` — simplest complete source (one request, oracle included). Proves the pipeline end to end.
3. `luma.ts` — adds cursor pagination and its exhaustion proof.
4. Normalizer + within-source dedupe + `snapshots` writes.
5. Coverage oracle + `runs` + contract tests. **The dataset is trustworthy from here.**
6. `eventbrite.ts` — browser session, CSRF, placeId resolution.
7. Cross-source dedupe, deterministic tiers only.
8. NanoClaw supervisor: run-report reader, drift repair, ambiguous-tail resolution, alerting.

Steps 1–5 deliver a filling, verifiable dataset with no browser and no claw. Everything after is additive.

---

## Appendix: research provenance

Reverse-engineering reused rather than rediscovered:

- `anhgemus/luma-scraper` — the `api2.luma.com/discover/get-paginated-events` endpoint and the note that per-event description fetches hit 429. Its pagination is **wrong**: it passes `cursor`, which Luma ignores, so it re-reads page 1 indefinitely. Corrected here to `pagination_cursor` after live testing (§2.1). Treat published scrapers as leads to verify, not as specifications.
- `oneshot-agent/oneshot-gtm` (`packages/find/src/_luma-discover.ts`) — the `luma.com/<city-slug>` `__NEXT_DATA__` fallback, and that it selects city by slug rather than caller IP.
- `chrischall/eventbrite-mcp` (`skills/eventbrite/references/discovery-api.md`) — the `destination/search` request shape, CSRF requirement, and `placeId` resolution via `__SERVER_DATA__`. Captured 2026-07-30.
- `mrh-is/partiful-mcp`, `cerebralvalley/partiful-api` — Partiful's Firebase architecture, and the confirmation that its documented endpoints are all user-scoped.
- `KalebCole/partiful-cli` — the buildId-recon problem, independently confirmed here.

The Partiful `/explore/[region]` discovery surface, `regionEventCounts`, and the `_next/data` JSON route are not documented in any repository found during this research. They were discovered by driving the live site.
