const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');
const app = require('../src/app');
const { pool, withTransaction } = require('../src/config/db');
const { register, login } = require('../src/services/auth.service');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const MIGRATIONS_DIRECTORY = path.join(__dirname, '..', 'migrations');
const createdCompanyIds = new Set();
let companyId;
let cashAccountId;
let capitalAccountId;
let authToken;
let testEmail;
let testPassword;
let mainTestUser;

function api(method, route, token = authToken) {
  const testRequest = request(app)[method](route);
  return token
    ? testRequest.set('Authorization', `Bearer ${token}`)
    : testRequest;
}

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

async function registerTestUser({ trackForCleanup = true } = {}) {
  const uniqueId = randomUUID();
  const email = `api-${uniqueId}@example.com`;
  const password = 'Test-password-123';
  const result = await register({
    companyName: `Authenticated API company ${uniqueId}`,
    fullName: 'API Test User',
    email,
    password,
  });
  const loginResult = await login({ email, password });
  const accountResult = await pool.query(
    `SELECT id, code
     FROM accounts
     WHERE company_id = $1 AND code IN ($2, $3)`,
    [result.company.id, '1000', '3000'],
  );
  const accountsByCode = new Map(
    accountResult.rows.map((account) => [account.code, account.id]),
  );

  if (trackForCleanup) {
    createdCompanyIds.add(result.company.id);
  }
  return {
    companyId: result.company.id,
    userId: result.user.id,
    token: loginResult.token,
    email,
    password,
    cashAccountId: accountsByCode.get('1000'),
    capitalAccountId: accountsByCode.get('3000'),
  };
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
      'DELETE FROM users WHERE company_id = $1',
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
    mainTestUser = await registerTestUser({ trackForCleanup: false });
    companyId = mainTestUser.companyId;
    cashAccountId = mainTestUser.cashAccountId;
    capitalAccountId = mainTestUser.capitalAccountId;
    authToken = mainTestUser.token;
    testEmail = mainTestUser.email;
    testPassword = mainTestUser.password;
  });

  beforeEach(async () => {
    companyId = mainTestUser.companyId;
    cashAccountId = mainTestUser.cashAccountId;
    capitalAccountId = mainTestUser.capitalAccountId;
    authToken = mainTestUser.token;
    testEmail = mainTestUser.email;
    testPassword = mainTestUser.password;

    await withTransaction(async (client) => {
      await client.query(
        'UPDATE accounts SET is_active = true WHERE company_id = $1',
        [companyId],
      );
      await client.query(
        `DELETE FROM journal_lines
         WHERE entry_id IN (
           SELECT id FROM journal_entries WHERE company_id = $1
         )`,
        [companyId],
      );
      await client.query(
        'DELETE FROM journal_entries WHERE company_id = $1',
        [companyId],
      );
    });
  });

  afterEach(async () => {
    for (const testCompanyId of createdCompanyIds) {
      await removeCompany(testCompanyId);
      createdCompanyIds.delete(testCompanyId);
    }
  });

  afterAll(async () => {
    if (mainTestUser) {
      await removeCompany(mainTestUser.companyId);
    }
    await pool.end();
  });

  test('lists accounts for the current company only', async () => {
    const otherCompany = await createCompany(`Other API company ${randomUUID()}`);

    const response = await api('get', '/api/accounts');

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(15);
    expect(response.body.data.map((account) => account.code)).toContain('1000');
    expect(response.body.data.map((account) => account.code)).toContain('3000');
    expect(response.body.data.some((account) => account.id === otherCompany.cashAccountId))
      .toBe(false);
  });

  test('creates a balanced manual entry', async () => {
    const response = await api('post', '/api/journal-entries')
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
    const response = await api('post', '/api/journal-entries')
      .send(balancedBody('2026-11-05', '10.01', '10.00'));

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
    const listResponse = await api('get', '/api/journal-entries');
    expect(listResponse.body.data).toHaveLength(0);
  });

  test('rejects a line with both a debit and credit', async () => {
    const body = balancedBody();
    body.lines[0].credit = '1.00';

    const response = await api('post', '/api/journal-entries')
      .send(body);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  test('rejects an entry with fewer than two lines', async () => {
    const body = balancedBody();
    body.lines = [body.lines[0]];

    const response = await api('post', '/api/journal-entries')
      .send(body);

    expect(response.status).toBe(422);
  });

  test('rejects an account belonging to another company', async () => {
    const otherCompany = await createCompany(`Foreign API company ${randomUUID()}`);
    const body = balancedBody();
    body.lines[1].accountId = otherCompany.capitalAccountId;

    const response = await api('post', '/api/journal-entries')
      .send(body);

    expect(response.status).toBe(422);
  });

  test('rejects an inactive account', async () => {
    await pool.query(
      'UPDATE accounts SET is_active = false WHERE company_id = $1 AND id = $2',
      [companyId, capitalAccountId],
    );

    const response = await api('post', '/api/journal-entries')
      .send(balancedBody());

    expect(response.status).toBe(422);
  });

  test('rejects malformed amounts and dates with validation errors', async () => {
    const malformedAmount = balancedBody();
    malformedAmount.lines[0].debit = '10.001';
    const amountResponse = await api('post', '/api/journal-entries')
      .send(malformedAmount);

    expect(amountResponse.status).toBe(400);
    expect(amountResponse.body.error.code).toBe('VALIDATION_ERROR');

    const dateResponse = await api('post', '/api/journal-entries')
      .send({ ...balancedBody(), date: '2026-02-30' });
    expect(dateResponse.status).toBe(400);
  });

  test('lists entries with date, status, and pagination filters', async () => {
    const earlier = await api('post', '/api/journal-entries')
      .send(balancedBody('2026-11-03'));
    const middle = await api('post', '/api/journal-entries')
      .send(balancedBody('2026-11-04'));
    const latest = await api('post', '/api/journal-entries')
      .send(balancedBody('2026-11-05'));
    expect([earlier.status, middle.status, latest.status]).toEqual([201, 201, 201]);

    await pool.query(
      'UPDATE journal_entries SET status = $1 WHERE company_id = $2 AND id = $3',
      ['void', companyId, middle.body.data.id],
    );

    const response = await api('get', '/api/journal-entries')
      .query({ from: '2026-11-04', to: '2026-11-05', status: 'posted', page: '1', limit: '1' });

    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({ page: 1, limit: 1, total: 1 });
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].id).toBe(latest.body.data.id);

    const secondPage = await api('get', '/api/journal-entries')
      .query({ page: '2', limit: '1' });
    expect(secondPage.body.meta).toEqual({ page: 2, limit: 1, total: 3 });
    expect(secondPage.body.data).toHaveLength(1);
  });

  test('gets an entry with its lines, and returns 404 for missing entries', async () => {
    const created = await api('post', '/api/journal-entries')
      .send(balancedBody());
    const response = await api('get', `/api/journal-entries/${created.body.data.id}`);

    expect(response.status).toBe(200);
    expect(response.body.data.lines[0]).toMatchObject({
      accountCode: '1000',
      accountName: 'Cash and Bank',
    });

    const missingResponse = await api('get', '/api/journal-entries/ffffffff-ffff-4fff-8fff-ffffffffffff');
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

    const crossCompanyResponse = await api('get', `/api/journal-entries/${otherEntry}`);
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

  test('registers a company, user, and 15 default accounts without returning the password hash', async () => {
    const email = `registration-${randomUUID()}@example.com`;
    const password = 'Registration-password-1';
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        companyName: '  Registration Test Company ',
        fullName: ' Registration User ',
        email: ` ${email} `,
        password,
      });

    expect(response.status).toBe(201);
    expect(response.body.data.user.email).toBe(email);
    expect(response.body.data.user.fullName).toBe('Registration User');
    expect(response.body.data.user).not.toHaveProperty('password_hash');
    expect(response.body.data.user).not.toHaveProperty('passwordHash');
    expect(response.body.data.company.name).toBe('Registration Test Company');
    const newCompanyId = response.body.data.company.id;
    createdCompanyIds.add(newCompanyId);

    const accountCount = await pool.query(
      'SELECT COUNT(*) AS total FROM accounts WHERE company_id = $1',
      [newCompanyId],
    );
    expect(Number(accountCount.rows[0].total)).toBe(15);

    const userResult = await pool.query(
      `SELECT password_hash
       FROM users
       WHERE id = $1 AND company_id = $2`,
      [response.body.data.user.id, newCompanyId],
    );
    const storedHash = userResult.rows[0].password_hash;
    expect(storedHash === password).toBe(false);
    expect(await bcrypt.compare(password, storedHash)).toBe(true);
  });

  test('rejects duplicate registration regardless of email case', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        companyName: 'Duplicate Test Company',
        fullName: 'Duplicate User',
        email: testEmail.toUpperCase(),
        password: 'Another-password-1',
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('EMAIL_IN_USE');
  });

  test('rejects invalid registration and login inputs', async () => {
    const weakPasswordResponse = await request(app)
      .post('/api/auth/register')
      .send({
        companyName: 'Invalid Test Company',
        fullName: 'Invalid User',
        email: `weak-${randomUUID()}@example.com`,
        password: 'short',
      });
    const invalidEmailResponse = await request(app)
      .post('/api/auth/register')
      .send({
        companyName: 'Invalid Test Company',
        fullName: 'Invalid User',
        email: 'not-an-email',
        password: 'Valid-password-1',
      });
    const unknownFieldResponse = await request(app)
      .post('/api/auth/login')
      .send({
        email: testEmail,
        password: testPassword,
        companyId,
      });

    expect(weakPasswordResponse.status).toBe(400);
    expect(invalidEmailResponse.status).toBe(400);
    expect(unknownFieldResponse.status).toBe(400);
  });

  test('logs in and returns a user without a password hash', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: ` ${testEmail.toUpperCase()} `, password: testPassword });

    expect(response.status).toBe(200);
    expect(typeof response.body.data.token === 'string').toBe(true);
    expect(response.body.data.user).toMatchObject({
      email: testEmail,
      fullName: 'API Test User',
    });
    expect(response.body.data.user).not.toHaveProperty('passwordHash');
    expect(response.body.data.user).not.toHaveProperty('password_hash');
  });

  test('returns identical login errors for an unknown email and a wrong password', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: testEmail, password: 'Wrong-password-1' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: `unknown-${randomUUID()}@example.com`, password: 'Wrong-password-1' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('UNAUTHENTICATED');
    expect(unknownEmail.body.error.code).toBe('UNAUTHENTICATED');
    expect(wrongPassword.body.error.message).toBe('Invalid email or password');
    expect(unknownEmail.body.error.message).toBe('Invalid email or password');
  });

  test('returns the authenticated user and company from /me', async () => {
    const response = await api('get', '/api/auth/me');

    expect(response.status).toBe(200);
    expect(response.body.data.user).toMatchObject({
      id: expect.any(String),
      email: testEmail,
      fullName: 'API Test User',
    });
    expect(response.body.data.company).toMatchObject({
      id: companyId,
      name: expect.stringContaining('Authenticated API company'),
      baseCurrency: 'MYR',
    });
  });

  test('rejects missing and invalid tokens on every protected API route', async () => {
    const invalidTokens = [
      null,
      'malformed-token',
      jwt.sign({ sub: 'not-a-real-user' }, 'wrong-secret-with-at-least-thirty-two-characters'),
      jwt.sign({ sub: 'not-a-real-user' }, process.env.JWT_SECRET, { expiresIn: -1 }),
      (() => {
        const valid = jwt.sign({ sub: 'not-a-real-user' }, process.env.JWT_SECRET);
        const [header, payload, signature] = valid.split('.');
        const changedSignature = signature[0] === 'A' ? 'B' : 'A';
        return `${header}.${payload}.${changedSignature}${signature.slice(1)}`;
      })(),
      (() => {
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ sub: 'not-a-real-user' })).toString('base64url');
        return `${header}.${payload}.`;
      })(),
    ];

    for (const token of invalidTokens) {
      for (const [method, route] of [
        ['get', '/api/accounts'],
        ['get', '/api/journal-entries'],
        ['get', '/api/journal-entries/ffffffff-ffff-4fff-8fff-ffffffffffff'],
        ['post', '/api/journal-entries'],
        ['get', '/api/auth/me'],
      ]) {
        const testRequest = api(method, route, token);
        if (method === 'post') {
          testRequest.send({});
        }
        const response = await testRequest;
        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('UNAUTHENTICATED');
      }
    }
  });

  test('rejects a valid token after its user has been deleted', async () => {
    const deletedUser = await registerTestUser();
    const deletedUserId = (await pool.query(
      'SELECT id FROM users WHERE company_id = $1',
      [deletedUser.companyId],
    )).rows[0].id;
    await pool.query(
      'DELETE FROM users WHERE company_id = $1 AND id = $2',
      [deletedUser.companyId, deletedUserId],
    );

    const response = await api('get', '/api/accounts', deletedUser.token);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('isolates accounts and journal entries between two authenticated companies', async () => {
    const userB = await registerTestUser();
    const entryForUserB = await api('post', '/api/journal-entries', userB.token)
      .send({
        date: '2026-11-05',
        memo: 'Private entry',
        lines: [
          { accountId: userB.cashAccountId, debit: '10.00', credit: '0.00' },
          { accountId: userB.capitalAccountId, debit: '0.00', credit: '10.00' },
        ],
      });
    expect(entryForUserB.status).toBe(201);

    const accountsForUserA = await api('get', '/api/accounts');
    const entriesForUserA = await api('get', '/api/journal-entries');
    const userBEntryAsUserA = await api(
      'get',
      `/api/journal-entries/${entryForUserB.body.data.id}`,
    );
    const userBAccountForUserA = await api('post', '/api/journal-entries')
      .send({
        date: '2026-11-05',
        memo: 'Attempt to use a foreign account',
        lines: [
          { accountId: userB.cashAccountId, debit: '10.00', credit: '0.00' },
          { accountId: capitalAccountId, debit: '0.00', credit: '10.00' },
        ],
      });

    expect(accountsForUserA.body.data).toHaveLength(15);
    expect(accountsForUserA.body.data.some((account) => account.id === userB.cashAccountId))
      .toBe(false);
    expect(entriesForUserA.body.meta.total).toBe(0);
    expect(userBEntryAsUserA.status).toBe(404);
    expect(userBAccountForUserA.status).toBe(422);
  }, 30000);
});
