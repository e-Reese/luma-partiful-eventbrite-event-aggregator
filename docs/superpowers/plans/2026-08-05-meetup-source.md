# Meetup Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add meetup.com as a fourth collection source via its unauthenticated `gql2` GraphQL endpoint, with the same exhaustion-proof discipline as the existing three sources.

**Architecture:** New `src/sources/meetup/` directory following the Luma pattern exactly — cursor-drain loop into a by-id map, injected HTTP dependency, `expectedCount: null` (exhaustion is the proof). One new HTTP helper (`httpPostJson`), one enum migration, collector registration, web frontend additions, unit + live contract tests.

**Tech Stack:** TypeScript ESM, vitest, `pg`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-05-meetup-source-design.md` — read §2 (verified surface facts) and §4 (field mapping) before starting. All endpoint behavior cited below was verified live on 2026-08-05.

---

### Task 1: `httpPostJson` helper

The pipeline's HTTP layer (`src/http.ts`) only has GET helpers. Meetup's gql2 endpoint takes POSTs. Codebase convention: network wrappers are thin and untested (the unit suite is "no network" by design — see README); all loop logic is tested through injected fakes. So this task is implementation + typecheck only; the wrapper gets exercised live in Task 6.

**Files:**
- Modify: `src/http.ts` (append after `httpGetJson`, line 37)

- [ ] **Step 1: Add the interface and implementation**

Append to `src/http.ts`:

```ts
export interface HttpPostJson {
  (url: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
}

/**
 * Real network POST with a JSON body, returning parsed JSON.
 *
 * Note for GraphQL callers: a GraphQL-level failure arrives as HTTP 200 with
 * an `errors` array in the body, which this helper does NOT treat as an error.
 * Callers must check for it themselves.
 */
export const httpPostJson: HttpPostJson = async (url, body, headers = {}) =>
  withRetry(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': BROWSER_UA, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }, { retries: 3, baseDelayMs: 500 });
```

- [ ] **Step 2: Verify it compiles and nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: clean compile, 98 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/http.ts
git commit -m "feat: add httpPostJson helper for GraphQL sources"
```

---

### Task 2: Register the `meetup` source name (types, oracle, migration, web list)

`SourceName` is a closed union enforced in four places: the TS const array, the Postgres enum, `COVERAGE_FLOORS` (a `Record<SourceName, number>`, so the compiler forces the entry), and the web's `SOURCES` list. Do them together so the repo never has a half-registered source.

**Files:**
- Modify: `src/types.ts:1`
- Modify: `src/oracle.ts:26-30`
- Create: `migrations/003_meetup.sql`
- Modify: `web/lib/sources.ts:8`
- Test: `test/types.test.ts`

- [ ] **Step 1: Update the failing test first**

Replace the first test in `test/types.test.ts`:

```ts
  it('lists exactly the four supported sources', () => {
    expect(SOURCE_NAMES).toEqual(['luma', 'partiful', 'eventbrite', 'meetup']);
  });
```

And in the `narrows unknown strings` test, change the meetup expectation:

```ts
    expect(isSourceName('meetup')).toBe(true);
    expect(isSourceName('facebook')).toBe(false);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -- test/types.test.ts`
Expected: FAIL — array mismatch and `isSourceName('meetup')` false.

- [ ] **Step 3: Make it pass**

`src/types.ts` line 1:

```ts
export const SOURCE_NAMES = ['luma', 'partiful', 'eventbrite', 'meetup'] as const;
```

`src/oracle.ts` — add to `COVERAGE_FLOORS` (and extend the doc comment above it):

```ts
export const COVERAGE_FLOORS: Record<SourceName, number> = {
  luma: 1,
  partiful: 0.5,
  eventbrite: 0.95,
  meetup: 1,
};
```

Doc comment addition, after the Partiful paragraph:

```ts
 * Meetup is held to 1.0 for the same reason as Luma: gql2's `totalCount` is the
 * page's edge count, not a corpus total (verified 2026-08-05: page 1 at
 * first:50 reports totalCount 40), so `expectedCount` is null, no ratio is ever
 * computed, and exhaustion of the cursor is the proof.
```

Create `migrations/003_meetup.sql`:

```sql
-- Meetup joins as the fourth source. ALTER TYPE ... ADD VALUE is allowed
-- inside a transaction on PG 12+, but the new value cannot be used in the
-- same transaction — fine here, since this migration only adds it.
alter type source_name add value if not exists 'meetup';
```

`web/lib/sources.ts` line 8 (update the doc comment's "three places" wording to "platforms" too):

```ts
export const SOURCES = ['luma', 'partiful', 'eventbrite', 'meetup'] as const;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all pass. The `Record<SourceName, number>` in oracle.ts would fail to compile if the floor entry were missing — that's the guard working.

- [ ] **Step 5: Apply the migration**

Run: `npm run migrate`
Expected: `003_meetup.sql ... ok`. (Safe to re-run; the `if not exists` guard makes it idempotent.)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/oracle.ts migrations/003_meetup.sql web/lib/sources.ts test/types.test.ts
git commit -m "feat: register meetup as a source across types, oracle, schema and web"
```

---

### Task 3: `fetchMeetup` — the drain loop

Luma's loop shape, adapted for GraphQL-over-POST. Three meetup-specific behaviors from spec §2.3, each with a test: pages overlap (by-id map, duplicate count as a drift signal), short pages are normal (only `hasNextPage` terminates), GraphQL errors arrive as HTTP 200 (must become `termination: error`, not silent success).

**Files:**
- Create: `src/sources/meetup/fetch.ts`
- Test: `test/sources/meetup/fetch.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/sources/meetup/fetch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { fetchMeetup } from '../../../src/sources/meetup/fetch.js';

function page(ids: string[], hasNextPage: boolean, endCursor: string | null) {
  return {
    data: {
      recommendedEvents: {
        totalCount: ids.length,
        pageInfo: { hasNextPage, endCursor },
        edges: ids.map((id) => ({
          node: { id, title: `Event ${id}`, dateTime: '2026-08-10T19:00:00-07:00' },
        })),
      },
    },
  };
}

const OPTS = { latitude: 37.7749, longitude: -122.4194, delayMs: 0 };

describe('fetchMeetup', () => {
  it('drains all pages and reports exhausted', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce(page(['a', 'b'], true, 'NTA='))
      .mockResolvedValueOnce(page(['c'], false, 'MzE1'));

    const result = await fetchMeetup({ ...OPTS, post });

    expect(result.records.map((r) => r.sourceEventId)).toEqual(['a', 'b', 'c']);
    expect(result.termination).toEqual({ kind: 'exhausted' });
    expect(result.pages).toBe(2);
    expect(result.expectedCount).toBeNull();
  });

  it('passes the cursor back as `after` and none on the first page', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce(page(['a'], true, 'CURSOR_ONE'))
      .mockResolvedValueOnce(page(['b'], false, null));

    await fetchMeetup({ ...OPTS, post });

    const firstVars = (post.mock.calls[0]![1] as any).variables;
    const secondVars = (post.mock.calls[1]![1] as any).variables;
    expect(firstVars.after).toBeNull();
    expect(secondVars.after).toBe('CURSOR_ONE');
  });

  it('dedupes overlapping pages by id and reports the overlap as drift', async () => {
    // The feed is ranked and re-ranks between pages; a 12-page live drain
    // returned 567 edges but 532 unique ids. Raw edge counts overstate coverage.
    const post = vi.fn()
      .mockResolvedValueOnce(page(['a', 'b'], true, 'c1'))
      .mockResolvedValueOnce(page(['b', 'c'], false, null));

    const result = await fetchMeetup({ ...OPTS, post });

    expect(result.records.map((r) => r.sourceEventId)).toEqual(['a', 'b', 'c']);
    expect(result.driftSignals).toMatchObject({ duplicateEdges: 1 });
  });

  it('treats a short page as normal, never as termination', async () => {
    // Live pages at first:50 return 40-50 edges mid-drain. Only hasNextPage
    // may terminate the loop.
    const post = vi.fn()
      .mockResolvedValueOnce(page(['a'], true, 'c1'))
      .mockResolvedValueOnce(page(['b'], true, 'c2'))
      .mockResolvedValueOnce(page(['c'], false, null));

    const result = await fetchMeetup({ ...OPTS, post });

    expect(result.termination).toEqual({ kind: 'exhausted' });
    expect(result.pages).toBe(3);
  });

  it('detects a stuck cursor instead of looping forever', async () => {
    const post = vi.fn().mockResolvedValue(page(['a'], true, 'SAME'));

    const result = await fetchMeetup({ ...OPTS, post });

    expect(result.termination).toEqual({ kind: 'cursor_stuck' });
    expect(post.mock.calls.length).toBeLessThan(5);
  });

  it('reports page_cap when maxPages is reached before exhaustion', async () => {
    let n = 0;
    const post = vi.fn().mockImplementation(async () => page([`e${n++}`], true, `c${n}`));

    const result = await fetchMeetup({ ...OPTS, post, maxPages: 3 });

    expect(result.termination).toEqual({ kind: 'page_cap' });
    expect(result.pages).toBe(3);
  });

  it('surfaces GraphQL-level errors as an error termination', async () => {
    // gql2 returns HTTP 200 with an errors array on validation failure —
    // schema drift must not look like a healthy empty feed.
    const post = vi.fn().mockResolvedValue({
      errors: [{ message: "Validation error (FieldUndefined) : Field 'venue'" }],
    });

    const result = await fetchMeetup({ ...OPTS, post });

    expect(result.termination.kind).toBe('error');
    expect((result.termination as { error: string }).error).toContain('FieldUndefined');
    expect(result.records).toEqual([]);
  });

  it('surfaces a thrown transport error as an error termination', async () => {
    const post = vi.fn().mockRejectedValue(new Error('HTTP 403 for https://www.meetup.com/gql2'));

    const result = await fetchMeetup({ ...OPTS, post });

    expect(result.termination).toEqual({
      kind: 'error',
      error: 'HTTP 403 for https://www.meetup.com/gql2',
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- test/sources/meetup/fetch.test.ts`
Expected: FAIL — cannot resolve `src/sources/meetup/fetch.js`.

- [ ] **Step 3: Implement**

Create `src/sources/meetup/fetch.ts`:

```ts
import type { FetchResult, RawRecord, Termination } from '../../types.js';
import { type HttpPostJson, sleep } from '../../http.js';

const GQL_URL = 'https://www.meetup.com/gql2';
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 60;
const DELAY_MS = 300;

export const MEETUP_HEADERS = {
  Accept: '*/*',
  Referer: 'https://www.meetup.com/find/',
};

/**
 * The selection the find page's own feed uses, trimmed to what normalize
 * needs. gql2 accepts arbitrary non-persisted queries with no auth (verified
 * 2026-08-05); it also validates them, so a field removed server-side comes
 * back as an `errors` array — which fetchMeetup turns into an error
 * termination rather than a silently thinner corpus.
 */
export const RECOMMENDED_EVENTS_QUERY = `
query recEvents($lat: Float!, $lon: Float!, $first: Int, $after: String) {
  recommendedEvents(filter: {lat: $lat, lon: $lon}, first: $first, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { node {
      id title description dateTime endTime eventType eventUrl rsvpState maxTickets
      venue { name address city state postalCode lat lon }
      group { id name urlname timezone city }
      going { totalCount }
      socialProofInsights { totalInterestedUsers }
      feeSettings { amount currency }
    } }
  }
}`;

interface MeetupPage {
  data?: {
    recommendedEvents?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      edges?: Array<{ node?: { id?: string } }>;
    } | null;
  } | null;
  errors?: Array<{ message?: string }>;
}

export interface FetchMeetupOptions {
  latitude: number;
  longitude: number;
  pageSize?: number;
  maxPages?: number;
  delayMs?: number;
  post: HttpPostJson;
}

/**
 * Drains Meetup's recommended-events feed for a lat/lng.
 *
 * Feed facts, verified live 2026-08-05 (see spec §2.3):
 *  - `totalCount` is the page's edge count, not a corpus total. Never use it
 *    as expectedCount; exhaustion is the proof, as with Luma.
 *  - Adjacent pages overlap (~6% on a full SF drain) because the feed
 *    re-ranks; the by-id map dedupes and the overlap is kept as a drift signal.
 *  - Short pages (40-50 edges at first:50) are normal mid-drain; only
 *    `hasNextPage === false` means exhausted.
 */
export async function fetchMeetup(opts: FetchMeetupOptions): Promise<FetchResult> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const delayMs = opts.delayMs ?? DELAY_MS;

  const byId = new Map<string, RawRecord>();
  let duplicateEdges = 0;
  let cursor: string | null = null;
  let previousCursor: string | null = null;
  let pages = 0;
  let termination: Termination = { kind: 'page_cap' };

  while (pages < maxPages) {
    let body: MeetupPage;
    try {
      body = (await opts.post(GQL_URL, {
        operationName: 'recEvents',
        variables: { lat: opts.latitude, lon: opts.longitude, first: pageSize, after: cursor },
        query: RECOMMENDED_EVENTS_QUERY,
      }, MEETUP_HEADERS)) as MeetupPage;
    } catch (err) {
      termination = { kind: 'error', error: err instanceof Error ? err.message : String(err) };
      break;
    }

    if (body.errors?.length) {
      termination = {
        kind: 'error',
        error: body.errors.map((e) => e.message ?? 'unknown GraphQL error').join('; '),
      };
      break;
    }

    pages += 1;
    const connection = body.data?.recommendedEvents;

    for (const edge of connection?.edges ?? []) {
      const id = edge?.node?.id;
      if (!id) continue;
      if (byId.has(id)) duplicateEdges += 1;
      byId.set(id, { source: 'meetup', sourceEventId: id, payload: edge.node });
    }

    if (!connection?.pageInfo?.hasNextPage) {
      termination = { kind: 'exhausted' };
      break;
    }

    const next = connection.pageInfo.endCursor ?? null;
    if (!next || next === previousCursor) {
      termination = { kind: 'cursor_stuck' };
      break;
    }

    previousCursor = next;
    cursor = next;
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    source: 'meetup',
    records: [...byId.values()],
    termination,
    expectedCount: null, // totalCount is page-local; exhaustion is the proof
    pages,
    driftSignals: { duplicateEdges },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/sources/meetup/fetch.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/meetup/fetch.ts test/sources/meetup/fetch.test.ts
git commit -m "feat: add Meetup gql2 drain loop with overlap and GraphQL-error handling"
```

---

### Task 4: `normalizeMeetup`

Field mapping from spec §4. Non-obvious rules, each with a test: `dateTime` carries a UTC offset so plain `Date` parsing is correct (the Eventbrite venue-timezone bug cannot recur); IANA timezone lives on `group`, not the event; `maxTickets: 0` means uncapped and must become null; `venue` is null for online events; `socialProofInsights` is a nullable object.

**Files:**
- Create: `src/sources/meetup/normalize.ts`
- Test: `test/sources/meetup/normalize.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/sources/meetup/normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeMeetup } from '../../../src/sources/meetup/normalize.js';
import type { RawRecord } from '../../../src/types.js';

function record(payload: Record<string, unknown>): RawRecord {
  return { source: 'meetup', sourceEventId: String(payload.id), payload };
}

const FULL = {
  id: '315938490',
  title: 'Thursday Nature Walk',
  description: 'A walk in the Presidio.',
  dateTime: '2026-08-06T17:30:00-07:00',
  endTime: '2026-08-06T19:00:00-07:00',
  eventType: 'PHYSICAL',
  eventUrl: 'https://www.meetup.com/thursday-nature-walk/events/315938490/',
  rsvpState: 'JOIN_OPEN',
  maxTickets: 10,
  venue: {
    name: 'Lobos Valley Overlook', address: '14 Wedemeyer St',
    city: 'San Francisco', state: 'CA', postalCode: '94129',
    lat: 37.787827, lon: -122.475655,
  },
  group: {
    id: '38566461', name: 'Thursday Nature Walks',
    urlname: 'thursday-nature-walk', timezone: 'America/Los_Angeles',
    city: 'San Francisco',
  },
  going: { totalCount: 7 },
  socialProofInsights: { totalInterestedUsers: 24 },
  feeSettings: null,
};

describe('normalizeMeetup', () => {
  it('maps a full physical event', () => {
    const [event] = normalizeMeetup([record(FULL)]);

    expect(event).toMatchObject({
      source: 'meetup',
      sourceEventId: '315938490',
      sourceUrl: 'https://www.meetup.com/thursday-nature-walk/events/315938490/',
      title: 'Thursday Nature Walk',
      description: 'A walk in the Presidio.',
      // -07:00 offset is in the payload; 17:30 PDT is 00:30 UTC next day.
      startsAt: '2026-08-07T00:30:00.000Z',
      endsAt: '2026-08-07T02:00:00.000Z',
      timezone: 'America/Los_Angeles',
      venueName: 'Lobos Valley Overlook',
      address: '14 Wedemeyer St',
      city: 'San Francisco',
      lat: 37.787827,
      lng: -122.475655,
      isPublic: true,
    });
    expect(event!.hosts).toEqual([{
      sourceHostId: '38566461',
      displayName: 'Thursday Nature Walks',
      profileUrl: 'https://www.meetup.com/thursday-nature-walk/',
    }]);
    expect(event!.counts).toMatchObject({
      going: 7,
      interested: 24,
      ticketCount: 10,
      registrationAvailability: 'JOIN_OPEN',
    });
    expect(event!.raw).toBe(record(FULL).payload as object);
  });

  it('treats maxTickets 0 as uncapped, not a zero-ticket event', () => {
    const [event] = normalizeMeetup([record({ ...FULL, maxTickets: 0 })]);
    expect(event!.counts.ticketCount).toBeNull();
  });

  it('handles online events with no venue', () => {
    const [event] = normalizeMeetup([record({ ...FULL, eventType: 'ONLINE', venue: null })]);
    expect(event).toMatchObject({ venueName: null, address: null, city: null, lat: null, lng: null });
  });

  it('handles missing social proof and going blocks', () => {
    const [event] = normalizeMeetup([
      record({ ...FULL, socialProofInsights: null, going: null }),
    ]);
    expect(event!.counts.interested).toBeNull();
    expect(event!.counts.going).toBeNull();
  });

  it('drops records without a title or start time', () => {
    const events = normalizeMeetup([
      record({ ...FULL, title: null }),
      record({ ...FULL, id: 'x2', dateTime: null }),
    ]);
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- test/sources/meetup/normalize.test.ts`
Expected: FAIL — cannot resolve `src/sources/meetup/normalize.js`.

- [ ] **Step 3: Implement**

Create `src/sources/meetup/normalize.ts`:

```ts
import { type CanonicalEvent, EMPTY_COUNTS, type HostRef, type RawRecord } from '../../types.js';

interface MeetupNode {
  id?: string;
  title?: string | null;
  description?: string | null;
  dateTime?: string | null;
  endTime?: string | null;
  eventType?: string | null;
  eventUrl?: string | null;
  rsvpState?: string | null;
  maxTickets?: number | null;
  venue?: {
    name?: string | null; address?: string | null; city?: string | null;
    state?: string | null; postalCode?: string | null;
    lat?: number | null; lon?: number | null;
  } | null;
  group?: {
    id?: string | null; name?: string | null; urlname?: string | null;
    timezone?: string | null; city?: string | null;
  } | null;
  going?: { totalCount?: number | null } | null;
  socialProofInsights?: { totalInterestedUsers?: number | null } | null;
}

function toHosts(node: MeetupNode): HostRef[] {
  const group = node.group;
  if (!group?.id) return [];
  return [{
    sourceHostId: group.id,
    displayName: group.name ?? null,
    profileUrl: group.urlname ? `https://www.meetup.com/${group.urlname}/` : null,
  }];
}

