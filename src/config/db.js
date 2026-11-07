const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set before using the database');
}

const databaseHost = new URL(databaseUrl).hostname;
const isLocalHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseHost);

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: isLocalHost ? false : { rejectUnauthorized: false },
});

async function withTransaction(callback) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Database transaction failed and could not be rolled back',
          { cause: error },
        );
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
