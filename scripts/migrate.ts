import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Applies every file in migrations/ in filename order.
 *
 * Uses `pg` rather than shelling out to psql so the project has no external
 * client dependency. Each file runs inside a transaction: a syntax error late
 * in a file must not leave half a schema behind.
 *
 * The migrations are written with `if not exists` guards throughout, so
 * re-running is safe.
 */
const dir = join(import.meta.dirname, '..', 'migrations');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(dir, file), 'utf-8');
  process.stdout.write(`${file} ... `);
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    console.log('ok');
  } catch (err) {
    await client.query('rollback');
    console.log('FAILED');
    console.error(err instanceof Error ? err.message : err);
    await client.end();
    process.exit(1);
  }
}

const { rows } = await client.query(
  `select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`,
);
console.log(`tables: ${rows.map((r) => r.table_name).join(', ')}`);

await client.end();
