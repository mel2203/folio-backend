const { centsToDecimal, decimalToCents } = require('../utils/money');

async function getArAging(client, companyId, { asOf }) {
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
              SUM(CASE WHEN inv_open.due_date >= $2 THEN inv_open.outstanding ELSE 0 END)::text AS current,
              SUM(CASE WHEN inv_open.due_date < $2 AND $2 - inv_open.due_date BETWEEN 1 AND 30 THEN inv_open.outstanding ELSE 0 END)::text AS "days1To30",
              SUM(CASE WHEN $2 - inv_open.due_date BETWEEN 31 AND 60 THEN inv_open.outstanding ELSE 0 END)::text AS "days31To60",
              SUM(CASE WHEN $2 - inv_open.due_date BETWEEN 61 AND 90 THEN inv_open.outstanding ELSE 0 END)::text AS "days61To90",
              SUM(CASE WHEN $2 - inv_open.due_date > 90 THEN inv_open.outstanding ELSE 0 END)::text AS "days90Plus",
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

  const buckets = ['current', 'days1To30', 'days31To60', 'days61To90', 'days90Plus'];
  const totals = Object.fromEntries([...buckets, 'total'].map((key) => [key, 0n]));
  const customers = result.rows.filter((row) => row.customerId).map((row) => {
    const customer = { customerId: row.customerId, name: row.name };
    for (const key of buckets) {
      const responseKey = key === 'days1To30' ? 'days1To30'
        : key === 'days31To60' ? 'days31To60'
          : key === 'days61To90' ? 'days61To90'
            : key === 'days90Plus' ? 'days90Plus' : key;
      const amount = decimalToCents(row[responseKey] || '0.00');
      totals[key] += amount;
      customer[key] = centsToDecimal(amount);
    }
    const total = decimalToCents(row.total || '0.00');
    totals.total += total;
    customer.total = centsToDecimal(total);
    return customer;
  });
  const agingTotal = totals.total;
  const ledgerBalance = decimalToCents(result.rows[0]?.ledgerBalance || '0.00');
  const difference = ledgerBalance - agingTotal;

  return {
    asOf,
    currency: result.rows[0]?.currency?.trim() || 'MYR',
    customers,
    totals: Object.fromEntries([...buckets, 'total'].map((key) => [key, centsToDecimal(totals[key])])),
    ledgerBalance: centsToDecimal(ledgerBalance),
    difference: centsToDecimal(difference),
    reconciles: difference === 0n,
  };
}

module.exports = { getArAging };
