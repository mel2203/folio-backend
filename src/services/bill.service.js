const { AppError, BusinessRuleError } = require('../errors');
const { addCents, centsToDecimal, decimalToCents } = require('../utils/money');
const { assertDocumentStatus, nextPaymentStatus } = require('../utils/document-status');
const { getTodayInKualaLumpur } = require('../utils/report-date');
const { postJournalEntry } = require('./journal.service');

function billSelect(alias = 'bill') {
  return `${alias}.id, ${alias}.company_id AS "companyId", ${alias}.vendor_id AS "vendorId",
    ${alias}.bill_number AS "billNumber", ${alias}.issue_date::text AS "issueDate",
    ${alias}.due_date::text AS "dueDate", ${alias}.status, ${alias}.total::text AS total,
    ${alias}.amount_paid::text AS "amountPaid", ${alias}.notes,
    ${alias}.journal_entry_id AS "journalEntryId", ${alias}.reversal_entry_id AS "reversalEntryId",
    ${alias}.created_at AS "createdAt"`;
}

function calculateBillItems(items) {
  let totalCents = 0n;
  const calculatedItems = items.map((item) => {
    const amountCents = decimalToCents(item.amount);
    totalCents = addCents(totalCents, amountCents);
    return { ...item, amount: centsToDecimal(amountCents), amountCents };
  });
  return { items: calculatedItems, totalCents };
}

async function assertVendorActive(client, companyId, vendorId) {
  const result = await client.query(
    'SELECT id FROM vendors WHERE id = $1 AND company_id = $2 AND is_active = true',
    [vendorId, companyId],
  );
  if (!result.rowCount) throw new BusinessRuleError('Vendor must be active and belong to the company');
}

async function assertBillAccounts(client, companyId, items) {
  const ids = [...new Set(items.map((item) => item.accountId))];
  const result = await client.query(
    `SELECT id FROM accounts
     WHERE company_id = $1 AND id = ANY($2::uuid[])
       AND type IN ('expense', 'asset') AND is_active = true`,
    [companyId, ids],
  );
  if (result.rowCount !== ids.length) {
    throw new BusinessRuleError('Each bill item must use an active expense or asset account belonging to the company');
  }
}

async function defaultDueDate(client, issueDate, vendorId, companyId) {
  const result = await client.query(
    `SELECT ($1::date + vendor.payment_terms_days)::text AS "dueDate"
     FROM vendors vendor WHERE vendor.id = $2 AND vendor.company_id = $3`,
    [issueDate, vendorId, companyId],
  );
  return result.rows[0].dueDate;
}

async function saveItems(client, companyId, billId, items) {
  for (const item of items) {
    await client.query(
      `INSERT INTO bill_items (bill_id, description, amount, account_id)
       SELECT bill.id, $3, $4, $5 FROM bills bill
       WHERE bill.id = $1 AND bill.company_id = $2`,
      [billId, companyId, item.description, item.amount, item.accountId],
    );
  }
}

function handleDuplicateBillNumber(error) {
  if (error.code === '23505' && error.constraint === 'bills_company_id_vendor_id_bill_number_key') {
    throw new AppError('A bill with this number already exists for this vendor', {
      statusCode: 409,
      code: 'BILL_NUMBER_IN_USE',
    });
  }
  throw error;
}

