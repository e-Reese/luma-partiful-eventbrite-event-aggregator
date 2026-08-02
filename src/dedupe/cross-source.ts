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
