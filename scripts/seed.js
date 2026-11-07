require('dotenv').config({ quiet: true });
const { pool, withTransaction } = require('../src/config/db');
const { seedDefaultAccounts } = require('../src/services/chart-of-accounts.service');

const DEMO_COMPANY_NAME = 'Folio Demo Company';
const SEED_LOCK_KEYS = [1946157056, 2];

async function seedDemoCompany() {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', SEED_LOCK_KEYS);

    const existingCompany = await client.query(
      'SELECT id FROM companies WHERE name = $1 ORDER BY created_at ASC LIMIT 1',
      [DEMO_COMPANY_NAME],
    );
    const companyId = existingCompany.rows[0]
      ? existingCompany.rows[0].id
      : (await client.query(
        'INSERT INTO companies (name) VALUES ($1) RETURNING id',
        [DEMO_COMPANY_NAME],
      )).rows[0].id;

    await seedDefaultAccounts(client, companyId);

    return companyId;
  });
}

seedDemoCompany()
  .then((companyId) => {
    process.stdout.write(`${companyId}\n`);
  })
  .catch((error) => {
    const errorCode = error.code ? ` (${error.code})` : '';
    console.error(`Seed failed${errorCode}.`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
