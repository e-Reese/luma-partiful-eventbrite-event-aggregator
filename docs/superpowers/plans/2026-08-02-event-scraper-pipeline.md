# Event Scraper Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic pipeline that collects all public events in San Francisco from Luma, Partiful, and Eventbrite into Postgres/Supabase, and can *prove* on every run that it got everything.

**Architecture:** Three per-source modules, each owning its own fetch + normalize (they change together when a platform changes shape). Every fetcher returns an explicit `Termination` reason, and only `exhausted` counts as success. A coverage oracle compares what was fetched against each source's own ground truth and writes a `runs` row. No LLM anywhere in the data path.

**Tech Stack:** TypeScript, Node 20+, `pg` (Postgres/Supabase), `vitest`, `tsx`. No crawler framework. Eventbrite alone needs a browser, driven via the gstack `browse` binary.

**Source spec:** `docs/superpowers/specs/2026-08-02-event-scraper-design.md`

**Out of scope for this plan:** The NanoClaw supervisor (spec §3, build step 8). It is a separate subsystem with its own runtime and deserves its own plan once `runs` rows exist to supervise.

---

## File Structure

Split by **source**, not by technical layer. When Partiful rotates its buildId or restructures `pageProps`, exactly one directory changes.

```
event_scraper/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example
├── migrations/
│   └── 001_initial.sql
├── src/
│   ├── types.ts                  # shared contracts; every other file imports from here
│   ├── oracle.ts                 # termination + coverage evaluation
│   ├── cycle.ts                  # orchestrates one full collection cycle
│   ├── http.ts                   # HttpGet/HttpPost interfaces + real impls with backoff
│   ├── db/
│   │   ├── client.ts             # pg Pool
│   │   ├── events.ts             # upsert events + event_sources + hosts
│   │   ├── snapshots.ts          # append-only guest-count writes
│   │   └── runs.ts               # run report writes + trailing median
│   ├── sources/
│   │   ├── luma/{fetch.ts,normalize.ts,index.ts}
│   │   ├── partiful/{fetch.ts,normalize.ts,index.ts}
│   │   └── eventbrite/{fetch.ts,normalize.ts,index.ts}
│   └── dedupe/
│       ├── within-source.ts
│       └── cross-source.ts
├── test/
│   ├── fixtures/                 # frozen real responses — the drift alarm baseline
│   ├── contract/                 # live-network schema tests
│   └── ...                       # unit tests mirror src/ paths
└── bin/run-cycle.ts
```

---

# Phase 1 — Foundation

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`

- [ ] **Step 1: Initialise the repo and package.json**

```bash
cd ~/workspaces/event_scraper
git init
npm init -y
npm pkg set name="event_scraper" version="0.1.0" private=true type="module"
npm pkg set description="Public event dataset for SF: Luma, Partiful, Eventbrite"
npm pkg set scripts.test="vitest run --exclude 'test/contract/**'"
npm pkg set scripts.test:contract="vitest run test/contract"
npm pkg set scripts.cycle="tsx bin/run-cycle.ts"
npm pkg set scripts.migrate="psql \$DATABASE_URL -f migrations/001_initial.sql"
```

- [ ] **Step 2: Install dependencies**

```bash
npm install pg dotenv
npm install -D typescript tsx vitest @types/node @types/pg
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src", "bin", "test"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 6: Create `.env.example`**

```
DATABASE_URL=postgresql://user:password@host:5432/postgres
BROWSE_BIN=/Users/pascal/.claude/skills/gstack/browse/dist/browse
SF_LAT=37.7749
SF_LNG=-122.4194
```

- [ ] **Step 7: Verify the test runner works**

Run: `npx vitest run --reporter=verbose`
Expected: exits successfully with "No test files found" (this confirms vitest resolves; it is not an error).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example
git commit -m "chore: scaffold TypeScript project with vitest"
```

---

### Task 2: Shared types

Every later task imports from this file. Names here are binding — do not rename them downstream.

**Files:**
- Create: `src/types.ts`
- Test: `test/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/types.test.ts
import { describe, it, expect } from 'vitest';
import { SOURCE_NAMES, isSourceName } from '../src/types.js';

