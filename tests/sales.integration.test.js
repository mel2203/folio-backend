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
let foreignCustomerId;
let foreignRevenueId;
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
  const owner = await register({ companyName: `${label} ${suffix}`, fullName: 'Sales Test', email, password });
  const signedIn = await login({ email, password });
  trackedCompanies.add(owner.company.id);
  return { companyId: owner.company.id, token: signedIn.token };
}

function api(method, route, auth = token) {
  const req = request(app)[method](route);
  return auth ? req.set('Authorization', `Bearer ${auth}`) : req;
}

async function createCustomer(name = 'Northwind Studio', auth = token) {
  const response = await api('post', '/api/customers', auth).send({
    name, email: `${name.toLowerCase().replaceAll(' ', '.')}@example.test`, paymentTermsDays: 30,
  });
  expect(response.status).toBe(201);
  return response.body.data;
}

async function makeInvoice(customerId, overrides = {}, auth = token) {
  return api('post', '/api/invoices', auth).send({
    customerId,
    issueDate: '2026-11-01',
    items: [{
      description: 'Consulting', quantity: '1.00', unitPrice: '100.00', taxRate: '6.00',
      revenueAccountId: accounts.revenue,
    }],
    ...overrides,
  });
}

async function sendInvoice(invoiceId, auth = token) {
  return api('post', `/api/invoices/${invoiceId}/send`, auth).send({});
}

async function clearSalesRows(targetCompanyId) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM payments WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM invoices WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM journal_entries WHERE company_id = $1', [targetCompanyId]);
    await client.query("DELETE FROM customers WHERE company_id = $1 AND name NOT LIKE 'Foreign %'", [targetCompanyId]);
    await client.query("DELETE FROM document_sequences WHERE company_id = $1 AND kind = 'invoice'", [targetCompanyId]);
  });
}

async function removeCompany(targetCompanyId) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM payments WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM invoices WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM journal_entries WHERE company_id = $1', [targetCompanyId]);
    await client.query('UPDATE accounts SET parent_id = NULL WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM accounts WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM customers WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM document_sequences WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM users WHERE company_id = $1', [targetCompanyId]);
    await client.query('DELETE FROM companies WHERE id = $1', [targetCompanyId]);
  });
}

