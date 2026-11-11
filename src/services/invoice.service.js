const { AppError, BusinessRuleError } = require('../errors');
const { addCents, centsToDecimal, decimalToCents } = require('../utils/money');
const { assertDocumentStatus, nextPaymentStatus } = require('../utils/document-status');
const { roundHalfUp, toHundredths } = require('../utils/rounding');
const { getTodayInKualaLumpur } = require('../utils/report-date');
const { postJournalEntry } = require('./journal.service');

function calculateInvoiceItems(items) {
  let subtotalCents = 0n;
  let taxTotalCents = 0n;
  const calculatedItems = items.map((item) => {
    const lineSubtotalCents = roundHalfUp(toHundredths(item.quantity) * decimalToCents(item.unitPrice), 100n);
    const lineTaxCents = roundHalfUp(lineSubtotalCents * toHundredths(item.taxRate), 10000n);
    subtotalCents = addCents(subtotalCents, lineSubtotalCents);
    taxTotalCents = addCents(taxTotalCents, lineTaxCents);
    return {
      ...item,
      lineSubtotal: centsToDecimal(lineSubtotalCents),
      lineTax: centsToDecimal(lineTaxCents),
      lineTotal: centsToDecimal(lineSubtotalCents + lineTaxCents),
      lineSubtotalCents,
      lineTaxCents,
    };
  });

  return {
    items: calculatedItems,
    subtotalCents,
    taxTotalCents,
    totalCents: subtotalCents + taxTotalCents,
  };
}

function invoiceSelect(alias = 'invoice') {
  return `${alias}.id, ${alias}.company_id AS "companyId", ${alias}.customer_id AS "customerId",
    ${alias}.invoice_number AS "invoiceNumber", ${alias}.issue_date::text AS "issueDate",
    ${alias}.due_date::text AS "dueDate", ${alias}.status,
    ${alias}.subtotal::text AS subtotal, ${alias}.tax_total::text AS "taxTotal",
    ${alias}.total::text AS total, ${alias}.amount_paid::text AS "amountPaid", ${alias}.notes,
    ${alias}.journal_entry_id AS "journalEntryId", ${alias}.reversal_entry_id AS "reversalEntryId",
    ${alias}.created_at AS "createdAt"`;
}

async function assertCustomerActive(client, companyId, customerId) {
  const result = await client.query(
    'SELECT id FROM customers WHERE id = $1 AND company_id = $2 AND is_active = true',
    [customerId, companyId],
  );
  if (!result.rowCount) {
    throw new BusinessRuleError('Customer must be active and belong to the company');
  }
}

async function assertRevenueAccounts(client, companyId, items) {
  const ids = [...new Set(items.map((item) => item.revenueAccountId))];
  const result = await client.query(
    `SELECT id FROM accounts
     WHERE company_id = $1 AND id = ANY($2::uuid[]) AND type = 'revenue' AND is_active = true`,
    [companyId, ids],
  );
  if (result.rowCount !== ids.length) {
    throw new BusinessRuleError('Each item must use an active revenue account belonging to the company');
  }
}

async function defaultDueDate(client, issueDate, customerId, companyId) {
  const result = await client.query(
    `SELECT ($1::date + customer.payment_terms_days)::text AS "dueDate"
     FROM customers customer WHERE customer.id = $2 AND customer.company_id = $3`,
    [issueDate, customerId, companyId],
  );
  return result.rows[0].dueDate;
}

async function saveItems(client, companyId, invoiceId, items) {
  for (const item of items) {
    await client.query(
      `INSERT INTO invoice_items
         (invoice_id, description, quantity, unit_price, tax_rate, revenue_account_id)
       SELECT invoice.id, $3, $4, $5, $6, $7
       FROM invoices invoice WHERE invoice.id = $1 AND invoice.company_id = $2`,
      [invoiceId, companyId, item.description, item.quantity, item.unitPrice, item.taxRate, item.revenueAccountId],
    );
  }
}

