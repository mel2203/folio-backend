const { addCents, centsToDecimal, decimalToCents } = require('../utils/money');
const { getArAging } = require('./ar-aging.service');
const { getApAging } = require('./ap-aging.service');

const DASHBOARD_QUERY = `
  WITH company AS (
    SELECT id, base_currency FROM companies WHERE id = $1
  ),
  cash_balance AS (
    SELECT COALESCE(
      SUM(CASE WHEN entry.id IS NOT NULL THEN line.debit - line.credit ELSE 0 END),
      0
    )::text AS amount
    FROM accounts account
    LEFT JOIN journal_lines line ON line.account_id = account.id
    LEFT JOIN journal_entries entry
      ON entry.id = line.entry_id
      AND entry.company_id = account.company_id
      AND entry.status = 'posted'
      AND entry.entry_date <= $2
    WHERE account.company_id = $1
      AND account.system_role = 'cash'
  ),
  month_series AS (
    SELECT month_start::date AS month_start
    FROM generate_series(
      date_trunc('month', $2::date) - interval '5 months',
      date_trunc('month', $2::date),
      interval '1 month'
    ) AS series(month_start)
  ),
  monthly_performance AS (
    SELECT period.month_start,
           COALESCE(SUM(CASE WHEN account.type = 'revenue' THEN line.credit - line.debit ELSE 0 END), 0)
             ::text AS revenue,
           COALESCE(SUM(CASE WHEN account.type = 'expense' THEN line.debit - line.credit ELSE 0 END), 0)
             ::text AS expenses
    FROM month_series period
    LEFT JOIN journal_entries entry
      ON entry.company_id = $1
      AND entry.status = 'posted'
      AND entry.entry_date >= period.month_start
      AND entry.entry_date < period.month_start + interval '1 month'
      AND entry.entry_date <= $2
    LEFT JOIN journal_lines line ON line.entry_id = entry.id
    LEFT JOIN accounts account
      ON account.id = line.account_id
      AND account.company_id = $1
      AND account.type IN ('revenue', 'expense')
    GROUP BY period.month_start
  ),
  overdue_invoices AS (
    SELECT invoice.id, invoice.due_date,
           invoice.total - COALESCE(
             SUM(payment.amount) FILTER (WHERE payment.payment_date <= $2),
             0
           ) AS outstanding
    FROM invoices invoice
    JOIN journal_entries invoice_entry
      ON invoice_entry.id = invoice.journal_entry_id
      AND invoice_entry.company_id = invoice.company_id
      AND invoice_entry.status = 'posted'
      AND invoice_entry.entry_date <= $2
    LEFT JOIN journal_entries reversal_entry
      ON reversal_entry.id = invoice.reversal_entry_id
      AND reversal_entry.company_id = invoice.company_id
      AND reversal_entry.status = 'posted'
      AND reversal_entry.entry_date <= $2
    LEFT JOIN payments payment
      ON payment.invoice_id = invoice.id
      AND payment.company_id = invoice.company_id
    WHERE invoice.company_id = $1
      AND invoice.issue_date <= $2
      AND invoice.due_date < $2
      AND reversal_entry.id IS NULL
    GROUP BY invoice.id
  ),
  overdue_totals AS (
    SELECT COUNT(*) FILTER (WHERE outstanding > 0)::int AS invoice_count,
           COALESCE(SUM(outstanding) FILTER (WHERE outstanding > 0), 0)
             ::text AS amount
    FROM overdue_invoices
  )
  SELECT company.base_currency AS currency,
         cash_balance.amount AS "cashBalance",
         COALESCE((
           SELECT json_agg(
             json_build_object(
               'month', to_char(performance.month_start, 'YYYY-MM'),
               'revenue', performance.revenue,
               'expenses', performance.expenses
             )
             ORDER BY performance.month_start
           )
           FROM monthly_performance performance
         ), '[]'::json) AS "monthlyPerformance",
         overdue_totals.invoice_count AS "overdueInvoiceCount",
         overdue_totals.amount AS "overdueInvoiceAmount",
         COALESCE((
           SELECT json_agg(
             json_build_object(
               'customerId', ranked.customer_id,
               'name', ranked.name,
               'invoicedAmount', ranked.invoiced_amount
             )
             ORDER BY ranked.invoiced_amount::numeric DESC, ranked.name ASC
           )
           FROM (
             SELECT customer.id AS customer_id, customer.name,
                    SUM(line.debit - line.credit)::text AS invoiced_amount
             FROM invoices invoice
             JOIN customers customer
               ON customer.id = invoice.customer_id
               AND customer.company_id = invoice.company_id
             JOIN journal_entries entry
               ON entry.id = invoice.journal_entry_id
               AND entry.company_id = invoice.company_id
               AND entry.status = 'posted'
               AND entry.entry_date >= date_trunc('year', $2::date)::date
               AND entry.entry_date <= $2
             JOIN accounts account
               ON account.company_id = invoice.company_id
               AND account.system_role = 'accounts_receivable'
             JOIN journal_lines line
               ON line.entry_id = entry.id
               AND line.account_id = account.id
             WHERE invoice.company_id = $1
               AND invoice.issue_date <= $2
             GROUP BY customer.id, customer.name
             HAVING SUM(line.debit - line.credit) > 0
             ORDER BY SUM(line.debit - line.credit) DESC, customer.name ASC
             LIMIT 5
           ) ranked
         ), '[]'::json) AS "topCustomers",
         COALESCE((
           SELECT json_agg(
             json_build_object(
               'accountId', ranked.account_id,
               'code', ranked.code,
               'name', ranked.name,
               'amount', ranked.amount
             )
             ORDER BY ranked.amount::numeric DESC, ranked.code ASC
           )
           FROM (
             SELECT account.id AS account_id, account.code, account.name,
                    SUM(line.debit - line.credit)::text AS amount
             FROM accounts account
             JOIN journal_lines line ON line.account_id = account.id
             JOIN journal_entries entry
               ON entry.id = line.entry_id
               AND entry.company_id = account.company_id
               AND entry.status = 'posted'
               AND entry.entry_date >= date_trunc('month', $2::date)::date
               AND entry.entry_date <= $2
             WHERE account.company_id = $1
               AND account.type = 'expense'
             GROUP BY account.id, account.code, account.name
             HAVING SUM(line.debit - line.credit) > 0
             ORDER BY SUM(line.debit - line.credit) DESC, account.code ASC
             LIMIT 5
           ) ranked
         ), '[]'::json) AS "topExpenseAccounts"
  FROM company
  CROSS JOIN cash_balance
  CROSS JOIN overdue_totals
`;

