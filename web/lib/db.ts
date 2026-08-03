import pg from 'pg';

/**
 * One pool per server process, cached across hot reloads in development.
 *
 * Next.js re-evaluates modules on every edit, so without the global cache a dev
 * session accumulates pools until the connection limit is hit. `max` is kept
 * small because this runs against Supabase's session pooler, which is itself
 * shared, and every query in this app is a fast indexed read.
 */
const globalForPg = globalThis as unknown as { eventPool?: pg.Pool };

export function pool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }
  globalForPg.eventPool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return globalForPg.eventPool;
}

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool().query(sql, params);
  return rows as T[];
}
