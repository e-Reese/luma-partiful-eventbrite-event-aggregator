/**
 * Converts Eventbrite's split local date/time into a UTC instant.
 *
 * Eventbrite returns `start_date: "2026-10-18"`, `start_time: "14:00"` and a
 * separate `timezone: "America/Los_Angeles"`. The time is **wall time in that
 * zone**, not UTC. Stamping it with `Z` — which an earlier version did — shifts
 * every event by the zone offset, turning a 9am workshop into 2am and scattering
 * the whole listing across the small hours.
 *
 * There is no built-in "parse wall time in zone" in JS, so this inverts
 * `Intl.DateTimeFormat`: guess that the wall time is UTC, ask what that instant
 * looks like in the target zone, and subtract the difference. A second pass
 * handles DST boundaries, where the offset at the guessed instant differs from
 * the offset at the corrected one.
 */

/** How far the zone is from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour'), get('minute'), get('second'),
  );
  return asIfUtc - instant.getTime();
}

/**
 * `2026-10-18` + `14:00` + `America/Los_Angeles` → `2026-10-18T21:00:00.000Z`.
 *
 * Returns null for an unparseable date, so the caller can skip the event rather
 * than store a broken timestamp. A missing time defaults to midnight local.
 * A missing or invalid zone falls back to UTC, which is wrong but explicit —
 * and better than silently shifting by an arbitrary offset.
 */
export function zonedToUtcIso(
  date?: string | null,
  time?: string | null,
  timeZone?: string | null,
): string | null {
  if (!date) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const [, y, mo, d] = m.map(Number) as [number, number, number, number];

  const t = /^(\d{1,2}):(\d{2})/.exec((time ?? '00:00').trim());
  const hour = t ? Number(t[1]) : 0;
  const minute = t ? Number(t[2]) : 0;
  if (hour > 23 || minute > 59) return null;

  const wallAsUtc = Date.UTC(y, mo - 1, d, hour, minute);
  if (Number.isNaN(wallAsUtc)) return null;

  if (!timeZone) return new Date(wallAsUtc).toISOString();

  try {
    const firstOffset = zoneOffsetMs(new Date(wallAsUtc), timeZone);
    let instant = wallAsUtc - firstOffset;
    // Across a DST transition the offset at the corrected instant can differ
    // from the offset at the guess; one refinement settles it.
    const secondOffset = zoneOffsetMs(new Date(instant), timeZone);
    if (secondOffset !== firstOffset) instant = wallAsUtc - secondOffset;
    return new Date(instant).toISOString();
  } catch {
    // Unknown zone identifier: fall back to UTC rather than throwing away the event.
    return new Date(wallAsUtc).toISOString();
  }
}
