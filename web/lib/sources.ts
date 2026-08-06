/**
 * The three places the pipeline collects from.
 *
 * Kept apart from `queries.ts` because that module opens a Postgres pool the
 * moment it is imported, and the client-side analytics component needs this
 * list without dragging `pg` into the browser bundle.
 */
export const SOURCES = ['luma', 'partiful', 'eventbrite'] as const;

export type Source = (typeof SOURCES)[number];
