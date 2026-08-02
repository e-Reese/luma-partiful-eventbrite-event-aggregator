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
