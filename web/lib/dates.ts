const TZ = 'America/Los_Angeles';

/** Calendar day key in the venue's timezone, not the viewer's. */
export function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
}

function todayKey(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

/**
 * A short human label for a day heading.
 *
 * "Tonight" and "Tomorrow" do more for comprehension than any styling: they let
 * someone answer "is there anything on right now" without parsing a date.
 */
export function dayLabel(key: string): { lead: string; date: string } {
  const today = todayKey();
  const date = new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  if (key === today) return { lead: 'Tonight', date };
  if (key === addDays(today, 1)) return { lead: 'Tomorrow', date };

  const within = (n: number) => {
    for (let i = 2; i <= n; i++) if (key === addDays(today, i)) return true;
    return false;
  };
  if (within(7)) {
    const weekday = new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
    });
    return { lead: weekday, date };
  }
  return { lead: '', date };
}

export function timeOfDay(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString('en-US', {
      timeZone: TZ,
      hour: 'numeric',
      minute: '2-digit',
    })
    .replace(':00', '')
    .toLowerCase()
    .replace(' ', '');
}

export function fullWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** Groups a chronological list into day buckets, preserving order. */
export function groupByDay<T extends { starts_at: string }>(
  rows: T[],
): Array<{ key: string; rows: T[] }> {
  const out: Array<{ key: string; rows: T[] }> = [];
  for (const row of rows) {
    const key = dayKey(row.starts_at);
    const last = out[out.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else out.push({ key, rows: [row] });
  }
  return out;
}