export function normalizeMeetup(records: RawRecord[]): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];

  for (const record of records) {
    const node = record.payload as MeetupNode;
    if (!node?.title || !node.dateTime) continue;

    const venue = node.venue ?? null;
    out.push({
      source: 'meetup',
      sourceEventId: record.sourceEventId,
      sourceUrl: node.eventUrl ?? `https://www.meetup.com/events/${record.sourceEventId}/`,
      title: node.title,
      description: node.description ?? null,
      // dateTime/endTime carry the venue's UTC offset (e.g. -07:00), so plain
      // Date parsing yields correct UTC — no venue-timezone lookup needed.
      startsAt: new Date(node.dateTime).toISOString(),
      endsAt: node.endTime ? new Date(node.endTime).toISOString() : null,
      timezone: node.group?.timezone ?? null, // IANA zone lives on the group, not the event
      venueName: venue?.name ?? null,
      address: venue?.address ?? null,
      city: venue?.city ?? null,
      lat: venue?.lat ?? null,
      lng: venue?.lon ?? null, // Meetup's field is `lon`
      isPublic: true,
      hosts: toHosts(node),
      counts: {
        ...EMPTY_COUNTS,
        going: node.going?.totalCount ?? null,
        interested: node.socialProofInsights?.totalInterestedUsers ?? null,
        // 0 means "no ticket cap", not "zero tickets".
        ticketCount: node.maxTickets ? node.maxTickets : null,
        registrationAvailability: node.rsvpState ?? null,
      },
      raw: record.payload,
    });
  }

  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/sources/meetup/normalize.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/meetup/normalize.ts test/sources/meetup/normalize.test.ts
