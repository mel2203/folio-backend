const { centsToDecimal, decimalToCents } = require('../utils/money');

function buildAggregateQuery(period) {
  const dateFilter = period.from
    ? 'AND je.entry_date >= $2 AND je.entry_date <= $3'
    : 'AND je.entry_date <= $2';

  return 'SELECT c.base_currency AS currency, '
    + 'a.id AS "accountId", a.code, a.name, a.type, '
    + 'COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit ELSE 0 END), 0)::text AS debit, '
    + 'COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit ELSE 0 END), 0)::text AS credit, '
    + 'COUNT(je.id)::int AS "lineCount" '
    + 'FROM companies c '
    + 'LEFT JOIN accounts a ON a.company_id = c.id '
    + 'LEFT JOIN journal_lines jl ON jl.account_id = a.id '
    + 'LEFT JOIN journal_entries je ON je.id = jl.entry_id '
    + "AND je.company_id = c.id AND je.status = 'posted' "
    + dateFilter + ' '
    + 'WHERE c.id = $1 '
    + 'GROUP BY c.base_currency, a.id, a.code, a.name, a.type '
    + 'ORDER BY a.code ASC';
}

async function getAggregateRows(client, companyId, period) {
  const values = period.from ? [companyId, period.from, period.to] : [companyId, period.asOf];
  const result = await client.query(buildAggregateQuery(period), values);
  return result.rows;
}

function getCurrency(rows) {
  return rows[0] && rows[0].currency ? rows[0].currency.trim() : 'MYR';
}

function getAccountRows(rows) {
  return rows.filter((row) => row.accountId);
}

function netBalance(row, debitNormal) {
  const debit = decimalToCents(row.debit);
  const credit = decimalToCents(row.credit);
  return debitNormal ? debit - credit : credit - debit;
}

async function getTrialBalance(client, companyId, { asOf }) {
  const rows = await getAggregateRows(client, companyId, { asOf });
  const accounts = [];
  let totalDebit = 0n;
  let totalCredit = 0n;

  for (const row of getAccountRows(rows)) {
    if (row.lineCount === 0) continue;
    const balance = netBalance(row, true);
    const debit = balance > 0n ? balance : 0n;
    const credit = balance < 0n ? -balance : 0n;
    totalDebit += debit;
    totalCredit += credit;
    accounts.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type,
      debit: centsToDecimal(debit),
      credit: centsToDecimal(credit),
    });
  }

  return {
    asOf,
    currency: getCurrency(rows),
    accounts,
    totals: { debit: centsToDecimal(totalDebit), credit: centsToDecimal(totalCredit) },
    isBalanced: totalDebit === totalCredit,
  };
}

async function getIncomeStatement(client, companyId, { from, to }) {
  const rows = await getAggregateRows(client, companyId, { from, to });
  const revenueAccounts = [];
  const expenseAccounts = [];
  let revenueTotal = 0n;
  let expenseTotal = 0n;

  for (const row of getAccountRows(rows)) {
    if (row.type === 'revenue') {
      const amount = netBalance(row, false);
      if (amount === 0n) continue;
      revenueTotal += amount;
      revenueAccounts.push({ accountId: row.accountId, code: row.code, name: row.name, amount: centsToDecimal(amount) });
    } else if (row.type === 'expense') {
      const amount = netBalance(row, true);
      if (amount === 0n) continue;
      expenseTotal += amount;
      expenseAccounts.push({ accountId: row.accountId, code: row.code, name: row.name, amount: centsToDecimal(amount) });
    }
  }

  return {
    from,
    to,
    currency: getCurrency(rows),
    revenue: { accounts: revenueAccounts, total: centsToDecimal(revenueTotal) },
    expenses: { accounts: expenseAccounts, total: centsToDecimal(expenseTotal) },
    netIncome: centsToDecimal(revenueTotal - expenseTotal),
  };
}

async function getBalanceSheet(client, companyId, { asOf }) {
  const rows = await getAggregateRows(client, companyId, { asOf });
  const assets = [];
  const liabilities = [];
  const equity = [];
  let assetsTotal = 0n;
  let liabilitiesTotal = 0n;
  let equityAccountsTotal = 0n;
  let revenueTotal = 0n;
  let expenseTotal = 0n;

  for (const row of getAccountRows(rows)) {
    if (row.type === 'asset') {
      const amount = netBalance(row, true);
      if (amount === 0n) continue;
      assetsTotal += amount;
      assets.push({ accountId: row.accountId, code: row.code, name: row.name, amount: centsToDecimal(amount) });
    } else if (row.type === 'liability') {
      const amount = netBalance(row, false);
      if (amount === 0n) continue;
      liabilitiesTotal += amount;
      liabilities.push({ accountId: row.accountId, code: row.code, name: row.name, amount: centsToDecimal(amount) });
    } else if (row.type === 'equity') {
      const amount = netBalance(row, false);
      if (amount === 0n) continue;
      equityAccountsTotal += amount;
      equity.push({ accountId: row.accountId, code: row.code, name: row.name, amount: centsToDecimal(amount) });
    } else if (row.type === 'revenue') {
      revenueTotal += netBalance(row, false);
    } else if (row.type === 'expense') {
      expenseTotal += netBalance(row, true);
    }
  }

  const currentEarnings = revenueTotal - expenseTotal;
  const equityTotal = equityAccountsTotal + currentEarnings;
  const liabilitiesAndEquityTotal = liabilitiesTotal + equityTotal;
  const difference = assetsTotal - liabilitiesAndEquityTotal;

  return {
    asOf,
    currency: getCurrency(rows),
    assets: { accounts: assets, total: centsToDecimal(assetsTotal) },
    liabilities: { accounts: liabilities, total: centsToDecimal(liabilitiesTotal) },
    equity: { accounts: equity, currentEarnings: centsToDecimal(currentEarnings), total: centsToDecimal(equityTotal) },
    totalLiabilitiesAndEquity: centsToDecimal(liabilitiesAndEquityTotal),
    isBalanced: difference === 0n,
    difference: centsToDecimal(difference),
  };
}

module.exports = { getTrialBalance, getIncomeStatement, getBalanceSheet };
