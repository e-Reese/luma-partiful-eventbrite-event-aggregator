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
