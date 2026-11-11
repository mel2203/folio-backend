const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');
const app = require('../src/app');
const { pool, withTransaction } = require('../src/config/db');
const { register, login } = require('../src/services/auth.service');

const MIGRATIONS_DIRECTORY = path.join(__dirname, '..', 'migrations');
const trackedCompanies = new Set();
const AS_OF = '2026-11-11';

async function applyTestMigrations() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const files = (await fs.readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  for (const name of files) {
    await withTransaction(async (client) => {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (applied.rowCount) return;
      await client.query(await fs.readFile(path.join(MIGRATIONS_DIRECTORY, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
  }
}

async function createCompany(label) {
  const suffix = randomUUID();
  const email = `${label}-${suffix}@example.test`;
  const password = 'Test-password-123';
  const owner = await register({ companyName: `${label} ${suffix}`, fullName: 'Dashboard Test', email, password });
  const session = await login({ email, password });
  trackedCompanies.add(owner.company.id);
  const accountResult = await pool.query(
    'SELECT id, code, name, type, system_role AS role FROM accounts WHERE company_id = $1',
    [owner.company.id],
  );
  const accounts = accountResult.rows;
  return {
    companyId: owner.company.id,
    token: session.token,
    cash: accounts.find((account) => account.role === 'cash').id,
    receivable: accounts.find((account) => account.role === 'accounts_receivable').id,
    payable: accounts.find((account) => account.role === 'accounts_payable').id,
    revenue: accounts.find((account) => account.type === 'revenue').id,
    expense: accounts.find((account) => account.type === 'expense').id,
    equity: accounts.find((account) => account.type === 'equity').id,
  };
}

function api(method, route, token) {
  const requestBuilder = request(app)[method](route);
  return token ? requestBuilder.set('Authorization', `Bearer ${token}`) : requestBuilder;
}

async function removeCompany(companyId) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM payments WHERE company_id = $1', [companyId]);
    await client.query(
      `DELETE FROM bill_payments payment USING bills bill
       WHERE payment.bill_id = bill.id AND bill.company_id = $1`,
      [companyId],
    );
    await client.query('DELETE FROM invoices WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM bills WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM journal_entries WHERE company_id = $1', [companyId]);
    await client.query('UPDATE accounts SET parent_id = NULL WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM accounts WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM vendors WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM document_sequences WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM users WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM companies WHERE id = $1', [companyId]);
  });
}

async function postCapital(company, amount = '1000.00', date = AS_OF) {
  return api('post', '/api/journal-entries', company.token).send({
    date,
    memo: 'Owner capital',
    lines: [
      { accountId: company.cash, debit: amount, credit: '0.00' },
      { accountId: company.equity, debit: '0.00', credit: amount },
    ],
  });
}

async function createSalesAndPurchaseActivity(company) {
  const customer = await api('post', '/api/customers', company.token).send({ name: 'Northstar Studio' });
  const invoice = await api('post', '/api/invoices', company.token).send({
    customerId: customer.body.data.id,
    issueDate: '2026-11-01',
    dueDate: '2026-11-10',
    items: [{
      description: 'Design services',
      quantity: '1.00',
      unitPrice: '100.00',
      taxRate: '6.00',
      revenueAccountId: company.revenue,
    }],
  });
  const sent = await api('post', `/api/invoices/${invoice.body.data.id}/send`, company.token).send({});
  const payment = await api('post', `/api/invoices/${invoice.body.data.id}/payments`, company.token).send({
    paymentDate: '2026-11-05',
    amount: '25.00',
    method: 'bank_transfer',
    depositAccountId: company.cash,
  });
  const vendor = await api('post', '/api/vendors', company.token).send({ name: 'City Offices' });
  const bill = await api('post', '/api/bills', company.token).send({
    vendorId: vendor.body.data.id,
    billNumber: `RENT-${randomUUID().slice(0, 8)}`,
    issueDate: '2026-11-03',
    dueDate: '2026-12-01',
    items: [{ description: 'Office rent', amount: '40.00', accountId: company.expense }],
  });
  const postedBill = await api('post', `/api/bills/${bill.body.data.id}/post`, company.token).send({});
  return { customer, invoice, sent, payment, vendor, bill, postedBill };
}

describe('Dashboard summary API', () => {
  beforeAll(async () => {
    await applyTestMigrations();
  });

  afterEach(async () => {
    for (const companyId of trackedCompanies) {
      await removeCompany(companyId);
      trackedCompanies.delete(companyId);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  test('summarizes posted activity and aging for a small company scenario', async () => {
    const company = await createCompany('Dashboard figures');
    const capital = await postCapital(company);
    const activity = await createSalesAndPurchaseActivity(company);
    expect([capital.status, activity.customer.status, activity.invoice.status, activity.sent.status])
      .toEqual([201, 201, 201, 200]);
    expect([activity.payment.status, activity.vendor.status, activity.bill.status, activity.postedBill.status])
      .toEqual([201, 201, 201, 200]);

    const response = await api('get', '/api/dashboard/summary', company.token).query({ asOf: AS_OF });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      asOf: AS_OF,
      currency: 'MYR',
      balances: {
        cash: '1025.00',
        accountsReceivable: '81.00',
        accountsPayable: '40.00',
      },
      netIncomeThisMonth: '60.00',
      overdueInvoices: { count: 1, amount: '81.00' },
      topCustomers: [{ customerId: activity.customer.body.data.id, name: 'Northstar Studio', invoicedAmount: '106.00' }],
      topExpenseAccounts: [{ accountId: company.expense, amount: '40.00' }],
    });
    expect(response.body.data.monthlyPerformance).toHaveLength(6);
    expect(response.body.data.monthlyPerformance.at(-1)).toEqual({
      month: '2026-11',
      revenue: '100.00',
      expenses: '40.00',
    });
    expect(response.body.data.monthlyPerformance.slice(0, 5).every(
      (month) => month.revenue === '0.00' && month.expenses === '0.00',
    )).toBe(true);
  });

  test('isolates dashboard aggregates by authenticated company', async () => {
    const owner = await createCompany('Dashboard owner');
    const otherCompany = await createCompany('Dashboard other');
    const otherCapital = await postCapital(otherCompany, '80.00');
    expect(otherCapital.status).toBe(201);

    const [ownerSummary, otherSummary] = await Promise.all([
      api('get', '/api/dashboard/summary', owner.token).query({ asOf: AS_OF }),
      api('get', '/api/dashboard/summary', otherCompany.token).query({ asOf: AS_OF }),
    ]);

    expect(ownerSummary.status).toBe(200);
    expect(ownerSummary.body.data.balances.cash).toBe('0.00');
    expect(ownerSummary.body.data.netIncomeThisMonth).toBe('0.00');
    expect(otherSummary.status).toBe(200);
    expect(otherSummary.body.data.balances.cash).toBe('80.00');
    expect(otherSummary.body.data.balances.accountsReceivable).toBe('0.00');
  });

  test('returns a complete zero summary for an empty company', async () => {
    const company = await createCompany('Dashboard empty');
    const response = await api('get', '/api/dashboard/summary', company.token).query({ asOf: AS_OF });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      asOf: AS_OF,
      currency: 'MYR',
      balances: { cash: '0.00', accountsReceivable: '0.00', accountsPayable: '0.00' },
      netIncomeThisMonth: '0.00',
      overdueInvoices: { count: 0, amount: '0.00' },
      topCustomers: [],
      topExpenseAccounts: [],
    });
    expect(response.body.data.monthlyPerformance).toHaveLength(6);
  });

  test('validates the as-of date and requires authentication', async () => {
    const company = await createCompany('Dashboard validation');
    const invalidDate = await api('get', '/api/dashboard/summary', company.token).query({ asOf: '2026-02-30' });
    const unauthenticated = await api('get', '/api/dashboard/summary', null).query({ asOf: AS_OF });

    expect(invalidDate.status).toBe(400);
    expect(invalidDate.body.error.code).toBe('VALIDATION_ERROR');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe('UNAUTHENTICATED');
  });
});