describe('Sales API', () => {
  beforeAll(async () => {
    await applyTestMigrations();
    const own = await createUserCompany('Sales API company');
    companyId = own.companyId;
    token = own.token;
    const accountRows = await pool.query(
      `SELECT system_role AS role, code, id FROM accounts WHERE company_id = $1`, [companyId],
    );
    accounts = Object.fromEntries(accountRows.rows.flatMap((row) => [
      [row.role || row.code, row.id], [row.code, row.id],
    ]));
    accounts.revenue = accounts['4000'];

    const foreign = await createUserCompany('Foreign sales company');
    foreignToken = foreign.token;
    const foreignCustomer = await api('post', '/api/customers', foreignToken).send({ name: 'Foreign Buyer' });
    foreignCustomerId = foreignCustomer.body.data.id;
    const foreignAccounts = await pool.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND type = 'revenue' ORDER BY code LIMIT 1`,
      [foreign.companyId],
    );
    foreignRevenueId = foreignAccounts.rows[0].id;
  });

  beforeEach(async () => {
    await clearSalesRows(companyId);
    await pool.query('UPDATE accounts SET is_active = true WHERE company_id = $1', [companyId]);
  });

  afterAll(async () => {
    for (const targetCompanyId of trackedCompanies) await removeCompany(targetCompanyId);
    await pool.end();
  });

  test('creates, searches, paginates, reads, and deactivates customers with company scoping', async () => {
    const customer = await createCustomer();
    const list = await api('get', '/api/customers?search=Northwind&active=true&page=1&limit=5');
    const detail = await api('get', `/api/customers/${customer.id}`);
    const inactive = await api('patch', `/api/customers/${customer.id}`).send({ isActive: false });
    const foreignRead = await api('get', `/api/customers/${foreignCustomerId}`);

    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta).toMatchObject({ page: 1, limit: 5, total: 1 });
    expect(detail.body.data.paymentTermsDays).toBe(30);
    expect(inactive.body.data.isActive).toBe(false);
    expect(foreignRead.status).toBe(404);
  });

  test('rejects missing authentication and invalid customer input', async () => {
    const unauthenticated = await api('get', '/api/customers', null);
    const invalid = await api('post', '/api/customers').send({ name: '  ' });
    expect(unauthenticated.status).toBe(401);
    expect(invalid.status).toBe(400);
  });

  test('creates drafts without numbers, applies terms, and assigns gapless numbers on send', async () => {
    const customer = await createCustomer('Numbering Buyer');
    const draft = await makeInvoice(customer.id);
    const secondDraft = await makeInvoice(customer.id);
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({ status: 'draft', invoiceNumber: null, dueDate: '2026-12-01', total: '106.00' });

    const firstSent = await sendInvoice(draft.body.data.id);
    const secondSent = await sendInvoice(secondDraft.body.data.id);
    const firstEntry = await api('get', `/api/journal-entries/${firstSent.body.data.journalEntryId}`);
    expect(firstSent.body.data.invoiceNumber).toBe('INV-0001');
    expect(secondSent.body.data.invoiceNumber).toBe('INV-0002');
    expect(firstEntry.body.data.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: accounts.accounts_receivable, debit: '106.00', credit: '0.00' }),
      expect.objectContaining({ accountId: accounts.revenue, debit: '0.00', credit: '100.00' }),
      expect.objectContaining({ accountId: accounts.sales_tax_payable, debit: '0.00', credit: '6.00' }),
    ]));
  });

  test('sends balanced exact lines, omits zero tax, and consumes no number on failed send', async () => {
    const customer = await createCustomer('Posting Buyer');
    const invalid = await makeInvoice(customer.id, { items: [{
      description: 'Free sample', quantity: '1.00', unitPrice: '0.00', taxRate: '0.00', revenueAccountId: accounts.revenue,
    }] });
    const failedSend = await sendInvoice(invalid.body.data.id);
    const draft = await makeInvoice(customer.id, { items: [{
      description: 'Tax-free service', quantity: '1.00', unitPrice: '250.00', taxRate: '0.00', revenueAccountId: accounts.revenue,
    }] });
    const sent = await sendInvoice(draft.body.data.id);
    const entry = await api('get', `/api/journal-entries/${sent.body.data.journalEntryId}`);

    expect(failedSend.status).toBe(422);
    expect(sent.body.data.invoiceNumber).toBe('INV-0001');
    expect(entry.body.data.lines).toHaveLength(2);
    expect(entry.body.data.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: accounts.accounts_receivable, debit: '250.00', credit: '0.00' }),
      expect.objectContaining({ accountId: accounts.revenue, debit: '0.00', credit: '250.00' }),
    ]));
  });

  test('rejects cross-company customers and revenue accounts, plus inactive customers and accounts', async () => {
    const customer = await createCustomer('Ownership Buyer');
    const crossCustomer = await makeInvoice(foreignCustomerId);
    const crossAccount = await makeInvoice(customer.id, { items: [{
      description: 'Foreign revenue', quantity: '1.00', unitPrice: '10.00', taxRate: '0.00', revenueAccountId: foreignRevenueId,
    }] });
    await api('patch', `/api/customers/${customer.id}`).send({ isActive: false });
    const inactiveCustomer = await makeInvoice(customer.id);

    const inactiveAccountResult = await pool.query('UPDATE accounts SET is_active = false WHERE id = $1', [accounts.revenue]);
    expect(inactiveAccountResult.rowCount).toBe(1);
    const newCustomer = await createCustomer('Active Buyer');
    const inactiveRevenue = await makeInvoice(newCustomer.id);

    expect(crossCustomer.status).toBe(422);
    expect(crossAccount.status).toBe(422);
    expect(inactiveCustomer.status).toBe(422);
    expect(inactiveRevenue.status).toBe(422);
    await pool.query('UPDATE accounts SET is_active = true WHERE id = $1', [accounts.revenue]);
  });

  test('keeps invoice lists tenant isolated and rejects foreign invoice customer and account ids', async () => {
    const foreignInvoice = await api('post', '/api/invoices', foreignToken).send({
      customerId: foreignCustomerId,
      issueDate: '2026-11-01',
      items: [{ description: 'Foreign sale', quantity: '1.00', unitPrice: '20.00', taxRate: '0.00', revenueAccountId: foreignRevenueId }],
    });
    const ownCustomer = await createCustomer('Tenant Buyer');
    const foreignCustomerRequest = await makeInvoice(foreignCustomerId);
    const foreignAccountRequest = await makeInvoice(ownCustomer.id, { items: [{
      description: 'Foreign account', quantity: '1.00', unitPrice: '20.00', taxRate: '0.00', revenueAccountId: foreignRevenueId,
    }] });
    const ownList = await api('get', '/api/invoices');

    expect(foreignInvoice.status).toBe(201);
    expect(foreignCustomerRequest.status).toBe(422);
    expect(foreignAccountRequest.status).toBe(422);
    expect(ownList.body.data.some((invoice) => invoice.id === foreignInvoice.body.data.id)).toBe(false);
  });

  test('edits and deletes drafts but prevents edits or deletion after sending', async () => {
    const customer = await createCustomer('Draft Buyer');
    const draft = await makeInvoice(customer.id);
    const edited = await api('patch', `/api/invoices/${draft.body.data.id}`).send({ notes: 'Updated draft note' });
    const sent = await sendInvoice(draft.body.data.id);
    const sentEdit = await api('patch', `/api/invoices/${draft.body.data.id}`).send({ notes: 'Not allowed' });
    const sentDelete = await api('delete', `/api/invoices/${draft.body.data.id}`);
    const deletable = await makeInvoice(customer.id);
    const deleted = await api('delete', `/api/invoices/${deletable.body.data.id}`);

    expect(edited.body.data.notes).toBe('Updated draft note');
    expect(sent.status).toBe(200);
    expect(sentEdit.status).toBe(422);
    expect(sentDelete.status).toBe(422);
    expect(deleted.status).toBe(204);
  });

  test('records partial then full payments and rejects overpayment', async () => {
    const customer = await createCustomer('Payment Buyer');
    const draft = await makeInvoice(customer.id);
    const sent = await sendInvoice(draft.body.data.id);
    const first = await api('post', `/api/invoices/${draft.body.data.id}/payments`).send({
      paymentDate: '2026-11-05', amount: '50.00', method: 'bank_transfer', depositAccountId: accounts.cash,
    });
    const voidPartial = await api('post', `/api/invoices/${draft.body.data.id}/void`).send({});
    const tooMuch = await api('post', `/api/invoices/${draft.body.data.id}/payments`).send({
      amount: '57.00', method: 'cash', depositAccountId: accounts.cash,
    });
    const final = await api('post', `/api/invoices/${draft.body.data.id}/payments`).send({
      paymentDate: '2026-11-06', amount: '56.00', method: 'bank_transfer', depositAccountId: accounts.cash,
    });

    expect(sent.body.data.status).toBe('sent');
    expect(first.body.data.invoice).toMatchObject({ status: 'partial', amountPaid: '50.00' });
    expect(voidPartial.status).toBe(422);
    expect(tooMuch.status).toBe(422);
    expect(final.body.data.invoice).toMatchObject({ status: 'paid', amountPaid: '106.00' });
  });

  test('voids only unpaid sent invoices and posts a reversal that returns A/R to zero', async () => {
    const customer = await createCustomer('Void Buyer');
    const draft = await makeInvoice(customer.id);
    const sent = await sendInvoice(draft.body.data.id);
    const voided = await api('post', `/api/invoices/${draft.body.data.id}/void`).send({});
    const duplicateVoid = await api('post', `/api/invoices/${draft.body.data.id}/void`).send({});
    const trialBalance = await api('get', '/api/reports/trial-balance?asOf=2026-11-30');
    const ar = trialBalance.body.data.accounts.find((account) => account.accountId === accounts.accounts_receivable);
    const reversal = await api('get', `/api/journal-entries/${voided.body.data.reversalEntryId}`);

    expect(voided.status).toBe(200);
    expect(duplicateVoid.status).toBe(422);
    expect(voided.body.data.status).toBe('void');
    expect(voided.body.data.reversalEntryId).toBeTruthy();
    expect(reversal.body.data.source_type || reversal.body.data.sourceType).toBe('reversal');
    expect(ar).toMatchObject({ debit: '0.00', credit: '0.00' });
    expect(sent.body.data.invoiceNumber).toBe('INV-0001');
  });

  test('reports invoice and payment effects in Trial Balance, Profit and Loss, and Balance Sheet', async () => {
    const customer = await createCustomer('Report Buyer');
    const draft = await makeInvoice(customer.id);
    const sent = await sendInvoice(draft.body.data.id);
    await api('post', `/api/invoices/${draft.body.data.id}/payments`).send({
      paymentDate: '2026-11-05', amount: '50.00', method: 'bank_transfer', depositAccountId: accounts.cash,
    });
    const trialBalance = await api('get', '/api/reports/trial-balance?asOf=2026-11-30');
    const income = await api('get', '/api/reports/income-statement?from=2026-11-01&to=2026-11-30');
    const balance = await api('get', '/api/reports/balance-sheet?asOf=2026-11-30');

    expect(sent.body.data.total).toBe('106.00');
    expect(trialBalance.body.data.totals).toEqual({ debit: '106.00', credit: '106.00' });
    expect(income.body.data.revenue.total).toBe('100.00');
    expect(balance.body.data.assets.total).toBe('106.00');
    expect(balance.body.data.liabilities.total).toBe('6.00');
    expect(balance.body.data.isBalanced).toBe(true);
  });

  test('ages due-date boundaries and reconciles to the A/R ledger balance', async () => {
    const customer = await createCustomer('Aging Buyer');
    const dueDates = ['2026-11-30', '2026-10-31', '2026-10-30', '2026-09-30', '2026-09-01', '2026-08-31'];
    for (const [index, dueDate] of dueDates.entries()) {
      const invoice = await makeInvoice(customer.id, {
        dueDate,
        items: [{ description: `Aging ${index}`, quantity: '1.00', unitPrice: '10.00', taxRate: '0.00', revenueAccountId: accounts.revenue }],
      });
      await sendInvoice(invoice.body.data.id);
    }
    const response = await api('get', '/api/reports/ar-aging?asOf=2026-11-30');
    const row = response.body.data.customers[0];

    expect(row).toMatchObject({
      current: '10.00', days1To30: '10.00', days31To60: '10.00',
      days61To90: '20.00', days90Plus: '10.00', total: '60.00',
    });
    expect(response.body.data.totals.total).toBe('60.00');
    expect(response.body.data.ledgerBalance).toBe('60.00');
    expect(response.body.data.difference).toBe('0.00');
    expect(response.body.data.reconciles).toBe(true);
  });

  test('aging as-of subtracts only payments through that date and exposes manual A/R differences', async () => {
    const customer = await createCustomer('Aging Payment Buyer');
    const draft = await makeInvoice(customer.id, { dueDate: '2026-10-01' });
    await sendInvoice(draft.body.data.id);
    await api('post', `/api/invoices/${draft.body.data.id}/payments`).send({
      paymentDate: '2026-11-10', amount: '20.00', method: 'cash', depositAccountId: accounts.cash,
    });
    const beforePayment = await api('get', '/api/reports/ar-aging?asOf=2026-11-09');
    const afterPayment = await api('get', '/api/reports/ar-aging?asOf=2026-11-10');

    expect(beforePayment.body.data.totals.total).toBe('106.00');
    expect(afterPayment.body.data.totals.total).toBe('86.00');
    expect(afterPayment.body.data.reconciles).toBe(true);

    await api('post', '/api/journal-entries').send({
      date: '2026-11-11', memo: 'Manual receivable adjustment', lines: [
        { accountId: accounts.accounts_receivable, debit: '5.00', credit: '0.00' },
        { accountId: accounts['3000'], debit: '0.00', credit: '5.00' },
      ],
    });
    const adjusted = await api('get', '/api/reports/ar-aging?asOf=2026-11-11');
    expect(adjusted.body.data.difference).toBe('5.00');
    expect(adjusted.body.data.reconciles).toBe(false);
  });

  test('rejects malformed dates and reversed invoice list ranges', async () => {
    const invalidAging = await api('get', '/api/reports/ar-aging?asOf=2026-02-30');
    const invalidRange = await api('get', '/api/invoices?from=2026-11-30&to=2026-11-01');
    expect(invalidAging.status).toBe(400);
    expect(invalidRange.status).toBe(400);
  });
});
