const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');
const app = require('../src/app');
const { pool, withTransaction } = require('../src/config/db');
const { register, login } = require('../src/services/auth.service');

const MIGRATIONS_DIRECTORY = path.join(__dirname, '..', 'migrations');
const trackedCompanies = new Set();
let companyId;
let token;
let accounts;
let foreignVendorId;
let foreignExpenseId;
let foreignToken;

async function applyTestMigrations() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const files = (await fs.readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const name of files) {
    await withTransaction(async (client) => {
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (exists.rowCount) return;
      await client.query(await fs.readFile(path.join(MIGRATIONS_DIRECTORY, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
  }
}

async function createUserCompany(label) {
  const suffix = randomUUID();
  const email = `${label}-${suffix}@example.test`;
  const password = 'Test-password-123';
  const owner = await register({ companyName: `${label} ${suffix}`, fullName: 'Purchases Test', email, password });
  const signedIn = await login({ email, password });
  trackedCompanies.add(owner.company.id);
  return { companyId: owner.company.id, token: signedIn.token };
}

function api(method, route, auth = token) {
  const req = request(app)[method](route);
  return auth ? req.set('Authorization', `Bearer ${auth}`) : req;
}

async function createVendor(name = `Vendor ${randomUUID()}`, auth = token, extra = {}) {
  const result = await api('post', '/api/vendors', auth).send({ name, paymentTermsDays: 30, ...extra });
  expect(result.status).toBe(201);
  return result.body.data;
}

function billBody(vendorId, overrides = {}) {
  return {
    vendorId,
    billNumber: `SUP-${randomUUID().slice(0, 8)}`,
    issueDate: '2026-11-01',
    items: [{ description: 'Office rent', amount: '300.00', accountId: accounts.expense }],
    ...overrides,
  };
}

async function makeBill(vendorId, overrides = {}, auth = token) {
  return api('post', '/api/bills', auth).send(billBody(vendorId, overrides));
}

async function postBill(billId, auth = token) {
  return api('post', `/api/bills/${billId}/post`, auth).send({});
}

async function clearPurchases(targetCompanyId) {
  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM bill_payments payment USING bills bill
       WHERE payment.bill_id = bill.id AND bill.company_id = $1`, [targetCompanyId],
    );
    await client.query('DELETE FROM bills WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM journal_entries WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM vendors WHERE company_id = $1', [targetCompanyId]);
  });
}

async function removeCompany(targetCompanyId) {
  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM bill_payments payment USING bills bill
       WHERE payment.bill_id = bill.id AND bill.company_id = $1`, [targetCompanyId],
    );
    await client.query('DELETE FROM bills WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM journal_entries WHERE company_id = $1', [targetCompanyId]);
    await client.query('UPDATE accounts SET parent_id = NULL WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM accounts WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM vendors WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM users WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM companies WHERE id = $1', [targetCompanyId]);
  });
}

describe('Purchases API', () => {
  beforeAll(async () => {
    await applyTestMigrations();
    const own = await createUserCompany('Purchases company');
    companyId = own.companyId;
    token = own.token;
    const accountRows = await pool.query('SELECT id, type, system_role AS role FROM accounts WHERE company_id = $1', [companyId]);
    accounts = {
      ...Object.fromEntries(accountRows.rows.map((row) => [row.role, row.id]).filter(([role]) => role)),
      expense: accountRows.rows.find((row) => row.type === 'expense').id,
      asset: accountRows.rows.find((row) => row.type === 'asset').id,
      revenue: accountRows.rows.find((row) => row.type === 'revenue').id,
    };
    const foreign = await createUserCompany('Foreign purchases company');
    foreignToken = foreign.token;
    foreignVendorId = (await createVendor('Foreign vendor', foreignToken)).id;
    foreignExpenseId = (await pool.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND type = 'expense' ORDER BY code LIMIT 1`, [foreign.companyId],
    )).rows[0].id;
  });

  beforeEach(async () => {
    await clearPurchases(companyId);
    await pool.query('UPDATE accounts SET is_active = true WHERE company_id = $1', [companyId]);
  });

  afterAll(async () => {
    for (const id of trackedCompanies) await removeCompany(id);
    await pool.end();
  });

  test('lists, searches, pages, edits, deactivates, and isolates vendors', async () => {
    const vendor = await createVendor('Northstar Supplies');
    const list = await api('get', '/api/vendors?search=Northstar&active=true&page=1&limit=5');
    const edited = await api('patch', `/api/vendors/${vendor.id}`).send({ name: 'Northstar Office' });
    const inactive = await api('patch', `/api/vendors/${vendor.id}`).send({ isActive: false });
    const foreignRead = await api('get', `/api/vendors/${foreignVendorId}`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta).toMatchObject({ page: 1, limit: 5, total: 1 });
    expect(edited.body.data.name).toBe('Northstar Office');
    expect(inactive.body.data.isActive).toBe(false);
    expect(foreignRead.status).toBe(404);
  });

  test('requires authentication and validates vendor and bill inputs', async () => {
    const unauthenticated = await api('get', '/api/vendors', null);
    const invalidVendor = await api('post', '/api/vendors').send({ name: '  ' });
    const invalidBill = await api('post', '/api/bills').send({ vendorId: 'bad', billNumber: '', items: [] });
    expect(unauthenticated.status).toBe(401);
    expect(invalidVendor.status).toBe(400);
    expect(invalidBill.status).toBe(400);
  });

  test('creates drafts, defaults due dates from terms, and rejects duplicate vendor bill numbers', async () => {
    const vendor = await createVendor('Terms supplier', token, { paymentTermsDays: 45 });
    const draft = await makeBill(vendor.id, { billNumber: 'INV-777', dueDate: undefined });
    const duplicate = await makeBill(vendor.id, { billNumber: 'INV-777' });
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({ status: 'draft', billNumber: 'INV-777', dueDate: '2026-12-16', total: '300.00' });
    expect(duplicate.status).toBe(409);
  });

  test('posts expense and asset lines against A/P and keeps all three reports balanced after payment', async () => {
    const vendor = await createVendor('Posting supplier');
    const bill = await makeBill(vendor.id, { items: [
      { description: 'Rent', amount: '200.00', accountId: accounts.expense },
      { description: 'Equipment', amount: '100.00', accountId: accounts.asset },
    ] });
    const posted = await postBill(bill.body.data.id);
    const entry = await api('get', `/api/journal-entries/${posted.body.data.journalEntryId}`);
    expect(posted.body.data.status).toBe('open');
    expect(entry.body.data.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: accounts.expense, debit: '200.00', credit: '0.00' }),
      expect.objectContaining({ accountId: accounts.asset, debit: '100.00', credit: '0.00' }),
      expect.objectContaining({ accountId: accounts.accounts_payable, debit: '0.00', credit: '300.00' }),
    ]));
    const trial = await api('get', '/api/reports/trial-balance?asOf=2026-11-30');
    expect(trial.body.data.totals).toEqual({ debit: '300.00', credit: '300.00' });
    expect(trial.body.data.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: accounts.expense, debit: '200.00', credit: '0.00' }),
      expect.objectContaining({ accountId: accounts.accounts_payable, debit: '0.00', credit: '300.00' }),
    ]));
    const paid = await api('post', `/api/bills/${bill.body.data.id}/payments`).send({
      paymentDate: '2026-11-10', amount: '100.00', method: 'bank_transfer', payingAccountId: accounts.asset,
    });
    expect(paid.body.data.bill).toMatchObject({ status: 'partial', amountPaid: '100.00' });
    const income = await api('get', '/api/reports/income-statement?from=2026-11-01&to=2026-11-30');
    const balance = await api('get', '/api/reports/balance-sheet?asOf=2026-11-30');
    expect(income.body.data.expenses.total).toBe('200.00');
    expect(balance.body.data.isBalanced).toBe(true);
    expect(balance.body.data.totalLiabilitiesAndEquity).toBe(balance.body.data.assets.total);
  });

  test('records partial then full payments and rejects overpayment and non-asset paying accounts', async () => {
    const vendor = await createVendor('Payments supplier');
    const bill = await makeBill(vendor.id);
    await postBill(bill.body.data.id);
    const first = await api('post', `/api/bills/${bill.body.data.id}/payments`).send({ amount: '100.00', method: 'cash', payingAccountId: accounts.asset });
    const voidPartial = await api('post', `/api/bills/${bill.body.data.id}/void`).send({});
    const excess = await api('post', `/api/bills/${bill.body.data.id}/payments`).send({ amount: '201.00', method: 'cash', payingAccountId: accounts.asset });
    const wrongAccount = await api('post', `/api/bills/${bill.body.data.id}/payments`).send({ amount: '1.00', method: 'cash', payingAccountId: accounts.expense });
    const final = await api('post', `/api/bills/${bill.body.data.id}/payments`).send({ amount: '200.00', method: 'cash', payingAccountId: accounts.asset });
    expect(first.body.data.bill.status).toBe('partial');
    expect(voidPartial.status).toBe(422);
    expect(excess.status).toBe(422);
    expect(wrongAccount.status).toBe(422);
    expect(final.body.data.bill).toMatchObject({ status: 'paid', amountPaid: '300.00' });
  });

  test('edits and deletes drafts only, rejects invalid accounts and cross-company ids', async () => {
    const vendor = await createVendor('Draft supplier');
    const bill = await makeBill(vendor.id);
    const edit = await api('patch', `/api/bills/${bill.body.data.id}`).send({ notes: 'Corrected before posting' });
    const foreignVendorBill = await makeBill(foreignVendorId);
    const foreignAccountBill = await makeBill(vendor.id, { items: [{ description: 'Foreign', amount: '10.00', accountId: foreignExpenseId }] });
    const revenueAccountBill = await makeBill(vendor.id, { items: [{ description: 'Wrong type', amount: '10.00', accountId: accounts.revenue }] });
    await pool.query('UPDATE accounts SET is_active = false WHERE id = $1 AND company_id = $2', [accounts.expense, companyId]);
    const inactiveAccountBill = await makeBill(vendor.id);
    await pool.query('UPDATE accounts SET is_active = true WHERE id = $1 AND company_id = $2', [accounts.expense, companyId]);
    const posted = await postBill(bill.body.data.id);
    const blockedEdit = await api('patch', `/api/bills/${bill.body.data.id}`).send({ notes: 'Too late' });
    const inactiveVendor = await api('patch', `/api/vendors/${vendor.id}`).send({ isActive: false });
    const inactiveBill = await makeBill(vendor.id);
    const activeVendor = await createVendor('Active draft supplier');
    const deletable = await makeBill(activeVendor.id);
    const deleted = await api('delete', `/api/bills/${deletable.body.data.id}`);
    expect(edit.body.data.notes).toBe('Corrected before posting');
    expect(foreignVendorBill.status).toBe(422);
    expect(foreignAccountBill.status).toBe(422);
    expect(revenueAccountBill.status).toBe(422);
    expect(inactiveAccountBill.status).toBe(422);
    expect(inactiveVendor.body.data.isActive).toBe(false);
    expect(inactiveBill.status).toBe(422);
    expect(posted.status).toBe(200);
    expect(blockedEdit.status).toBe(422);
    expect(deleted.status).toBe(204);
  });

  test('voids only unpaid open bills and reversal returns A/P to zero', async () => {
    const vendor = await createVendor('Void supplier');
    const bill = await makeBill(vendor.id);
    const posted = await postBill(bill.body.data.id);
    const voided = await api('post', `/api/bills/${bill.body.data.id}/void`).send({});
    const duplicateVoid = await api('post', `/api/bills/${bill.body.data.id}/void`).send({});
    const trial = await api('get', '/api/reports/trial-balance?asOf=2026-11-30');
    const ap = trial.body.data.accounts.find((account) => account.accountId === accounts.accounts_payable);
    const reversal = await api('get', `/api/journal-entries/${voided.body.data.reversalEntryId}`);
    expect(posted.body.data.status).toBe('open');
    expect(voided.body.data.status).toBe('void');
    expect(reversal.body.data.sourceType || reversal.body.data.source_type).toBe('reversal');
    expect(duplicateVoid.status).toBe(422);
    expect(ap).toMatchObject({ debit: '0.00', credit: '0.00' });
  });

  test('keeps the bill list tenant isolated and excludes payments after the A/P aging date', async () => {
    const ownVendor = await createVendor('Own aging supplier');
    const ownBill = await makeBill(ownVendor.id, { issueDate: '2026-11-01', dueDate: '2026-11-30' });
    await postBill(ownBill.body.data.id);
    const foreignBill = await makeBill(foreignVendorId, {
      issueDate: '2026-11-01', dueDate: '2026-11-30',
      items: [{ description: 'Foreign bill', amount: '20.00', accountId: foreignExpenseId }],
    }, foreignToken);
    const list = await api('get', '/api/bills');
    const payment = await api('post', `/api/bills/${ownBill.body.data.id}/payments`).send({
      paymentDate: '2026-12-01', amount: '50.00', method: 'cash', payingAccountId: accounts.asset,
    });
    const aging = await api('get', '/api/reports/ap-aging?asOf=2026-11-30');
    expect(foreignBill.status).toBe(201);
    expect(list.body.data.some((row) => row.id === foreignBill.body.data.id)).toBe(false);
    expect(payment.status).toBe(201);
    expect(aging.body.data.totals.total).toBe('300.00');
    expect(aging.body.data.ledgerBalance).toBe('300.00');
    expect(aging.body.data.reconciles).toBe(true);
  });

  test('groups A/P aging on exact due-date boundaries and reconciles with the ledger', async () => {
    const vendor = await createVendor('Aging supplier');
    const dueDates = ['2026-11-30', '2026-11-29', '2026-10-31', '2026-10-30', '2026-10-01', '2026-09-30', '2026-09-01', '2026-08-31'];
    for (const [index, dueDate] of dueDates.entries()) {
      const bill = await makeBill(vendor.id, {
        billNumber: `AGE-${index}`, issueDate: '2026-11-30', dueDate,
        items: [{ description: `Aging item ${index}`, amount: '10.00', accountId: accounts.expense }],
      });
      await postBill(bill.body.data.id);
    }
    const aging = await api('get', '/api/reports/ap-aging?asOf=2026-11-30');
    expect(aging.body.data.vendors[0]).toMatchObject({
      current: '10.00', days1To30: '20.00', days31To60: '20.00',
      days61To90: '20.00', days90Plus: '10.00', total: '80.00',
    });
    expect(aging.body.data.totals.total).toBe('80.00');
    expect(aging.body.data.ledgerBalance).toBe('80.00');
    expect(aging.body.data.difference).toBe('0.00');
    expect(aging.body.data.reconciles).toBe(true);
  });

  test('rejects malformed aging dates and returns empty aging for a company without bills', async () => {
    const noBillCompany = await createUserCompany('Empty purchases company');
    const invalid = await api('get', '/api/reports/ap-aging?asOf=2026-02-30');
    const invalidRange = await api('get', '/api/bills?from=2026-11-30&to=2026-11-01');
    const empty = await api('get', '/api/reports/ap-aging', noBillCompany.token);
    expect(invalid.status).toBe(400);
    expect(invalidRange.status).toBe(400);
    expect(empty.body.data).toMatchObject({
      vendors: [], ledgerBalance: '0.00', difference: '0.00', reconciles: true,
      totals: { current: '0.00', days1To30: '0.00', days31To60: '0.00', days61To90: '0.00', days90Plus: '0.00', total: '0.00' },
    });
  });
});