describe('source names', () => {
  it('lists exactly the three supported sources', () => {
    expect(SOURCE_NAMES).toEqual(['luma', 'partiful', 'eventbrite']);
  });

  it('narrows unknown strings', () => {
    expect(isSourceName('luma')).toBe(true);
    expect(isSourceName('meetup')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/types.test.ts`
Expected: FAIL — "Failed to resolve import ../src/types.js"

- [ ] **Step 3: Write `src/types.ts`**

```ts
export const SOURCE_NAMES = ['luma', 'partiful', 'eventbrite'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export function isSourceName(value: string): value is SourceName {
  return (SOURCE_NAMES as readonly string[]).includes(value);
}

/** Why a pagination loop stopped. Only `exhausted` is success. */
export type Termination =
  | { kind: 'exhausted' }
  | { kind: 'cursor_stuck' }
  | { kind: 'page_cap' }
  | { kind: 'error'; error: string };

export interface RawRecord {
  source: SourceName;
  sourceEventId: string;
  payload: unknown;
}

export interface FetchResult {
  source: SourceName;
  records: RawRecord[];
  termination: Termination;
  /** Source-reported ground truth, or null when the source cannot report one. */
  expectedCount: number | null;
  pages: number;
  driftSignals: Record<string, unknown>;
}

export interface HostRef {
  sourceHostId: string;
  displayName: string | null;
  profileUrl: string | null;
}

export interface GuestCounts {
  interested: number | null;
  going: number | null;
  approved: number | null;
  maybe: number | null;
  waitlist: number | null;
  guestCount: number | null;
  ticketCount: number | null;
  registrationAvailability: string | null;
  salesStatus: string | null;
}

export const EMPTY_COUNTS: GuestCounts = {
  interested: null, going: null, approved: null, maybe: null, waitlist: null,
  guestCount: null, ticketCount: null, registrationAvailability: null, salesStatus: null,
};

export interface CanonicalEvent {
  source: SourceName;
  sourceEventId: string;
  sourceUrl: string;
  title: string;
  description: string | null;
  startsAt: string;          // ISO 8601 UTC
  endsAt: string | null;
  timezone: string | null;
  venueName: string | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  isPublic: boolean;
  hosts: HostRef[];
  counts: GuestCounts;
  raw: unknown;
}

export type RunStatus = 'ok' | 'degraded' | 'failed';

export interface RunReport {
  source: SourceName;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  fetchedCount: number;
  expectedCount: number | null;
  coveragePct: number | null;
  terminationKind: Termination['kind'];
  error: string | null;
  driftSignals: Record<string, unknown>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/types.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/types.test.ts
git commit -m "feat: add shared pipeline types"
```

---

### Task 3: Database schema

**Files:**
- Create: `migrations/001_initial.sql`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/001_initial.sql
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

do $$ begin
  create type source_name as enum ('luma', 'partiful', 'eventbrite');
exception when duplicate_object then null; end $$;

create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  timezone      text,
  venue_name    text,
  address       text,
  city          text,
  lat           double precision,
  lng           double precision,
  is_public     boolean not null default true,
  canonical_url text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists events_starts_at_idx on events (starts_at);
create index if not exists events_city_idx      on events (city);
create index if not exists events_title_trgm_idx on events using gin (title gin_trgm_ops);

-- One row per (event, platform). A cross-posted event has two rows.
create table if not exists event_sources (
  id              bigserial primary key,
  event_id        uuid not null references events(id) on delete cascade,
  source          source_name not null,
  source_event_id text not null,
  source_url      text,
  raw             jsonb not null,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  unique (source, source_event_id)
);

create index if not exists event_sources_event_idx on event_sources (event_id);

create table if not exists hosts (
  id             uuid primary key default gen_random_uuid(),
  source         source_name not null,
  source_host_id text not null,
  display_name   text,
  profile_url    text,
  unique (source, source_host_id)
);

create table if not exists event_hosts (
  event_id uuid not null references events(id) on delete cascade,
  host_id  uuid not null references hosts(id)  on delete cascade,
  primary key (event_id, host_id)
);

-- Append-only time series. Never updated, never deleted.
create table if not exists snapshots (
  id                        bigserial primary key,
  event_id                  uuid not null references events(id) on delete cascade,
  source                    source_name not null,
  captured_at               timestamptz not null default now(),
  interested_count          int,
  going_count               int,
  approved_count            int,
  maybe_count               int,
  waitlist_count            int,
  guest_count               int,
  ticket_count              int,
  registration_availability text,
  sales_status              text
);

create index if not exists snapshots_event_captured_idx
  on snapshots (event_id, captured_at desc);

create table if not exists runs (
  id               bigserial primary key,
  source           source_name not null,
  started_at       timestamptz not null,
  finished_at      timestamptz not null,
  status           text not null check (status in ('ok', 'degraded', 'failed')),
  fetched_count    int not null,
  expected_count   int,
  coverage_pct     numeric(5,4),
  termination_kind text not null,
  error            text,
  drift_signals    jsonb not null default '{}'::jsonb
);

create index if not exists runs_source_started_idx on runs (source, started_at desc);
```

- [ ] **Step 2: Apply the migration**

```bash
cp .env.example .env    # then edit .env with the real DATABASE_URL
set -a && source .env && set +a
psql "$DATABASE_URL" -f migrations/001_initial.sql
```

Expected: `CREATE EXTENSION` / `CREATE TABLE` / `CREATE INDEX` lines, no ERROR.

- [ ] **Step 3: Verify the tables exist**

Run: `psql "$DATABASE_URL" -c "\dt"`
Expected: `event_hosts`, `event_sources`, `events`, `hosts`, `runs`, `snapshots`

- [ ] **Step 4: Commit**

```bash
git add migrations/001_initial.sql
git commit -m "feat: add initial database schema"
```

---

### Task 4: HTTP layer with backoff

**Files:**
- Create: `src/http.ts`
- Test: `test/http.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/http.test.ts
import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../src/http.js';

describe('withRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting retries and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/http.test.ts`
Expected: FAIL — cannot resolve `../src/http.js`

- [ ] **Step 3: Write `src/http.ts`**

```ts
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface HttpGet {
  (url: string, headers?: Record<string, string>): Promise<unknown>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseDelayMs: number },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < opts.retries) {
        await sleep(opts.baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

/** Real network GET returning parsed JSON. Retries on transient failure. */
export const httpGetJson: HttpGet = async (url, headers = {}) =>
  withRetry(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }, { retries: 3, baseDelayMs: 500 });

/** Real network GET returning raw text (for HTML pages). */
export async function httpGetText(
  url: string,
  headers: Record<string, string> = {},
): Promise<string> {
  return withRetry(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }, { retries: 3, baseDelayMs: 500 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/http.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/http.ts test/http.test.ts
git commit -m "feat: add HTTP layer with exponential backoff"
```

---

# Phase 2 — Luma

Luma is built first because it is the largest source (779 SF events) and because it carries the trap that justifies the whole design.

### Task 5: Luma fetcher

**The critical regression test in this plan is Step 1's third case.** Luma accepts `cursor` and silently ignores it, returning HTTP 200, the same page, and the same cursor forever — 45 events instead of 779. The parameter must be `pagination_cursor`. A test asserts the emitted URL so this can never regress.

**Files:**
- Create: `src/sources/luma/fetch.ts`
- Test: `test/sources/luma/fetch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/sources/luma/fetch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fetchLuma } from '../../../src/sources/luma/fetch.js';

function page(ids: string[], hasMore: boolean, cursor: string | null) {
  return {
    entries: ids.map((id) => ({
      api_id: id,
      event: { name: `Event ${id}`, start_at: '2026-08-10T19:00:00.000Z', url: `slug-${id}` },
    })),
    has_more: hasMore,
    next_cursor: cursor,
  };
}

describe('fetchLuma', () => {
  it('drains all pages and reports exhausted', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(page(['a', 'b'], true, 'c1'))
      .mockResolvedValueOnce(page(['c'], false, null));

    const result = await fetchLuma({ latitude: 37.7749, longitude: -122.4194, get });

    expect(result.records.map((r) => r.sourceEventId)).toEqual(['a', 'b', 'c']);
    expect(result.termination).toEqual({ kind: 'exhausted' });
    expect(result.pages).toBe(2);
  });

  it('uses pagination_cursor, never cursor — regression guard for the 17x truncation bug', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(page(['a'], true, 'CURSOR_ONE'))
      .mockResolvedValueOnce(page(['b'], false, null));

    await fetchLuma({ latitude: 37.7749, longitude: -122.4194, get });

    const secondUrl = get.mock.calls[1]![0] as string;
    expect(secondUrl).toContain('pagination_cursor=CURSOR_ONE');
    expect(secondUrl).not.toMatch(/[?&]cursor=/);
  });

  it('detects a stuck cursor instead of looping forever', async () => {
    const get = vi.fn().mockResolvedValue(page(['a'], true, 'SAME'));

    const result = await fetchLuma({ latitude: 37.7749, longitude: -122.4194, get });

    expect(result.termination).toEqual({ kind: 'cursor_stuck' });
    expect(get.mock.calls.length).toBeLessThan(5);
  });

  it('reports page_cap when maxPages is reached before exhaustion', async () => {
    let n = 0;
    const get = vi.fn().mockImplementation(async () => page([`e${n++}`], true, `c${n}`));

    const result = await fetchLuma({
      latitude: 37.7749, longitude: -122.4194, get, maxPages: 3,
    });

    expect(result.termination).toEqual({ kind: 'page_cap' });
    expect(result.pages).toBe(3);
  });

  it('captures a thrown error as an error termination, keeping records so far', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(page(['a'], true, 'c1'))
      .mockRejectedValueOnce(new Error('network down'));

    const result = await fetchLuma({ latitude: 37.7749, longitude: -122.4194, get });

    expect(result.termination).toEqual({ kind: 'error', error: 'network down' });
    expect(result.records).toHaveLength(1);
  });

  it('never sends a slug param, because slug=all silently returns zero events', async () => {
    const get = vi.fn().mockResolvedValueOnce(page(['a'], false, null));

    await fetchLuma({ latitude: 37.7749, longitude: -122.4194, get });

    expect(get.mock.calls[0]![0] as string).not.toContain('slug=');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sources/luma/fetch.test.ts`
Expected: FAIL — cannot resolve `fetchLuma`

- [ ] **Step 3: Write `src/sources/luma/fetch.ts`**

```ts
import type { FetchResult, RawRecord, Termination } from '../../types.js';
import { type HttpGet, sleep } from '../../http.js';

const BASE = 'https://api2.luma.com/discover/get-paginated-events';
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 60;
const DELAY_MS = 300;

export const LUMA_HEADERS = {
  Accept: 'application/json',
  Referer: 'https://luma.com/',
};

interface LumaPage {
  entries?: Array<{ api_id?: string }>;
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface FetchLumaOptions {
  latitude: number;
  longitude: number;
  pageSize?: number;
  maxPages?: number;
  delayMs?: number;
  get: HttpGet;
}

/**
 * Drains Luma's discovery feed.
 *
 * Two non-obvious rules, both verified against the live API on 2026-08-02:
 *  - The cursor parameter is `pagination_cursor`. Passing `cursor` is accepted
 *    and ignored: same page, same cursor, has_more true forever (45 vs 779 events).
 *  - `slug` (category) is omitted deliberately. An unrecognised slug such as
 *    `all` returns an empty entries array with no error.
 */
export async function fetchLuma(opts: FetchLumaOptions): Promise<FetchResult> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const delayMs = opts.delayMs ?? DELAY_MS;

  const byId = new Map<string, RawRecord>();
  let cursor: string | null = null;
  let previousCursor: string | null = null;
  let pages = 0;
  let termination: Termination = { kind: 'page_cap' };

  while (pages < maxPages) {
    const params = new URLSearchParams({
      latitude: String(opts.latitude),
      longitude: String(opts.longitude),
      pagination_limit: String(pageSize),
    });
    if (cursor) params.set('pagination_cursor', cursor);

    let body: LumaPage;
    try {
      body = (await opts.get(`${BASE}?${params.toString()}`, LUMA_HEADERS)) as LumaPage;
    } catch (err) {
      termination = { kind: 'error', error: err instanceof Error ? err.message : String(err) };
      break;
    }

    pages += 1;

    for (const entry of body.entries ?? []) {
      if (!entry?.api_id) continue;
      byId.set(entry.api_id, {
        source: 'luma',
        sourceEventId: entry.api_id,
        payload: entry,
      });
    }

    if (!body.has_more) {
      termination = { kind: 'exhausted' };
      break;
    }

    const next = body.next_cursor ?? null;
    if (!next || next === previousCursor) {
      termination = { kind: 'cursor_stuck' };
      break;
    }

    previousCursor = next;
    cursor = next;
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    source: 'luma',
    records: [...byId.values()],
    termination,
    expectedCount: null, // Luma reports no total; exhaustion is its proof
    pages,
    driftSignals: {},
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sources/luma/fetch.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/sources/luma/fetch.ts test/sources/luma/fetch.test.ts
git commit -m "feat: add Luma fetcher with cursor-truncation guards"
```

---

### Task 6: Luma normalizer

**Files:**
- Create: `src/sources/luma/normalize.ts`
- Test: `test/sources/luma/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/sources/luma/normalize.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeLuma } from '../../../src/sources/luma/normalize.js';
import type { RawRecord } from '../../../src/types.js';

const record: RawRecord = {
  source: 'luma',
  sourceEventId: 'evt-6J4GrvPZ2jtGWHD',
  payload: {
    api_id: 'evt-6J4GrvPZ2jtGWHD',
    guest_count: 42,
    ticket_count: 10,
    registration_availability: 'available',
    hosts: [{ api_id: 'usr-1', name: 'Ada', url: 'ada' }],
    event: {
      name: 'AI Innovation Studio',
      start_at: '2026-08-02T01:30:00.000Z',
      end_at: '2026-08-02T04:30:00.000Z',
      timezone: 'America/Los_Angeles',
      url: '5g7a63ns',
      geo_address_info: {
        city: 'Milpitas', region: 'California',
        address: 'California Science And Technology University',
      },
      coordinate: { latitude: 37.43, longitude: -121.9 },
    },
  },
};

describe('normalizeLuma', () => {
  it('maps a discovery entry to a CanonicalEvent', () => {
    const [event] = normalizeLuma([record]);
    expect(event).toBeDefined();
    expect(event!.source).toBe('luma');
    expect(event!.title).toBe('AI Innovation Studio');
    expect(event!.startsAt).toBe('2026-08-02T01:30:00.000Z');
    expect(event!.endsAt).toBe('2026-08-02T04:30:00.000Z');
    expect(event!.city).toBe('Milpitas');
    expect(event!.sourceUrl).toBe('https://lu.ma/5g7a63ns');
    expect(event!.counts.guestCount).toBe(42);
    expect(event!.hosts).toEqual([
      { sourceHostId: 'usr-1', displayName: 'Ada', profileUrl: 'https://lu.ma/user/ada' },
    ]);
  });

  it('leaves description null — the discovery payload has no description field', () => {
    const [event] = normalizeLuma([record]);
    expect(event!.description).toBeNull();
  });

  it('skips records missing a title or start time rather than emitting a broken row', () => {
    const broken: RawRecord = {
      source: 'luma', sourceEventId: 'x', payload: { event: { name: null } },
    };
    expect(normalizeLuma([broken])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sources/luma/normalize.test.ts`
Expected: FAIL — cannot resolve `normalizeLuma`

- [ ] **Step 3: Write `src/sources/luma/normalize.ts`**

```ts
import { type CanonicalEvent, EMPTY_COUNTS, type HostRef, type RawRecord } from '../../types.js';

interface LumaEntry {
  api_id?: string;
  guest_count?: number | null;
  ticket_count?: number | null;
  registration_availability?: string | null;
  hosts?: Array<{ api_id?: string; name?: string | null; url?: string | null }>;
  event?: {
    name?: string | null;
    start_at?: string | null;
    end_at?: string | null;
    timezone?: string | null;
    url?: string | null;
    geo_address_info?: {
      city?: string | null; region?: string | null; address?: string | null;
    } | null;
    coordinate?: { latitude?: number | null; longitude?: number | null } | null;
  } | null;
}

function toHosts(entry: LumaEntry): HostRef[] {
  return (entry.hosts ?? [])
    .filter((h): h is { api_id: string; name?: string | null; url?: string | null } =>
      typeof h?.api_id === 'string')
    .map((h) => ({
      sourceHostId: h.api_id,
      displayName: h.name ?? null,
      profileUrl: h.url ? `https://lu.ma/user/${h.url}` : null,
    }));
}

export function normalizeLuma(records: RawRecord[]): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];

  for (const record of records) {
    const entry = record.payload as LumaEntry;
    const ev = entry?.event;
    if (!ev?.name || !ev.start_at) continue;

    const geo = ev.geo_address_info ?? null;
    out.push({
      source: 'luma',
      sourceEventId: record.sourceEventId,
      sourceUrl: ev.url ? `https://lu.ma/${ev.url}` : `https://lu.ma/${record.sourceEventId}`,
      title: ev.name,
      description: null, // not present in the discovery payload; see spec §9
      startsAt: new Date(ev.start_at).toISOString(),
      endsAt: ev.end_at ? new Date(ev.end_at).toISOString() : null,
      timezone: ev.timezone ?? null,
      venueName: geo?.address ?? null,
      address: geo?.address ?? null,
      city: geo?.city ?? null,
      lat: ev.coordinate?.latitude ?? null,
      lng: ev.coordinate?.longitude ?? null,
      isPublic: true,
      hosts: toHosts(entry),
      counts: {
        ...EMPTY_COUNTS,
        guestCount: entry.guest_count ?? null,
        ticketCount: entry.ticket_count ?? null,
        registrationAvailability: entry.registration_availability ?? null,
      },
      raw: record.payload,
    });
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sources/luma/normalize.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/sources/luma/normalize.ts test/sources/luma/normalize.test.ts
git commit -m "feat: add Luma normalizer"
```

---

# Phase 3 — Partiful

### Task 7: Partiful fetcher

Partiful serves its city page as a Next.js static page. The `buildId` rotates on every deploy, so it is scraped fresh each cycle and a 404 triggers exactly one re-scrape and retry.

**Files:**
- Create: `src/sources/partiful/fetch.ts`
- Test: `test/sources/partiful/fetch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/sources/partiful/fetch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractBuildId, fetchPartiful } from '../../../src/sources/partiful/fetch.js';

const HTML = `<html><body><script id="__NEXT_DATA__" type="application/json">
{"buildId":"lQ8EngFIXMTxMGIl_INAM","props":{"pageProps":{}}}
</script></body></html>`;

function item(id: string) {
  return { id: `item-${id}`, type: 'EVENT', tags: [], event: { id, title: `E${id}` } };
}

const PAGE = {
  pageProps: {
    region: 'SF',
    regionEventCounts: { SF: 67, NYC: 102 },
    trendingSection: { id: 'sf-trending', items: [item('a')] },
    sections: [{ id: 'sf-arts', items: [item('b'), item('c')] }],
    feedItems: [item('c'), item('d')], // 'c' intentionally duplicated across pools
  },
};

describe('extractBuildId', () => {
  it('pulls buildId out of the embedded __NEXT_DATA__', () => {
    expect(extractBuildId(HTML)).toBe('lQ8EngFIXMTxMGIl_INAM');
  });

  it('returns null when the page has no __NEXT_DATA__', () => {
    expect(extractBuildId('<html></html>')).toBeNull();
  });
});

describe('fetchPartiful', () => {
  it('merges all four pools and dedupes by event id', async () => {
    const getText = vi.fn().mockResolvedValue(HTML);
    const getJson = vi.fn().mockResolvedValue(PAGE);

    const result = await fetchPartiful({ region: 'sf', getText, getJson });

    expect(result.records.map((r) => r.sourceEventId).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(result.termination).toEqual({ kind: 'exhausted' });
  });

  it('reports regionEventCounts for the requested region as the oracle', async () => {
    const getText = vi.fn().mockResolvedValue(HTML);
    const getJson = vi.fn().mockResolvedValue(PAGE);

    const result = await fetchPartiful({ region: 'sf', getText, getJson });

    expect(result.expectedCount).toBe(67);
    expect(result.driftSignals.buildId).toBe('lQ8EngFIXMTxMGIl_INAM');
  });

  it('re-scrapes the buildId once when the data route 404s', async () => {
    const getText = vi.fn().mockResolvedValue(HTML);
    const getJson = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP 404 for /_next/data/stale/explore/sf.json'))
      .mockResolvedValueOnce(PAGE);

    const result = await fetchPartiful({
      region: 'sf', getText, getJson, knownBuildId: 'stale',
    });

    expect(getText).toHaveBeenCalledTimes(1);
    expect(result.termination).toEqual({ kind: 'exhausted' });
    expect(result.driftSignals.buildIdRotated).toBe(true);
  });

  it('records an error termination when the retry also fails', async () => {
    const getText = vi.fn().mockResolvedValue(HTML);
    const getJson = vi.fn().mockRejectedValue(new Error('HTTP 500'));

    const result = await fetchPartiful({ region: 'sf', getText, getJson });

    expect(result.termination.kind).toBe('error');
    expect(result.records).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sources/partiful/fetch.test.ts`
Expected: FAIL — cannot resolve `extractBuildId`

- [ ] **Step 3: Write `src/sources/partiful/fetch.ts`**

```ts
import type { FetchResult, RawRecord, Termination } from '../../types.js';

const ORIGIN = 'https://partiful.com';
const NEXT_DATA_RE =
  /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

interface PartifulItem {
  id?: string;
  tags?: Array<{ id?: string; label?: string }>;
  event?: { id?: string };
}

interface PartifulPage {
  pageProps?: {
    region?: string;
    regionEventCounts?: Record<string, number>;
    trendingSection?: { items?: PartifulItem[] } | null;
    sections?: Array<{ items?: PartifulItem[] }>;
    feedItems?: PartifulItem[];
  };
}

export interface FetchPartifulOptions {
  region: string;                                   // 'sf', 'nyc', 'la', ...
  getText: (url: string) => Promise<string>;
  getJson: (url: string) => Promise<unknown>;
  knownBuildId?: string;
}

/** Pull the Next.js buildId out of a Partiful HTML page. */
export function extractBuildId(html: string): string | null {
  const match = NEXT_DATA_RE.exec(html);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as { buildId?: string };
    return parsed.buildId ?? null;
  } catch {
    return null;
  }
}

function collect(page: PartifulPage): PartifulItem[] {
  const props = page.pageProps ?? {};
  return [
    ...(props.trendingSection?.items ?? []),
    ...(props.sections ?? []).flatMap((s) => s.items ?? []),
    ...(props.feedItems ?? []),
  ];
}

/**
 * Fetches one Partiful region page.
 *
 * The buildId rotates on every Partiful deploy, so it is never hardcoded. A 404
 * on the data route means the build moved: re-scrape once and retry.
 */
export async function fetchPartiful(opts: FetchPartifulOptions): Promise<FetchResult> {
  const region = opts.region.toLowerCase();
  const driftSignals: Record<string, unknown> = {};
  let termination: Termination = { kind: 'exhausted' };
  let page: PartifulPage | null = null;
  let buildId = opts.knownBuildId ?? null;

  const dataUrl = (id: string) => `${ORIGIN}/_next/data/${id}/explore/${region}.json`;

  const scrapeBuildId = async (): Promise<string | null> =>
    extractBuildId(await opts.getText(`${ORIGIN}/explore/${region}`));

  try {
    if (!buildId) buildId = await scrapeBuildId();
    if (!buildId) throw new Error('could not extract buildId');

    try {
      page = (await opts.getJson(dataUrl(buildId))) as PartifulPage;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('404')) throw err;
      const fresh = await scrapeBuildId();
      if (!fresh) throw new Error('buildId rotated and could not be re-scraped');
      driftSignals.buildIdRotated = true;
      buildId = fresh;
      page = (await opts.getJson(dataUrl(fresh))) as PartifulPage;
    }
  } catch (err) {
    termination = { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }

  driftSignals.buildId = buildId;

  const byId = new Map<string, RawRecord>();
  let expectedCount: number | null = null;

  if (page) {
    for (const item of collect(page)) {
      const id = item.event?.id;
      if (!id) continue;
      byId.set(id, { source: 'partiful', sourceEventId: id, payload: item });
    }
    const counts = page.pageProps?.regionEventCounts ?? {};
    expectedCount = counts[region.toUpperCase()] ?? null;
  }

  return {
    source: 'partiful',
    records: [...byId.values()],
    termination,
    expectedCount,
    pages: page ? 1 : 0,
    driftSignals,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sources/partiful/fetch.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/sources/partiful/fetch.ts test/sources/partiful/fetch.test.ts
git commit -m "feat: add Partiful fetcher with buildId rotation handling"
```

---

### Task 8: Partiful normalizer

**Files:**
- Create: `src/sources/partiful/normalize.ts`
- Test: `test/sources/partiful/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/sources/partiful/normalize.test.ts
import { describe, it, expect } from 'vitest';
import { normalizePartiful } from '../../../src/sources/partiful/normalize.js';
import type { RawRecord } from '../../../src/types.js';

const record: RawRecord = {
  source: 'partiful',
  sourceEventId: 'muz6tv150fmIFm9wcdte',
  payload: {
    id: 'item-1',
    tags: [{ id: 'COMMUNITY', label: 'Community' }],
    event: {
      id: 'muz6tv150fmIFm9wcdte',
      title: 'Run for Mutts',
      description: 'Join us for a community run/walk',
      startDate: '2026-09-05T16:00:00.000Z',
      endDate: null,
      timezone: 'America/Los_Angeles',
      ownerIds: ['KARWuleKo9czrJaphLHFV5RBTCf2'],
      interestedGuestCount: 163,
      goingGuestCount: 65,
      approvedGuestCount: 0,
      maybeGuestCount: 25,
      waitlistGuestCount: 0,
      isPublic: true,
      status: 'PUBLISHED',
      locationInfo: {
        type: 'structured',
        mapsInfo: { name: 'Crosstown Trail', addressLines: ['San Francisco, CA'] },
      },
    },
  },
};

describe('normalizePartiful', () => {
  it('maps an explore item to a CanonicalEvent', () => {
    const [event] = normalizePartiful([record]);
    expect(event!.title).toBe('Run for Mutts');
    expect(event!.description).toBe('Join us for a community run/walk');
    expect(event!.startsAt).toBe('2026-09-05T16:00:00.000Z');
    expect(event!.endsAt).toBeNull();
    expect(event!.venueName).toBe('Crosstown Trail');
    expect(event!.address).toBe('San Francisco, CA');
    expect(event!.sourceUrl).toBe('https://partiful.com/e/muz6tv150fmIFm9wcdte');
  });

  it('maps all five guest counters', () => {
    const [event] = normalizePartiful([record]);
    expect(event!.counts.interested).toBe(163);
    expect(event!.counts.going).toBe(65);
    expect(event!.counts.approved).toBe(0);
    expect(event!.counts.maybe).toBe(25);
    expect(event!.counts.waitlist).toBe(0);
  });

  it('maps ownerIds to hosts', () => {
    const [event] = normalizePartiful([record]);
    expect(event!.hosts).toEqual([
      { sourceHostId: 'KARWuleKo9czrJaphLHFV5RBTCf2', displayName: null, profileUrl: null },
    ]);
  });

  it('skips events that are not PUBLISHED', () => {
    const draft = structuredClone(record) as RawRecord;
    (draft.payload as any).event.status = 'DRAFT';
    expect(normalizePartiful([draft])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sources/partiful/normalize.test.ts`
Expected: FAIL — cannot resolve `normalizePartiful`

- [ ] **Step 3: Write `src/sources/partiful/normalize.ts`**

```ts
import { type CanonicalEvent, EMPTY_COUNTS, type RawRecord } from '../../types.js';

interface PartifulPayload {
  event?: {
    id?: string;
    title?: string | null;
    description?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    timezone?: string | null;
    ownerIds?: string[];
    interestedGuestCount?: number | null;
    goingGuestCount?: number | null;
    approvedGuestCount?: number | null;
    maybeGuestCount?: number | null;
    waitlistGuestCount?: number | null;
    isPublic?: boolean;
    status?: string | null;
    locationInfo?: {
      mapsInfo?: { name?: string | null; addressLines?: string[] } | null;
    } | null;
  } | null;
}

export function normalizePartiful(records: RawRecord[]): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];

  for (const record of records) {
    const ev = (record.payload as PartifulPayload)?.event;
    if (!ev?.title || !ev.startDate) continue;
    if (ev.status && ev.status !== 'PUBLISHED') continue;

    const maps = ev.locationInfo?.mapsInfo ?? null;
    const address = maps?.addressLines?.join(', ') ?? null;

    out.push({
      source: 'partiful',
      sourceEventId: record.sourceEventId,
      sourceUrl: `https://partiful.com/e/${record.sourceEventId}`,
      title: ev.title,
      description: ev.description ?? null,
      startsAt: new Date(ev.startDate).toISOString(),
      endsAt: ev.endDate ? new Date(ev.endDate).toISOString() : null,
      timezone: ev.timezone ?? null,
      venueName: maps?.name ?? null,
      address,
      city: null, // Partiful gives a free-text address, not a city field
      lat: null,
      lng: null,
      isPublic: ev.isPublic ?? true,
      hosts: (ev.ownerIds ?? []).map((id) => ({
        sourceHostId: id, displayName: null, profileUrl: null,
      })),
      counts: {
        ...EMPTY_COUNTS,
        interested: ev.interestedGuestCount ?? null,
        going: ev.goingGuestCount ?? null,
        approved: ev.approvedGuestCount ?? null,
        maybe: ev.maybeGuestCount ?? null,
        waitlist: ev.waitlistGuestCount ?? null,
      },
      raw: record.payload,
    });
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sources/partiful/normalize.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/sources/partiful/normalize.ts test/sources/partiful/normalize.test.ts
git commit -m "feat: add Partiful normalizer"
```

---

# Phase 4 — Oracle and persistence

### Task 9: Coverage oracle

This is the mechanism that distinguishes "quiet weekend" from "silently broken."

**Files:**
- Create: `src/oracle.ts`
- Test: `test/oracle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/oracle.test.ts
import { describe, it, expect } from 'vitest';
import { COVERAGE_FLOORS, evaluateRun, VOLUME_DROP_THRESHOLD } from '../src/oracle.js';
import type { FetchResult } from '../src/types.js';

function result(over: Partial<FetchResult> = {}): FetchResult {
  return {
    source: 'luma',
    records: Array.from({ length: 779 }, (_, i) => ({
      source: 'luma' as const, sourceEventId: `e${i}`, payload: {},
    })),
    termination: { kind: 'exhausted' },
    expectedCount: null,
    pages: 17,
    driftSignals: {},
    ...over,
  };
}

describe('evaluateRun', () => {
  it('marks a cleanly exhausted run ok', () => {
    expect(evaluateRun(result()).status).toBe('ok');
  });

  it('marks a stuck cursor degraded even though rows were returned', () => {
    const report = evaluateRun(result({ termination: { kind: 'cursor_stuck' } }));
    expect(report.status).toBe('degraded');
    expect(report.terminationKind).toBe('cursor_stuck');
  });

  it('marks a page_cap termination degraded', () => {
    expect(evaluateRun(result({ termination: { kind: 'page_cap' } })).status).toBe('degraded');
  });

  it('marks an error termination failed', () => {
    const report = evaluateRun(result({
      termination: { kind: 'error', error: 'network down' }, records: [],
    }));
    expect(report.status).toBe('failed');
    expect(report.error).toBe('network down');
  });

  it('treats zero records as an error, never as an empty city', () => {
    expect(evaluateRun(result({ records: [] })).status).toBe('degraded');
  });

  it('computes coverage against a source-reported expected count', () => {
    const report = evaluateRun(result({
      source: 'partiful',
      records: Array.from({ length: 52 }, (_, i) => ({
        source: 'partiful' as const, sourceEventId: `p${i}`, payload: {},
      })),
      expectedCount: 67,
    }));
    expect(report.coveragePct).toBeCloseTo(0.7761, 3);
    expect(report.status).toBe('ok'); // 0.776 clears the 0.75 Partiful floor
  });

  it('degrades when coverage falls below the source floor', () => {
    const report = evaluateRun(result({
      source: 'partiful',
      records: Array.from({ length: 10 }, (_, i) => ({
        source: 'partiful' as const, sourceEventId: `p${i}`, payload: {},
      })),
      expectedCount: 67,
    }));
    expect(report.status).toBe('degraded');
  });

  it('degrades on a large volume drop against the trailing median', () => {
    const report = evaluateRun(
      result({ records: [{ source: 'luma', sourceEventId: 'e1', payload: {} }] }),
      { trailingMedian: 779 },
    );
    expect(report.status).toBe('degraded');
  });

  it('exposes the configured floors', () => {
    expect(COVERAGE_FLOORS.partiful).toBe(0.75);
    expect(COVERAGE_FLOORS.luma).toBe(1);
    expect(VOLUME_DROP_THRESHOLD).toBe(0.4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/oracle.test.ts`
Expected: FAIL — cannot resolve `../src/oracle.js`

- [ ] **Step 3: Write `src/oracle.ts`**

```ts
import type { FetchResult, RunReport, RunStatus, SourceName } from './types.js';

/**
 * Minimum acceptable fetched/expected ratio, per source.
 * Sources that can prove exhaustion are held to 1.0; Partiful's single page
 * returns roughly 52 of a reported 67, so its floor sits just below that.
 */
export const COVERAGE_FLOORS: Record<SourceName, number> = {
  luma: 1,
  partiful: 0.75,
  eventbrite: 1,
};

/** A run losing more than this fraction vs the trailing median is degraded. */
export const VOLUME_DROP_THRESHOLD = 0.4;

export interface EvaluateOptions {
  startedAt?: string;
  finishedAt?: string;
  /** Median unique-event count for this source over the trailing window. */
  trailingMedian?: number | null;
}

export function evaluateRun(result: FetchResult, opts: EvaluateOptions = {}): RunReport {
  const now = new Date().toISOString();
  const fetchedCount = result.records.length;

  const coveragePct =
    result.expectedCount && result.expectedCount > 0
      ? fetchedCount / result.expectedCount
      : null;

  let status: RunStatus = 'ok';
  let error: string | null = null;

  if (result.termination.kind === 'error') {
    status = 'failed';
    error = result.termination.error;
  } else if (result.termination.kind !== 'exhausted') {
    // A truncated loop that returned rows is still a truncated loop.
    status = 'degraded';
  } else if (fetchedCount === 0) {
    // Zero results is always an error, never an empty city.
    status = 'degraded';
  } else if (coveragePct !== null && coveragePct < COVERAGE_FLOORS[result.source]) {
    status = 'degraded';
  } else if (
    opts.trailingMedian != null &&
    opts.trailingMedian > 0 &&
    fetchedCount < opts.trailingMedian * (1 - VOLUME_DROP_THRESHOLD)
  ) {
    status = 'degraded';
  }

  return {
    source: result.source,
    startedAt: opts.startedAt ?? now,
    finishedAt: opts.finishedAt ?? now,
    status,
    fetchedCount,
    expectedCount: result.expectedCount,
    coveragePct,
    terminationKind: result.termination.kind,
    error,
    driftSignals: result.driftSignals,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/oracle.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/oracle.ts test/oracle.test.ts
git commit -m "feat: add coverage oracle with termination and volume checks"
```

---

### Task 10: Within-source dedupe

**Files:**
- Create: `src/dedupe/within-source.ts`
- Test: `test/dedupe/within-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/dedupe/within-source.test.ts
import { describe, it, expect } from 'vitest';
import { dedupeWithinSource } from '../../src/dedupe/within-source.js';
import { EMPTY_COUNTS, type CanonicalEvent } from '../../src/types.js';

function ev(id: string, title = 'Party'): CanonicalEvent {
  return {
    source: 'partiful', sourceEventId: id, sourceUrl: `https://partiful.com/e/${id}`,
    title, description: null, startsAt: '2026-09-05T16:00:00.000Z', endsAt: null,
    timezone: null, venueName: null, address: null, city: null, lat: null, lng: null,
    isPublic: true, hosts: [], counts: EMPTY_COUNTS, raw: {},
  };
}

describe('dedupeWithinSource', () => {
  it('keeps one row per sourceEventId', () => {
    const result = dedupeWithinSource([ev('a'), ev('b'), ev('a')]);
    expect(result.map((e) => e.sourceEventId)).toEqual(['a', 'b']);
  });

  it('keeps the last occurrence, which carries the freshest counts', () => {
    const stale = ev('a', 'Old title');
    const fresh = ev('a', 'New title');
    expect(dedupeWithinSource([stale, fresh])[0]!.title).toBe('New title');
  });

  it('returns an empty array unchanged', () => {
    expect(dedupeWithinSource([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dedupe/within-source.test.ts`
Expected: FAIL — cannot resolve `dedupeWithinSource`

- [ ] **Step 3: Write `src/dedupe/within-source.ts`**

```ts
import type { CanonicalEvent } from '../types.js';

/**
 * Collapses duplicates inside one source. Partiful's four pools overlap heavily,
 * so this runs on every Partiful cycle. Later entries win: they are encountered
 * further down the page and carry the freshest guest counts.
 */
export function dedupeWithinSource(events: CanonicalEvent[]): CanonicalEvent[] {
  const byId = new Map<string, CanonicalEvent>();
  for (const event of events) byId.set(event.sourceEventId, event);
  return [...byId.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dedupe/within-source.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/dedupe/within-source.ts test/dedupe/within-source.test.ts
git commit -m "feat: add within-source deduplication"
```

---

### Task 11: Database client and run reports

**Files:**
- Create: `src/db/client.ts`, `src/db/runs.ts`
- Test: `test/db/runs.test.ts`

- [ ] **Step 1: Write `src/db/client.ts`**

```ts
import pg from 'pg';

export type Db = pg.Pool;

let pool: pg.Pool | null = null;

export function getPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool ??= new pg.Pool({ connectionString, max: 4 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// test/db/runs.test.ts
import { describe, it, expect, vi } from 'vitest';
import { insertRun, medianRecentCount } from '../../src/db/runs.js';
import type { RunReport } from '../../src/types.js';

const report: RunReport = {
  source: 'luma',
  startedAt: '2026-08-02T00:00:00.000Z',
  finishedAt: '2026-08-02T00:01:00.000Z',
  status: 'ok',
  fetchedCount: 779,
  expectedCount: null,
  coveragePct: null,
  terminationKind: 'exhausted',
  error: null,
  driftSignals: { buildId: 'abc' },
};

describe('insertRun', () => {
  it('writes every field of the report', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    await insertRun({ query } as any, report);

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain('insert into runs');
    expect(params).toEqual([
      'luma', report.startedAt, report.finishedAt, 'ok',
      779, null, null, 'exhausted', null, JSON.stringify({ buildId: 'abc' }),
    ]);
  });
});

describe('medianRecentCount', () => {
  it('returns the median fetched_count for the source', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ median: '779' }] });
    await expect(medianRecentCount({ query } as any, 'luma', 7)).resolves.toBe(779);
  });

  it('returns null when there is no history yet', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ median: null }] });
    await expect(medianRecentCount({ query } as any, 'luma', 7)).resolves.toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/db/runs.test.ts`
Expected: FAIL — cannot resolve `../../src/db/runs.js`

- [ ] **Step 4: Write `src/db/runs.ts`**

```ts
import type { RunReport, SourceName } from '../types.js';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export async function insertRun(db: Queryable, report: RunReport): Promise<void> {
  await db.query(
    `insert into runs
       (source, started_at, finished_at, status, fetched_count,
        expected_count, coverage_pct, termination_kind, error, drift_signals)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      report.source,
      report.startedAt,
      report.finishedAt,
      report.status,
      report.fetchedCount,
      report.expectedCount,
      report.coveragePct,
      report.terminationKind,
      report.error,
      JSON.stringify(report.driftSignals),
    ],
  );
}

/** Median fetched_count for a source over the trailing N days, or null. */
export async function medianRecentCount(
  db: Queryable,
  source: SourceName,
  days: number,
): Promise<number | null> {
  const { rows } = await db.query(
    `select percentile_cont(0.5) within group (order by fetched_count) as median
       from runs
      where source = $1
        and status = 'ok'
        and started_at > now() - ($2 || ' days')::interval`,
    [source, String(days)],
  );
  const median = rows[0]?.median;
  return median == null ? null : Number(median);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/db/runs.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 6: Commit**

```bash
git add src/db/client.ts src/db/runs.ts test/db/runs.test.ts
git commit -m "feat: add database client and run report persistence"
```

---

### Task 12: Event and snapshot persistence

**Files:**
- Create: `src/db/events.ts`, `src/db/snapshots.ts`
- Test: `test/db/events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/db/events.test.ts
import { describe, it, expect, vi } from 'vitest';
import { upsertEvent } from '../../src/db/events.js';
import { EMPTY_COUNTS, type CanonicalEvent } from '../../src/types.js';

const event: CanonicalEvent = {
  source: 'partiful', sourceEventId: 'abc',
  sourceUrl: 'https://partiful.com/e/abc',
  title: 'Run for Mutts', description: 'A run',
  startsAt: '2026-09-05T16:00:00.000Z', endsAt: null,
  timezone: 'America/Los_Angeles', venueName: 'Crosstown Trail',
  address: 'San Francisco, CA', city: null, lat: null, lng: null,
  isPublic: true,
  hosts: [{ sourceHostId: 'owner1', displayName: null, profileUrl: null }],
  counts: { ...EMPTY_COUNTS, interested: 163, going: 65 },
  raw: { hello: 'world' },
};

function mockDb(eventId = 'uuid-1') {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('from event_sources')) return { rows: [] };
    if (sql.includes('insert into events')) return { rows: [{ id: eventId }] };
    if (sql.includes('insert into hosts')) return { rows: [{ id: 'host-uuid' }] };
    return { rows: [] };
  });
  return { query };
}

describe('upsertEvent', () => {
  it('creates the event and links the source row', async () => {
    const db = mockDb();
    const id = await upsertEvent(db as any, event);

    expect(id).toBe('uuid-1');
    const sqls = db.query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('insert into events'))).toBe(true);
    expect(sqls.some((s) => s.includes('insert into event_sources'))).toBe(true);
  });

  it('always persists the raw payload for later backfill', async () => {
    const db = mockDb();
    await upsertEvent(db as any, event);

    const call = db.query.mock.calls.find((c) =>
      (c[0] as string).includes('insert into event_sources'))!;
    expect(call[1]).toContain(JSON.stringify({ hello: 'world' }));
  });

  it('reuses the existing event when the source row is already known', async () => {
    const db = { query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('from event_sources')) return { rows: [{ event_id: 'existing' }] };
      return { rows: [] };
    }) };

    const id = await upsertEvent(db as any, event);

    expect(id).toBe('existing');
    const sqls = db.query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('insert into events'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/events.test.ts`
Expected: FAIL — cannot resolve `../../src/db/events.js`

- [ ] **Step 3: Write `src/db/events.ts`**

```ts
import type { CanonicalEvent } from '../types.js';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

async function linkHosts(db: Queryable, eventId: string, event: CanonicalEvent) {
  for (const host of event.hosts) {
    const { rows } = await db.query(
      `insert into hosts (source, source_host_id, display_name, profile_url)
       values ($1, $2, $3, $4)
       on conflict (source, source_host_id) do update
         set display_name = coalesce(excluded.display_name, hosts.display_name)
       returning id`,
      [event.source, host.sourceHostId, host.displayName, host.profileUrl],
    );
    const hostId = rows[0]?.id;
    if (!hostId) continue;
    await db.query(
      `insert into event_hosts (event_id, host_id) values ($1, $2)
       on conflict do nothing`,
      [eventId, hostId],
    );
  }
}

/**
 * Inserts or refreshes one event. Returns the canonical event id.
 * The raw payload is always stored so a future schema change can be backfilled
 * from history rather than re-crawled.
 */
export async function upsertEvent(db: Queryable, event: CanonicalEvent): Promise<string> {
  const existing = await db.query(
    `select event_id from event_sources where source = $1 and source_event_id = $2`,
    [event.source, event.sourceEventId],
  );

  let eventId: string | undefined = existing.rows[0]?.event_id;

  if (eventId) {
    await db.query(`update events set last_seen_at = now() where id = $1`, [eventId]);
  } else {
    const inserted = await db.query(
      `insert into events
         (title, description, starts_at, ends_at, timezone,
          venue_name, address, city, lat, lng, is_public, canonical_url)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning id`,
      [
        event.title, event.description, event.startsAt, event.endsAt, event.timezone,
        event.venueName, event.address, event.city, event.lat, event.lng,
        event.isPublic, event.sourceUrl,
      ],
    );
    eventId = inserted.rows[0]?.id as string;
  }

  await db.query(
    `insert into event_sources (event_id, source, source_event_id, source_url, raw)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (source, source_event_id) do update
       set raw = excluded.raw, last_seen_at = now()`,
    [eventId, event.source, event.sourceEventId, event.sourceUrl, JSON.stringify(event.raw)],
  );

  await linkHosts(db, eventId!, event);
  return eventId!;
}
```

- [ ] **Step 4: Write `src/db/snapshots.ts`**

```ts
import type { CanonicalEvent } from '../types.js';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Append-only. One row per event per cycle; never updated. */
export async function insertSnapshot(
  db: Queryable,
  eventId: string,
  event: CanonicalEvent,
): Promise<void> {
  const c = event.counts;
  await db.query(
    `insert into snapshots
       (event_id, source, interested_count, going_count, approved_count,
        maybe_count, waitlist_count, guest_count, ticket_count,
        registration_availability, sales_status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      eventId, event.source, c.interested, c.going, c.approved,
      c.maybe, c.waitlist, c.guestCount, c.ticketCount,
      c.registrationAvailability, c.salesStatus,
    ],
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/db/events.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 6: Commit**

```bash
git add src/db/events.ts src/db/snapshots.ts test/db/events.test.ts
git commit -m "feat: add event, host, and snapshot persistence"
```

---

### Task 13: Cycle orchestration

**Files:**
- Create: `src/sources/luma/index.ts`, `src/sources/partiful/index.ts`, `src/cycle.ts`, `bin/run-cycle.ts`
- Test: `test/cycle.test.ts`

- [ ] **Step 1: Write the source index modules**

```ts
// src/sources/luma/index.ts
export { fetchLuma, LUMA_HEADERS } from './fetch.js';
export { normalizeLuma } from './normalize.js';
```

```ts
// src/sources/partiful/index.ts
export { fetchPartiful, extractBuildId } from './fetch.js';
export { normalizePartiful } from './normalize.js';
```

- [ ] **Step 2: Write the failing test**

```ts
// test/cycle.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runCycle } from '../src/cycle.js';
import { EMPTY_COUNTS, type CanonicalEvent, type FetchResult } from '../src/types.js';

function event(id: string): CanonicalEvent {
  return {
    source: 'luma', sourceEventId: id, sourceUrl: `https://lu.ma/${id}`,
    title: `Event ${id}`, description: null, startsAt: '2026-08-10T19:00:00.000Z',
    endsAt: null, timezone: null, venueName: null, address: null, city: 'San Francisco',
    lat: null, lng: null, isPublic: true, hosts: [], counts: EMPTY_COUNTS, raw: {},
  };
}

const good: FetchResult = {
  source: 'luma', records: [{ source: 'luma', sourceEventId: 'a', payload: {} }],
  termination: { kind: 'exhausted' }, expectedCount: null, pages: 1, driftSignals: {},
};

describe('runCycle', () => {
  it('persists events, snapshots, and a run report per source', async () => {
    const deps = {
      db: { query: vi.fn().mockResolvedValue({ rows: [{ id: 'uuid-1' }] }) } as any,
      collectors: [
        { source: 'luma' as const, fetch: async () => good, normalize: () => [event('a')] },
      ],
      upsertEvent: vi.fn().mockResolvedValue('uuid-1'),
      insertSnapshot: vi.fn().mockResolvedValue(undefined),
      insertRun: vi.fn().mockResolvedValue(undefined),
      medianRecentCount: vi.fn().mockResolvedValue(null),
    };

    const reports = await runCycle(deps as any);

    expect(deps.upsertEvent).toHaveBeenCalledTimes(1);
    expect(deps.insertSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.insertRun).toHaveBeenCalledTimes(1);
    expect(reports[0]!.status).toBe('ok');
  });

  it('keeps going when one source throws, and marks only that source failed', async () => {
    const deps = {
      db: { query: vi.fn().mockResolvedValue({ rows: [{ id: 'uuid-1' }] }) } as any,
      collectors: [
        {
          source: 'luma' as const,
          fetch: async () => { throw new Error('luma down'); },
          normalize: () => [],
        },
        { source: 'partiful' as const, fetch: async () => good, normalize: () => [event('a')] },
      ],
      upsertEvent: vi.fn().mockResolvedValue('uuid-1'),
      insertSnapshot: vi.fn().mockResolvedValue(undefined),
      insertRun: vi.fn().mockResolvedValue(undefined),
      medianRecentCount: vi.fn().mockResolvedValue(null),
    };

    const reports = await runCycle(deps as any);

    expect(reports).toHaveLength(2);
    expect(reports[0]!.status).toBe('failed');
    expect(reports[0]!.error).toBe('luma down');
    expect(reports[1]!.status).toBe('ok');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/cycle.test.ts`
Expected: FAIL — cannot resolve `../src/cycle.js`

- [ ] **Step 4: Write `src/cycle.ts`**

```ts
import { evaluateRun } from './oracle.js';
import { dedupeWithinSource } from './dedupe/within-source.js';
import type { CanonicalEvent, FetchResult, RawRecord, RunReport, SourceName } from './types.js';

export interface Collector {
  source: SourceName;
  fetch(): Promise<FetchResult>;
  normalize(records: RawRecord[]): CanonicalEvent[];
}

export interface CycleDeps {
  db: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };
  collectors: Collector[];
  upsertEvent(db: CycleDeps['db'], event: CanonicalEvent): Promise<string>;
  insertSnapshot(db: CycleDeps['db'], eventId: string, event: CanonicalEvent): Promise<void>;
  insertRun(db: CycleDeps['db'], report: RunReport): Promise<void>;
  medianRecentCount(
    db: CycleDeps['db'], source: SourceName, days: number,
  ): Promise<number | null>;
}

/**
 * Runs one full collection cycle. Sources are independent: one failing must
 * never prevent the others from collecting or from writing their run reports.
 */
export async function runCycle(deps: CycleDeps): Promise<RunReport[]> {
  const reports: RunReport[] = [];

  for (const collector of deps.collectors) {
    const startedAt = new Date().toISOString();
    let result: FetchResult;

    try {
      result = await collector.fetch();
    } catch (err) {
      result = {
        source: collector.source,
        records: [],
        termination: { kind: 'error', error: err instanceof Error ? err.message : String(err) },
        expectedCount: null,
        pages: 0,
        driftSignals: {},
      };
    }

    const events = dedupeWithinSource(collector.normalize(result.records));

    for (const event of events) {
      try {
        const eventId = await deps.upsertEvent(deps.db, event);
        await deps.insertSnapshot(deps.db, eventId, event);
      } catch {
        // A single bad row must not abort the cycle; coverage reporting will
        // surface a systemic problem via fetched vs persisted divergence.
      }
    }

    const trailingMedian = await deps.medianRecentCount(deps.db, collector.source, 7);
    const report = evaluateRun(result, {
      startedAt,
      finishedAt: new Date().toISOString(),
      trailingMedian,
    });

    await deps.insertRun(deps.db, report);
    reports.push(report);
  }

  return reports;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/cycle.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 6: Write `bin/run-cycle.ts`**

```ts
import 'dotenv/config';
import { getPool, closePool } from '../src/db/client.js';
import { insertRun, medianRecentCount } from '../src/db/runs.js';
import { upsertEvent } from '../src/db/events.js';
import { insertSnapshot } from '../src/db/snapshots.js';
import { runCycle, type Collector } from '../src/cycle.js';
import { httpGetJson, httpGetText } from '../src/http.js';
import { fetchLuma, normalizeLuma } from '../src/sources/luma/index.js';
import { fetchPartiful, normalizePartiful } from '../src/sources/partiful/index.js';

const SF_LAT = Number(process.env.SF_LAT ?? 37.7749);
const SF_LNG = Number(process.env.SF_LNG ?? -122.4194);

const collectors: Collector[] = [
  {
    source: 'luma',
    fetch: () => fetchLuma({ latitude: SF_LAT, longitude: SF_LNG, get: httpGetJson }),
    normalize: normalizeLuma,
  },
  {
    source: 'partiful',
    fetch: () => fetchPartiful({ region: 'sf', getText: httpGetText, getJson: httpGetJson }),
    normalize: normalizePartiful,
  },
];

const reports = await runCycle({
  db: getPool(),
  collectors,
  upsertEvent,
  insertSnapshot,
  insertRun,
  medianRecentCount,
});

for (const r of reports) {
  const coverage = r.coveragePct == null ? 'n/a' : `${(r.coveragePct * 100).toFixed(1)}%`;
  console.log(
    `${r.source}: ${r.status} — ${r.fetchedCount} events, coverage ${coverage}, ` +
    `terminated ${r.terminationKind}${r.error ? ` (${r.error})` : ''}`,
  );
}

await closePool();
process.exit(reports.some((r) => r.status === 'failed') ? 1 : 0);
```

- [ ] **Step 7: Run a real cycle against the live sources**

```bash
set -a && source .env && set +a
npm run cycle
```

Expected output shape (counts will differ):

```
luma: ok — 779 events, coverage n/a, terminated exhausted
partiful: ok — 52 events, coverage 77.6%, terminated exhausted
```

If Luma reports far fewer than ~700 events or terminates `cursor_stuck`, the pagination parameter has regressed — see Task 5.

- [ ] **Step 8: Verify the data landed**

```bash
psql "$DATABASE_URL" -c "select source, count(*) from event_sources group by source;"
psql "$DATABASE_URL" -c "select source, status, fetched_count, coverage_pct, termination_kind from runs order by id desc limit 5;"
```

Expected: non-zero counts for `luma` and `partiful`; run rows with status `ok`.

- [ ] **Step 9: Commit**

```bash
git add src/cycle.ts src/sources/luma/index.ts src/sources/partiful/index.ts bin/run-cycle.ts test/cycle.test.ts
git commit -m "feat: add cycle orchestration and CLI entry point"
```

---

# Phase 5 — Drift alarm

### Task 14: Contract tests against live sources

These hit the network deliberately. They are excluded from `npm test` and run on their own so a network blip never blocks a commit.

**Files:**
- Create: `test/contract/luma.contract.test.ts`, `test/contract/partiful.contract.test.ts`

- [ ] **Step 1: Write the Luma contract test**

```ts
// test/contract/luma.contract.test.ts
import { describe, it, expect } from 'vitest';
import { fetchLuma } from '../../src/sources/luma/fetch.js';
import { normalizeLuma } from '../../src/sources/luma/normalize.js';
import { httpGetJson } from '../../src/http.js';

describe('Luma live contract', () => {
  it('drains SF cleanly and returns a realistic corpus', async () => {
    const result = await fetchLuma({
      latitude: 37.7749, longitude: -122.4194, get: httpGetJson,
    });

    // Exhaustion is the only acceptable termination.
    expect(result.termination).toEqual({ kind: 'exhausted' });

    // Observed 779 on 2026-08-02. A collapse toward ~45 means the pagination
    // parameter regressed from pagination_cursor back to cursor.
    expect(result.records.length).toBeGreaterThan(300);
    expect(result.pages).toBeGreaterThan(5);
  }, 300_000);

  it('still exposes every field the normalizer depends on', async () => {
    const result = await fetchLuma({
      latitude: 37.7749, longitude: -122.4194, maxPages: 1, get: httpGetJson,
    });
    const events = normalizeLuma(result.records);

    expect(events.length).toBeGreaterThan(0);
    const event = events[0]!;
    expect(typeof event.title).toBe('string');
    expect(Number.isNaN(Date.parse(event.startsAt))).toBe(false);
    expect(event.sourceUrl).toMatch(/^https:\/\/lu\.ma\//);
  }, 60_000);
});
```

- [ ] **Step 2: Write the Partiful contract test**

```ts
// test/contract/partiful.contract.test.ts
import { describe, it, expect } from 'vitest';
import { fetchPartiful } from '../../src/sources/partiful/fetch.js';
import { normalizePartiful } from '../../src/sources/partiful/normalize.js';
import { httpGetJson, httpGetText } from '../../src/http.js';

describe('Partiful live contract', () => {
  it('resolves a buildId and returns the SF region payload', async () => {
    const result = await fetchPartiful({
      region: 'sf', getText: httpGetText, getJson: httpGetJson,
    });

    expect(result.termination).toEqual({ kind: 'exhausted' });
    expect(typeof result.driftSignals.buildId).toBe('string');

    // regionEventCounts is the coverage oracle; losing it blinds the pipeline.
    expect(result.expectedCount).toBeGreaterThan(0);
    expect(result.records.length).toBeGreaterThan(20);
  }, 60_000);

  it('still exposes the fields the normalizer depends on', async () => {
    const result = await fetchPartiful({
      region: 'sf', getText: httpGetText, getJson: httpGetJson,
    });
    const events = normalizePartiful(result.records);

    expect(events.length).toBeGreaterThan(0);
    const event = events[0]!;
    expect(typeof event.title).toBe('string');
    expect(Number.isNaN(Date.parse(event.startsAt))).toBe(false);
    expect(event.sourceUrl).toMatch(/^https:\/\/partiful\.com\/e\//);
  }, 60_000);
});
```

- [ ] **Step 3: Run the contract tests**

Run: `npm run test:contract`
Expected: PASS — 4 tests. Luma takes 1–3 minutes because it drains ~17 pages with a 300ms delay.

- [ ] **Step 4: Confirm unit tests still ignore the network**

Run: `npm test`
Expected: PASS, and the contract tests are not listed.

- [ ] **Step 5: Commit**

```bash
git add test/contract
git commit -m "test: add live contract tests as the schema drift alarm"
```

---

# Phase 6 — Eventbrite

Eventbrite is last because it is the only source needing a browser. Everything before this works without one.

### Task 15: Eventbrite browser bridge

**Files:**
- Create: `src/sources/eventbrite/browse.ts`
- Test: `test/sources/eventbrite/browse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/sources/eventbrite/browse.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  extractAppVersion, extractPlaceId, extractServerData,
} from '../../../src/sources/eventbrite/browse.js';

const HTML = `<html><script>window.__SERVER_DATA__ = {"placeId":"85922583",
"app_version":"10.14.65",
"search_data":{"events":{"results":[{"id":"1","name":"Blues Night"}]}}};</script></html>`;

describe('extractPlaceId', () => {
  it('pulls the internal place id from __SERVER_DATA__', () => {
    expect(extractPlaceId(HTML)).toBe('85922583');
  });

  it('returns null when the marker is absent', () => {
    expect(extractPlaceId('<html></html>')).toBeNull();
  });
});

describe('extractServerData', () => {
  it('parses the embedded first page of results', () => {
    const data = extractServerData(HTML);
    expect(data?.search_data?.events?.results?.[0]?.id).toBe('1');
  });
});

describe('extractAppVersion', () => {
  it('captures the discover app version as a drift signal', () => {
    expect(extractAppVersion(HTML)).toBe('10.14.65');
  });

  it('returns null when the version is absent', () => {
    expect(extractAppVersion('<html></html>')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sources/eventbrite/browse.test.ts`
Expected: FAIL — cannot resolve `extractPlaceId`

- [ ] **Step 3: Write `src/sources/eventbrite/browse.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PLACE_ID_RE = /"placeId"\s*:\s*"(\d+)"/;
const APP_VERSION_RE = /"app_version"\s*:\s*"([^"]+)"/;
const SERVER_DATA_RE = /window\.__SERVER_DATA__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/;

export interface EventbriteServerData {
  placeId?: string;
  app_version?: string;
  search_data?: { events?: { results?: Array<Record<string, unknown>> } };
}

export function extractPlaceId(html: string): string | null {
  return PLACE_ID_RE.exec(html)?.[1] ?? null;
}

/** Recorded per run so a version bump shows up as drift (spec §7). */
export function extractAppVersion(html: string): string | null {
  return APP_VERSION_RE.exec(html)?.[1] ?? null;
}

export function extractServerData(html: string): EventbriteServerData | null {
  const match = SERVER_DATA_RE.exec(html) ?? /window\.__SERVER_DATA__\s*=\s*(\{[\s\S]*?\});/.exec(html);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as EventbriteServerData;
  } catch {
    return null;
  }
}

const BROWSE_BIN =
  process.env.BROWSE_BIN ?? '/Users/pascal/.claude/skills/gstack/browse/dist/browse';

export async function browseGoto(url: string): Promise<void> {
  await run(BROWSE_BIN, ['goto', url], { maxBuffer: 64 * 1024 * 1024 });
}

export async function browseHtml(): Promise<string> {
  const { stdout } = await run(BROWSE_BIN, ['html'], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Evaluate an expression inside the live page and parse its JSON result. */
export async function browseEval<T>(expression: string): Promise<T> {
  const { stdout } = await run(BROWSE_BIN, ['js', expression], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

export async function readCsrfToken(): Promise<string> {
  const token = await browseEval<string | null>(
    `(document.cookie.match(/(?:^|;\\s*)csrftoken=([^;]+)/) || [])[1] || null`,
  );
  if (!token) {
    throw new Error('csrftoken cookie not found; load an eventbrite.com page first');
  }
  return token;
}

/**
 * POSTs from inside the page's own origin.
 *
 * Eventbrite's discovery API is WAF-blocked for server-side callers, so a Node
 * `fetch` from this process is rejected regardless of headers. Issuing the
 * request through the live browser session makes it a same-origin XHR carrying
 * the real cookie jar, which is what the WAF expects (spec §2.3).
 */
export function browsePostJson() {
  return async (
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<unknown> =>
    browseEval(`(async () => {
      const res = await fetch(${JSON.stringify(url)}, {
        method: 'POST',
        credentials: 'include',
        headers: ${JSON.stringify(headers)},
        body: ${JSON.stringify(JSON.stringify(body))}
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    })()`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sources/eventbrite/browse.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Verify the browse binary works against Eventbrite**

```bash
set -a && source .env && set +a
"$BROWSE_BIN" goto "https://www.eventbrite.com/d/ca--san-francisco/events/"
"$BROWSE_BIN" html | grep -oE '"placeId":"[0-9]+"' | head -1
```

Expected: a line like `"placeId":"85922583"`. If empty, Eventbrite changed its SSR shape — record the finding and adjust `PLACE_ID_RE` before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/sources/eventbrite/browse.ts test/sources/eventbrite/browse.test.ts
git commit -m "feat: add Eventbrite browser bridge and SSR parsers"
```

---

### Task 16: Eventbrite fetcher and normalizer

**Files:**
- Create: `src/sources/eventbrite/fetch.ts`, `src/sources/eventbrite/normalize.ts`, `src/sources/eventbrite/index.ts`
- Test: `test/sources/eventbrite/fetch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/sources/eventbrite/fetch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fetchEventbrite } from '../../../src/sources/eventbrite/fetch.js';
import { normalizeEventbrite } from '../../../src/sources/eventbrite/normalize.js';
import type { RawRecord } from '../../../src/types.js';

function searchPage(ids: string[], total: number) {
  return {
    events: {
      results: ids.map((id) => ({
        id, name: `Event ${id}`, url: `https://www.eventbrite.com/e/${id}`,
        start_date: '2026-08-10', start_time: '19:00',
        primary_venue: { name: 'The Venue', address: { localized_address_display: 'SF, CA' } },
      })),
      pagination: { object_count: total, page_number: 1, page_size: 2 },
    },
  };
}

describe('fetchEventbrite', () => {
  it('pages until the reported total is reached and reports exhausted', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce(searchPage(['a', 'b'], 3))
      .mockResolvedValueOnce(searchPage(['c'], 3));

    const result = await fetchEventbrite({ placeId: '859', csrfToken: 'tok', post });

    expect(result.records.map((r) => r.sourceEventId)).toEqual(['a', 'b', 'c']);
    expect(result.expectedCount).toBe(3);
    expect(result.termination).toEqual({ kind: 'exhausted' });
  });

  it('sends the CSRF header Eventbrite requires', async () => {
    const post = vi.fn().mockResolvedValue(searchPage(['a'], 1));
    await fetchEventbrite({ placeId: '859', csrfToken: 'tok123', post });

    const headers = post.mock.calls[0]![2] as Record<string, string>;
    expect(headers['X-CSRFToken']).toBe('tok123');
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
  });

  it('records an error termination when the WAF rejects the call', async () => {
    const post = vi.fn().mockRejectedValue(new Error('HTTP 403'));
    const result = await fetchEventbrite({ placeId: '859', csrfToken: 'tok', post });
    expect(result.termination).toEqual({ kind: 'error', error: 'HTTP 403' });
  });
});

describe('normalizeEventbrite', () => {
  it('maps a search result to a CanonicalEvent', () => {
    const record: RawRecord = {
      source: 'eventbrite', sourceEventId: 'a',
      payload: searchPage(['a'], 1).events.results[0],
    };
    const [event] = normalizeEventbrite([record]);
    expect(event!.title).toBe('Event a');
    expect(event!.venueName).toBe('The Venue');
    expect(event!.address).toBe('SF, CA');
    expect(event!.startsAt).toBe('2026-08-10T19:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sources/eventbrite/fetch.test.ts`
Expected: FAIL — cannot resolve `fetchEventbrite`

- [ ] **Step 3: Write `src/sources/eventbrite/fetch.ts`**

```ts
import type { FetchResult, RawRecord, Termination } from '../../types.js';

const SEARCH_URL = 'https://www.eventbrite.com/api/v3/destination/search/';
const PAGE_SIZE = 20;
const MAX_PAGES = 100;

export interface HttpPostJson {
  (url: string, body: unknown, headers: Record<string, string>): Promise<unknown>;
}

interface SearchResponse {
  events?: {
    results?: Array<{ id?: string }>;
    pagination?: { object_count?: number; page_number?: number; page_size?: number };
  };
}

export interface FetchEventbriteOptions {
  placeId: string;
  csrfToken: string;
  post: HttpPostJson;
  maxPages?: number;
}

export async function fetchEventbrite(opts: FetchEventbriteOptions): Promise<FetchResult> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const byId = new Map<string, RawRecord>();
  let termination: Termination = { kind: 'page_cap' };
  let expectedCount: number | null = null;
  let pages = 0;

  const headers = {
    'X-CSRFToken': opts.csrfToken,
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    Referer: 'https://www.eventbrite.com/',
  };

  for (let page = 1; page <= maxPages; page++) {
    const body = {
      browse_surface: 'search',
      event_search: {
        places: [opts.placeId],
        dates: ['current_future'],
        dedup: true,
        page,
        page_size: PAGE_SIZE,
      },
      'expand.destination_event': [
        'primary_venue', 'image', 'ticket_availability',
        'event_sales_status', 'primary_organizer',
      ],
    };

    let response: SearchResponse;
    try {
      response = (await opts.post(SEARCH_URL, body, headers)) as SearchResponse;
    } catch (err) {
      termination = { kind: 'error', error: err instanceof Error ? err.message : String(err) };
      break;
    }

    pages += 1;
    const results = response.events?.results ?? [];
    for (const result of results) {
      if (!result?.id) continue;
      byId.set(result.id, {
        source: 'eventbrite', sourceEventId: result.id, payload: result,
      });
    }

    expectedCount = response.events?.pagination?.object_count ?? expectedCount;

    if (results.length === 0 || (expectedCount !== null && byId.size >= expectedCount)) {
      termination = { kind: 'exhausted' };
      break;
    }
  }

  return {
    source: 'eventbrite',
    records: [...byId.values()],
    termination,
    expectedCount,
    pages,
    driftSignals: {},
  };
}
```

- [ ] **Step 4: Write `src/sources/eventbrite/normalize.ts`**

```ts
import { type CanonicalEvent, EMPTY_COUNTS, type RawRecord } from '../../types.js';

interface EventbriteResult {
  id?: string;
  name?: string | null;
  summary?: string | null;
  url?: string | null;
  start_date?: string | null;
  start_time?: string | null;
  end_date?: string | null;
  end_time?: string | null;
  timezone?: string | null;
  event_sales_status?: { sales_status?: string | null } | null;
  primary_organizer?: { id?: string; name?: string | null; url?: string | null } | null;
  primary_venue?: {
    name?: string | null;
    address?: {
      localized_address_display?: string | null;
      city?: string | null;
      latitude?: string | null;
      longitude?: string | null;
    } | null;
  } | null;
}

function toIso(date?: string | null, time?: string | null): string | null {
  if (!date) return null;
  const parsed = new Date(`${date}T${time ?? '00:00'}:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeEventbrite(records: RawRecord[]): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];

  for (const record of records) {
    const r = record.payload as EventbriteResult;
    const startsAt = toIso(r?.start_date, r?.start_time);
    if (!r?.name || !startsAt) continue;

    const address = r.primary_venue?.address ?? null;
    const organizer = r.primary_organizer ?? null;

    out.push({
      source: 'eventbrite',
      sourceEventId: record.sourceEventId,
      sourceUrl: r.url ?? `https://www.eventbrite.com/e/${record.sourceEventId}`,
      title: r.name,
      description: r.summary ?? null,
      startsAt,
      endsAt: toIso(r.end_date, r.end_time),
      timezone: r.timezone ?? null,
      venueName: r.primary_venue?.name ?? null,
      address: address?.localized_address_display ?? null,
      city: address?.city ?? null,
      lat: address?.latitude ? Number(address.latitude) : null,
      lng: address?.longitude ? Number(address.longitude) : null,
      isPublic: true,
      hosts: organizer?.id
        ? [{
            sourceHostId: organizer.id,
            displayName: organizer.name ?? null,
            profileUrl: organizer.url ?? null,
          }]
        : [],
      counts: {
        ...EMPTY_COUNTS,
        salesStatus: r.event_sales_status?.sales_status ?? null,
      },
      raw: record.payload,
    });
  }

  return out;
}
```

- [ ] **Step 5: Write `src/sources/eventbrite/index.ts`**

```ts
export { fetchEventbrite, type HttpPostJson } from './fetch.js';
export { normalizeEventbrite } from './normalize.js';
export {
  extractPlaceId, extractAppVersion, extractServerData,
  browseGoto, browseHtml, browseEval, browsePostJson, readCsrfToken,
} from './browse.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/sources/eventbrite/fetch.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 7: Commit**

```bash
git add src/sources/eventbrite test/sources/eventbrite/fetch.test.ts
git commit -m "feat: add Eventbrite fetcher and normalizer"
```

---

# Phase 7 — Cross-source deduplication

### Task 17: Cross-source entity resolution

Deterministic tiers only. A wrong merge is worse than a missed merge, so anything uncertain is flagged rather than merged.

**Files:**
- Create: `src/dedupe/cross-source.ts`
- Test: `test/dedupe/cross-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/dedupe/cross-source.test.ts
import { describe, it, expect } from 'vitest';
import { classifyPair, normalizeTitle, titleSimilarity } from '../../src/dedupe/cross-source.js';
import { EMPTY_COUNTS, type CanonicalEvent, type SourceName } from '../../src/types.js';

function ev(over: Partial<CanonicalEvent> & { source: SourceName }): CanonicalEvent {
  return {
    sourceEventId: 'x', sourceUrl: 'https://example.com',
    title: 'Rooftop Sunset Party', description: null,
    startsAt: '2026-08-10T19:00:00.000Z', endsAt: null, timezone: null,
    venueName: null, address: null, city: 'San Francisco',
    lat: 37.7749, lng: -122.4194, isPublic: true, hosts: [],
    counts: EMPTY_COUNTS, raw: {}, ...over,
  };
}

describe('normalizeTitle', () => {
  it('lowercases, strips emoji and punctuation, and collapses whitespace', () => {
    expect(normalizeTitle('  ✰ Rooftop  SUNSET Party! ✰ ')).toBe('rooftop sunset party');
  });
});

describe('titleSimilarity', () => {
  it('scores identical titles as 1', () => {
    expect(titleSimilarity('Rooftop Party', 'rooftop party')).toBe(1);
  });

  it('scores unrelated titles low', () => {
    expect(titleSimilarity('Rooftop Party', 'Chess Tournament')).toBeLessThan(0.4);
  });
});

describe('classifyPair', () => {
  it('matches identical title and start time within the window', () => {
    const a = ev({ source: 'luma' });
    const b = ev({ source: 'partiful', startsAt: '2026-08-10T19:20:00.000Z' });
    expect(classifyPair(a, b)).toBe('same');
  });

  it('matches on high title similarity plus time and geo proximity', () => {
    const a = ev({ source: 'luma', title: 'Rooftop Sunset Party' });
    const b = ev({ source: 'partiful', title: 'Rooftop Sunset Party 2026', lat: 37.7752, lng: -122.4190 });
    expect(classifyPair(a, b)).toBe('same');
  });

  it('rejects the same title on a different day', () => {
    const a = ev({ source: 'luma' });
    const b = ev({ source: 'partiful', startsAt: '2026-08-14T19:00:00.000Z' });
    expect(classifyPair(a, b)).toBe('different');
  });

  it('flags matching time and geo with unrelated titles as ambiguous, never same', () => {
    const a = ev({ source: 'luma', title: 'Rooftop Sunset Party' });
    const b = ev({ source: 'partiful', title: 'Chess Tournament Night' });
    expect(classifyPair(a, b)).toBe('ambiguous');
  });

  it('never merges two events from the same source', () => {
    const a = ev({ source: 'luma', sourceEventId: 'a' });
    const b = ev({ source: 'luma', sourceEventId: 'b' });
    expect(classifyPair(a, b)).toBe('different');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dedupe/cross-source.test.ts`
Expected: FAIL — cannot resolve `classifyPair`

- [ ] **Step 3: Write `src/dedupe/cross-source.ts`**

```ts
import type { CanonicalEvent } from '../types.js';

export type PairVerdict = 'same' | 'ambiguous' | 'different';

const TIME_WINDOW_MS = 30 * 60 * 1000; // ±30 minutes
const GEO_RADIUS_M = 500;
const TITLE_SIMILARITY_THRESHOLD = 0.85;

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Jaccard similarity over trigrams — mirrors Postgres pg_trgm semantics. */
export function titleSimilarity(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (left === right) return 1;
  if (!left || !right) return 0;

  const setA = trigrams(left);
  const setB = trigrams(right);
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared++;
  return shared / (setA.size + setB.size - shared);
}

function withinTimeWindow(a: CanonicalEvent, b: CanonicalEvent): boolean {
  const delta = Math.abs(Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return Number.isFinite(delta) && delta <= TIME_WINDOW_MS;
}

function metresBetween(a: CanonicalEvent, b: CanonicalEvent): number | null {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Decides whether two events from different sources are the same real-world event.
 * Under uncertainty this returns 'ambiguous', never 'same': a wrong merge
 * destroys data, a missed merge only defers it.
 */
export function classifyPair(a: CanonicalEvent, b: CanonicalEvent): PairVerdict {
  if (a.source === b.source) return 'different';

  const timeMatch = withinTimeWindow(a, b);
  const similarity = titleSimilarity(a.title, b.title);
  const distance = metresBetween(a, b);
  const geoMatch = distance !== null && distance <= GEO_RADIUS_M;

  // Tier 1: exact normalized title within the time window.
  if (timeMatch && normalizeTitle(a.title) === normalizeTitle(b.title)) return 'same';

  // Tier 2: strong title similarity plus time and geo agreement.
  if (timeMatch && geoMatch && similarity >= TITLE_SIMILARITY_THRESHOLD) return 'same';

  // Tier 3: agrees on some axes but not others — a human or agent decides.
  if (timeMatch && (geoMatch || similarity >= 0.5)) return 'ambiguous';

  return 'different';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dedupe/cross-source.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all unit tests across every task.

- [ ] **Step 6: Commit**

```bash
git add src/dedupe/cross-source.ts test/dedupe/cross-source.test.ts
git commit -m "feat: add cross-source entity resolution"
```

---

### Task 18: Wire Eventbrite into the cycle

**Files:**
- Modify: `bin/run-cycle.ts`
- Create: `src/sources/eventbrite/collector.ts`

- [ ] **Step 1: Write `src/sources/eventbrite/collector.ts`**

```ts
import {
  browseGoto, browseHtml, browsePostJson, extractAppVersion, extractPlaceId, readCsrfToken,
} from './browse.js';
import { fetchEventbrite } from './fetch.js';
import type { FetchResult } from '../../types.js';

const BROWSE_URL = 'https://www.eventbrite.com/d/ca--san-francisco/events/';

/**
 * Loads the SF browse page in the live browser session to resolve the internal
 * placeId and the csrftoken cookie, then pages the search API from inside that
 * same session. Every request originates in the page, never from Node.
 */
export async function collectEventbrite(): Promise<FetchResult> {
  await browseGoto(BROWSE_URL);
  const html = await browseHtml();
  const placeId = extractPlaceId(html);
  const appVersion = extractAppVersion(html);

  if (!placeId) {
    return {
      source: 'eventbrite',
      records: [],
      termination: { kind: 'error', error: 'could not resolve placeId from __SERVER_DATA__' },
      expectedCount: null,
      pages: 0,
      driftSignals: { placeIdMissing: true, appVersion },
    };
  }

  const csrfToken = await readCsrfToken();
  const result = await fetchEventbrite({ placeId, csrfToken, post: browsePostJson() });

  return {
    ...result,
    driftSignals: { ...result.driftSignals, placeId, appVersion },
  };
}
```

Record the `appVersion` value on the first successful run. Spec §2.3 captured the
request shapes against `v10.14.65`; a change here paired with a coverage drop means
the request contract moved.

- [ ] **Step 2: Add the collector to `bin/run-cycle.ts`**

Add these imports below the existing source imports:

```ts
import { collectEventbrite } from '../src/sources/eventbrite/collector.js';
import { normalizeEventbrite } from '../src/sources/eventbrite/index.js';
```

Then append this collector to the `collectors` array:

```ts
  {
    source: 'eventbrite',
    fetch: collectEventbrite,
    normalize: normalizeEventbrite,
  },
```

- [ ] **Step 3: Run a full three-source cycle**

```bash
set -a && source .env && set +a
npm run cycle
```

Expected: three status lines, for example:

```
luma: ok — 779 events, coverage n/a, terminated exhausted
partiful: ok — 52 events, coverage 77.6%, terminated exhausted
eventbrite: ok — 312 events, coverage 100.0%, terminated exhausted
```

If Eventbrite reports `failed` with an `HTTP 403`, the browser session lacks the
csrftoken cookie. Load any eventbrite.com page in the session first
(`$BROWSE_BIN goto https://www.eventbrite.com/`) and re-run.

- [ ] **Step 4: Verify all three sources landed**

```bash
psql "$DATABASE_URL" -c "select source, count(*) from event_sources group by source;"
psql "$DATABASE_URL" -c "select source, status, fetched_count, expected_count, coverage_pct, termination_kind from runs order by id desc limit 3;"
```

Expected: rows for `luma`, `partiful`, and `eventbrite`.

- [ ] **Step 5: Commit**

```bash
git add bin/run-cycle.ts src/sources/eventbrite/collector.ts
git commit -m "feat: wire Eventbrite into the collection cycle"
```

---

### Task 19: Scheduling

**Files:**
- Create: `scripts/cycle.sh`

- [ ] **Step 1: Write `scripts/cycle.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a && source .env && set +a
npm run cycle >> "$HOME/.local/state/event_scraper.log" 2>&1
```

- [ ] **Step 2: Make it executable and test it**

```bash
mkdir -p ~/.local/state
chmod +x scripts/cycle.sh
./scripts/cycle.sh && tail -5 ~/.local/state/event_scraper.log
```

Expected: three status lines in the log.

- [ ] **Step 3: Install the 3-hourly cron entry**

```bash
( crontab -l 2>/dev/null; echo "0 */3 * * * $HOME/workspaces/event_scraper/scripts/cycle.sh" ) | crontab -
crontab -l | grep event_scraper
```

Expected: the cron line is listed.

- [ ] **Step 4: Commit**

```bash
git add scripts/cycle.sh
git commit -m "feat: add cycle shell wrapper for scheduled runs"
```

---

## Verification

After Task 19, confirm the whole system:

- [ ] `npm test` — all unit tests pass, no network
- [ ] `npm run test:contract` — live schema contracts hold for Luma and Partiful
- [ ] `npm run cycle` — three sources report status, Luma terminates `exhausted` with several hundred events
- [ ] `psql "$DATABASE_URL" -c "select count(*) from snapshots;"` returns a growing number across two consecutive cycles

The last check is the one that proves the time series works: run the cycle twice, an hour apart, and confirm `snapshots` grows while `events` stays roughly flat.

---

## Follow-on work (not in this plan)

1. **NanoClaw supervisor** — reads `runs`, repairs drift, resolves `ambiguous` pairs, alerts on degraded coverage. Its own plan.
2. **Cross-source merge writer** — `classifyPair` decides; nothing yet collapses two `event_sources` rows onto one `events` row. Deliberately deferred until real duplicate rates are measured.
3. **The Partiful coverage gap** — measure whether 3-hourly accumulation closes 52/67 before building host-graph snowballing.
4. **Luma descriptions** — absent from discovery, and per-event fetches hit 429. Needs a slow, separate backfill job.
