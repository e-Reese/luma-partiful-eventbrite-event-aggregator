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
