const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');
const app = require('../src/app');
const { pool, withTransaction } = require('../src/config/db');
const { register, login } = require('../src/services/auth.service');

const MIGRATIONS_DIRECTORY = path.join(__dirname, '..', 'migrations');
const createdCompanyIds = new Set();
let companyId;
let token;
let cashAccountId;
let capitalAccountId;
let foreignAccountId;
let accountCode = 9000;

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
      if (applied.rowCount > 0) return;

      const migrationSql = await fs.readFile(
        path.join(MIGRATIONS_DIRECTORY, fileName),
        'utf8',
      );
      await client.query(migrationSql);
      await client.query(
        'INSERT INTO schema_migrations (name) VALUES ($1)',
        [fileName],
      );
    });
  }
}

async function removeCompany(targetCompanyId) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM journal_entries WHERE company_id = $1', [targetCompanyId]);
    await client.query('UPDATE accounts SET parent_id = NULL WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM accounts WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM users WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM companies WHERE id = $1', [targetCompanyId]);
  });
}

function api(method, route) {
  return request(app)[method](route).set('Authorization', `Bearer ${token}`);
}

async function createAccount({ code = String(accountCode++), ...body } = {}) {
  const response = await api('post', '/api/accounts').send({
    code,
    name: 'Test account',
    type: 'asset',
    ...body,
  });
  expect(response.status).toBe(201);
  return response.body.data;
}

async function postEntry(lines, date = '2026-11-05') {
  return api('post', '/api/journal-entries').send({
    date,
    memo: 'Account lifecycle test',
    lines,
  });
}

