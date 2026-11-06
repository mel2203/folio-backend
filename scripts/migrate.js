require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
const { pool } = require('../src/config/db');

const MIGRATIONS_DIRECTORY = path.join(__dirname, '..', 'migrations');
const MIGRATION_LOCK_KEYS = [1946157056, 1];

async function runMigrations() {
  const migrationFiles = (await fs.readdir(MIGRATIONS_DIRECTORY))
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const fileName of migrationFiles) {
      await client.query('BEGIN');

      try {
        await client.query(
          'SELECT pg_advisory_xact_lock($1, $2)',
          MIGRATION_LOCK_KEYS,
        );

        const applied = await client.query(
          'SELECT 1 FROM schema_migrations WHERE name = $1',
          [fileName],
        );

        if (applied.rowCount > 0) {
          await client.query('COMMIT');
          continue;
        }

        const migrationSql = await fs.readFile(
          path.join(MIGRATIONS_DIRECTORY, fileName),
          'utf8',
        );
        await client.query(migrationSql);
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1)',
          [fileName],
        );
        await client.query('COMMIT');
        process.stdout.write(`Applied ${fileName}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

runMigrations()
  .catch((error) => {
    const errorCode = error.code ? ` (${error.code})` : '';
    console.error(`Migration failed${errorCode}.`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
