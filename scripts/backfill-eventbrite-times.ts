import 'dotenv/config';
import pg from 'pg';
import { zonedToUtcIso } from '../src/sources/eventbrite/time.js';

/**
 * Recomputes Eventbrite start/end times from the stored raw payloads.
 *
 * An earlier normalizer stamped Eventbrite's local wall time with `Z`, shifting
 * every event by the venue's UTC offset — a 9am workshop was stored as 9am UTC
 * and therefore displayed as 2am Pacific.
 *
 * No re-crawl is needed because `event_sources.raw` holds the untouched payload.
 * That is the whole reason the column exists, and this is the first time it has
 * earned its keep.
 *
 * Idempotent: rows already holding the correct instant are skipped.
 */
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `select es.event_id, es.raw, e.starts_at, e.ends_at
     from event_sources es
     join events e on e.id = es.event_id
    where es.source = 'eventbrite'`,
);

console.log(`inspecting ${rows.length} eventbrite events`);

let fixed = 0;
let unchanged = 0;
let unusable = 0;
const shifts = new Map<number, number>();

for (const row of rows) {
  const raw = row.raw as {
    start_date?: string; start_time?: string;
    end_date?: string; end_time?: string; timezone?: string;
  };

  const starts = zonedToUtcIso(raw.start_date, raw.start_time, raw.timezone);
  if (!starts) {
    unusable += 1;
    continue;
  }
  const ends = zonedToUtcIso(raw.end_date, raw.end_time, raw.timezone);

  const currentStart = new Date(row.starts_at).toISOString();
  const currentEnd = row.ends_at ? new Date(row.ends_at).toISOString() : null;
  if (currentStart === starts && currentEnd === ends) {
    unchanged += 1;
    continue;
  }

  const hours = Math.round((Date.parse(starts) - Date.parse(currentStart)) / 3_600_000);
  shifts.set(hours, (shifts.get(hours) ?? 0) + 1);

  await client.query('update events set starts_at = $2, ends_at = $3 where id = $1', [
    row.event_id, starts, ends,
  ]);
  fixed += 1;
}

console.log(`corrected ${fixed}, already correct ${unchanged}, unusable ${unusable}`);
console.log('shift distribution (hours):');
for (const [h, n] of [...shifts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${h > 0 ? '+' : ''}${h}h : ${n}`);
}

await client.end();
