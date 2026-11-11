const { agingBucketSql, summarizeAging } = require('../utils/aging');

async function getArAging(client, companyId, { asOf }) {
  const buckets = agingBucketSql('inv_open.due_date', '$2', 'inv_open.outstanding');
  const result = await client.query(
    `WITH company AS (
       SELECT id, base_currency FROM companies WHERE id = $1
     ),
     invoice_open AS (
       SELECT invoice.id, invoice.customer_id, invoice.due_date,
              invoice.total - COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_date <= $2), 0) AS outstanding
       FROM invoices invoice
       LEFT JOIN payments payment
         ON payment.invoice_id = invoice.id AND payment.company_id = invoice.company_id
       WHERE invoice.company_id = $1
         AND invoice.issue_date <= $2
         AND invoice.status IN ('sent', 'partial', 'paid')
       GROUP BY invoice.id
     ),
     customer_aging AS (
       SELECT customer.id AS "customerId", customer.name,
              ${buckets.current} AS current,
              ${buckets.days1To30} AS "days1To30",
              ${buckets.days31To60} AS "days31To60",
              ${buckets.days61To90} AS "days61To90",
              ${buckets.days90Plus} AS "days90Plus",
              SUM(inv_open.outstanding)::text AS total
       FROM invoice_open inv_open
       JOIN customers customer ON customer.id = inv_open.customer_id AND customer.company_id = $1
       WHERE inv_open.outstanding > 0
       GROUP BY customer.id, customer.name
     ),
     ar_balance AS (
       SELECT COALESCE(SUM(CASE WHEN entry.id IS NOT NULL THEN line.debit - line.credit ELSE 0 END), 0)::text AS amount
       FROM accounts account
       LEFT JOIN journal_lines line ON line.account_id = account.id
       LEFT JOIN journal_entries entry
         ON entry.id = line.entry_id AND entry.company_id = account.company_id
         AND entry.status = 'posted' AND entry.entry_date <= $2
       WHERE account.company_id = $1 AND account.system_role = 'accounts_receivable'
     )
     SELECT company.base_currency AS currency, ar_balance.amount AS "ledgerBalance",
            customer_aging."customerId", customer_aging.name, customer_aging.current,
            customer_aging."days1To30", customer_aging."days31To60",
            customer_aging."days61To90", customer_aging."days90Plus", customer_aging.total
     FROM company CROSS JOIN ar_balance
     LEFT JOIN customer_aging ON true
     ORDER BY customer_aging.name ASC NULLS LAST`,
    [companyId, asOf],
  );

  const summary = summarizeAging(result.rows, 'customerId', result.rows[0]?.ledgerBalance);
  return {
    asOf,
    currency: result.rows[0]?.currency?.trim() || 'MYR',
    customers: summary.entities.map(({ customerId, name, ...amounts }) => ({ customerId, name, ...amounts })),
    totals: summary.totals,
    ledgerBalance: summary.ledgerBalance,
    difference: summary.difference,
    reconciles: summary.reconciles,
  };
}

module.exports = { getArAging };
