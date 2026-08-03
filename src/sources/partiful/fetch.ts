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
  region: string; // 'sf', 'nyc', 'la', ...
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
