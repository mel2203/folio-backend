const { pool, withTransaction } = require('../src/config/db');
const { register } = require('../src/services/auth.service');
const { createCustomer } = require('../src/services/customer.service');
const { createVendor } = require('../src/services/vendor.service');
const {
  createInvoice,
  recordPayment,
  sendInvoice,
} = require('../src/services/invoice.service');
const {
  createBill,
  postBill,
  recordBillPayment,
} = require('../src/services/bill.service');
const { postJournalEntry } = require('../src/services/journal.service');
const { centsToDecimal, decimalToCents } = require('../src/utils/money');
const { getTodayInKualaLumpur } = require('../src/utils/report-date');

const DEMO_COMPANY_NAME = 'Folio Demo Company';
const DEMO_FULL_NAME = 'Folio Demo User';
const CUSTOMER_NAMES = [
  'Bunga Raya Studio',
  'Kopi Kita Sdn Bhd',
  'Rimba Design House',
  'Selatan Wellness',
  'Cahaya Events',
  'Tiga Rakan Trading',
  'Pandan Creative Co.',
  'Laman Digital',
];
const VENDOR_NAMES = [
  'Metro Office Supplies',
  'Tenaga Utilities Services',
  'Sentral Property Management',
  'Kawan Payroll Services',
  'Nusa Software Solutions',
  'Maju Printing Works',
];
const INVOICE_DESCRIPTIONS = [
  'Brand identity package',
  'Monthly social media management',
  'Website design and maintenance',
  'Product photography',
  'Marketing campaign services',
];
const INVOICE_PRICES = ['850.00', '1250.00', '1680.00', '2200.00', '2950.00'];
const INVOICE_STATUSES = [
  'paid', 'paid', 'partial', 'overdue', 'sent', 'draft',
  'paid', 'partial', 'sent', 'draft', 'paid', 'overdue',
  'partial', 'paid', 'sent', 'overdue', 'paid', 'partial',
  'draft', 'sent', 'paid', 'overdue', 'partial', 'paid', 'draft',
];
const BILL_TYPES = [
  { description: 'Monthly office rent', accountName: 'Rent Expense', amount: '3500.00' },
  { description: 'Electricity and water', accountName: 'Utilities Expense', amount: '465.00' },
  { description: 'Monthly payroll services', accountName: 'Salaries Expense', amount: '6200.00' },
  { description: 'Office stationery and supplies', accountName: 'Office Supplies Expense', amount: '185.00' },
];

function formatDate(year, month, day) {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function addDays(date, count) {
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + count));
  return formatDate(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate());
}

function monthStartOffset(date, offset) {
  const [year, month] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1 + offset, 1));
  return formatDate(result.getUTCFullYear(), result.getUTCMonth() + 1, 1);
}

function dateInMonth(monthStart, requestedDay, asOf) {
  const [year, month] = monthStart.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(requestedDay, lastDay);
  const candidate = formatDate(year, month, day);
  return monthStart.slice(0, 7) === asOf.slice(0, 7) && candidate > asOf
    ? asOf
    : candidate;
}

function paymentAmount(total, fraction) {
  const amountCents = decimalToCents(total);
  const paidCents = amountCents * BigInt(fraction) / 2n;
  return centsToDecimal(paidCents);
}

function parseArguments(args) {
  if (args.some((arg) => arg !== '--reset')) {
    throw new Error('Only the optional --reset flag is supported');
  }
  if (args.filter((arg) => arg === '--reset').length > 1) {
    throw new Error('The --reset flag may only be supplied once');
  }
  return { reset: args.includes('--reset') };
}

async function findDemoUser(email) {
  const result = await pool.query(
    `SELECT user_row.id, user_row.company_id AS "companyId",
            user_row.full_name AS "fullName", company.name AS "companyName"
     FROM users user_row
     JOIN companies company ON company.id = user_row.company_id
     WHERE LOWER(user_row.email) = $1`,
    [email],
  );
  return result.rows[0] ?? null;
}