git commit -m "feat: normalize Meetup nodes to canonical events"
```

---

### Task 5: Wire the collector into the cycle

**Files:**
- Create: `src/sources/meetup/index.ts`
- Modify: `bin/run-cycle.ts` (imports at top, collectors array at line 17)

- [ ] **Step 1: Create the barrel**

Create `src/sources/meetup/index.ts`:

```ts
export { fetchMeetup, MEETUP_HEADERS, RECOMMENDED_EVENTS_QUERY } from './fetch.js';
export { normalizeMeetup } from './normalize.js';
```

- [ ] **Step 2: Register the collector**

In `bin/run-cycle.ts`, add the import after the eventbrite imports:

```ts
import { fetchMeetup, normalizeMeetup } from '../src/sources/meetup/index.js';
```

Add `httpPostJson` to the existing http import:

```ts
import { httpGetJson, httpGetText, httpPostJson } from '../src/http.js';
```

Append to the `collectors` array (after the eventbrite entry):

```ts
  {
    source: 'meetup',
    fetch: () => fetchMeetup({ latitude: SF_LAT, longitude: SF_LNG, post: httpPostJson }),
    normalize: normalizeMeetup,
  },
```

- [ ] **Step 3: Verify everything compiles and the full suite passes**

Run: `npx tsc --noEmit && npm test`
Expected: clean compile; all unit tests pass (cycle orchestration, dedupe, batching are source-agnostic and need no changes).

- [ ] **Step 4: Run one live cycle**

Run: `npm run cycle`
Expected output includes a line like:

```
meetup: ok — ~530 events, coverage n/a, terminated exhausted
```

All four sources must report. If meetup reports `failed` or a termination other than `exhausted`, stop and diagnose against spec §2 before proceeding — do not loosen anything to get past this step.

- [ ] **Step 5: Commit**

```bash
git add src/sources/meetup/index.ts bin/run-cycle.ts
git commit -m "feat: wire Meetup into the collection cycle"
```

---

### Task 6: Live contract test

The drift alarm, mirroring `test/contract/luma.contract.test.ts`. Floor of 250 follows the Luma convention (observed 779 → floor 300 ≈ 40%; observed 532 → 250 ≈ 47%): far enough below the live number to ride out feed rotation, far above what a broken pagination loop returns (one page = ~50).

**Files:**
- Create: `test/contract/meetup.contract.test.ts`

- [ ] **Step 1: Write the contract test**

```ts
import { describe, it, expect } from 'vitest';
import { fetchMeetup } from '../../src/sources/meetup/fetch.js';
import { normalizeMeetup } from '../../src/sources/meetup/normalize.js';
import { httpPostJson } from '../../src/http.js';