async function createInvoice(client, companyId, input) {
  await assertCustomerActive(client, companyId, input.customerId);
  await assertRevenueAccounts(client, companyId, input.items);
  const issueDate = input.issueDate || getTodayInKualaLumpur();
  const dueDate = input.dueDate || await defaultDueDate(client, issueDate, input.customerId, companyId);
  const totals = calculateInvoiceItems(input.items);
  const inserted = await client.query(
    `INSERT INTO invoices
       (company_id, customer_id, issue_date, due_date, subtotal, tax_total, total, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [companyId, input.customerId, issueDate, dueDate,
      centsToDecimal(totals.subtotalCents), centsToDecimal(totals.taxTotalCents),
      centsToDecimal(totals.totalCents), input.notes ?? null],
  );
  await saveItems(client, companyId, inserted.rows[0].id, input.items);
  return getInvoice(client, companyId, inserted.rows[0].id);
}

async function listInvoices(client, companyId, filters) {
  const conditions = ['invoice.company_id = $1'];
  const values = [companyId];
  for (const [key, column] of [['status', 'invoice.status'], ['customerId', 'invoice.customer_id']]) {
    if (filters[key]) {
      values.push(filters[key]);
      conditions.push(`${column} = $${values.length}`);
    }
  }
  if (filters.from) {
    values.push(filters.from);
    conditions.push(`invoice.issue_date >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    conditions.push(`invoice.issue_date <= $${values.length}`);
  }
  if (filters.number) {
    values.push(`%${filters.number}%`);
    conditions.push(`invoice.invoice_number ILIKE $${values.length}`);
  }
  const where = conditions.join(' AND ');
  const count = await client.query(`SELECT COUNT(*)::int AS total FROM invoices invoice WHERE ${where}`, values);
  const pageValues = [...values, filters.limit, (filters.page - 1) * filters.limit];
  const rows = await client.query(
    `SELECT ${invoiceSelect()}, customer.name AS "customerName",
            customer.email AS "customerEmail"
     FROM invoices invoice
     JOIN customers customer ON customer.id = invoice.customer_id AND customer.company_id = invoice.company_id
     WHERE ${where}
     ORDER BY invoice.issue_date DESC, invoice.created_at DESC
     LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues,
  );
  return { data: rows.rows, meta: { page: filters.page, limit: filters.limit, total: count.rows[0].total } };
}

async function getInvoice(client, companyId, invoiceId) {
  const result = await client.query(
    `SELECT ${invoiceSelect()},
            json_build_object('id', customer.id, 'name', customer.name, 'email', customer.email,
              'phone', customer.phone, 'address', customer.address,
              'paymentTermsDays', customer.payment_terms_days) AS customer
     FROM invoices invoice
     JOIN customers customer ON customer.id = invoice.customer_id AND customer.company_id = invoice.company_id
     WHERE invoice.company_id = $1 AND invoice.id = $2`,
    [companyId, invoiceId],
  );
  if (!result.rowCount) throw new AppError('Invoice not found', { statusCode: 404, code: 'NOT_FOUND' });

  const [itemResult, paymentResult] = await Promise.all([
    client.query(
      `SELECT item.id, item.description, item.quantity::text AS quantity,
              item.unit_price::text AS "unitPrice", item.tax_rate::text AS "taxRate",
              item.revenue_account_id AS "revenueAccountId", account.code AS "revenueAccountCode",
              account.name AS "revenueAccountName"
       FROM invoice_items item
       JOIN invoices invoice ON invoice.id = item.invoice_id AND invoice.company_id = $1
       JOIN accounts account ON account.id = item.revenue_account_id AND account.company_id = invoice.company_id
       WHERE invoice.id = $2
       ORDER BY item.id`,
      [companyId, invoiceId],
    ),
    client.query(
      `SELECT payment.id, payment.payment_date::text AS "paymentDate", payment.amount::text AS amount,
              payment.method, payment.reference, payment.deposit_account_id AS "depositAccountId",
              payment.journal_entry_id AS "journalEntryId", payment.created_at AS "createdAt"
       FROM payments payment
       WHERE payment.company_id = $1 AND payment.invoice_id = $2
       ORDER BY payment.payment_date, payment.created_at`,
      [companyId, invoiceId],
    ),
  ]);
  const calculated = calculateInvoiceItems(itemResult.rows).items.map((item) => ({
    id: item.id,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    taxRate: item.taxRate,
    revenueAccountId: item.revenueAccountId,
    revenueAccountCode: item.revenueAccountCode,
    revenueAccountName: item.revenueAccountName,
    lineSubtotal: item.lineSubtotal,
    lineTax: item.lineTax,
    lineTotal: item.lineTotal,
  }));
  return { ...result.rows[0], items: calculated, payments: paymentResult.rows };
}

async function lockInvoice(client, companyId, invoiceId) {
  const result = await client.query(
    `SELECT ${invoiceSelect()} FROM invoices invoice
     WHERE invoice.company_id = $1 AND invoice.id = $2 FOR UPDATE`,
    [companyId, invoiceId],
  );
  if (!result.rowCount) throw new AppError('Invoice not found', { statusCode: 404, code: 'NOT_FOUND' });
  return result.rows[0];
}

async function updateInvoice(client, companyId, invoiceId, changes) {
  const current = await lockInvoice(client, companyId, invoiceId);
  assertDocumentStatus(current.status, ['draft'], 'Only draft invoices can be edited');
  const customerId = changes.customerId ?? current.customerId;
  await assertCustomerActive(client, companyId, customerId);
  const items = changes.items;
  if (items) await assertRevenueAccounts(client, companyId, items);
  const issueDate = changes.issueDate ?? current.issueDate;
  const dueDate = changes.dueDate ?? (
    changes.issueDate || changes.customerId
      ? await defaultDueDate(client, issueDate, customerId, companyId)
      : current.dueDate
  );
  let totals = { subtotalCents: decimalToCents(current.subtotal), taxTotalCents: decimalToCents(current.taxTotal), totalCents: decimalToCents(current.total) };
  if (items) totals = calculateInvoiceItems(items);

  await client.query(
    `UPDATE invoices SET customer_id = $3, issue_date = $4, due_date = $5,
       subtotal = $6, tax_total = $7, total = $8, notes = $9
     WHERE company_id = $1 AND id = $2`,
    [companyId, invoiceId, customerId, issueDate, dueDate, centsToDecimal(totals.subtotalCents),
      centsToDecimal(totals.taxTotalCents), centsToDecimal(totals.totalCents),
      Object.hasOwn(changes, 'notes') ? changes.notes : current.notes],
  );
  if (items) {
    await client.query(
      `DELETE FROM invoice_items item USING invoices invoice
       WHERE item.invoice_id = invoice.id AND invoice.company_id = $1 AND invoice.id = $2`,
      [companyId, invoiceId],
    );
    await saveItems(client, companyId, invoiceId, items);
  }
  return getInvoice(client, companyId, invoiceId);
}

async function deleteInvoice(client, companyId, invoiceId) {
  const invoice = await lockInvoice(client, companyId, invoiceId);
  assertDocumentStatus(invoice.status, ['draft'], 'Only draft invoices can be deleted');
  await client.query('DELETE FROM invoices WHERE company_id = $1 AND id = $2', [companyId, invoiceId]);
}

async function nextInvoiceNumber(client, companyId) {
  const result = await client.query(
    `INSERT INTO document_sequences (company_id, kind, last_number)
     VALUES ($1, 'invoice', 1)
     ON CONFLICT (company_id, kind)
     DO UPDATE SET last_number = document_sequences.last_number + 1
     RETURNING last_number`,
    [companyId],
  );
  return `INV-${String(result.rows[0].last_number).padStart(4, '0')}`;
}

async function sendInvoice(client, companyId, invoiceId) {
  const invoice = await lockInvoice(client, companyId, invoiceId);
  assertDocumentStatus(invoice.status, ['draft'], 'Only draft invoices can be sent');
  await assertCustomerActive(client, companyId, invoice.customerId);
  const itemResult = await client.query(
    `SELECT item.description, item.quantity::text AS quantity,
            item.unit_price::text AS "unitPrice", item.tax_rate::text AS "taxRate",
            item.revenue_account_id AS "revenueAccountId"
     FROM invoice_items item
     JOIN invoices invoice ON invoice.id = item.invoice_id AND invoice.company_id = $1
     WHERE invoice.id = $2 ORDER BY item.id`,
    [companyId, invoiceId],
  );
  await assertRevenueAccounts(client, companyId, itemResult.rows);
  const totals = calculateInvoiceItems(itemResult.rows);
  if (totals.totalCents === 0n) throw new BusinessRuleError('An invoice total must be greater than zero before it can be sent');

  const roleResult = await client.query(
    `SELECT system_role AS role, id FROM accounts
     WHERE company_id = $1 AND system_role = ANY($2::text[]) AND is_active = true`,
    [companyId, ['accounts_receivable', 'sales_tax_payable']],
  );
  const roles = new Map(roleResult.rows.map((account) => [account.role, account.id]));
  if (!roles.has('accounts_receivable')) throw new BusinessRuleError('The company is missing an active Accounts Receivable system account');
  if (totals.taxTotalCents > 0n && !roles.has('sales_tax_payable')) {
    throw new BusinessRuleError('The company is missing an active Sales Tax Payable system account');
  }

  const revenueByAccount = new Map();
  for (const item of totals.items) {
    if (item.lineSubtotalCents === 0n) continue;
    const current = revenueByAccount.get(item.revenueAccountId) || 0n;
    revenueByAccount.set(item.revenueAccountId, addCents(current, item.lineSubtotalCents));
  }
  const lines = [{
    accountId: roles.get('accounts_receivable'),
    debit: centsToDecimal(totals.totalCents),
    credit: '0.00',
    description: `Invoice ${await nextInvoiceNumber(client, companyId)}`,
  }];
  for (const [accountId, cents] of revenueByAccount) {
    lines.push({ accountId, debit: '0.00', credit: centsToDecimal(cents), description: 'Invoice revenue' });
  }
  if (totals.taxTotalCents > 0n) {
    lines.push({ accountId: roles.get('sales_tax_payable'), debit: '0.00', credit: centsToDecimal(totals.taxTotalCents), description: 'Invoice sales tax' });
  }
  const invoiceNumber = lines[0].description.slice('Invoice '.length);
  const entry = await postJournalEntry(client, {
    companyId,
    date: invoice.issueDate,
    memo: `Invoice ${invoiceNumber}`,
    sourceType: 'invoice',
    sourceId: invoiceId,
    lines,
  });
  await client.query(
    `UPDATE invoices SET invoice_number = $3, status = 'sent', journal_entry_id = $4
     WHERE company_id = $1 AND id = $2`,
    [companyId, invoiceId, invoiceNumber, entry.id],
  );
  return getInvoice(client, companyId, invoiceId);
}

async function recordPayment(client, companyId, invoiceId, input) {
  const invoice = await lockInvoice(client, companyId, invoiceId);
  assertDocumentStatus(invoice.status, ['sent', 'partial'], 'Payments can only be recorded for sent or partially paid invoices');
  const amountCents = decimalToCents(input.amount);
  const outstandingCents = decimalToCents(invoice.total) - decimalToCents(invoice.amountPaid);
  if (amountCents > outstandingCents) throw new BusinessRuleError('Payment exceeds the invoice amount outstanding');

  const account = await client.query(
    `SELECT id FROM accounts WHERE id = $1 AND company_id = $2 AND type = 'asset' AND is_active = true`,
    [input.depositAccountId, companyId],
  );
  if (!account.rowCount) throw new BusinessRuleError('Deposit account must be an active asset account belonging to the company');
  const arAccount = await client.query(
    `SELECT id FROM accounts WHERE company_id = $1 AND system_role = 'accounts_receivable' AND is_active = true`,
    [companyId],
  );
  if (!arAccount.rowCount) throw new BusinessRuleError('The company is missing an active Accounts Receivable system account');
  const paymentDate = input.paymentDate || getTodayInKualaLumpur();
  const entry = await postJournalEntry(client, {
    companyId,
    date: paymentDate,
    memo: `Payment for invoice ${invoice.invoiceNumber}`,
    sourceType: 'payment',
    sourceId: invoiceId,
    lines: [
      { accountId: input.depositAccountId, debit: input.amount, credit: '0.00', description: 'Customer payment' },
      { accountId: arAccount.rows[0].id, debit: '0.00', credit: input.amount, description: 'Accounts receivable payment' },
    ],
  });
  const payment = await client.query(
    `INSERT INTO payments
       (company_id, invoice_id, payment_date, amount, method, reference, deposit_account_id, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, payment_date::text AS "paymentDate", amount::text AS amount,
       method, reference, deposit_account_id AS "depositAccountId", journal_entry_id AS "journalEntryId", created_at AS "createdAt"`,
    [companyId, invoiceId, paymentDate, input.amount, input.method, input.reference ?? null, input.depositAccountId, entry.id],
  );
  const nextPaidCents = decimalToCents(invoice.amountPaid) + amountCents;
  const nextStatus = nextPaymentStatus(decimalToCents(invoice.total), nextPaidCents);
  await client.query(
    'UPDATE invoices SET amount_paid = $3, status = $4 WHERE company_id = $1 AND id = $2',
    [companyId, invoiceId, centsToDecimal(nextPaidCents), nextStatus],
  );
  return { payment: payment.rows[0], invoice: await getInvoice(client, companyId, invoiceId) };
}

async function voidInvoice(client, companyId, invoiceId) {
  const invoice = await lockInvoice(client, companyId, invoiceId);
  assertDocumentStatus(invoice.status, ['sent'], 'Only sent invoices with no payments can be voided');
  if (decimalToCents(invoice.amountPaid) !== 0n) throw new BusinessRuleError('Only sent invoices with no payments can be voided');
  const originalLines = await client.query(
    `SELECT line.account_id AS "accountId", line.debit::text AS debit, line.credit::text AS credit,
            line.description
     FROM journal_lines line
     JOIN journal_entries entry ON entry.id = line.entry_id
     WHERE entry.company_id = $1 AND entry.id = $2
     ORDER BY line.id`,
    [companyId, invoice.journalEntryId],
  );
  if (!originalLines.rowCount) throw new BusinessRuleError('The invoice journal entry is missing and cannot be reversed');
  const reversal = await postJournalEntry(client, {
    companyId,
    date: getTodayInKualaLumpur(),
    memo: `Void invoice ${invoice.invoiceNumber}`,
    sourceType: 'reversal',
    sourceId: invoiceId,
    reversesEntryId: invoice.journalEntryId,
    lines: originalLines.rows.map((line) => ({
      accountId: line.accountId,
      debit: line.credit,
      credit: line.debit,
      description: line.description,
    })),
  });
  await client.query(
    `UPDATE invoices SET status = 'void', reversal_entry_id = $3
     WHERE company_id = $1 AND id = $2`,
    [companyId, invoiceId, reversal.id],
  );
  return getInvoice(client, companyId, invoiceId);
}

module.exports = {
  calculateInvoiceItems,
  createInvoice,
  deleteInvoice,
  getInvoice,
  listInvoices,
  recordPayment,
  sendInvoice,
  updateInvoice,
  voidInvoice,
};
