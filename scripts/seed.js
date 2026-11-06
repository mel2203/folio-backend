require('dotenv').config();
const { pool, withTransaction } = require('../src/config/db');

const DEMO_COMPANY_NAME = 'Folio Demo Company';
const SEED_LOCK_KEYS = [1946157056, 2];
const DEFAULT_ACCOUNTS = [
  { code: '1000', name: 'Cash and Bank', type: 'asset', normalBalance: 'debit' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset', normalBalance: 'debit' },
  { code: '1200', name: 'Prepaid Expenses', type: 'asset', normalBalance: 'debit' },
  { code: '1500', name: 'Equipment', type: 'asset', normalBalance: 'debit' },
  { code: '2000', name: 'Accounts Payable', type: 'liability', normalBalance: 'credit' },
  { code: '2100', name: 'Sales Tax Payable', type: 'liability', normalBalance: 'credit' },
  { code: '3000', name: "Owner's Capital", type: 'equity', normalBalance: 'credit' },
  { code: '3100', name: 'Retained Earnings', type: 'equity', normalBalance: 'credit' },
  { code: '4000', name: 'Sales Revenue', type: 'revenue', normalBalance: 'credit' },
  { code: '4100', name: 'Service Revenue', type: 'revenue', normalBalance: 'credit' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', normalBalance: 'debit' },
  { code: '6000', name: 'Rent Expense', type: 'expense', normalBalance: 'debit' },
  { code: '6100', name: 'Utilities Expense', type: 'expense', normalBalance: 'debit' },
  { code: '6200', name: 'Salaries Expense', type: 'expense', normalBalance: 'debit' },
  { code: '6300', name: 'Office Supplies Expense', type: 'expense', normalBalance: 'debit' },
];

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

    for (const account of DEFAULT_ACCOUNTS) {
      await client.query(
        `INSERT INTO accounts (company_id, code, name, type, normal_balance)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company_id, code) DO NOTHING`,
        [
          companyId,
          account.code,
          account.name,
          account.type,
          account.normalBalance,
        ],
      );
    }

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