async function createBill(client, companyId, input) {
  await assertVendorActive(client, companyId, input.vendorId);
  await assertBillAccounts(client, companyId, input.items);
  const issueDate = input.issueDate || getTodayInKualaLumpur();
  const dueDate = input.dueDate || await defaultDueDate(client, issueDate, input.vendorId, companyId);
  const totals = calculateBillItems(input.items);
  try {
    const inserted = await client.query(
      `INSERT INTO bills (company_id, vendor_id, bill_number, issue_date, due_date, total, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [companyId, input.vendorId, input.billNumber, issueDate, dueDate, centsToDecimal(totals.totalCents), input.notes ?? null],
    );
    await saveItems(client, companyId, inserted.rows[0].id, input.items);
    return getBill(client, companyId, inserted.rows[0].id);
  } catch (error) {
    handleDuplicateBillNumber(error);
  }
}

async function listBills(client, companyId, filters) {
  const conditions = ['bill.company_id = $1'];
  const values = [companyId];
  for (const [key, column] of [['status', 'bill.status'], ['vendorId', 'bill.vendor_id']]) {
    if (filters[key]) {
      values.push(filters[key]);
      conditions.push(`${column} = $${values.length}`);
    }
  }
  if (filters.from) {
    values.push(filters.from);
    conditions.push(`bill.issue_date >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    conditions.push(`bill.issue_date <= $${values.length}`);
  }
  if (filters.number) {
    values.push(`%${filters.number}%`);
    conditions.push(`bill.bill_number ILIKE $${values.length}`);
  }
  const where = conditions.join(' AND ');
  const count = await client.query(`SELECT COUNT(*)::int AS total FROM bills bill WHERE ${where}`, values);
  const pageValues = [...values, filters.limit, (filters.page - 1) * filters.limit];
  const rows = await client.query(
    `SELECT ${billSelect()}, vendor.name AS "vendorName"
     FROM bills bill
     JOIN vendors vendor ON vendor.id = bill.vendor_id AND vendor.company_id = bill.company_id
     WHERE ${where}
     ORDER BY bill.issue_date DESC, bill.created_at DESC
     LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues,
  );
  return { data: rows.rows, meta: { page: filters.page, limit: filters.limit, total: count.rows[0].total } };
}

async function getBill(client, companyId, billId) {
  const result = await client.query(
    `SELECT ${billSelect()}, json_build_object(
       'id', vendor.id, 'name', vendor.name, 'email', vendor.email,
       'phone', vendor.phone, 'address', vendor.address,
       'paymentTermsDays', vendor.payment_terms_days) AS vendor
     FROM bills bill
     JOIN vendors vendor ON vendor.id = bill.vendor_id AND vendor.company_id = bill.company_id
     WHERE bill.company_id = $1 AND bill.id = $2`,
    [companyId, billId],
  );
  if (!result.rowCount) throw new AppError('Bill not found', { statusCode: 404, code: 'NOT_FOUND' });
  const [itemResult, paymentResult] = await Promise.all([
    client.query(
      `SELECT item.id, item.description, item.amount::text AS amount, item.account_id AS "accountId",
              account.code AS "accountCode", account.name AS "accountName", account.type AS "accountType"
       FROM bill_items item
       JOIN bills bill ON bill.id = item.bill_id AND bill.company_id = $1
       JOIN accounts account ON account.id = item.account_id AND account.company_id = bill.company_id
       WHERE bill.id = $2 ORDER BY item.id`,
      [companyId, billId],
    ),
    client.query(
      `SELECT payment.id, payment.payment_date::text AS "paymentDate", payment.amount::text AS amount,
              payment.method, payment.reference, payment.paying_account_id AS "payingAccountId",
              payment.journal_entry_id AS "journalEntryId", payment.created_at AS "createdAt"
       FROM bill_payments payment
       JOIN bills bill ON bill.id = payment.bill_id AND bill.company_id = $1
       WHERE bill.id = $2 ORDER BY payment.payment_date, payment.created_at`,
      [companyId, billId],
    ),
  ]);
  return { ...result.rows[0], items: itemResult.rows, payments: paymentResult.rows };
}

async function lockBill(client, companyId, billId) {
  const result = await client.query(
    `SELECT ${billSelect()} FROM bills bill WHERE bill.company_id = $1 AND bill.id = $2 FOR UPDATE`,
    [companyId, billId],
  );
  if (!result.rowCount) throw new AppError('Bill not found', { statusCode: 404, code: 'NOT_FOUND' });
  return result.rows[0];
}

async function updateBill(client, companyId, billId, changes) {
  const current = await lockBill(client, companyId, billId);
  assertDocumentStatus(current.status, ['draft'], 'Only draft bills can be edited');
  const vendorId = changes.vendorId ?? current.vendorId;
  await assertVendorActive(client, companyId, vendorId);
  if (changes.items) await assertBillAccounts(client, companyId, changes.items);
  const issueDate = changes.issueDate ?? current.issueDate;
  const dueDate = changes.dueDate ?? (
    changes.issueDate || changes.vendorId
      ? await defaultDueDate(client, issueDate, vendorId, companyId)
      : current.dueDate
  );
  let totalCents = decimalToCents(current.total);
  if (changes.items) totalCents = calculateBillItems(changes.items).totalCents;
  try {
    await client.query(
      `UPDATE bills SET vendor_id = $3, bill_number = $4, issue_date = $5,
         due_date = $6, total = $7, notes = $8
       WHERE company_id = $1 AND id = $2`,
      [companyId, billId, vendorId, changes.billNumber ?? current.billNumber, issueDate, dueDate,
        centsToDecimal(totalCents), Object.hasOwn(changes, 'notes') ? changes.notes : current.notes],
    );
    if (changes.items) {
      await client.query(
        `DELETE FROM bill_items item USING bills bill
         WHERE item.bill_id = bill.id AND bill.company_id = $1 AND bill.id = $2`,
        [companyId, billId],
      );
      await saveItems(client, companyId, billId, changes.items);
    }
    return getBill(client, companyId, billId);
  } catch (error) {
    handleDuplicateBillNumber(error);
  }
}

async function deleteBill(client, companyId, billId) {
  const bill = await lockBill(client, companyId, billId);
  assertDocumentStatus(bill.status, ['draft'], 'Only draft bills can be deleted');
  await client.query('DELETE FROM bills WHERE company_id = $1 AND id = $2', [companyId, billId]);
}

async function postBill(client, companyId, billId) {
  const bill = await lockBill(client, companyId, billId);
  assertDocumentStatus(bill.status, ['draft'], 'Only draft bills can be posted');
  await assertVendorActive(client, companyId, bill.vendorId);
  const itemResult = await client.query(
    `SELECT item.description, item.amount::text AS amount, item.account_id AS "accountId"
     FROM bill_items item JOIN bills bill ON bill.id = item.bill_id AND bill.company_id = $1
     WHERE bill.id = $2 ORDER BY item.id`,
    [companyId, billId],
  );
  await assertBillAccounts(client, companyId, itemResult.rows);
  const totals = calculateBillItems(itemResult.rows);
  const payable = await client.query(
    `SELECT id FROM accounts WHERE company_id = $1 AND system_role = 'accounts_payable' AND is_active = true`,
    [companyId],
  );
  if (!payable.rowCount) throw new BusinessRuleError('The company is missing an active Accounts Payable system account');
  const lines = totals.items.map((item) => ({
    accountId: item.accountId,
    debit: item.amount,
    credit: '0.00',
    description: item.description,
  }));
  lines.push({ accountId: payable.rows[0].id, debit: '0.00', credit: centsToDecimal(totals.totalCents), description: `Bill ${bill.billNumber}` });
  const entry = await postJournalEntry(client, {
    companyId, date: bill.issueDate, memo: `Bill ${bill.billNumber}`,
    sourceType: 'bill', sourceId: billId, lines,
  });
  await client.query(
    `UPDATE bills SET status = 'open', journal_entry_id = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, billId, entry.id],
  );
  return getBill(client, companyId, billId);
}

