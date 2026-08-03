-- Search support for the web frontend.
--
-- The frontend searches title and description together. A generated tsvector
-- column keeps the index maintained by Postgres rather than by application
-- code, so a future writer that forgets to update it cannot silently break
-- search. Title is weighted above description so a title match ranks first.

alter table events
  add column if not exists search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) stored;

create index if not exists events_search_tsv_idx on events using gin (search_tsv);

-- Browsing is almost always "upcoming, newest first", and the city filter is
-- the most common narrowing. These cover both without scanning.
create index if not exists events_starts_at_city_idx on events (starts_at, city);

-- Popularity sort reads the latest snapshot per event; this makes that lookup
-- an index scan rather than a sort over the whole table.
create index if not exists snapshots_latest_idx on snapshots (event_id, captured_at desc)
  include (interested_count, going_count, guest_count);
