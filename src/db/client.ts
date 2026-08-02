import pg from 'pg';

export type Db = pg.Pool;

let pool: pg.Pool | null = null;

export function getPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool ??= new pg.Pool({ connectionString, max: 4 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