async function recordBillPayment(client, companyId, billId, input) {
  const bill = await lockBill(client, companyId, billId);
  assertDocumentStatus(bill.status, ['open', 'partial'], 'Payments can only be recorded for open or partially paid bills');
  const amountCents = decimalToCents(input.amount);
  const outstandingCents = decimalToCents(bill.total) - decimalToCents(bill.amountPaid);
  if (amountCents > outstandingCents) throw new BusinessRuleError('Payment exceeds the bill amount outstanding');
  const account = await client.query(
    `SELECT id FROM accounts WHERE id = $1 AND company_id = $2 AND type = 'asset' AND is_active = true`,
    [input.payingAccountId, companyId],
  );
  if (!account.rowCount) throw new BusinessRuleError('Paying account must be an active asset account belonging to the company');
  const payable = await client.query(
    `SELECT id FROM accounts WHERE company_id = $1 AND system_role = 'accounts_payable' AND is_active = true`,
    [companyId],
  );
  if (!payable.rowCount) throw new BusinessRuleError('The company is missing an active Accounts Payable system account');
  const paymentDate = input.paymentDate || getTodayInKualaLumpur();
  const entry = await postJournalEntry(client, {
    companyId, date: paymentDate, memo: `Payment for bill ${bill.billNumber}`,
    sourceType: 'payment', sourceId: billId,
    lines: [
      { accountId: payable.rows[0].id, debit: input.amount, credit: '0.00', description: 'Accounts payable payment' },
      { accountId: input.payingAccountId, debit: '0.00', credit: input.amount, description: 'Bill payment' },
    ],
  });
  const paymentResult = await client.query(
    `INSERT INTO bill_payments (bill_id, payment_date, amount, method, reference, paying_account_id, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, payment_date::text AS "paymentDate", amount::text AS amount, method, reference,
       paying_account_id AS "payingAccountId", journal_entry_id AS "journalEntryId", created_at AS "createdAt"`,
    [billId, paymentDate, input.amount, input.method, input.reference ?? null, input.payingAccountId, entry.id],
  );
  const nextPaidCents = decimalToCents(bill.amountPaid) + amountCents;
  const nextStatus = nextPaymentStatus(decimalToCents(bill.total), nextPaidCents);
  await client.query(
    `UPDATE bills SET amount_paid = $3, status = $4 WHERE company_id = $1 AND id = $2`,
    [companyId, billId, centsToDecimal(nextPaidCents), nextStatus],
  );
  return { payment: paymentResult.rows[0], bill: await getBill(client, companyId, billId) };
}

