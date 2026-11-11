const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');
const app = require('../src/app');
const { pool, withTransaction } = require('../src/config/db');
const { register, login } = require('../src/services/auth.service');
const { getTodayInKualaLumpur } = require('../src/utils/report-date');

const MIGRATIONS_DIRECTORY = path.join(__dirname, '..', 'migrations');
const trackedCompanies = new Set();
let companyId;
let token;
let accounts;
let foreignCustomerId;
let foreignRevenueId;
let foreignCashId;
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
    const foreignCashAccount = await pool.query(
      `SELECT id FROM accounts WHERE company_id = $1 AND system_role = 'cash'`,
      [foreign.companyId],
    );
    foreignCashId = foreignCashAccount.rows[0].id;
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

  test('updates customers, keeps customer lists company-scoped, and exposes no delete endpoint', async () => {
    const customer = await createCustomer('Customer Edit Buyer');
    const updated = await api('patch', `/api/customers/${customer.id}`).send({
      name: 'Updated Customer',
      paymentTermsDays: 45,
    });
    const foreignReadList = await api('get', '/api/customers?search=Foreign&page=1&limit=100');
    const foreignUpdate = await api('patch', `/api/customers/${foreignCustomerId}`).send({ name: 'Unauthorized Update' });
    const deleted = await api('delete', `/api/customers/${customer.id}`);

    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ id: customer.id, name: 'Updated Customer', paymentTermsDays: 45 });
    expect(foreignReadList.body.data.some((item) => item.id === foreignCustomerId)).toBe(false);
    expect(foreignUpdate.status).toBe(404);
    expect(deleted.status).toBe(404);
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

  test('assigns distinct invoice numbers when two drafts are sent concurrently', async () => {
    const customer = await createCustomer('Concurrent Numbering Buyer');
    const [firstDraft, secondDraft] = await Promise.all([
      makeInvoice(customer.id),
      makeInvoice(customer.id),
    ]);
    expect([firstDraft.status, secondDraft.status]).toEqual([201, 201]);

    const sentInvoices = await Promise.all([
      sendInvoice(firstDraft.body.data.id),
      sendInvoice(secondDraft.body.data.id),
    ]);
    const numbers = sentInvoices.map((response) => response.body.data.invoiceNumber).sort();
    const journalEntryIds = sentInvoices.map((response) => response.body.data.journalEntryId);

    expect(sentInvoices.map((response) => response.status)).toEqual([200, 200]);
    expect(numbers).toEqual(['INV-0001', 'INV-0002']);
    expect(new Set(journalEntryIds).size).toBe(2);
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

  test('gets invoice details and filters and paginates invoice lists', async () => {
    const customer = await createCustomer('Filtered Invoice Buyer');
    const otherCustomer = await createCustomer('Other Invoice Buyer');
    const first = await makeInvoice(customer.id, { issueDate: '2026-11-01' });
    const second = await makeInvoice(customer.id, { issueDate: '2026-11-02' });
    const third = await makeInvoice(customer.id, { issueDate: '2026-11-03' });
    const other = await makeInvoice(otherCustomer.id, { issueDate: '2026-11-02' });
    expect([first.status, second.status, third.status, other.status]).toEqual([201, 201, 201, 201]);

    const sent = await sendInvoice(second.body.data.id);
    const detail = await api('get', `/api/invoices/${first.body.data.id}`);
    const filteredPageOne = await api(
      'get',
      `/api/invoices?status=draft&customerId=${customer.id}&from=2026-11-01&to=2026-11-03&page=1&limit=1`,
    );
    const filteredPageTwo = await api(
      'get',
      `/api/invoices?status=draft&customerId=${customer.id}&from=2026-11-01&to=2026-11-03&page=2&limit=1`,
    );
    const numberFiltered = await api('get', '/api/invoices?number=INV-0001');

    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      id: first.body.data.id,
      companyId,
      customerId: customer.id,
      invoiceNumber: null,
      issueDate: '2026-11-01',
      status: 'draft',
      subtotal: '100.00',
      taxTotal: '6.00',
      total: '106.00',
      amountPaid: '0.00',
      customer: { id: customer.id, name: customer.name },
      items: [expect.objectContaining({
        quantity: '1.00',
        unitPrice: '100.00',
        taxRate: '6.00',
        lineSubtotal: '100.00',
        lineTax: '6.00',
        lineTotal: '106.00',
      })],
      payments: [],
    });
    expect(filteredPageOne.body.meta).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(filteredPageTwo.body.meta).toMatchObject({ page: 2, limit: 1, total: 2 });
    expect(filteredPageOne.body.data).toHaveLength(1);
    expect(filteredPageTwo.body.data).toHaveLength(1);
    expect(filteredPageOne.body.data[0].id).not.toBe(filteredPageTwo.body.data[0].id);
    expect(filteredPageOne.body.data.every((invoice) => invoice.customerId === customer.id && invoice.status === 'draft')).toBe(true);
    expect(sent.body.data.invoiceNumber).toBe('INV-0001');
    expect(numberFiltered.body.data.map((invoice) => invoice.id)).toEqual([second.body.data.id]);

    const foreignInvoice = await api('post', '/api/invoices', foreignToken).send({
      customerId: foreignCustomerId,
      issueDate: '2026-11-01',
      items: [{ description: 'Foreign sale', quantity: '1.00', unitPrice: '20.00', taxRate: '0.00', revenueAccountId: foreignRevenueId }],
    });
    const missing = await api('get', `/api/invoices/${randomUUID()}`);
    const foreignDetail = await api('get', `/api/invoices/${foreignInvoice.body.data.id}`);
    expect(foreignInvoice.status).toBe(201);
    expect(missing.status).toBe(404);
    expect(foreignDetail.status).toBe(404);
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
    const firstEntry = await api('get', `/api/journal-entries/${first.body.data.payment.journalEntryId}`);
    const finalEntry = await api('get', `/api/journal-entries/${final.body.data.payment.journalEntryId}`);
    const voidPaid = await api('post', `/api/invoices/${draft.body.data.id}/void`).send({});

    expect(sent.body.data.status).toBe('sent');
    expect(first.status).toBe(201);
    expect(first.body.data.invoice).toMatchObject({ status: 'partial', amountPaid: '50.00' });
    expect(voidPartial.status).toBe(422);
    expect(tooMuch.status).toBe(422);
    expect(firstEntry.body.data.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: accounts.cash, debit: '50.00', credit: '0.00' }),
      expect.objectContaining({ accountId: accounts.accounts_receivable, debit: '0.00', credit: '50.00' }),
    ]));
    expect(final.status).toBe(201);
    expect(final.body.data.invoice).toMatchObject({ status: 'paid', amountPaid: '106.00' });
    expect(finalEntry.body.data.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: accounts.cash, debit: '56.00', credit: '0.00' }),
      expect.objectContaining({ accountId: accounts.accounts_receivable, debit: '0.00', credit: '56.00' }),
    ]));
    expect(voidPaid.status).toBe(422);
  });

  test('rejects a deposit account owned by another company without recording a payment', async () => {
    const customer = await createCustomer('Foreign Deposit Buyer');
    const draft = await makeInvoice(customer.id);
    await sendInvoice(draft.body.data.id);

    const rejected = await api('post', `/api/invoices/${draft.body.data.id}/payments`).send({
      amount: '10.00', method: 'bank_transfer', depositAccountId: foreignCashId,
    });
    const invoice = await api('get', `/api/invoices/${draft.body.data.id}`);
    const paymentEntries = await pool.query(
      `SELECT id FROM journal_entries
       WHERE company_id = $1 AND source_type = 'payment' AND source_id = $2`,
      [companyId, draft.body.data.id],
    );

    expect(rejected.status).toBe(422);
    expect(invoice.body.data).toMatchObject({ status: 'sent', amountPaid: '0.00', payments: [] });
    expect(paymentEntries.rowCount).toBe(0);
  });

  test('voids only unpaid sent invoices and posts a reversal that returns A/R to zero', async () => {
    const customer = await createCustomer('Void Buyer');
    const draft = await makeInvoice(customer.id);
    const sent = await sendInvoice(draft.body.data.id);
    const voided = await api('post', `/api/invoices/${draft.body.data.id}/void`).send({});
    const duplicateVoid = await api('post', `/api/invoices/${draft.body.data.id}/void`).send({});
    const trialBalance = await api('get', '/api/reports/trial-balance?asOf=2026-11-30');
    const ar = trialBalance.body.data.accounts.find((account) => account.accountId === accounts.accounts_receivable);
    const original = await api('get', `/api/journal-entries/${sent.body.data.journalEntryId}`);
    const reversal = await api('get', `/api/journal-entries/${voided.body.data.reversalEntryId}`);

    expect(voided.status).toBe(200);
    expect(duplicateVoid.status).toBe(422);
    expect(voided.body.data.status).toBe('void');
    expect(voided.body.data.reversalEntryId).toBeTruthy();
    expect(original.body.data.status).toBe('posted');
    expect(original.body.data.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: accounts.accounts_receivable, debit: '106.00', credit: '0.00' }),
      expect.objectContaining({ accountId: accounts.revenue, debit: '0.00', credit: '100.00' }),
      expect.objectContaining({ accountId: accounts.sales_tax_payable, debit: '0.00', credit: '6.00' }),
    ]));
    expect(reversal.body.data).toMatchObject({
      status: 'posted',
      source_type: 'reversal',
      reverses_entry_id: sent.body.data.journalEntryId,
    });
    expect(reversal.body.data.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: accounts.accounts_receivable, debit: '0.00', credit: '106.00' }),
      expect.objectContaining({ accountId: accounts.revenue, debit: '100.00', credit: '0.00' }),
      expect.objectContaining({ accountId: accounts.sales_tax_payable, debit: '6.00', credit: '0.00' }),
    ]));
    expect(ar).toMatchObject({ debit: '0.00', credit: '0.00' });
    expect(sent.body.data.invoiceNumber).toBe('INV-0001');
  });

  test('keeps A/R aging consistent before and after a later-dated void reversal', async () => {
    const customer = await createCustomer('Historical Void Buyer');
    const asOfBeforeVoid = new Date(`${getTodayInKualaLumpur()}T00:00:00.000Z`);
    asOfBeforeVoid.setUTCDate(asOfBeforeVoid.getUTCDate() - 1);
    const asOf = asOfBeforeVoid.toISOString().slice(0, 10);
    const issueDate = new Date(`${asOf}T00:00:00.000Z`);
    issueDate.setUTCDate(issueDate.getUTCDate() - 1);
    const invoice = await makeInvoice(customer.id, {
      issueDate: issueDate.toISOString().slice(0, 10),
      dueDate: asOf,
      items: [{
        description: 'Historical void', quantity: '1.00', unitPrice: '100.00', taxRate: '0.00',
        revenueAccountId: accounts.revenue,
      }],
    });
    await sendInvoice(invoice.body.data.id);
    await api('post', `/api/invoices/${invoice.body.data.id}/void`).send({});

    const beforeReversal = await api('get', `/api/reports/ar-aging?asOf=${asOf}`);
    const afterReversal = await api('get', `/api/reports/ar-aging?asOf=${getTodayInKualaLumpur()}`);

    expect(beforeReversal.body.data).toMatchObject({
      totals: { total: '100.00' },
      ledgerBalance: '100.00',
      difference: '0.00',
      reconciles: true,
    });
    expect(afterReversal.body.data).toMatchObject({
      totals: { total: '0.00' },
      ledgerBalance: '0.00',
      difference: '0.00',
      reconciles: true,
    });
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

  test('keeps A/R aging scoped to the authenticated company', async () => {
    const foreignDraft = await api('post', '/api/invoices', foreignToken).send({
      customerId: foreignCustomerId,
      issueDate: '2026-11-01',
      dueDate: '2026-11-30',
      items: [{
        description: 'Foreign aging balance',
        quantity: '1.00',
        unitPrice: '25.00',
        taxRate: '0.00',
        revenueAccountId: foreignRevenueId,
      }],
    });
    const foreignSent = await sendInvoice(foreignDraft.body.data.id, foreignToken);
    const ownReport = await api('get', '/api/reports/ar-aging?asOf=2026-11-30');
    const foreignReport = await api('get', '/api/reports/ar-aging?asOf=2026-11-30', foreignToken);

    expect(foreignDraft.status).toBe(201);
    expect(foreignSent.status).toBe(200);
    expect(ownReport.body.data.customers).toEqual([]);
    expect(ownReport.body.data.ledgerBalance).toBe('0.00');
    expect(ownReport.body.data.totals.total).toBe('0.00');
    expect(foreignReport.body.data.customers).toEqual(expect.arrayContaining([
      expect.objectContaining({ customerId: foreignCustomerId }),
    ]));
    expect(foreignReport.body.data.ledgerBalance).not.toBe('0.00');
    expect(foreignReport.body.data.reconciles).toBe(true);
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

  test('rejects money with more than two decimal places at the invoice and payment APIs', async () => {
    const customer = await createCustomer('Decimal Validation Buyer');
    const invalidInvoice = await makeInvoice(customer.id, { items: [{
      description: 'Invalid precision',
      quantity: '1.00',
      unitPrice: '1.001',
      taxRate: '0.00',
      revenueAccountId: accounts.revenue,
    }] });
    const draft = await makeInvoice(customer.id);
    await sendInvoice(draft.body.data.id);
    const invalidPayment = await api('post', `/api/invoices/${draft.body.data.id}/payments`).send({
      amount: '1.001',
      method: 'cash',
      depositAccountId: accounts.cash,
    });

    expect(invalidInvoice.status).toBe(400);
    expect(invalidPayment.status).toBe(400);
  });
});