async function getDashboardSummary(client, companyId, { asOf }) {
  const [dashboardResult, arAging, apAging] = await Promise.all([
    client.query(DASHBOARD_QUERY, [companyId, asOf]),
    getArAging(client, companyId, { asOf }),
    getApAging(client, companyId, { asOf }),
  ]);
  const row = dashboardResult.rows[0];
  const monthlyPerformance = row.monthlyPerformance.map((month) => ({
    month: month.month,
    revenue: centsToDecimal(decimalToCents(month.revenue)),
    expenses: centsToDecimal(decimalToCents(month.expenses)),
  }));
  const currentMonth = monthlyPerformance[monthlyPerformance.length - 1];

  return {
    asOf,
    currency: row.currency.trim(),
    balances: {
      cash: centsToDecimal(decimalToCents(row.cashBalance)),
      accountsReceivable: arAging.totals.total,
      accountsPayable: apAging.totals.total,
    },
    netIncomeThisMonth: centsToDecimal(addCents(
      decimalToCents(currentMonth.revenue),
      -decimalToCents(currentMonth.expenses),
    )),
    monthlyPerformance,
    overdueInvoices: {
      count: row.overdueInvoiceCount,
      amount: centsToDecimal(decimalToCents(row.overdueInvoiceAmount)),
    },
    topCustomers: row.topCustomers.map((customer) => ({
      ...customer,
      invoicedAmount: centsToDecimal(decimalToCents(customer.invoicedAmount)),
    })),
    topExpenseAccounts: row.topExpenseAccounts.map((account) => ({
      ...account,
      amount: centsToDecimal(decimalToCents(account.amount)),
    })),
  };
}

module.exports = { getDashboardSummary };