async function voidBill(client, companyId, billId) {
  const bill = await lockBill(client, companyId, billId);
  assertDocumentStatus(bill.status, ['open'], 'Only open bills with no payments can be voided');
  if (decimalToCents(bill.amountPaid) !== 0n) throw new BusinessRuleError('Only open bills with no payments can be voided');
  const originalLines = await client.query(
    `SELECT line.account_id AS "accountId", line.debit::text AS debit, line.credit::text AS credit, line.description
     FROM journal_lines line JOIN journal_entries entry ON entry.id = line.entry_id
     WHERE entry.company_id = $1 AND entry.id = $2 ORDER BY line.id`,
    [companyId, bill.journalEntryId],
  );
  if (!originalLines.rowCount) throw new BusinessRuleError('The bill journal entry is missing and cannot be reversed');
  const reversal = await postJournalEntry(client, {
    companyId, date: getTodayInKualaLumpur(), memo: `Void bill ${bill.billNumber}`,
    sourceType: 'reversal', sourceId: billId, reversesEntryId: bill.journalEntryId,
    lines: originalLines.rows.map((line) => ({
      accountId: line.accountId, debit: line.credit, credit: line.debit, description: line.description,
    })),
  });
  await client.query(
    `UPDATE bills SET status = 'void', reversal_entry_id = $3 WHERE company_id = $1 AND id = $2`,
    [companyId, billId, reversal.id],
  );
  return getBill(client, companyId, billId);
}

module.exports = {
  calculateBillItems,
  createBill,
  deleteBill,
  getBill,
  listBills,
  postBill,
  recordBillPayment,
  updateBill,
  voidBill,
};
