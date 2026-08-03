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
  coverage_pct     numeric,        -- unbounded: a source under-reporting
                                   -- expected_count must not throw on insert
                                   -- and lose the run report entirely
  termination_kind text not null,
  error            text,
  drift_signals    jsonb not null default '{}'::jsonb
);

create index if not exists runs_source_started_idx on runs (source, started_at desc);