describe('Meetup live contract', () => {
  it('drains SF cleanly and returns a realistic corpus', async () => {
    const result = await fetchMeetup({
      latitude: 37.7749, longitude: -122.4194, post: httpPostJson,
    });

    // Exhaustion is the only acceptable termination. A GraphQL validation
    // error here means the schema drifted (a field in
    // RECOMMENDED_EVENTS_QUERY was removed or renamed).
    expect(result.termination).toEqual({ kind: 'exhausted' });

    // Observed 532 over 12 pages on 2026-08-05. A collapse toward ~50 means
    // pagination stopped advancing (single page); toward 0 means the endpoint
    // now requires auth or persisted queries.
    expect(result.records.length).toBeGreaterThan(250);
    expect(result.pages).toBeGreaterThan(5);
  }, 300_000);

  it('still exposes every field the normalizer depends on', async () => {
    const result = await fetchMeetup({
      latitude: 37.7749, longitude: -122.4194, maxPages: 1, post: httpPostJson,
    });
    const events = normalizeMeetup(result.records);

    expect(events.length).toBeGreaterThan(0);
    const event = events[0]!;
    expect(typeof event.title).toBe('string');
    expect(Number.isNaN(Date.parse(event.startsAt))).toBe(false);
    expect(event.sourceUrl).toMatch(/^https:\/\/www\.meetup\.com\//);
    expect(event.hosts.length).toBeGreaterThan(0);
  }, 60_000);
});
```

- [ ] **Step 2: Run it live**

Run: `npm run test:contract -- test/contract/meetup.contract.test.ts`
Expected: 2 tests PASS in under 30s. (Full `npm run test:contract` runs all four sources; fine too.)

- [ ] **Step 3: Commit**

```bash
git add test/contract/meetup.contract.test.ts
git commit -m "test: add Meetup live contract as the drift alarm"
```

---

### Task 7: Completeness cross-check (decision gate — spec §6)

Exhaustion proves we drained the feed; this measures whether the *feed* itself hides events. Drain 8 weekly date-partitioned windows and compare the union against the unpartitioned drain. Runs once during implementation; kept in `scripts/` for re-measurement.

**Files:**
- Create: `scripts/meetup-completeness-check.ts`

- [ ] **Step 1: Write the script**

```ts
/**
 * One-off measurement (spec §6): does date-partitioning the recommendedEvents
 * feed surface events the unpartitioned drain misses?
 *
 * Decision rule: if the partitioned union exceeds the unpartitioned drain by
 * more than 5%, the collector must switch to partitioned drains (Eventbrite
 * pattern) before shipping.
 *
 * Offsets are hardcoded to PDT (-07:00); when re-running between November and
 * March, change to -08:00.
 */
import { fetchMeetup, RECOMMENDED_EVENTS_QUERY } from '../src/sources/meetup/fetch.js';
import { httpPostJson } from '../src/http.js';

const LAT = 37.7749;
const LNG = -122.4194;
const WEEKS = 8;

const DATE_QUERY = RECOMMENDED_EVENTS_QUERY.replace(
  'filter: {lat: $lat, lon: $lon}',
  'filter: {lat: $lat, lon: $lon, startDateRange: $start, endDateRange: $end}',
).replace(
  'query recEvents($lat: Float!, $lon: Float!, $first: Int, $after: String)',
  'query recEvents($lat: Float!, $lon: Float!, $first: Int, $after: String, $start: ZonedDateTime, $end: ZonedDateTime)',
);

function zdt(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  const day = d.toISOString().slice(0, 10);
  return `${day}T00:00:00-07:00[US/Pacific]`;
}

async function drainWindow(start: string, end: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 60; page++) {
    const body = (await httpPostJson('https://www.meetup.com/gql2', {
      operationName: 'recEvents',
      variables: { lat: LAT, lon: LNG, first: 50, after: cursor, start, end },
      query: DATE_QUERY,
    }, { Referer: 'https://www.meetup.com/find/' })) as any;
    if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
    const conn = body.data?.recommendedEvents;
    for (const edge of conn?.edges ?? []) if (edge?.node?.id) ids.add(edge.node.id);
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor ?? null;
    if (!cursor) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return ids;
}

const full = await fetchMeetup({ latitude: LAT, longitude: LNG, post: httpPostJson });
console.log(`unpartitioned: ${full.records.length} unique (${full.termination.kind})`);

const union = new Set<string>();
for (let week = 0; week < WEEKS; week++) {
  const ids = await drainWindow(zdt(week * 7), zdt((week + 1) * 7));
  for (const id of ids) union.add(id);
  console.log(`week ${week + 1}: ${ids.size} events, running union ${union.size}`);
}

const fullIds = new Set(full.records.map((r) => r.sourceEventId));
const onlyPartitioned = [...union].filter((id) => !fullIds.has(id)).length;
const ratio = union.size / fullIds.size;
console.log(`\npartitioned union: ${union.size}; only in partitioned: ${onlyPartitioned}`);
console.log(`union / unpartitioned = ${ratio.toFixed(3)} ${ratio > 1.05 ? '>> EXCEEDS 5% — switch the collector to partitioned drains' : '(within 5% — unpartitioned drain stands)'}`);
```

- [ ] **Step 2: Run it and record the verdict**

Run: `npx tsx scripts/meetup-completeness-check.ts`
Expected: a final line reporting the ratio. Note the partitioned windows only cover 8 weeks while the unpartitioned drain is unbounded, so judge on `only in partitioned` (events the feed hid), not on raw union size.

Record the measured numbers and date in spec §6 (`docs/superpowers/specs/2026-08-05-meetup-source-design.md`).

- [ ] **Step 3: Act on the verdict**

If `only in partitioned` exceeds 5% of the unpartitioned corpus: STOP — the collector must switch to date-partitioned drains before shipping. That is a design change (Eventbrite's partition pattern in `src/sources/eventbrite/partition.ts` is the template); update the spec first, then rework Task 3's loop. Otherwise proceed.

- [ ] **Step 4: Commit**

```bash
git add scripts/meetup-completeness-check.ts docs/superpowers/specs/2026-08-05-meetup-source-design.md
git commit -m "test: measure recommendedEvents feed completeness against date partitions"
```

---

### Task 8: Web frontend

`web/lib/sources.ts` was already updated in Task 2 (the search filter UI derives from it). What remains: a color token for the source dot, and the site copy that names the sources. Meetup's brand is red, but red would collide with Luma (hue 35) and the accent (hue 25) at 5px-dot size — a teal token keeps the four sources distinguishable.

**Files:**
- Modify: `web/app/globals.css:23-25` (light) and `:44-46` (dark)
- Modify: `web/components/event-card.tsx:6-9`
- Modify: `web/app/layout.tsx:24,39`

- [ ] **Step 1: Add the color tokens**

In `web/app/globals.css`, light theme block after `--color-eventbrite` (line 25):

```css
  --color-meetup: oklch(50% 0.12 165);
```

Dark theme block after `--color-eventbrite` (line 46):

```css
    --color-meetup: oklch(75% 0.11 165);
```

- [ ] **Step 2: Add the source dot mapping**

In `web/components/event-card.tsx`, extend `SOURCE_TEXT`:

```ts
const SOURCE_TEXT: Record<string, string> = {
  luma: 'text-luma',
  partiful: 'text-partiful',
  eventbrite: 'text-eventbrite',
  meetup: 'text-meetup',
};
```

- [ ] **Step 3: Update the site copy**

In `web/app/layout.tsx` line 24:

```ts
    'Every public event in San Francisco from Luma, Partiful, Eventbrite and Meetup, collected every three hours.',
```

Line 39:

```tsx
              Everything on in the city, from Luma, Partiful, Eventbrite and Meetup.
```

- [ ] **Step 4: Verify in the browser**

Run: `cd web && npm run dev`
Check: filter panel lists a `meetup` checkbox; once a cycle has run, meetup events render with a teal dot; footer copy names four sources. (Events only appear after Task 5's live cycle has written rows.)

- [ ] **Step 5: Commit**

```bash
git add web/app/globals.css web/components/event-card.tsx web/app/layout.tsx
git commit -m "feat: surface Meetup in the web frontend"
```

---

### Task 9: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the intro, sources table and notes**

Line 3-4 intro sentence — add Meetup:

```markdown
A dataset of public San Francisco events, collected from **Luma**, **Partiful**,
**Eventbrite** and **Meetup** every three hours, plus a web frontend to search it.
```

Line 6: change "None of the three sources" to "None of the four sources"; adjust the per-cycle total (~13,500).

Sources table — add the row:

```markdown
| Meetup | `POST www.meetup.com/gql2` (GraphQL) | no | ~530 |
```

Notes list — add:

```markdown
- **Meetup** — the web app's own GraphQL endpoint accepts arbitrary unauthenticated
  queries. `totalCount` is the page's edge count, not a corpus total, so exhaustion is
  the proof (as with Luma). Pages overlap ~6% because the feed re-ranks — dedupe by id
  and never count raw edges.
```

Tests section: update "live schema contracts against all three sources" to "all four sources", and bump the unit-test count to the number Task 5 reported.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add Meetup to the README"
```

---

## Self-review notes

- **Spec coverage:** §2 surface + traps → Tasks 3 (loop, overlap, short pages, GraphQL errors) and 6 (live contract); §4 mapping → Task 4; §5 touch points 1-7 → Tasks 2, 3-5, 8, and 6 respectively; §6 completeness → Task 7 with an explicit stop-the-line rule; §2.4 partition fallback → exercised by Task 7's script so it stays verified.
- **Deliberate deviations from strict TDD:** Task 1 (thin network wrapper — codebase convention keeps the unit suite network-free and tests loops via injected fakes) and Tasks 5/8/9 (wiring, CSS, copy — verified by compile, live cycle, and browser check).
- **Type consistency:** `HttpPostJson` (Task 1) is the type consumed by `FetchMeetupOptions.post` (Task 3) and `httpPostJson` is passed in Tasks 5-7; `RECOMMENDED_EVENTS_QUERY` exported in Task 3, reused in Task 7; `normalizeMeetup` consumes `RawRecord.payload` shaped by Task 3's `edge.node`.