async function removeDemoCompany(companyId) {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM payments WHERE company_id = $1', [companyId]);
    await client.query(
      `DELETE FROM bill_payments payment
       USING bills bill
       WHERE payment.bill_id = bill.id AND bill.company_id = $1`,
      [companyId],
    );
    await client.query('DELETE FROM invoices WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM bills WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM document_sequences WHERE company_id = $1', [companyId]);
    await client.query(
      `DELETE FROM journal_lines line
       USING journal_entries entry
       WHERE line.entry_id = entry.id AND entry.company_id = $1`,
      [companyId],
    );
    await client.query(
      'DELETE FROM journal_entries WHERE company_id = $1 AND reverses_entry_id IS NOT NULL',
      [companyId],
    );
    await client.query('DELETE FROM journal_entries WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM accounts WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM vendors WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM users WHERE company_id = $1', [companyId]);
    await client.query('DELETE FROM companies WHERE id = $1', [companyId]);
  });
}

async function loadAccounts(client, companyId) {
  const result = await client.query(
    `SELECT id, name, type, system_role AS "systemRole"
     FROM accounts
     WHERE company_id = $1 AND is_active = true`,
    [companyId],
  );
  const byName = new Map(result.rows.map((account) => [account.name, account]));
  const byRole = new Map(result.rows.map((account) => [account.systemRole, account]));
  const requiredNames = [
    'Owner\'s Capital',
    'Rent Expense',
    'Utilities Expense',
    'Salaries Expense',
    'Office Supplies Expense',
  ];
  for (const name of requiredNames) {
    if (!byName.has(name)) throw new Error(`The demo chart of accounts is missing ${name}`);
  }
  const cash = byRole.get('cash');
  const revenue = byRole.get('sales_revenue')
    || result.rows.find((account) => account.type === 'revenue');
  if (!cash || !revenue) throw new Error('The demo chart of accounts is missing required accounts');
  return { byName, cash, revenue };
}

async function seedCapital(client, companyId, accounts, date) {
  // Owner capital funds the opening cash balance and keeps the entry balanced.
  await postJournalEntry(client, {
    companyId,
    date,
    memo: 'Initial owner capital',
    sourceType: 'manual',
    lines: [
      { accountId: accounts.cash.id, debit: '30000.00', credit: '0.00', description: 'Opening cash contribution' },
      { accountId: accounts.byName.get('Owner\'s Capital').id, debit: '0.00', credit: '30000.00', description: 'Owner capital' },
    ],
  });
}

async function seedCustomers(client, companyId) {
  const customers = [];
  for (const [index, name] of CUSTOMER_NAMES.entries()) {
    customers.push(await createCustomer(client, companyId, {
      name,
      email: `customer${index + 1}@folio-demo.example`,
      phone: `+60 12 345 67${String(index).padStart(2, '0')}`,
      address: `Jalan ${index + 1}, Kuala Lumpur`,
      paymentTermsDays: index % 2 === 0 ? 30 : 14,
    }));
  }
  return customers;
}

async function seedVendors(client, companyId) {
  const vendors = [];
  for (const [index, name] of VENDOR_NAMES.entries()) {
    vendors.push(await createVendor(client, companyId, {
      name,
      email: `vendor${index + 1}@folio-demo.example`,
      phone: `+60 3 2345 67${String(index).padStart(2, '0')}`,
      address: `Jalan ${index + 1}, Petaling Jaya`,
      paymentTermsDays: 30,
    }));
  }
  return vendors;
}

async function seedInvoices(client, companyId, accounts, customers, asOf) {
  const monthStarts = [-2, -1, 0].map((offset) => monthStartOffset(asOf, offset));
  for (let index = 0; index < INVOICE_STATUSES.length; index += 1) {
    const status = INVOICE_STATUSES[index];
    const issueDate = status === 'overdue'
      ? addDays(asOf, -45)
      : dateInMonth(monthStarts[Math.floor(index / 9)], 3 + (index % 8) * 3, asOf);
    const dueDate = status === 'overdue'
      ? addDays(asOf, -15)
      : addDays(issueDate, status === 'sent' ? 90 : 30);
    const invoice = await createInvoice(client, companyId, {
      customerId: customers[index % customers.length].id,
      issueDate,
      dueDate,
      notes: 'Demo invoice',
      items: [{
        description: INVOICE_DESCRIPTIONS[index % INVOICE_DESCRIPTIONS.length],
        quantity: '1.00',
        unitPrice: INVOICE_PRICES[index % INVOICE_PRICES.length],
        taxRate: '6.00',
        revenueAccountId: accounts.revenue.id,
      }],
    });

    if (status !== 'draft') {
      const sentInvoice = await sendInvoice(client, companyId, invoice.id);
      if (status === 'paid' || status === 'partial') {
        const amount = status === 'paid' ? sentInvoice.total : paymentAmount(sentInvoice.total, 1);
        await recordPayment(client, companyId, invoice.id, {
          amount,
          paymentDate: addDays(issueDate, 10) > asOf ? asOf : addDays(issueDate, 10),
          method: 'bank_transfer',
          reference: `DEMO-INV-${String(index + 1).padStart(3, '0')}`,
          depositAccountId: accounts.cash.id,
        });
      }
    }
  }
}

