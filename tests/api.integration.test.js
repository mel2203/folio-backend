const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');
const app = require('../src/app');
const { pool, withTransaction } = require('../src/config/db');

const MIGRATIONS_DIRECTORY = path.join(__dirname, '..', 'migrations');
const createdCompanyIds = new Set();
let companyId;
let cashAccountId;
let capitalAccountId;

async function applyTestMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrationFiles = (await fs.readdir(MIGRATIONS_DIRECTORY))
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  for (const fileName of migrationFiles) {
    await withTransaction(async (client) => {
      const applied = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [fileName],
      );

      if (applied.rowCount > 0) {
        return;
      }

      const sql = await fs.readFile(path.join(MIGRATIONS_DIRECTORY, fileName), 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name) VALUES ($1)',
        [fileName],
      );
    });
  }
}

async function createCompany(name) {
  const company = await withTransaction(async (client) => {
    const companyResult = await client.query(
      'INSERT INTO companies (name) VALUES ($1) RETURNING id',
      [name],
    );
    const newCompanyId = companyResult.rows[0].id;
    const cashResult = await client.query(
      `INSERT INTO accounts (company_id, code, name, type, normal_balance)
       VALUES ($1, '1000', 'Cash and Bank', 'asset', 'debit')
       RETURNING id`,
      [newCompanyId],
    );
    const capitalResult = await client.query(
      `INSERT INTO accounts (company_id, code, name, type, normal_balance)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [newCompanyId, '3000', "Owner's Capital", 'equity', 'credit'],
    );

    return {
      id: newCompanyId,
      cashAccountId: cashResult.rows[0].id,
      capitalAccountId: capitalResult.rows[0].id,
    };
  });

  createdCompanyIds.add(company.id);
  return company;
}

async function removeCompany(testCompanyId) {
  await withTransaction(async (client) => {
    await client.query(
      'DELETE FROM journal_entries WHERE company_id = $1',
      [testCompanyId],
    );
    await client.query(
      'DELETE FROM accounts WHERE company_id = $1',
      [testCompanyId],
    );
    await client.query(
      'DELETE FROM companies WHERE id = $1',
      [testCompanyId],
    );
  });
}

function balancedBody(date = '2026-11-05', debit = '10.00', credit = debit) {
  return {
    date,
    memo: 'Test journal entry',
    lines: [
      { accountId: cashAccountId, debit, credit: '0.00' },
      { accountId: capitalAccountId, debit: '0.00', credit },
    ],
  };
}

describe('journal and account API', () => {
  beforeAll(async () => {
    await applyTestMigrations();
  });

  beforeEach(async () => {
    const company = await createCompany(`API test company ${randomUUID()}`);
    companyId = company.id;
    cashAccountId = company.cashAccountId;
    capitalAccountId = company.capitalAccountId;
    process.env.DEV_COMPANY_ID = companyId;
  });

  afterEach(async () => {
    for (const testCompanyId of createdCompanyIds) {
      await removeCompany(testCompanyId);
      createdCompanyIds.delete(testCompanyId);
    }
    delete process.env.DEV_COMPANY_ID;
  });

  afterAll(async () => {
    await pool.end();
  });

  test('lists accounts for the current company only', async () => {
    const otherCompany = await createCompany(`Other API company ${randomUUID()}`);

    const response = await request(app).get('/api/accounts');

    expect(response.status).toBe(200);
    expect(response.body.data.map((account) => account.code)).toEqual(['1000', '3000']);
    expect(response.body.data.some((account) => account.id === otherCompany.cashAccountId))
      .toBe(false);
  });

  test('creates a balanced manual entry', async () => {
    const response = await request(app)
      .post('/api/journal-entries')
      .send(balancedBody());

    expect(response.status).toBe(201);
    expect(response.body.data.source_type).toBe('manual');
    expect(response.body.data.lines).toHaveLength(2);
    expect(response.body.data.lines[0]).toMatchObject({
      debit: '10.00',
      credit: '0.00',
      accountCode: '1000',
      accountName: 'Cash and Bank',
    });
  });

  test('returns 422 for an unbalanced entry and saves nothing', async () => {
    const response = await request(app)
      .post('/api/journal-entries')
      .send(balancedBody('2026-11-05', '10.01', '10.00'));

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
    const listResponse = await request(app).get('/api/journal-entries');
    expect(listResponse.body.data).toHaveLength(0);
  });

  test('rejects a line with both a debit and credit', async () => {
    const body = balancedBody();
    body.lines[0].credit = '1.00';

    const response = await request(app)
      .post('/api/journal-entries')
      .send(body);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  test('rejects an entry with fewer than two lines', async () => {
    const body = balancedBody();
    body.lines = [body.lines[0]];

    const response = await request(app)
      .post('/api/journal-entries')
      .send(body);

    expect(response.status).toBe(422);
  });

  test('rejects an account belonging to another company', async () => {
    const otherCompany = await createCompany(`Foreign API company ${randomUUID()}`);
    const body = balancedBody();
    body.lines[1].accountId = otherCompany.capitalAccountId;

    const response = await request(app)
      .post('/api/journal-entries')
      .send(body);

    expect(response.status).toBe(422);
  });

  test('rejects an inactive account', async () => {
    await pool.query(
      'UPDATE accounts SET is_active = false WHERE company_id = $1 AND id = $2',
      [companyId, capitalAccountId],
    );

    const response = await request(app)
      .post('/api/journal-entries')
      .send(balancedBody());

    expect(response.status).toBe(422);
  });

  test('rejects malformed amounts and dates with validation errors', async () => {
    const malformedAmount = balancedBody();
    malformedAmount.lines[0].debit = '10.001';
    const amountResponse = await request(app)
      .post('/api/journal-entries')
      .send(malformedAmount);

    expect(amountResponse.status).toBe(400);
    expect(amountResponse.body.error.code).toBe('VALIDATION_ERROR');

    const dateResponse = await request(app)
      .post('/api/journal-entries')
      .send({ ...balancedBody(), date: '2026-02-30' });
    expect(dateResponse.status).toBe(400);
  });

  test('lists entries with date, status, and pagination filters', async () => {
    const earlier = await request(app)
      .post('/api/journal-entries')
      .send(balancedBody('2026-11-03'));
    const middle = await request(app)
      .post('/api/journal-entries')
      .send(balancedBody('2026-11-04'));
    const latest = await request(app)
      .post('/api/journal-entries')
      .send(balancedBody('2026-11-05'));
    expect([earlier.status, middle.status, latest.status]).toEqual([201, 201, 201]);

    await pool.query(
      'UPDATE journal_entries SET status = $1 WHERE company_id = $2 AND id = $3',
      ['void', companyId, middle.body.data.id],
    );

    const response = await request(app)
      .get('/api/journal-entries')
      .query({ from: '2026-11-04', to: '2026-11-05', status: 'posted', page: '1', limit: '1' });

    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({ page: 1, limit: 1, total: 1 });
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].id).toBe(latest.body.data.id);

    const secondPage = await request(app)
      .get('/api/journal-entries')
      .query({ page: '2', limit: '1' });
    expect(secondPage.body.meta).toEqual({ page: 2, limit: 1, total: 3 });
    expect(secondPage.body.data).toHaveLength(1);
  });

  test('gets an entry with its lines, and returns 404 for missing entries', async () => {
    const created = await request(app)
      .post('/api/journal-entries')
      .send(balancedBody());
    const response = await request(app)
      .get(`/api/journal-entries/${created.body.data.id}`);

    expect(response.status).toBe(200);
    expect(response.body.data.lines[0]).toMatchObject({
      accountCode: '1000',
      accountName: 'Cash and Bank',
    });

    const missingResponse = await request(app)
      .get('/api/journal-entries/ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.body.error.code).toBe('NOT_FOUND');

    const otherCompany = await createCompany(`Private API company ${randomUUID()}`);
    const otherEntry = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO journal_entries (company_id, entry_date, source_type)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [otherCompany.id, '2026-11-05', 'manual'],
      );
      await client.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit)
         VALUES ($1, $2, $3)`,
        [result.rows[0].id, otherCompany.cashAccountId, '10.00'],
      );
      await client.query(
        `INSERT INTO journal_lines (entry_id, account_id, credit)
         VALUES ($1, $2, $3)`,
        [result.rows[0].id, otherCompany.capitalAccountId, '10.00'],
      );
      return result.rows[0].id;
    });

    const crossCompanyResponse = await request(app)
      .get(`/api/journal-entries/${otherEntry}`);
    expect(crossCompanyResponse.status).toBe(404);
  });

  test('database trigger rejects an unbalanced entry at commit', async () => {
    const client = await pool.connect();
    let entryId;

    try {
      await client.query('BEGIN');
      const entryResult = await client.query(
        `INSERT INTO journal_entries (company_id, entry_date, source_type)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [companyId, '2026-11-05', 'manual'],
      );
      entryId = entryResult.rows[0].id;
      await client.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit)
         VALUES ($1, $2, $3)`,
        [entryId, cashAccountId, '10.00'],
      );

      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: 'P0001' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const savedEntry = await pool.query(
      'SELECT 1 FROM journal_entries WHERE company_id = $1 AND id = $2',
      [companyId, entryId],
    );
    expect(savedEntry.rowCount).toBe(0);
  });
});
