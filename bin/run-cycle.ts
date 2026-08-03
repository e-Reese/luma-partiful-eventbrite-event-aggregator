import 'dotenv/config';
import { getPool, closePool } from '../src/db/client.js';
import { insertRun, medianRecentCount } from '../src/db/runs.js';
import { upsertEvent } from '../src/db/events.js';
import { insertSnapshot } from '../src/db/snapshots.js';
import { persistEvents } from '../src/db/batch.js';
import { runCycle, type Collector } from '../src/cycle.js';
import { httpGetJson, httpGetText } from '../src/http.js';
import { fetchLuma, normalizeLuma } from '../src/sources/luma/index.js';
import { fetchPartiful, normalizePartiful } from '../src/sources/partiful/index.js';
import { collectEventbrite } from '../src/sources/eventbrite/collector.js';
import { normalizeEventbrite } from '../src/sources/eventbrite/index.js';

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
  {
    source: 'eventbrite',
    fetch: collectEventbrite,
    normalize: normalizeEventbrite,
  },
];

const reports = await runCycle({
  db: getPool(),
  collectors,
  persistEvents: (db, events) =>
    persistEvents(db, events, async (d, event) => {
      const id = await upsertEvent(d, event);
      await insertSnapshot(d, id, event);
    }),
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