async function seedBills(client, companyId, accounts, vendors, asOf) {
  const monthStarts = [-2, -1, 0].map((offset) => monthStartOffset(asOf, offset));
  for (let index = 0; index < 12; index += 1) {
    const type = BILL_TYPES[index % BILL_TYPES.length];
    const monthStart = monthStarts[Math.floor(index / 4)];
    const issueDate = dateInMonth(monthStart, 5 + (index % 4) * 5, asOf);
    const bill = await createBill(client, companyId, {
      vendorId: vendors[index % vendors.length].id,
      billNumber: `DEMO-BILL-${String(index + 1).padStart(3, '0')}`,
      issueDate,
      dueDate: addDays(issueDate, 30),
      notes: 'Demo operating expense',
      items: [{
        description: type.description,
        amount: type.amount,
        accountId: accounts.byName.get(type.accountName).id,
      }],
    });
    await postBill(client, companyId, bill.id);

    if (index % 4 === 0 || index % 4 === 1) {
      const paidAmount = index % 4 === 0 ? bill.total : paymentAmount(bill.total, 1);
      await recordBillPayment(client, companyId, bill.id, {
        amount: paidAmount,
        paymentDate: addDays(issueDate, 10) > asOf ? asOf : addDays(issueDate, 10),
        method: 'bank_transfer',
        reference: `DEMO-BILL-PAY-${String(index + 1).padStart(3, '0')}`,
        payingAccountId: accounts.cash.id,
      });
    }
  }
}

async function seedDemoActivity(companyId, asOf) {
  await withTransaction(async (client) => {
    const accounts = await loadAccounts(client, companyId);
    await seedCapital(client, companyId, accounts, monthStartOffset(asOf, -2));
    const customers = await seedCustomers(client, companyId);
    const vendors = await seedVendors(client, companyId);
    await seedInvoices(client, companyId, accounts, customers, asOf);
    await seedBills(client, companyId, accounts, vendors, asOf);
  });
}

async function run() {
  const { reset } = parseArguments(process.argv.slice(2));
  const email = process.env.DEMO_EMAIL?.trim().toLowerCase();
  const password = process.env.DEMO_PASSWORD;
  if (!email || !password) {
    throw new Error('Set DEMO_EMAIL and DEMO_PASSWORD in the process environment');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be set');
  process.stdout.write(`Database host: ${new URL(databaseUrl).hostname}\n`);

  const existing = await findDemoUser(email);
  if (existing && !reset) {
    throw new Error('A company for DEMO_EMAIL already exists; use --reset to replace its demo data');
  }
  if (existing && reset) {
    if (existing.companyName !== DEMO_COMPANY_NAME || existing.fullName !== DEMO_FULL_NAME) {
      throw new Error('Refusing to reset a company that is not marked as Folio demo data');
    }
    await removeDemoCompany(existing.companyId);
  }

  const { company } = await register({
    companyName: DEMO_COMPANY_NAME,
    fullName: DEMO_FULL_NAME,
    email,
    password,
  });
  await seedDemoActivity(company.id, getTodayInKualaLumpur());
  process.stdout.write('Demo data created successfully.\n');
}

if (require.main === module) {
  run()
    .catch((error) => {
      const errorCode = error.code ? ` (${error.code})` : '';
      console.error(`Demo seed failed${errorCode}.`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = {
  addDays,
  dateInMonth,
  monthStartOffset,
  parseArguments,
  paymentAmount,
};
