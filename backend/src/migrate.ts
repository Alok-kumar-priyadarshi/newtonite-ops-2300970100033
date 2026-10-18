import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from './db';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/ (tsx) and dist/ (built): both sit next to ../migrations.
const MIGRATIONS_DIR = path.resolve(here, '../migrations');

/** Applies pending .sql files in name order, each in its own transaction. */
export async function migrate(log = true) {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  // One transaction for the whole run; the advisory lock serializes concurrent runners
  // (e.g. two containers starting at once). Postgres DDL is transactional.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727001)`;
    await tx`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`;
    const applied = new Set((await tx`select name from schema_migrations`).map((r) => r.name as string));
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
      if (log) console.log(`applied ${file}`);
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  migrate()
    .then(() => sql.end())
    .catch(async (err) => {
      console.error(err);
      await sql.end();
      process.exit(1);
    });
}