describe('account management API', () => {
  beforeAll(async () => {
    await applyTestMigrations();

    const unique = randomUUID();
    const owner = await register({
      companyName: `Account API company ${unique}`,
      fullName: 'Account API Test User',
      email: `account-api-${unique}@example.com`,
      password: 'Test-password-123',
    });
    companyId = owner.company.id;
    createdCompanyIds.add(companyId);
    token = (await login({
      email: `account-api-${unique}@example.com`,
      password: 'Test-password-123',
    })).token;

    const seededAccounts = await pool.query(
      `SELECT id, code FROM accounts
       WHERE company_id = $1 AND code IN ('1000', '3000')`,
      [companyId],
    );
    cashAccountId = seededAccounts.rows.find((account) => account.code === '1000').id;
    capitalAccountId = seededAccounts.rows.find((account) => account.code === '3000').id;

    const otherUnique = randomUUID();
    const otherOwner = await register({
      companyName: `Foreign account company ${otherUnique}`,
      fullName: 'Foreign Account API Test User',
      email: `foreign-account-api-${otherUnique}@example.com`,
      password: 'Test-password-123',
    });
    createdCompanyIds.add(otherOwner.company.id);
    foreignAccountId = (await pool.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND code = '1000'`,
      [otherOwner.company.id],
    )).rows[0].id;
  });

  beforeEach(async () => {
    accountCode = 9000;
    await withTransaction(async (client) => {
      await client.query('DELETE FROM journal_entries WHERE company_id = $1', [companyId]);
      await client.query(
        'UPDATE accounts SET is_active = true, parent_id = NULL WHERE company_id = $1',
        [companyId],
      );
      await client.query(
        `DELETE FROM accounts
         WHERE company_id = $1 AND code ~ '^9[0-9]{3,6}$'`,
        [companyId],
      );
    });
  });

  afterAll(async () => {
    for (const targetCompanyId of createdCompanyIds) {
      await removeCompany(targetCompanyId);
    }
    await pool.end();
  });

  test('creates accounts with derived normal balances and returns the account fields', async () => {
    const account = await createAccount({ name: '  Clearing  ', type: 'expense' });
    const accounts = await api('get', '/api/accounts?active=true');
    const cash = accounts.body.data.find((row) => row.id === cashAccountId);

    expect(account).toMatchObject({
      code: '9000',
      name: 'Clearing',
      type: 'expense',
      normalBalance: 'debit',
      parentId: null,
      isActive: true,
      systemRole: null,
    });
    expect(cash).toMatchObject({ normalBalance: 'debit', systemRole: 'cash', isActive: true });
  });

  test('returns 409 for a duplicate company code and 400 for invalid code or type', async () => {
    const duplicate = await api('post', '/api/accounts').send({
      code: '1000', name: 'Duplicate', type: 'asset',
    });
    const invalidCode = await api('post', '/api/accounts').send({
      code: '10A0', name: 'Invalid code', type: 'asset',
    });
    const invalidType = await api('post', '/api/accounts').send({
      code: '9000', name: 'Invalid type', type: 'bank',
    });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ACCOUNT_CODE_IN_USE');
    expect(invalidCode.status).toBe(400);
    expect(invalidType.status).toBe(400);
  });

  test('rejects a parent from another company', async () => {
    const response = await api('post', '/api/accounts').send({
      code: '9000', name: 'Foreign parent child', type: 'asset', parentId: foreignAccountId,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/same company/i);
  });

  test('rejects a parent with another account type and prevents parent cycles', async () => {
    const expenseParent = await createAccount({ type: 'expense' });
    const wrongTypeParent = await api('post', '/api/accounts').send({
      code: String(accountCode++), name: 'Wrong type child', type: 'asset', parentId: expenseParent.id,
    });
    const first = await createAccount();
    const second = await createAccount({ parentId: first.id });
    const cycle = await api('patch', `/api/accounts/${first.id}`).send({ parentId: second.id });

    expect(wrongTypeParent.status).toBe(422);
    expect(cycle.status).toBe(422);
    expect(cycle.body.error.message).toMatch(/descendant/i);
  });

  test('renames and recodes an account but rejects any type change', async () => {
    const account = await createAccount();
    const renamed = await api('patch', `/api/accounts/${account.id}`).send({
      name: 'Updated account', code: '9001',
    });
    const typeChange = await api('patch', `/api/accounts/${account.id}`).send({ type: 'expense' });

    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ name: 'Updated account', code: '9001', type: 'asset' });
    expect(typeChange.status).toBe(400);
  });

  test('refuses to deactivate an account with a nonzero posted balance', async () => {
    const account = await createAccount();
    const entry = await postEntry([
      { accountId: account.id, debit: '50.00', credit: '0.00' },
      { accountId: capitalAccountId, debit: '0.00', credit: '50.00' },
    ]);
    const response = await api('patch', `/api/accounts/${account.id}`).send({ isActive: false });

    expect(entry.status).toBe(201);
    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/net posted balance/i);
  });

  test('refuses to deactivate a system account and allows clean account deactivation/reactivation', async () => {
    const systemAccount = await api('patch', `/api/accounts/${cashAccountId}`).send({ isActive: false });
    const cleanAccount = await createAccount();
    const deactivated = await api('patch', `/api/accounts/${cleanAccount.id}`).send({ isActive: false });
    const reactivated = await api('patch', `/api/accounts/${cleanAccount.id}`).send({ isActive: true });

    expect(systemAccount.status).toBe(422);
    expect(systemAccount.body.error.message).toMatch(/system accounts/i);
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.data.isActive).toBe(false);
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.data.isActive).toBe(true);
  });

  test('filters active accounts and keeps account data scoped to the authenticated company', async () => {
    const inactive = await createAccount();
    await api('patch', `/api/accounts/${inactive.id}`).send({ isActive: false });
    const active = await api('get', '/api/accounts?active=true');
    const inactiveList = await api('get', '/api/accounts?active=false');
    const foreignPatch = await api('patch', `/api/accounts/${foreignAccountId}`).send({ name: 'Changed' });

    expect(active.status).toBe(200);
    expect(active.body.data.every((account) => account.isActive)).toBe(true);
    expect(inactiveList.body.data.map((account) => account.id)).toContain(inactive.id);
    expect(active.body.data.some((account) => account.id === foreignAccountId)).toBe(false);
    expect(foreignPatch.status).toBe(404);
  });

  test('rejects journal postings to inactive accounts', async () => {
    const account = await createAccount();
    await api('patch', `/api/accounts/${account.id}`).send({ isActive: false });
    const response = await postEntry([
      { accountId: account.id, debit: '10.00', credit: '0.00' },
      { accountId: capitalAccountId, debit: '0.00', credit: '10.00' },
    ]);

    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/active account/i);
  });

  test('shows historical posted balances for accounts that are now inactive', async () => {
    const account = await createAccount();
    const firstEntry = await postEntry([
      { accountId: account.id, debit: '10.00', credit: '0.00' },
      { accountId: capitalAccountId, debit: '0.00', credit: '10.00' },
    ], '2026-11-02');
    const secondEntry = await postEntry([
      { accountId: cashAccountId, debit: '10.00', credit: '0.00' },
      { accountId: account.id, debit: '0.00', credit: '10.00' },
    ], '2026-11-03');
    const deactivated = await api('patch', `/api/accounts/${account.id}`).send({ isActive: false });
    const trialBalance = await api('get', '/api/reports/trial-balance?asOf=2026-11-02');
    const accountBalance = trialBalance.body.data.accounts.find((row) => row.accountId === account.id);

    expect(firstEntry.status).toBe(201);
    expect(secondEntry.status).toBe(201);
    expect(deactivated.status).toBe(200);
    expect(accountBalance).toMatchObject({ debit: '10.00', credit: '0.00' });
  });
});
